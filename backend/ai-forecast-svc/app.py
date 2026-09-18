# -*- coding: utf-8 -*-
"""
V4.13 ⑥ 销量预测 LightGBM 微服务（ai-forecast-svc）
  能力全景 3.1：方案的 Prophet+LightGBM 混合是「数据攒够后的自然升级」。
  本服务为升级通道：功能常备、默认不启用（后端设置 ai.forecast.engine=baseline）。
  启用条件（后端自动把关）：
    1) ai.forecast.engine = 'lgbm'
    2) 全店累计有流水天数 ≥ ai.forecast.lgbm.min_days（默认 56 天，8 周起步防过拟合）
    3) 本服务可达（ai.forecast.lgbm.url，默认 http://localhost:9101）
  任一条件不满足，后端自动回落 baseline 规则引擎，本链路永不阻断预测主流程。

  接口：
    GET  /health   → {ok, model: 'lightgbm'|'fallback-avg', version}
    POST /predict  → {horizonDays, series:[{productId,date,qty}]}
                   ← {model, predictions:[{productId,horizonDate,qty,confidence}]}

  训练策略（免维护、随请求增量拟合）：
    每商品构造滞后特征（lag1/3/7、7/14 日均值、星期几）→ LightGBM 回归逐商品 fit；
    样本 <14 天的商品退回「星期基准 × 近 14 日趋势」fallback（与后端 baseline 同构，保证有输出）。

  启动：pip install -r requirements.txt && uvicorn app:app --host 127.0.0.1 --port 9101
"""
from __future__ import annotations
from datetime import date, timedelta
from typing import Dict, List, Optional
from collections import defaultdict

try:
    import lightgbm as lgb
    HAS_LGBM = True
except Exception:
    HAS_LGBM = False

from fastapi import FastAPI

app = FastAPI(title="pos-ai-forecast-svc", version="1.0.0")
MODEL_TAG = "lightgbm" if HAS_LGBM else "fallback-avg"


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_TAG, "version": "1.0.0"}


def _build_features(rows: List[dict]) -> Dict[int, Dict[date, float]]:
    """按商品聚合日销序列 {pid: {date: qty}}（缺省日补 0 到连续序列）"""
    by_prod: Dict[int, Dict[date, float]] = defaultdict(dict)
    for r in rows:
        d = r["date"]
        if isinstance(d, str):
            d = date.fromisoformat(d[:10])
        by_prod[int(r["productId"])][d] = float(r.get("qty") or 0)
    out: Dict[int, Dict[date, float]] = {}
    for pid, m in by_prod.items():
        ds = sorted(m.keys())
        if not ds:
            continue
        seq: Dict[date, float] = {}
        cur = ds[0]
        while cur <= ds[-1]:
            seq[cur] = m.get(cur, 0.0)
            cur += timedelta(days=1)
        out[pid] = seq
    return out


def _lag(seq: Dict[date, float], d: date, lag: int) -> float:
    return seq.get(d - timedelta(days=lag), 0.0)


def _avg(seq: Dict[date, float], d: date, win: int) -> float:
    vals = [seq.get(d - timedelta(days=i), 0.0) for i in range(1, win + 1)]
    return sum(vals) / win


def _predict_prod_lgbm(seq: Dict[date, float], horizon: int) -> Optional[List[dict]]:
    """单商品 LightGBM：滞后特征 → 未来 horizon 天；样本不足返回 None（调用方回落）"""
    ds = sorted(seq.keys())
    if len(ds) < 14 or not HAS_LGBM:
        return None
    X, y = [], []
    for d in ds:
        if min(_avg(seq, d, 7), 1e9) == 0 and all(seq[x] == 0 for x in ds if x < d):
            pass  # 冷启动期样本也保留（特征全 0 → 预测趋 0，可接受）
        X.append([_lag(seq, d, 1), _lag(seq, d, 3), _lag(seq, d, 7),
                  _avg(seq, d, 7), _avg(seq, d, 14), d.weekday()])
        y.append(seq[d])
    reg = lgb.LGBMRegressor(n_estimators=120, learning_rate=0.08, num_leaves=15,
                            min_child_samples=5, verbose=-1)
    reg.fit(X, y)
    out = []
    last = ds[-1]
    for i in range(1, horizon + 1):
        d = last + timedelta(days=i)
        feats = [[_lag(seq, d, 1) if d - timedelta(days=1) in seq else seq[ds[-1]],
                  _lag(seq, d, 3), _lag(seq, d, 7), _avg(seq, d, 7), _avg(seq, d, 14), d.weekday()]]
        pred = max(0.0, float(reg.predict(feats)[0]))
        # 置信度代理：近 14 日变异系数越小越可信
        recent = [seq.get(d - timedelta(days=k), 0.0) for k in range(1, 15)]
        mean = sum(recent) / 14
        var = sum((v - mean) ** 2 for v in recent) / 14
        cv = (var ** 0.5) / mean if mean > 0 else 2.0
        conf = max(0.3, min(0.99, 1.0 - cv / 2))
        out.append({"date": d, "qty": round(pred, 3), "confidence": round(conf, 3)})
    return out


def _predict_prod_baseline(seq: Dict[date, float], horizon: int) -> List[dict]:
    """星期基准 × 近 14 日趋势（与后端 baseline 引擎同构；样本不足时的保底输出）"""
    ds = sorted(seq.keys())
    wd_sum, wd_cnt = [0.0] * 7, [0] * 7
    for d, q in seq.items():
        wd_sum[d.weekday()] += q
        wd_cnt[d.weekday()] += 1
    wd_avg = [wd_sum[i] / wd_cnt[i] if wd_cnt[i] else 0.0 for i in range(7)]
    mean = sum(seq.values()) / max(1, len(seq))
    recent = [seq.get(ds[-1] - timedelta(days=k), 0.0) for k in range(14)]
    prev = [seq.get(ds[-1] - timedelta(days=k), 0.0) for k in range(14, 28)]
    avg7 = sum(recent) / 14
    avg14 = sum(prev) / 14 if any(prev) else avg7
    trend = max(0.5, min(1.5, avg7 / avg14)) if avg14 > 0 else 1.0
    out = []
    last = ds[-1]
    for i in range(1, horizon + 1):
        d = last + timedelta(days=i)
        base = wd_avg[d.weekday()] if wd_cnt[d.weekday()] else mean
        pred = max(0.0, base * trend)
        out.append({"date": d, "qty": round(pred, 3), "confidence": 0.6})
    return out


@app.post("/predict")
def predict(body: dict):
    horizon = int(body.get("horizonDays") or 7)
    series = body.get("series") or []
    by_prod = _build_features(series)
    predictions = []
    used_lgbm = 0
    for pid, seq in by_prod.items():
        res = _predict_prod_lgbm(seq, horizon)
        if res is None:
            res = _predict_prod_baseline(seq, horizon)
        else:
            used_lgbm += 1
        for r in res:
            predictions.append({"productId": pid, "horizonDate": r["date"].isoformat(),
                                "qty": r["qty"], "confidence": r["confidence"]})
    model = "lightgbm" if used_lgbm > 0 and HAS_LGBM else "fallback-avg"
    return {"model": model, "count": len(by_prod), "predictions": predictions}
