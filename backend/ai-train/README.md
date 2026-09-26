# AI 商品检测训练包（借鉴 ultralytics · V4.27.0）

用 [ultralytics](https://github.com/ultralytics/ultralytics)（YOLO 系）在 GPU 服务器上训练**单类「商品」检测模型**，
替换多件识别原先的零训练轮廓分割（`ai.seg.ts`），并对识别结果做多帧跟踪平滑。

> 许可说明：ultralytics 为 AGPL-3.0，本项目非商用场景使用不受影响；若未来商用需购企业授权。

## 训练闭环总览

```
收银识别 ──纠正回传/随手拍──▶ ai_samples 样本库（店长审核入库）
                                    │
              步骤1 export_dataset.py│（自动标注：YOLO-World 或 背景差分）
                                    ▼
                        YOLO 检测数据集（单类「商品」）
                                    │ 步骤2 train_detect.py（GPU 训练）
                                    ▼
                        best.onnx ──(可选)──▶ best_int8.onnx
                                    │ 步骤3 训练台「模型管理」导入
                                    ▼
             后台设置 ai.seg.model_id = 模型 id → 多件识别启用 YOLO 定位
```

## 环境准备（GPU 服务器）

```bash
# Python ≥ 3.9；按 CUDA 版本装 GPU 版 PyTorch（示例 CUDA 12.1）
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt
```

数据库与图片目录（默认值如下，可用环境变量覆盖）：
- `DATABASE_URL`：默认 `postgres://cashier:cashier123@localhost:5432/cashier`
- `AI_UPLOADS_DIR`：默认 `backend/public/uploads`

## 三步训练

```bash
# 1) 导出数据集（自动标注；推荐 YOLO-World，离线可用 --labeler bg）
python export_dataset.py --labeler auto --limit 5000

# 2) GPU 训练 + 导出 ONNX（显存小用 --batch 8；无 GPU 加 --device cpu）
python train_detect.py --data dataset/data.yaml --model yolo11n.pt --epochs 80 --batch 16

# 3)（可选）INT8 量化提速（CPU 推理延迟下降；启用前务必复测识别效果）
python quantize_onnx.py --onnx runs/detect/product-loc/weights/best.onnx --calib_dir dataset/images/train
```

## 部署启用

1. 后台「AI 训练台 → 模型管理」导入 `best.onnx`（或量化版）：
   - mode=`detect`，classes=`{"0":{"name":"商品"}}`；
   - **导入时可不激活**——激活仅影响主识别引擎（`ai.engine=yolo`），多件定位单独由下面的设置控制。
2. 后台设置（系统设置 → AI 赋能）：
   - `ai.seg.model_id` = 导入后的模型 id（0 = 回落轮廓分割，随时可回滚）；
   - `ai.seg.yolo_min_conf` = 定位框最低置信度（默认 0.25）。
3. 生效路径：`POST /ai/recognize?mode=multi` → YOLO 框出每件 → 逐件 CLIP 检索 → 三门槛判定（不变）。

## 多帧跟踪平滑（已内置，无需训练）

- 设置项：`ai.track.enabled`（默认开）、`ai.track.stable_frames`（默认连续 2 帧）。
- 识别结果新增字段：`trackStable`（连续 N 帧同品命中）、`trackHits`、`trackConf`（EMA 平滑置信度）。
- 只做标注辅助（店员信心 / 前端可据此免重复播报），**不改变三门槛命中判定**（融合分只排序铁律不变）。

## 文件说明

| 文件 | 用途 |
|---|---|
| `export_dataset.py` | ai_samples → YOLO 检测数据集（内置两种自动标注器） |
| `train_detect.py` | GPU 训练 + ONNX 导出（含防过拟合增广参数） |
| `quantize_onnx.py` | INT8 静态量化（含原模型 vs 量化版同图校验） |
| `requirements.txt` | Python 依赖 |
