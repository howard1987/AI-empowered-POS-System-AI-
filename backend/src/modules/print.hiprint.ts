/**
 * hiprint 模板 JSON → v2 排版元素转换（V4.15.9 可视化编辑器内核为 vue-plugin-hiprint）
 *   - hiprint 坐标单位 pt（1mm = 72/25.4 pt），面板宽高为 mm
 *   - text(+field/testData) → text/field；textType barcode/qrcode → barcode/qrcode；
 *     hline → divider；rect/oval → rect；table → items（明细）；image/vline/html 热敏不支持 → 忽略
 *   - 与前端 layout-editor.js 的 hip2els 同逻辑（前端供 PWA 小票/设计器，后端供标签渲染/预览）
 */
import { LayoutEl } from './print.label';

const PT = 72 / 25.4;
const pt2mm = (v: any) => Math.round(((Number(v) || 0) / PT) * 100) / 100;

export type HipDoc = { version?: number; title?: string; hp?: any; paper?: { wmm: number; hmm: number }; elements?: LayoutEl[] };

let uid = 0;
const nid = () => 'e' + (++uid) + Math.random().toString(36).slice(2, 6);

/** 归一化：v3(hiprint) → v2 elements；v2 原样；返回 null=无法识别 */
export function normalizeLayoutDoc(content: any): { paper?: { wmm: number; hmm: number }; elements: LayoutEl[] } | null {
  if (!content || typeof content !== 'object') return null;
  if (content.version === 2 && Array.isArray(content.elements)) {
    return { paper: content.paper, elements: content.elements as LayoutEl[] };
  }
  if (content.version === 3 && content.hp) {
    const hp = content.hp;
    const panel = Array.isArray(hp?.panels) ? hp.panels[0] : null;
    if (!panel) return null;
    const paper = {
      wmm: Math.max(10, Math.round(Number(panel.width) || 40)),
      hmm: Math.max(10, Math.round(Number(panel.height) || 30)),
    };
    const elements: LayoutEl[] = [];
    for (const pe of (panel.printElements || [])) {
      const o = (pe && pe.options) || {};
      const t = ((pe && pe.printElementType) || {}).type || '';
      const base = { id: nid(), x: pt2mm(o.left), y: pt2mm(o.top), w: pt2mm(o.width), h: pt2mm(o.height), show: true };
      if (t === 'hline') elements.push({ ...base, type: 'divider', h: 0.4 });
      else if (t === 'rect' || t === 'oval') elements.push({ ...base, type: 'rect', th: 0.3 });
      else if (t === 'barcode') elements.push({ ...base, type: 'barcode', key: o.field || 'barcode' });
      else if (t === 'qrcode') elements.push({ ...base, type: 'qrcode', key: o.field || 'barcode' });
      else if (t === 'table') elements.push({ ...base, type: 'items', h: Math.max(base.h, 10) });
      else if (t === 'text' || t === 'longText' || t === 'customText') {
        if (o.textType === 'barcode') elements.push({ ...base, type: 'barcode', key: o.field || 'barcode' });
        else if (o.textType === 'qrcode') elements.push({ ...base, type: 'qrcode', key: o.field || 'barcode' });
        else {
          const el: any = { ...base, type: o.field ? 'field' : 'text',
            fontSize: Math.max(1.5, pt2mm(o.fontSize || 6.75)),
            align: o.textAlign === 'center' ? 'center' : o.textAlign === 'right' ? 'right' : 'left',
            bold: ['bold', '600', '700'].includes(String(o.fontWeight)) };
          if (o.field) el.key = o.field; else el.text = o.title || o.testData || '';
          elements.push(el);
        }
      }
      // image/vline/html：热敏不支持，忽略
    }
    return { paper, elements };
  }
  return null;
}
