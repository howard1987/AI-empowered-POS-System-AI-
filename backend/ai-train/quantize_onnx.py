# -*- coding: utf-8 -*-
"""
步骤 3/3（可选提速）· ONNX INT8 静态量化：CPU 收银机推理延迟进一步下降
==========================================================================
原理：用数据集图片做校准（CalibrationDataReader），对卷积/矩阵乘做 INT8 量化。
注意：量化后 mAP 通常有 0.5~2% 内的轻微损失，务必在验证集复测识别效果后再启用。
用法：
  python quantize_onnx.py --onnx runs/detect/product-loc/weights/best.onnx --calib_dir dataset/images/train
  # 产出 <原名>_int8.onnx；脚本会自动跑一次原模型 vs 量化模型的同图推理对比
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image


def letterbox(img: Image.Image, size=640):
    """与后端 ai.detect.ts letterbox 对齐：保比例缩放 + 灰边 (114) 填充"""
    w, h = img.width, img.height
    scale = min(size / w, size / h)
    nw, nh = round(w * scale), round(h * scale)
    img = img.convert('RGB').resize((nw, nh), Image.BILINEAR)
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    px, py = (size - nw) // 2, (size - nh) // 2
    canvas[py:py + nh, px:px + nw] = np.asarray(img)
    x = canvas.astype(np.float32) / 255.0
    x = x.transpose(2, 0, 1)[None]           # 1x3x640x640
    return x


class CalibReader:
    """onnxruntime 校准数据读取器（取数据集前 N 张图）"""

    def __init__(self, files, size=640, max_n=64):
        self.files = files[:max_n]
        self.size = size
        self.idx = 0

    def get_next(self):
        if self.idx >= len(self.files):
            return None
        f = self.files[self.idx]
        self.idx += 1
        try:
            x = letterbox(Image.open(f), self.size)
        except Exception:
            x = np.zeros((1, 3, self.size, self.size), dtype=np.float32)
        return {'images': x}   # 输入名在 reader 使用时按模型实际输入名修正（见 main）


def fix_input_name(session, reader):
    name = session.get_inputs()[0].name
    orig = reader.get_next

    def wrapped():
        d = orig()
        if d is None:
            return None
        return {name: list(d.values())[0]}
    reader.get_next = wrapped
    return reader


def run_once(sess, img: Image.Image):
    x = letterbox(img)
    out = sess.run(None, {sess.get_inputs()[0].name: x})
    o = out[0]
    return float(np.asarray(o).max()), np.asarray(o).shape


def main():
    ap = argparse.ArgumentParser(description='YOLO ONNX INT8 静态量化')
    ap.add_argument('--onnx', required=True, help='训练导出的 best.onnx')
    ap.add_argument('--calib_dir', default='dataset/images/train', help='校准图片目录（数据集即可）')
    ap.add_argument('--n', type=int, default=64, help='校准图片张数')
    args = ap.parse_args()

    import onnxruntime as ort
    from onnxruntime.quantization import CalibrationMethod, QuantType, quantize_static
    from onnxruntime.quantization import CalibrationDataReader as _R  # noqa: F401

    src = Path(args.onnx)
    dst = src.with_name(src.stem + '_int8.onnx')
    files = sorted([p for p in Path(args.calib_dir).glob('*.jpg')] +
                   [p for p in Path(args.calib_dir).glob('*.png')])
    if not files:
        raise SystemExit(f'校准目录无图片：{args.calib_dir}（先运行 export_dataset.py）')

    so = ort.SessionOptions()
    ref = ort.InferenceSession(str(src), so, providers=['CPUExecutionProvider'])

    reader = fix_input_name(ref, CalibReader(files, max_n=args.n))
    quantize_static(
        str(src), str(dst), reader,
        quant_format='QDQ',
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        calibrate_method=CalibrationMethod.MINMAX,
        per_channel=True,
    )

    # 同图对比：原模型 vs 量化模型（粗校验，确信量化未破坏输出结构）
    probe = files[0]
    img = Image.open(probe)
    q = ort.InferenceSession(str(dst), so, providers=['CPUExecutionProvider'])
    m_ref, s_ref = run_once(ref, img)
    m_q, s_q = run_once(q, img)
    import os
    print(f'量化完成：{dst}')
    print(f'体积：{src.stat().st_size / 1e6:.1f}MB → {dst.stat().st_size / 1e6:.1f}MB')
    print(f'同图输出对比：原 max={m_ref:.4f} shape={s_ref} | 量化 max={m_q:.4f} shape={s_q}')
    if s_ref != s_q:
        print('⚠ 输出维度不一致：该模型量化后结构变化，请勿使用量化版（用原版 best.onnx）')
    else:
        print('✔ 结构一致。导入训练台前请在验证集复测识别效果（INT8 通常有轻微 mAP 损失）')


if __name__ == '__main__':
    main()
