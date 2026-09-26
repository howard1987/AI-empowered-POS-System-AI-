-- 138 · V4.28.7 临期档位备注改为"区间归属"表述（行为不变，仅文案校准）
UPDATE system_settings SET remark='临期N天自动按档位折价：[{"days":剩余天数上限,"pct":售价百分数}]（pct 80=8折）。按剩余保质期落入的区间匹配档位（天数从小到大，命中第一个 剩余天数≤days 的档），越临期折越深；超出全部档位不折扣。收银自动折扣（promo.expiry_auto.enabled 开启时）与 AI 临期调价建议共用此档位' WHERE setting_key='promo.expiry_auto_discount';
