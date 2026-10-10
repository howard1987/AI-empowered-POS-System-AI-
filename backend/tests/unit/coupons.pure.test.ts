/**
 * Q-02 特征测试基座 · 券纯函数（coupons.pure.ts）表驱动用例
 * 运行：npm run test:unit（= node --test tests/unit/，Node ≥22 原生跑 TS，零额外依赖）
 *
 * 目的：锁住现行为（特征测试），为后续 checkout 大重构（Q-01/P-03）提供安全网。
 *   - chooseCoupons：V5.0 多券模式裁决（single/manual/auto）——抽离自 applyCoupons，行为不变
 *   - sumChosenCoupons：L-05 叠加封顶——累计抵扣 ≤ (goodsAmount − promoAmount)，应付恒 ≥ 0
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chooseCoupons, sumChosenCoupons, type CouponScore } from '../../src/modules/coupons.pure.ts';

const mc = (id: number, stackable?: boolean, name = `券${id}`) => ({ id, name, stackable });
const sc = (id: number, amount: number, stackable?: boolean): CouponScore => ({ mc: mc(id, stackable), amount });

describe('chooseCoupons · single 模式', () => {
  it('未指定券：全池取最优一张', () => {
    const pool = [sc(1, 20), sc(2, 60), sc(3, 35)];
    assert.deepEqual(chooseCoupons(pool, 'single'), [sc(2, 60)]);
  });
  it('指定券：只在指定集合内取最优', () => {
    const pool = [sc(1, 20), sc(2, 60), sc(3, 35)];
    assert.deepEqual(chooseCoupons(pool, 'single', [1, 3]), [sc(3, 35)]);
  });
  it('指定的券都不在可用池：chosen 为空（触发 50042 拦截）', () => {
    assert.deepEqual(chooseCoupons([sc(1, 20)], 'single', [9]), []);
  });
});

describe('chooseCoupons · manual 模式', () => {
  it('全可叠加：全选累加', () => {
    assert.deepEqual(chooseCoupons([sc(1, 20), sc(2, 30)], 'manual', [1, 2]), [sc(1, 20), sc(2, 30)]);
  });
  it('含不可叠加券：互斥裁决 → 只用其中最优一张', () => {
    const pool = [sc(1, 20, false), sc(2, 50, false), sc(3, 10, true)];
    assert.deepEqual(chooseCoupons(pool, 'manual', [1, 2, 3]), [sc(2, 50, false)]);
  });
  it('未传指定集合：空选择', () => {
    assert.deepEqual(chooseCoupons([sc(1, 20)], 'manual', []), []);
  });
});

describe('chooseCoupons · auto 模式', () => {
  it('可叠加合计 ≥ 最优不可叠加 → 用全部可叠加券', () => {
    const pool = [sc(1, 60, true), sc(2, 50, true), sc(3, 90, false)];
    assert.deepEqual(chooseCoupons(pool, 'auto'), [sc(1, 60, true), sc(2, 50, true)]);
  });
  it('可叠加合计 < 最优不可叠加 → 只用最优不可叠加券', () => {
    const pool = [sc(1, 60, true), sc(2, 50, true), sc(3, 200, false)];
    assert.deepEqual(chooseCoupons(pool, 'auto'), [sc(3, 200, false)]);
  });
  it('没有不可叠加券 → 全部可叠加券', () => {
    assert.deepEqual(chooseCoupons([sc(1, 60), sc(2, 50)], 'auto'), [sc(1, 60), sc(2, 50)]);
  });
  it('空池 → 空', () => {
    assert.deepEqual(chooseCoupons([], 'auto'), []);
  });
  it('不改写入参（scored 顺序保持原样）', () => {
    const pool = [sc(1, 20), sc(2, 60), sc(3, 35)];
    chooseCoupons(pool, 'single');
    assert.deepEqual(pool.map(x => x.mc.id), [1, 2, 3]);
  });
});

describe('sumChosenCoupons · L-05 叠加封顶（核心不变量：应付恒 ≥ 0）', () => {
  it('表驱动：各场景累计抵扣与封顶', () => {
    const cases: { name: string; chosen: CouponScore[]; goods: number; promo: number; want: number }[] = [
      // L-05 修复前的 bug 场景：两张 ¥60 用于 ¥100 货 → 旧实现 120（应付 -20 → 50031 拒单）
      { name: '两张¥60用于¥100货 → 60+40=100（应付归零可结账）', chosen: [sc(1, 60), sc(2, 60)], goods: 100, promo: 0, want: 100 },
      { name: '顺序相关：¥30+¥90 同样封顶 100', chosen: [sc(1, 30), sc(2, 90)], goods: 100, promo: 0, want: 100 },
      { name: '促销吃掉部分余量：货100促30 → 余70，60+60 封顶 70', chosen: [sc(1, 60), sc(2, 60)], goods: 100, promo: 30, want: 70 },
      { name: '不触顶：单张60货100 → 60', chosen: [sc(1, 60)], goods: 100, promo: 0, want: 60 },
      { name: '余量为0（促销≥货值）→ 全部抵 0', chosen: [sc(1, 60), sc(2, 60)], goods: 50, promo: 50, want: 0 },
      { name: '负金额按 0 处理', chosen: [sc(1, -5), sc(2, 60)], goods: 100, promo: 0, want: 60 },
      { name: '空选择 → 0', chosen: [], goods: 100, promo: 0, want: 0 },
      { name: '金额含小数按分舍入（0.005→0.01）', chosen: [sc(1, 10.005)], goods: 100, promo: 0, want: 10.01 },
      { name: '货值含小数：货19.99促0 → 单张25封顶19.99', chosen: [sc(1, 25)], goods: 19.99, promo: 0, want: 19.99 },
    ];
    for (const c of cases) {
      assert.equal(sumChosenCoupons(c.chosen, c.goods, c.promo), c.want, c.name);
    }
  });
  it('性质校验：任意随机组合累计抵扣永不超过可用余量', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 50; i++) {
      const n = 1 + Math.floor(rnd() * 5);
      const chosen = Array.from({ length: n }, (_, k) => sc(k + 1, Math.round(rnd() * 20000) / 100));
      const goods = Math.round(rnd() * 30000) / 100;
      const promo = Math.round(rnd() * Math.min(goods, 10000)) / 100;
      const total = sumChosenCoupons(chosen, goods, promo);
      const remain = Math.max(0, Math.round((goods - promo) * 100) / 100);
      assert.ok(total <= remain + 1e-9, `goods=${goods} promo=${promo} amounts=${chosen.map(x => x.amount)} → ${total}`);
      assert.ok(total >= 0);
    }
  });
});
