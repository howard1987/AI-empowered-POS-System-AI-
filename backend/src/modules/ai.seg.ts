/**
 * V4.11.2 · 方案 v3.2 M2 多件识别 · 零训练轮廓分割（ai.seg.ts）
 *   - 场景：固定俯拍浅色秤盘/浅色台面，商品随意摆放、不堆叠（方案 v3.1 定位层 MVP 路线）
 *   - 原理：纯 Node（jimp）灰度 → 边框采样估计背景亮度 → 前景二值化（|亮度差|阈值）
 *     → 3×3 膨胀连接断裂边缘 → 连通域标记（BFS，降采样网格 <10ms 级）→ 外接框
 *     → 面积/宽高过滤 → 小框合并 → 坐标映射回原图。零训练、零新增依赖。
 *   - 防御：仅 0~1 个框（含"一整块大框"）→ 返回 multi=false，调用方回落单件管线；
 *     框数上限 12（超过取面积最大的 12 个，防极端噪声拖垮逐件检索）。
 */
export interface SegBox { x: number; y: number; w: number; h: number; frac: number; virtual?: boolean; }

/** 从识别帧裁出单件外接框（JPEG base64），供逐件 CLIP 编码 */
export async function cropItemBase64(imageBase64: string, box: SegBox): Promise<string> {
  const { Jimp } = await import('jimp');
  const buf = Buffer.from(String(imageBase64 || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
  const img = await Jimp.read(buf);
  return cropFromImg(img, box);
}

/** V5.0.18g：从已解码图像裁单件框（复用同一次解码，消除多件识别逐框重复解码） */
export async function cropFromImg(img: any, box: SegBox): Promise<string> {
  const c = img.clone();
  const x = Math.max(0, Math.min(img.bitmap.width - 1, Math.floor(box.x)));
  const y = Math.max(0, Math.min(img.bitmap.height - 1, Math.floor(box.y)));
  const w = Math.max(1, Math.min(img.bitmap.width - x, Math.ceil(box.w)));
  const h = Math.max(1, Math.min(img.bitmap.height - y, Math.ceil(box.h)));
  c.crop({ x, y, w, h });
  const out = await c.getBuffer('image/jpeg');
  return out.toString('base64');
}

/** 分割参数（降采样后的网格尺度） */
const MAX_SIDE = 480;          // 降采样上限（速度：<10ms/帧量级）
const BG_BORDER = 4;           // 背景估计取四边框宽（像素）
const FG_DELTA = 18;           // 与背景亮度差 ≥ 该值视为前景（0-255）
const MIN_FRAC = 0.004;        // 最小面积占比 0.4%（滤噪点）
const MAX_FRAC = 0.55;         // 单框最大面积占比 55%（一整块=没分开，回落单件）
const MIN_SIDE = 28;           // 框最小边（降采样网格像素，滤细长噪声）
const MAX_BOXES = 12;
const PAD_PCT = 0.08;          // 裁剪框外扩比例（保住商品边缘轮廓）

export interface SegResult {
  multi: boolean;              // 是否判定为多件画面（≥2 个有效框）
  boxes: SegBox[];             // 原图坐标外接框
  ms: number;
  w: number; h: number;        // 原图尺寸
}

/** 灰度化 + 降采样网格（最近邻） */
function grid(img: any): { g: Uint8Array; w: number; h: number; k: number } {
  const w0 = img.bitmap.width, h0 = img.bitmap.height;
  const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
  const g = new Uint8Array(w * h);
  const d = img.bitmap.data;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h0 - 1, Math.floor(y / k));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w0 - 1, Math.floor(x / k));
      const si = (sy * w0 + sx) * 4;
      // Rec.601 亮度
      g[y * w + x] = (d[si] * 299 + d[si + 1] * 587 + d[si + 2] * 114) / 1000 | 0;
    }
  }
  return { g, w, h, k };
}

/** 背景亮度：四边框采样中位数（浅色秤盘/台面假设） */
function bgLuminance(g: Uint8Array, w: number, h: number): number {
  const samples: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < BG_BORDER || y < BG_BORDER || x >= w - BG_BORDER || y >= h - BG_BORDER) samples.push(g[y * w + x]);
    }
  }
  samples.sort((a, b) => a - b);
  return samples.length ? samples[samples.length >> 1] : 235;
}

/** 3×3 膨胀（连接断裂边缘；腐蚀省略——膨胀足够并域，且多并一点对 CLIP 裁剪无害） */
function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= w) continue;
          out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

/** 连通域 BFS → 外接框列表（面积降序） */
function components(mask: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number; area: number }[] {
  const seen = new Uint8Array(mask.length);
  const boxes: { x: number; y: number; w: number; h: number; area: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let minX = w, minY = h, maxX = 0, maxY = 0, area = 0;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      const cy = (cur / w) | 0, cx = cur % w;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      area++;
      // 8 邻域
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy; if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx; if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
        }
      }
    }
    boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area });
  }
  return boxes.sort((a, b) => b.area - a.area);
}

/** V5.0.18g 大块投影切分：对连成一整块的前景做 X→Y 两次投影谷底切分
 *  （并排/堆叠摆放的主流场景）。谷底阈值 = 峰值 12%；段最小宽 ≥ MIN_SIDE×0.8。
 *  切出 ≥2 段返回（段内按另一维前景精确收边）；切不出返回空（调用方保留原框）。 */
function splitLargeBox(b: { x: number; y: number; w: number; h: number }, fat: Uint8Array, w: number): SegBox[] {
  const one = (x0: number, y0: number, bw: number, bh: number, axis: 'x' | 'y'): { a: number; b: number; lo: number; hi: number }[] => {
    if (bw < MIN_SIDE || bh < MIN_SIDE) return [];
    const len = axis === 'x' ? bw : bh;
    const proj = new Uint32Array(len);
    if (axis === 'x') {
      for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) if (fat[y * w + x]) proj[x - x0]++;
    } else {
      for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) if (fat[y * w + x]) proj[y - y0]++;
    }
    const sm = new Uint32Array(len);
    for (let i = 0; i < len; i++) {
      const a = proj[Math.max(0, i - 1)], c = proj[Math.min(len - 1, i + 1)];
      sm[i] = (a + proj[i] + c) / 3 | 0;
    }
    let peak = 0;
    for (let i = 0; i < len; i++) if (sm[i] > peak) peak = sm[i];
    if (!peak) return [];
    const valley = Math.max(1, Math.round(peak * 0.12));
    const segs: { a: number; b: number }[] = [];
    let s = -1;
    for (let i = 0; i < len; i++) {
      const on = sm[i] > valley;
      if (on && s < 0) s = i;
      if (s >= 0 && (!on || i === len - 1)) { segs.push({ a: s, b: on ? i : i - 1 }); s = -1; }
    }
    const minSeg = Math.round(MIN_SIDE * 0.8);
    const out: { a: number; b: number; lo: number; hi: number }[] = [];
    for (const sg of segs) {
      if (sg.b - sg.a + 1 < minSeg) continue;
      // 段内按另一维前景精确收边（避免全高/全宽虚框）
      let lo = -1, hi = -1;
      if (axis === 'x') {
        for (let y = y0; y < y0 + bh; y++) {
          let cnt = 0;
          for (let x = x0 + sg.a; x <= x0 + sg.b; x++) if (fat[y * w + x]) cnt++;
          if (cnt > 0) { if (lo < 0) lo = y; hi = y; }
        }
      } else {
        for (let x = x0; x < x0 + bw; x++) {
          let cnt = 0;
          for (let y = y0; y < y0 + bh; y++) if (fat[y * w + x]) cnt++;
          if (cnt > 0) { if (lo < 0) lo = x; hi = x; }
        }
      }
      if (lo >= 0 && hi - lo + 1 >= MIN_SIDE) out.push({ a: x0 + sg.a, b: axis === 'x' ? x0 + sg.b : y0 + sg.b, lo, hi });
    }
    return out;
  };
  const mk = (axis: 'x' | 'y', sg: { a: number; b: number; lo: number; hi: number }): SegBox =>
    axis === 'x'
      ? { x: sg.a, y: sg.lo, w: sg.b - sg.a + 1, h: sg.hi - sg.lo + 1, frac: 0 }
      : { x: sg.lo, y: sg.a, w: sg.hi - sg.lo + 1, h: sg.b - sg.a + 1, frac: 0 };
  // 先 X 切分（并排摆放主流）；每个 X 段再尝试 Y 切分（处理堆叠）
  const xs = one(b.x, b.y, b.w, b.h, 'x');
  if (xs.length >= 2) {
    const out: SegBox[] = [];
    for (const sg of xs) {
      const sub = one(axisOf(sg, 'x').x, axisOf(sg, 'x').y, axisOf(sg, 'x').w, axisOf(sg, 'x').h, 'y');
      out.push(...(sub.length >= 2 ? sub.map(s => mk('y', s)) : [mk('x', sg)]));
    }
    return out;
  }
  const ys = one(b.x, b.y, b.w, b.h, 'y');
  return ys.length >= 2 ? ys.map(s => mk('y', s)) : [];
}
/** 由切分段还原其在 mask 坐标系中的外接框（供递归 Y 切分取参数） */
function axisOf(sg: { a: number; b: number; lo: number; hi: number }, axis: 'x' | 'y'): { x: number; y: number; w: number; h: number } {
  return axis === 'x'
    ? { x: sg.a, y: sg.lo, w: sg.b - sg.a + 1, h: sg.hi - sg.lo + 1 }
    : { x: sg.lo, y: sg.a, w: sg.hi - sg.lo + 1, h: sg.b - sg.a + 1 };
}

/** 框合并：中心距小于双方平均边长 0.6 倍的近邻合并（同一商品断裂的两块） */
function mergeNear(boxes: SegBox[], w: number, h: number): SegBox[] {  const out = boxes.slice();
  let merged = true;
  while (merged && out.length > 1) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        const a = out[i], b = out[j];
        const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
        const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
        const meanW = (a.w + b.w) / 2, meanH = (a.h + b.h) / 2;
        if (Math.abs(acx - bcx) < meanW * 0.6 && Math.abs(acy - bcy) < meanH * 0.6) {
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          out[i] = {
            x, y,
            w: Math.max(a.x + a.w, b.x + b.w) - x,
            h: Math.max(a.y + a.h, b.y + b.h) - y,
            frac: 0,
          };
          out.splice(j, 1);
          merged = true;
        }
      }
    }
  }
  return out.map(b => ({ ...b, frac: (b.w * b.h) / (w * h) }));
}

/**
 * 识别帧 → 多件外接框（原图坐标）。multi=false 时 boxes 可能为空或仅一块大框。
 */
export async function segmentItems(imageBase64: string): Promise<SegResult> {
  const t0 = Date.now();
  const { Jimp } = await import('jimp');
  const buf = Buffer.from(String(imageBase64 || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (!buf.length) return { multi: false, boxes: [], ms: Date.now() - t0, w: 0, h: 0 };
  const img = await Jimp.read(buf);
  const r = await segmentItemsFromImg(img);
  return { ...r, ms: Date.now() - t0 };   // ms 含解码（薄壳口径，与历史一致）
}

/** V5.0.18g：对已解码图像做分割（供多件识别复用同一次解码——原先分割 1 次 + 逐件裁剪 N 次
 *  共 N+1 次全图 jimp 解码，大图每次 300~500ms，是多商品识别的最大耗时项）。 */
export async function segmentItemsFromImg(img: any): Promise<SegResult> {
  const t0 = Date.now();
  const w0 = img.bitmap.width, h0 = img.bitmap.height;
  const { g, w, h, k } = grid(img);
  const bg = bgLuminance(g, w, h);
  // 前景二值化：|亮度 - 背景| ≥ 阈值（暗于或亮于背景的商品都算前景）
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) if (Math.abs(g[i] - bg) >= FG_DELTA) mask[i] = 1;
  const fat = dilate(mask, w, h);
  const rawBoxes = components(fat, w, h)
    .map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h, frac: 0 }))
    .filter(b => b.w >= MIN_SIDE && b.h >= MIN_SIDE);
  /* V5.0.18g 大块切分：商品占满画面/相互贴近时，前景连成一整块（旧逻辑 frac>MAX_FRAC 直接
   * 丢弃 → 0 框 → 中央虚拟框混合检索 → 误采信）。对大块做 X→Y 投影谷底切分（并排/堆叠
   * 摆放的主流场景）；切不出 ≥2 段则保留真实前景大框（好过中央猜框），仅近乎全屏的
   * frac≥0.9（背景估计失败/全帧误报）仍丢弃。 */
  const mergedIn: SegBox[] = [], splitOut: SegBox[] = [];
  for (const b of rawBoxes) {
    const frac = (b.w * b.h) / (w * h);
    if (frac > MAX_FRAC * 0.6) {
      const parts = splitLargeBox(b, fat, w);
      if (parts.length >= 2) { splitOut.push(...parts); continue; }
      if (frac <= 0.9) { mergedIn.push({ ...b, frac }); continue; }
      continue;
    }
    if (frac >= MIN_FRAC) mergedIn.push({ ...b, frac });
  }
  let boxes = [
    ...mergeNear(mergedIn, w, h).filter(b => b.frac >= MIN_FRAC),
    ...splitOut.filter(b => b.frac >= MIN_FRAC),
  ].sort((a, b) => b.frac - a.frac).slice(0, MAX_BOXES);
  // 坐标映射回原图 + 外扩
  const out: SegBox[] = boxes
    .sort((a, b) => b.frac - a.frac)
    .slice(0, MAX_BOXES)
    .map(b => {
      const px = Math.round(PAD_PCT * Math.max(b.w, b.h));
      const x = Math.max(0, Math.floor((b.x - px) / k));
      const y = Math.max(0, Math.floor((b.y - px) / k));
      return {
        x, y,
        w: Math.min(w0 - x, Math.ceil((b.w + 2 * px) / k)),
        h: Math.min(h0 - y, Math.ceil((b.h + 2 * px) / k)),
        frac: b.frac,
      };
    });
  return { multi: out.length >= 2, boxes: out, ms: Date.now() - t0, w: w0, h: h0 };
}
