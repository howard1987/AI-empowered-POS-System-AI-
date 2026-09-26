# -*- coding: utf-8 -*-
"""
步骤 2/3 · 训练单类「商品」检测模型（GPU）→ 导出 ONNX
==========================================================================
产物用途（对应系统设置）：
  ① 多件识别定位（推荐）：后台设置 ai.seg.model_id = 导入后的模型 id
     → 多件识别不再用轮廓分割，改用本模型框出每件商品，任意背景/光照/堆叠都鲁棒；
  ② 亦可作为主识别引擎：训练台导入（mode=detect，classes={"0":{"name":"商品"}}）后 ai.engine 切 yolo。
模型说明：默认 YOLO26（端到端 NMS-free，ONNX 输出 [1,300,6]，后端已支持该格式解析）；
  如需回退 YOLO11/YOLOv8（输出 [1,4+nc,N]，同样支持），--model yolo11n.pt / yolov8n.pt。

用法（在装有 NVIDIA 显卡的服务器上）：
  # 1) 先装 GPU 版 PyTorch（按 CUDA 版本选一）：
  #    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
  # 2) pip install ultralytics
  python train_detect.py --data dataset/data.yaml --model yolo26n.pt --epochs 80 --batch 16
  # 显存小（4-6GB）用 --batch 8；无 GPU 加 --device cpu（慢）
输出：
  runs/detect/<name>/weights/best.onnx  → 训练台「模型管理」导入（base64），激活后生效
"""
import argparse
import shutil
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description='单类商品检测训练（ultralytics）+ ONNX 导出')
    ap.add_argument('--data', default='dataset/data.yaml', help='数据集 yaml（export_dataset.py 产出）')
    ap.add_argument('--model', default='yolo26n.pt', help='预训练底座：yolo26n.pt（端到端 NMS-free，推荐）/ yolo11n.pt / yolov8n.pt')
    ap.add_argument('--epochs', type=int, default=80)
    ap.add_argument('--imgsz', type=int, default=640, help='与后端 letterbox 640 对齐，勿随意改小')
    ap.add_argument('--batch', type=int, default=16, help='GPU 显存不足时降到 8')
    ap.add_argument('--device', default='0', help='GPU 编号 0/0,1；无 GPU 用 cpu')
    ap.add_argument('--name', default='product-loc', help='实验名（runs/detect/<name>）')
    args = ap.parse_args()

    from ultralytics import YOLO

    model = YOLO(args.model)   # 首次自动下载预训练权重；离线可提前放到本目录
    results = model.train(
        data=args.data,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        name=args.name,
        # 小数据集防过拟合：
        patience=20,
        hsv_h=0.015, hsv_s=0.6, hsv_v=0.4,   # 光照/色调增广（收银台光照变化常见）
        fliplr=0.5,
        mosaic=1.0, close_mosaic=10,          # Mosaic 拼接：隐式构造多商品同框构图（防多件翻车）
        erasing=0.2,                          # 随机擦除：轻度遮挡鲁棒
        degrees=10.0, translate=0.1, scale=0.5, shear=2.0,   # 几何增广：拍摄角度/位置抖动
        perspective=0.0005,                   # 轻透视：手机俯拍倾斜
        verbose=True,
    )
    m = model.metrics  # results.box 映射
    try:
        map50 = round(float(m.box.map50), 4)
        map5095 = round(float(m.box.map), 4)
    except Exception:
        map50 = map5095 = None

    # 导出 ONNX（与后端 onnxruntime-node 对齐；opset 12 稳定）
    onnx_path = model.export(format='onnx', imgsz=args.imgsz, opset=12, dynamic=False, simplify=True)
    onnx_path = Path(onnx_path)
    print('\n================ 训练完成 ================')
    print(f'mAP50: {map50}   mAP50-95: {map5095}')
    print(f'ONNX 模型：{onnx_path.resolve()}')
    print('下一步：')
    print('  1) （可选提速）python quantize_onnx.py --onnx "%s" --calib_dir dataset/images/train' % onnx_path)
    print('  2) 后台「AI 训练台 → 模型管理」导入该 ONNX（mode=detect，classes={"0":{"name":"商品"}}）')
    print('  3) 后台设置 ai.seg.model_id = 导入后的模型 id → 多件识别即用 YOLO 定位')
    print('     （导入时未激活不影响多件定位；激活仅影响主识别引擎 ai.engine=yolo）')


if __name__ == '__main__':
    main()
