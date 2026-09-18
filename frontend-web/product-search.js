import { get, must, esc } from './api.js';

/**
 * 商品模糊搜索组件（V4.8.20 共享，供调价单/入库/退货等单据复用）
 * - 支持：条码全码、条码后六位、商品名称、拼音码、货号 模糊定位（后端 /products?keyword=）
 * - 扫码枪友好：扫码枪输入以回车结尾 → 回车即选（唯一结果或高亮项）
 * - 键盘：↑↓ 切换高亮、Enter 确认、Esc 关闭；鼠标点击选择
 * 用法：attachProductSearch(inputEl, { onPick })；onPick(product) 后自动清空输入
 */
export function attachProductSearch(input, { onPick, placeholder } = {}) {
  if (placeholder) input.placeholder = placeholder;
  const wrap = document.createElement('div');
  wrap.className = 'ps-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const pop = document.createElement('div');
  pop.className = 'ps-pop';
  wrap.appendChild(pop);

  let items = [];
  let active = -1;
  let timer = null;

  function hide() { pop.classList.remove('open'); items = []; active = -1; }

  function draw() {
    if (!items.length) {
      pop.innerHTML = '<div class="ps-item ps-empty">无匹配商品（支持条码/条码后6位/名称/拼音）</div>';
    } else {
      pop.innerHTML = items.map((p, i) => `
        <div class="ps-item ${i === active ? 'active' : ''}" data-i="${i}">
          <span>${esc(p.name)}</span>
          <span class="ps-bc">${esc(p.barcode || '无条码')}</span>
          <span class="ps-price">¥${Number(p.sell_price ?? 0).toFixed(2)}</span>
        </div>`).join('');
    }
    pop.classList.add('open');
  }

  async function query(kw) {
    try {
      const d = await must(get(`/products?keyword=${encodeURIComponent(kw)}&size=20`));
      items = d.items || d || [];
      active = items.length ? 0 : -1;
      draw();
    } catch (e) { hide(); }
  }

  function pick(p) {
    hide();
    input.value = '';
    input.focus();
    if (onPick) onPick(p);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const kw = input.value.trim();
    if (!kw) { hide(); return; }
    timer = setTimeout(() => query(kw), 180);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { active = (active + 1) % items.length; draw(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { active = (active - 1 + items.length) % items.length; draw(); } }
    else if (e.key === 'Enter') {
      e.preventDefault();
      // 扫码枪：输入完整条码回车 → 精确条码命中优先；否则选高亮项；唯一结果直选
      const kw = input.value.trim();
      const exact = items.find(p => p.barcode && p.barcode === kw);
      const target = exact || items[active] || (items.length === 1 ? items[0] : null);
      if (target) pick(target);
      else if (kw && items.length === 0) { clearTimeout(timer); query(kw); }
    }
    else if (e.key === 'Escape') hide();
  });

  pop.addEventListener('mousedown', e => {
    const el = e.target.closest('.ps-item[data-i]');
    if (el) { e.preventDefault(); pick(items[Number(el.dataset.i)]); }
  });

  input.addEventListener('blur', () => setTimeout(hide, 150));

  return { refresh: () => { const kw = input.value.trim(); if (kw) query(kw); }, hide };
}
