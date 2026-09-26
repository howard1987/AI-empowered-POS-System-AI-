# -*- coding: utf-8 -*-
"""
步骤 1/3 · 导出训练数据集（ai_samples 已入库样本 → YOLO 检测格式，单类「商品」）
==========================================================================
数据来源：backend PG 库 ai_samples（status IN ('已审核','已入库')，image_path LIKE '/uploads/%'）
标注方式（--labeler）：
  bg   —— 内置零训练背景差分定位（与后端 ai.seg.ts 同原理：亮度阈值+连通域），离线可用，适合
          固定俯拍浅色秤盘/台面样本；识别帧场景与样本采集一致时效果稳定。
  auto —— ultralytics YOLO-World 开放词汇检测预标注（yolov8s-worldv2），对任意背景/构图更鲁棒，
          首次运行需联网下载权重。推荐样本量大或背景多样时使用。
人工校正框优先：标注审核台（/pwa/label-review.html）人工保存过的框（annotation.boxes +
          labelReviewed=true）直接采用，跳过自动标注（--no-reviewed 可关闭）。
数据划分（--split，默认 8:1:1）：train/val/test 随机划分（固定种子，可复现）。
输出目录结构（YOLO detect 规范）：
  dataset/images/{train,val,test}/*.jpg
  dataset/labels/{train,val,test}/*.txt   （class cx cy w h，归一化坐标；空文件=负样本/背景图）
  dataset/data.yaml
用法：
  python export_dataset.py --labeler auto            # 推荐
  python export_dataset.py --labeler bg --limit 2000 # 离线 / 快速起步
  # 数据库连接：环境变量 DATABASE_URL（默认 postgres://cashier:cashier123@localhost:5432/cashier）
  # 图片目录：环境变量 AI_UPLOADS_DIR（默认 backend/public/uploads）
"""
import argparse
import os
from pathlib import Path
from collections import deque

import numpy as np
import psycopg2
from PIL import Image

DEFAULT_DSN = os.environ.get('DATABASE_URL', 'postgres://cashier:cashier123@localhost:5432/cashier')

# ── 与 backend/src/modules/ai.seg.ts 对齐的轮廓定位参数 ──
MAX_SIDE = 480      # 降采样上限
BG_BORDER = 4       # 背景估计取四边框宽
FG_DELTA = 18       # 与背景亮度差阈值
MIN_FRAC = 0.004    # 最小面积占比
MAX_FRAC = 0.55     # 单框最大面积占比
MIN_SIDE = 28       # 框最小边（降采样网格像素）
MAX_BOXES = 12
PAD_PCT = 0.08      # 外扩比例


def gray_grid(img: Image.Image):
    g = img.convert('L')
    k = min(1.0, MAX_SIDE / max(g.width, g.height))
    w, h = max(1, round(g.width * k)), max(1, round(g.height * k))
    a = np.asarray(g.resize((w, h), Image.NEAREST), dtype=np.uint8)
    return a, w, h, k


def bg_luminance(a: np.ndarray) -> int:
    border = np.concatenate([
        a[:BG_BORDER, :].ravel(), a[-BG_BORDER:, :].ravel(),
        a[:, :BG_BORDER].ravel(), a[:, -BG_BORDER:].ravel()])
    return int(np.median(border)) if border.size else 235


def dilate(mask: np.ndarray) -> np.ndarray:
    out = mask.copy()
    out[1:, :] |= mask[:-1, :]; out[:-1, :] |= mask[1:, :]
    out[:, 1:] |= mask[:, :-1]; out[:, :-1] |= mask[:, 1:]
    return out


def components(mask: np.ndarray):
    """8 邻域连通域 → 外接框列表（面积降序），同 ai.seg.ts"""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    boxes = []
    for sy in range(h):
        for sx in range(w):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            q = deque([(sy, sx)]); seen[sy, sx] = True
            x0 = x1 = sx; y0 = y1 = sy; area = 0
            while q:
                cy, cx = q.popleft(); area += 1
                x0 = min(x0, cx); x1 = max(x1, cx); y0 = min(y0, cy); y1 = max(y1, cy)
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True; q.append((ny, nx))
            boxes.append({'x': x0, 'y': y0, 'w': x1 - x0 + 1, 'h': y1 - y0 + 1, 'area': area})
    return sorted(boxes, key=lambda b: -b['area'])


def merge_near(boxes, w, h):
    """中心距小于双方平均边长 0.6 倍的近邻合并（同 ai.seg.ts mergeNear）"""
    out = list(boxes)
    merged = True
    while merged and len(out) > 1:
        merged = False
        for i in range(len(out)):
            if merged: break
            for j in range(i + 1, len(out)):
                a, b = out[i], out[j]
                acx, acy = a['x'] + a['w'] / 2, a['y'] + a['h'] / 2
                bcx, bcy = b['x'] + b['w'] / 2, b['y'] + b['h'] / 2
                mw, mh = (a['w'] + b['w']) / 2, (a['h'] + b['h']) / 2
                if abs(acx - bcx) < mw * 0.6 and abs(acy - bcy) < mh * 0.6:
                    x, y = min(a['x'], b['x']), min(a['y'], b['y'])
                    out[i] = {'x': x, 'y': y,
                              'w': max(a['x'] + a['w'], b['x'] + b['w']) - x,
                              'h': max(a['y'] + a['h'], b['y'] + b['h']) - y}
                    out.pop(j); merged = True
                    break
    return out


def label_bg(image: Image.Image):
    """零训练背景差分定位（复刻 ai.seg.ts），返回原图坐标 [x, y, w, h] 列表"""
    w0, h0 = image.width, image.height
    a, w, h, k = gray_grid(image)
    bg = bg_luminance(a)
    mask = np.abs(a.astype(np.int16) - bg) >= FG_DELTA
    mask = dilate(mask)
    boxes = []
    for b in components(mask):
        frac = b['w'] * b['h'] / (w * h)
        if b['w'] < MIN_SIDE or b['h'] < MIN_SIDE or not (MIN_FRAC <= frac <= MAX_FRAC):
            continue
        boxes.append(b)
    boxes = merge_near(boxes, w, h)
    out = []
    for b in sorted(boxes, key=lambda x: -(x['w'] * x['h']))[:MAX_BOXES]:
        frac = b['w'] * b['h'] / (w * h)
        if not (MIN_FRAC <= frac <= MAX_FRAC):
            continue
        px = round(PAD_PCT * max(b['w'], b['h']))
        x = max(0, int((b['x'] - px) / k)); y = max(0, int((b['y'] - px) / k))
        bw = min(w0 - x, int(np.ceil((b['w'] + 2 * px) / k)))
        bh = min(h0 - y, int(np.ceil((b['h'] + 2 * px) / k)))
        if bw > 4 and bh > 4:
            out.append([x, y, bw, bh])
    return out


_world = None

def label_auto(image: Image.Image):
    """YOLO-World 开放词汇检测预标注（ultralytics），返回原图坐标 [x, y, w, h] 列表"""
    global _world
    if _world is None:
        from ultralytics import YOLO
        _world = YOLO('yolov8s-worldv2.pt')   # 首次自动下载（约 12MB）
        _world.set_classes(['product', 'bottle', 'box', 'snack', 'goods'])
    r = _world.predict(np.asarray(image.convert('RGB')), conf=0.25, verbose=False)[0]
    out = []
    for b in r.boxes:
        x1, y1, x2, y2 = [float(v) for v in b.xyxy[0]]
        out.append([int(x1), int(y1), int(x2 - x1), int(y2 - y1)])
    return out


def main():
    ap = argparse.ArgumentParser(description='ai_samples → YOLO 检测数据集（单类商品）')
    ap.add_argument('--labeler', choices=['bg', 'auto'], default='auto', help='自动标注器：bg=背景差分（离线），auto=YOLO-World（推荐）')
    ap.add_argument('--out', default='dataset', help='输出目录')
    ap.add_argument('--limit', type=int, default=5000, help='最多导出样本张数')
    ap.add_argument('--min-box', type=int, default=0, help='每图至少需要的目标框数（不足则跳过该图；0=负样本也保留）')
    ap.add_argument('--split', default='8:1:1', help='train:val:test 划分比例（样本 <100 时自动 8:2:0）')
    ap.add_argument('--no-reviewed', action='store_true', help='忽略标注审核台的人工校正框，全部重新自动标注')
    ap.add_argument('--seed', type=int, default=42, help='划分随机种子（固定可复现）')
    args = ap.parse_args()

    uploads = Path(os.environ.get('AI_UPLOADS_DIR') or Path(__file__).resolve().parents[1] / 'public' / 'uploads')
    out = Path(args.out)
    for split in ('train', 'val', 'test'):
        (out / 'images' / split).mkdir(parents=True, exist_ok=True)
        (out / 'labels' / split).mkdir(parents=True, exist_ok=True)

    conn = psycopg2.connect(DEFAULT_DSN)
    rows = None
    with conn.cursor() as cur:
        cur.execute(
            """SELECT s.id, s.image_path, s.annotation FROM ai_samples s
                WHERE s.status IN ('已审核','已入库') AND s.image_path LIKE '/uploads/%'
                ORDER BY s.id DESC LIMIT %s""", (args.limit,))
        rows = cur.fetchall()
    conn.close()

    # 数据划分（固定种子可复现；小样本自动 8:2:0 保证 val 有图）
    import random
    rng = random.Random(args.seed)
    rows = list(rows)
    rng.shuffle(rows)
    n = len(rows)
    try:
        tr, va, te = [max(0, int(x)) for x in args.split.split(':')]
    except ValueError:
        tr, va, te = 8, 1, 1
    if n < 100 and te > 0:
        tr, va, te = 8, 2, 0
    ratio_sum = max(1, tr + va + te)
    n_train = n * tr // ratio_sum
    n_val = n * va // ratio_sum
    split_of = {}
    for i, r in enumerate(rows):
        split_of[r[0]] = 'train' if i < n_train else ('val' if i < n_train + n_val else 'test')

    labeler = label_auto if args.labeler == 'auto' else label_bg
    ok = neg = skip = 0; boxes_total = 0; reviewed_cnt = 0
    for sid, ipath, ann in rows:
        rel = str(ipath).replace('/uploads/', '').replace('\\', '/')
        f = uploads / rel
        if not f.is_file():
            skip += 1; continue
        try:
            image = Image.open(f)
            image.load()
        except Exception:
            skip += 1; continue
        # 人工校正框优先（标注审核台保存过即直接采用）
        boxes = None
        if not args.no_reviewed and isinstance(ann, dict):
            marked = str(ann.get('labelReviewed', '')).lower() == 'true' or ann.get('labelReviewed') is True
            raw = ann.get('boxes')
            if marked and isinstance(raw, list):
                boxes = [[int(b['x']), int(b['y']), int(b['w']), int(b['h'])]
                         for b in raw if isinstance(b, dict) and int(b.get('w', 0)) > 4 and int(b.get('h', 0)) > 4]
                reviewed_cnt += 1
        if boxes is None:
            try:
                boxes = labeler(image)
            except Exception as e:
                print(f'[warn] 标注失败 #{sid}: {e}'); skip += 1; continue
        if len(boxes) < args.min_box:
            skip += 1; continue
        w0, h0 = image.width, image.height
        split = split_of.get(sid, 'train')
        stem = f'{sid}'
        image.convert('RGB').save(out / 'images' / split / f'{stem}.jpg', quality=92)
        lines = []
        for (x, y, bw, bh) in boxes:
            xc, yc = (x + bw / 2) / w0, (y + bh / 2) / h0
            lines.append(f'0 {xc:.6f} {yc:.6f} {bw / w0:.6f} {bh / h0:.6f}')
            boxes_total += 1
        (out / 'labels' / split / f'{stem}.txt').write_text('\n'.join(lines), encoding='utf-8')
        if lines: ok += 1
        else: neg += 1

    yaml = ("path: dataset\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n  0: 商品\n"
            if any((out / 'images' / 'test').iterdir())
            else "path: dataset\ntrain: images/train\nval: images/val\nnames:\n  0: 商品\n")
    (out / 'data.yaml').write_text(yaml, encoding='utf-8')
    print(f'导出完成：有效图 {ok} 张（目标框 {boxes_total} 个，人工校正 {reviewed_cnt} 张），负样本/背景图 {neg} 张，跳过 {skip} 张')
    print(f'划分：train {n_train} / val {n_val} / test {n - n_train - n_val}（比例 {args.split}）')
    print(f'数据集目录：{out.resolve()}')
    print('下一步：python train_detect.py --data dataset/data.yaml')


if __name__ == '__main__':
    main()
