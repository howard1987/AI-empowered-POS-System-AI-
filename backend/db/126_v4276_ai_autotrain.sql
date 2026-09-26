-- 102 · V4.27.6 AI 自动训练（把"每周手动跑三步脚本"变成系统设置里的自动任务）
-- 前置（一次性，服务器上）：NVIDIA 显卡 + CUDA 版 PyTorch + pip install -r backend/ai-train/requirements.txt
-- 默认全部关闭：打开 ai.autotrain.enabled 后，调度器按周计划在收银闲时自动训练。
INSERT INTO system_settings (group_name, setting_key, display_name, value, default_value, value_type, remark) VALUES
('AI赋能','ai.autotrain.enabled','自动训练开关','false','false','bool','开=按周计划自动执行：导出数据集→GPU训练→导入模型库（默认不自动激活，训练台确认后手动激活）'),
('AI赋能','ai.autotrain.day_of_week','自动训练星期','0','0','number','0=周日 1=周一 … 6=周六（建议收银闲时的凌晨）'),
('AI赋能','ai.autotrain.hour','自动训练小时','2','2','number','0~23，到点触发（建议 2，即凌晨 2 点）'),
('AI赋能','ai.autotrain.min_samples','最低样本量','30','30','number','已入库样本少于该值时自动跳过本次训练（避免无效训练）'),
('AI赋能','ai.autotrain.epochs','训练轮数','60','60','number','自动训练的 epochs（样本多可适当调大）'),
('AI赋能','ai.autotrain.model','训练底座','"yolo26n.pt"','"yolo26n.pt"','string','yolo26n.pt / yolo11n.pt / yolov8n.pt'),
('AI赋能','ai.autotrain.python','Python 命令','"python"','"python"','string','服务器上可用的 python 命令（或完整路径，如 C:\\Python312\\python.exe）'),
('AI赋能','ai.autotrain.device','训练设备','0','0','number','GPU 编号 0；无 GPU 用 cpu（很慢，不建议）'),
('AI赋能','ai.autotrain.auto_activate','训练后自动激活','false','false','bool','开=新模型导入后自动激活并切换多件定位；关=训练台人工确认后激活（推荐先关）'),
('AI赋能','ai.autotrain.last_run','自动训练上次运行','null','null','json','系统自动写回（时间/阶段/结果/日志尾部），勿手工改')
ON CONFLICT (setting_key) DO NOTHING;
