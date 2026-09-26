/**
 * make-icon.cjs · 生成"超市收银系统"快捷方式图标（扁平矢量风格，程序化绘制，无需外部素材）
 * 图案：绿色圆角方块底 + 店铺遮阳棚（绿白条纹）+ 白色购物篮（篮内橙子 + 青菜叶）
 * 输出：pos.ico（16/32/48 BMP + 256 PNG 四尺寸）+ preview-256.png（人工核验用）
 * 运行：node make-icon.cjs   （依赖 backend/node_modules 的 jimp）
 */
const path = require('path');
const fs = require('fs');
const { Jimp } = require(path.resolve(__dirname, '..', '..', '..', 'backend', 'node_modules', 'jimp'));

// ── 调色板 ──
const C_BG = 0x2f9e63ff;        // 底色·生鲜绿
const C_BG_DARK = 0x247a4eff;   // 底色·下缘加深（轻立体）
const C_WHITE = 0xffffffff;
const C_ORANGE = 0xf59f3bff;    // 橙子
const C_ORANGE_D = 0xd97f22ff;
const C_LEAF = 0x6fbf4bff;      // 青菜叶
const C_LEAF_D = 0x4f9e33ff;
const C_BASKET = 0xd97f22ff;    // 篮体橙棕
const C_BASKET_D = 0xb5661aff;

const S = 2048;                 // 超采样画布（缩出小尺寸天然抗锯齿）
const img = new Jimp({ width: S, height: S, color: 0x00000000 });

const hex = c => [(c >> 24) & 255, (c >> 16) & 255, (c >> 8) & 255, c & 255];
function setPx(x, y, c) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const [r, g, b, a] = hex(c);
  if (a >= 255) { img.setPixelColor(((r << 24) | (g << 16) | (b << 8) | 255) >>> 0, x, y); return; }
  const old = img.getPixelColor(x, y);
  const [or, og, ob, oa] = [(old >> 24) & 255, (old >> 16) & 255, (old >> 8) & 255, old & 255];
  const na = a + oa * (255 - a) / 255;
  if (!na) return;
  const mix = (nw, oldCh) => Math.max(0, Math.min(255, Math.round((nw * a + oldCh * (oa * (255 - a) / 255)) / na)));
  img.setPixelColor(((mix(r, or) << 24) | (mix(g, og) << 16) | (mix(b, ob) << 8) | Math.round(na)) >>> 0, x, y);
}
/** 圆角矩形（内缩 in 内填充；抗锯齿按 1px 边缘羽化） */
function roundRect(x0, y0, x1, y1, r, c) {
  const [rr, gg, bb] = hex(c);
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) {
      const cx = Math.max(x0 + r, Math.min(x, x1 - r));
      const cy = Math.max(y0 + r, Math.min(y, y1 - r));
      const d = Math.hypot(x - cx, y - cy);
      let a = 255;
      if (d > r) { if (d > r + 1) continue; a = Math.round(255 * (r + 1 - d)); }
      setPx(x, y, (rr << 24) | (gg << 16) | (bb << 8) | a);
    }
  }
}
function circle(cx, cy, r, c) {
  const [rr, gg, bb] = hex(c);
  for (let y = Math.floor(cy - r) - 1; y <= Math.ceil(cy + r) + 1; y++) {
    for (let x = Math.floor(cx - r) - 1; x <= Math.ceil(cx + r) + 1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let a = 255;
      if (d > r) { if (d > r + 1) continue; a = Math.round(255 * (r + 1 - d)); }
      setPx(x, y, (rr << 24) | (gg << 16) | (bb << 8) | a);
    }
  }
}
/** 圆环（描边） */
function ring(cx, cy, rOut, rIn, c) {
  const [rr, gg, bb] = hex(c);
  for (let y = Math.floor(cy - rOut) - 1; y <= Math.ceil(cy + rOut) + 1; y++) {
    for (let x = Math.floor(cx - rOut) - 1; x <= Math.ceil(cx + rOut) + 1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let a = 0;
      if (d <= rIn) continue;
      if (d < rIn + 1) a = Math.round(255 * (d - rIn));
      else if (d <= rOut) a = 255;
      else if (d < rOut + 1) a = Math.round(255 * (rOut + 1 - d));
      if (a) setPx(x, y, (rr << 24) | (gg << 16) | (bb << 8) | a);
    }
  }
}
/** 多边形扫描线填充 */
function polygon(pts, c) {
  const [rr, gg, bb] = hex(c);
  const ys = pts.map(p => p[1]);
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  for (let y = y0; y <= y1; y++) {
    const xs = [];
    for (let i = 0; i < pts.length; i++) {
      const [xa, ya] = pts[i], [xb, yb] = pts[(i + 1) % pts.length];
      if ((ya <= y && yb > y) || (yb <= y && ya > y)) xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.round(xs[k]); x <= Math.round(xs[k + 1]); x++) setPx(x, y, c);
    }
  }
}

// ── 构图（2048 画布）──
// 1) 底：圆角方块 + 下缘深色带（轻立体）
roundRect(80, 80, S - 80, S - 80, 340, C_BG);
roundRect(80, S - 640, S - 80, S - 80, 340, C_BG_DARK);
roundRect(80, 80, S - 80, S - 760, 340, C_BG);

// 2) 店铺遮阳棚：顶部绿白相间条纹 + 扇贝边
const awTop = 300, awBot = 560, n = 8, w = (S - 160) / n;
for (let i = 0; i < n; i++) {
  const x0 = 80 + i * w, x1 = x0 + w;
  const col = i % 2 === 0 ? C_WHITE : 0xe8f5ecff;
  polygon([[x0, awTop], [x1, awTop], [x1, awBot - 40], [x0, awBot - 40]], col);
  circle(x0 + w / 2, awBot - 40, w / 2, col);   // 扇贝圆弧
}
roundRect(80, awTop - 46, S - 80, awTop, 40, C_WHITE);   // 棚顶横梁

// 3) 购物篮：梯形篮体（橙棕）+ 白色提手环
const bx0 = 480, bx1 = S - 480, byTop = 900, byBot = 1520;
ring(S / 2, byTop - 60, 430, 320, C_WHITE);
polygon([[bx0 - 90, byTop], [bx1 + 90, byTop], [bx1 - 120, byBot], [bx0 + 120, byBot]], C_BASKET);
roundRect(bx0 - 120, byTop - 46, bx1 + 120, byTop + 60, 60, C_BASKET_D);   // 篮沿
// 篮身竖纹
for (let i = 1; i < 6; i++) {
  const t = i / 6;
  const xa = (bx0 - 90) + ((bx1 + 90) - (bx0 - 90)) * t;
  polygon([[xa - 26, byTop + 80], [xa + 26, byTop + 80], [xa - 14, byBot - 40], [xa - 66, byBot - 40]], C_BASKET_D);
}

// 4) 篮内商品：橙子 + 青菜叶（探出篮沿）
circle(S / 2 - 260, byTop - 120, 190, C_ORANGE);
circle(S / 2 - 330, byTop - 200, 56, 0xffd08aff);           // 高光
circle(S / 2 + 240, byTop - 140, 160, C_ORANGE_D);
// 青菜叶（两片叶形椭圆 + 叶脉）
const leaf = (cx, cy, rx, ry, rot, c) => {
  const rad = rot * Math.PI / 180, cos = Math.cos(-rad), sin = Math.sin(-rad);
  for (let y = cy - ry - 2; y <= cy + ry + 2; y++) {
    for (let x = cx - Math.max(rx, ry) - 2; x <= cx + Math.max(rx, ry) + 2; x++) {
      const dx = x - cx, dy = y - cy;
      const u = dx * cos - dy * sin, v = dx * sin + dy * cos;
      const k = (u * u) / (rx * rx) + (v * v) / (ry * ry);
      if (k <= 1) setPx(x, y, c);
    }
  }
};
leaf(S / 2 + 30, byTop - 240, 90, 250, 18, C_LEAF);
leaf(S / 2 + 30, byTop - 240, 70, 210, -26, C_LEAF_D);

// ── 输出 ──
(async () => {
  const base = await Jimp.fromBuffer(await img.getBuffer('image/png'));
  // 512 主尺寸 + 各小尺寸
  const png256 = await (await base.clone().resize({ w: 256, h: 256 })).getBuffer('image/png');
  fs.writeFileSync(path.join(__dirname, 'preview-256.png'), png256);
  const bmps = {};
  for (const size of [16, 32, 48]) {
    const im = await base.clone().resize({ w: size, h: size });
    const { data, width, height } = im.bitmap;
    // 32bpp DIB：行序自底向上 BGRA
    const xor = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const o = ((height - 1 - y) * width + x) * 4;
        xor[o] = data[i + 2]; xor[o + 1] = data[i + 1]; xor[o + 2] = data[i]; xor[o + 3] = data[i + 3];
      }
    }
    const mask = Buffer.alloc(Math.ceil(width / 32) * 4 * height);
    const hdr = Buffer.alloc(40);
    hdr.writeUInt32LE(40, 0); hdr.writeInt32LE(width, 4); hdr.writeInt32LE(height * 2, 8);
    hdr.writeUInt16LE(1, 12); hdr.writeUInt16LE(32, 14);
    bmps[size] = Buffer.concat([hdr, xor, mask]);
  }
  // ICO 组装：16/32/48(BMP) + 256(PNG)
  const entries = [
    { w: 16, h: 16, buf: bmps[16] }, { w: 32, h: 32, buf: bmps[32] },
    { w: 48, h: 48, buf: bmps[48] }, { w: 256, h: 256, buf: png256, png: true },
  ];
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.w >= 256 ? 0 : e.w; dir[o + 1] = e.h >= 256 ? 0 : e.h;
    dir[o + 2] = 0; dir[o + 3] = 0; dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(e.png ? 32 : 32, o + 6);
    dir.writeUInt32LE(e.buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += e.buf.length;
  });
  fs.writeFileSync(path.join(__dirname, 'pos.ico'), Buffer.concat([header, dir, ...entries.map(e => e.buf)]));
  console.log('OK: pos.ico（16/32/48/256 四尺寸）+ preview-256.png');
})();
