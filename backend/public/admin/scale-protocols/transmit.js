// 传秤下发核心：被「生鲜管理」「调价管理·一键传秤」复用，单一数据源
// 负责：中文化秤名(GBK/GB2312) → 组帧 → 串口 Web Serial / 网口 TCP 实际下发 → 写下发日志 → 进度回调
import { post, must } from '../api.js';
import { ScaleSerial } from './serial.js';
import { getProtocol } from './index.js';

/**
 * 把一组商品按 config 编码为秤帧并实际下发。
 * @param {Array} items 需含：id, name, short_name, sell_price, member_price, goods_no, barcode,
 *                          scale_plu_code?, scale_department?, base_unit?, is_weighted?
 * @param {Object} cfg  传秤配置（见 GET /scale-transmission/config）：protocol/portType/port/baud/tcpHost/tcpPort/department/barcodePrefix/useMemberPrice/charset
 * @param {Object} [hooks] { onStart(msg), onProgress(msg,isErr), onFinish(ok,fail) }
 * @returns {Promise<{ok,fail,detail,total}>}
 */
export async function transmitScaleItems(items, cfg, hooks = {}) {
  if (!Array.isArray(items) || !items.length) return { ok: 0, fail: 0, detail: [], total: 0 };
  const proto = getProtocol(cfg.protocol || 'dahua');
  const charset = String(cfg.charset || 'gbk').toLowerCase();
  const onProgress = (m, e) => { try { hooks.onProgress && hooks.onProgress(m, e); } catch { /* noop */ } };
  if (hooks.onStart) try { hooks.onStart(`协议：${proto.name} · 秤端编码：${charset.toUpperCase()} · 共 ${items.length} 条`); } catch { /* noop */ }

  // 中文化秤名：一次性向后端取 GBK/GB2312 字节表，串口与网口共用
  const nameMap = {};
  if (charset === 'gbk' || charset === 'gb2312') {
    try {
      const names = [...new Set(items.map(it => String(it.short_name || it.name || '')))];
      const res = await must(post('/scale-transmission/encode-names', { charset, names }));
      (res.bytes || []).forEach((b, i) => { nameMap[names[i]] = new Uint8Array(b); });
    } catch (e) {
      onProgress('中文名编码失败，本次回退为英文：' + (e.message || e), true);
    }
  }
  const optsOf = it => ({ nameBytes: nameMap[String(it.short_name || it.name || '')] });
  const serial = new ScaleSerial();
  let ok = 0, fail = 0;
  const detail = [];
  try {
    if (cfg.portType === 'tcp') {
      // 网口：前端组帧 → 服务端 TCP 逐帧下发
      const frames = [];
      for (let i = 0; i < items.length; i++) {
        const { bytes, preview } = proto.encodePlu(items[i], cfg, optsOf(items[i]));
        frames.push(Array.from(bytes));
        onProgress(`组帧 [${i + 1}/${items.length}] ${items[i].name} → ${String(preview).slice(0, 44)}`);
      }
      onProgress(`正在连接 ${cfg.tcpHost}:${cfg.tcpPort} …`);
      const res = await must(post('/scale-transmission/transmit-tcp', {
        host: cfg.tcpHost, port: cfg.tcpPort, frames, interDelay: 60,
      }));
      for (const d of (res.detail || [])) {
        const it = items[d.index];
        if (d.status === 'ok') {
          ok++;
          onProgress(`[${d.index + 1}/${items.length}] ${it?.name} 已下发 ${d.bytes} 字节${d.resp ? ' · 回应 ' + d.resp : ''}`);
        } else {
          fail++;
          onProgress(`[${d.index + 1}/${items.length}] ${it?.name} 失败：${d.msg}`, true);
        }
        detail.push({ productId: it?.id, name: it?.name, status: d.status, bytes: d.bytes, resp: d.resp, msg: d.msg });
      }
    } else {
      // 串口：优先已授权端口（免每次弹窗），否则弹一次选择器
      let port = null;
      try { const gp = await ScaleSerial.getGrantedPorts(); if (gp.length) port = gp[0]; } catch { /* noop */ }
      if (!port) {
        try { port = await navigator.serial.requestPort(); }
        catch (e) { onProgress('未选择串口，已取消传秤', true); return { ok, fail, detail, total: items.length }; }
      }
      await serial.connect({ port, baudRate: cfg.baud });
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const { bytes, preview } = proto.encodePlu(it, cfg, optsOf(it));
        try {
          await serial.write(bytes);
          onProgress(`[${i + 1}/${items.length}] ${it.name} → ${preview}`);
          await new Promise(r => setTimeout(r, 80)); // 部分秤需要行间隔
          ok++;
          detail.push({ productId: it.id, name: it.name, status: 'ok', preview });
        } catch (err) {
          fail++;
          onProgress(`[${i + 1}/${items.length}] ${it.name} 失败：${err.message}`, true);
          detail.push({ productId: it.id, name: it.name, status: 'fail', msg: err.message });
        }
      }
    }
  } finally {
    try { await serial.disconnect(); } catch { /* noop */ }
  }
  // 写下发日志（失败忽略）
  try {
    await post('/scale-transmission/logs', {
      taskNo: 'TX' + new Date().toISOString().slice(0, 19).replace(/[-T:]/g, ''),
      protocol: cfg.protocol, portType: cfg.portType,
      portPath: cfg.portType === 'serial' ? cfg.port : `${cfg.tcpHost}:${cfg.tcpPort}`,
      totalCount: items.length, okCount: ok, failCount: fail, detail, status: 'done',
    });
  } catch { /* noop */ }
  if (hooks.onFinish) try { hooks.onFinish(ok, fail); } catch { /* noop */ }
  return { ok, fail, detail, total: items.length };
}
