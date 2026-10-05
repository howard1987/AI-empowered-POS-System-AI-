/* 全站表格「按列语义」数据对齐（V5.0.8）：
 *  · 单号 / 批次 / 状态 / 日期 / 时间 / 类型 等「列数据长度基本一致」的列 → 数据居中
 *  · 金额 / 数量 / 单价 等数值列 → 数据居右
 * 规则：读每个 <th> 的表头文案判定该列语义，只给 tbody/tfoot 的 <td> 打标（表头沿用全局居中）。
 * 尊重单元格内联 text-align（内联优先级更高，不会被覆盖），故不破坏个别屏的刻意排版。
 *
 * 性能与交互（V5.0.8a 修复「双击行弹明细」失效）：
 *  此前用 MutationObserver 对 document.body 全量重扫，任何 DOM 变化（含弹窗打开、行内渲染）
 *  都会 scan() 遍历全站表格并写 td.classList，持续重排抢占事件处理，
 *  导致 tr 的 dblclick 在两次点击之间被重排打断而失焦。
 *  现改为：① 初始全站扫一次，之后只扫「新增到 DOM 的节点」，不做全站盲扫；
 *        ② 处理过的表打 __calDone 标记，绝不重复处理；
 *        ③ 只在状态不符时增删 class，避免无谓 DOM 写入。 */
(function () {
  'use strict';

  // 数值列（居右）：命中即优先判定
  var RIGHT = ['金额', '数量', '单价', '总价', '费用', '余额', '合计', '应付', '应收', '成本', '毛利',
    '优惠', '找零', '实付', '已付', '已收', '收入', '支出', '库存', '重量', '进价', '售价', '定价',
    '税额', '退款', '货值', '客单价', '市值', '欠款', '未付', '抹零'];
  // 短文本/编码列（居中）：长度一致的列
  var CENTER = ['单号', '单据', '编号', '批号', '批次', '状态', '日期', '时间', '类型', '方向', '方式',
    '单位', '序号', '性别', '等级', '编码', '代号',
    '预计到货', '到货', '来源', '范围', '行数', '制单', '备注', '部门', '秤内码', '生鲜码', '条码', '规格',
    '到期日', '渠道', '会员', '收银员', '班次', 'POS', '开班', '关班', '联系人', '电话', '台号', '对象',
    '周期', '贡献', '频次', '偏好', '最近消费', 'ID', '大类', '名称', '天气', '气温', '降水', '域',
    '原因', '决定人', '样本', '大小', '族', '量化', '工号', '账户', '姓名', '手机', '授权', '登录', '签名'];
  // 明显是长文本的表头，即便含关键词也不居中（如「使用说明」）
  var LONG = ['说明', '描述', '标题', '摘要', '内容', '地址'];

  function hasAny(text, arr) {
    for (var i = 0; i < arr.length; i++) if (text.indexOf(arr[i]) >= 0) return true;
    return false;
  }

  function alignOf(headerText) {
    var t = String(headerText || '').replace(/\s+/g, '');
    if (!t) return '';
    if (hasAny(t, RIGHT)) return 'tar';
    if (hasAny(t, LONG)) return '';
    if (hasAny(t, CENTER)) return 'tac';
    return '';
  }

  function processTable(tb) {
    if (tb.__calDone) return;               // 已处理过，绝不重复（保交互、防重排）
    var head = tb.tHead;
    if (!head || !head.rows.length) return;
    var hrow = head.rows[0];
    var n = hrow.cells.length;
    var map = [];
    var any = false;
    for (var i = 0; i < n; i++) { map[i] = alignOf(hrow.cells[i].textContent); if (map[i]) any = true; }
    if (!any) { tb.__calDone = true; return; }
    var parts = [];
    for (var b = 0; b < tb.tBodies.length; b++) parts.push(tb.tBodies[b]);
    if (tb.tFoot) parts.push(tb.tFoot);
    for (var p = 0; p < parts.length; p++) {
      var rows = parts[p].rows;
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].cells;
        // 合并单元格的行（空态/合计提示）跳过，避免列错位
        var span = 0;
        for (var s = 0; s < cells.length; s++) span += cells[s].colSpan || 1;
        if (span !== n) continue;
        for (var c = 0; c < cells.length; c++) {
          var want = map[c] || '';
          var td = cells[c];
          var cl = td.classList;
          var other = want === 'tac' ? 'tar' : 'tac';
          // 仅在状态不符时增删（幂等、不触发无谓重排）
          if (want && !cl.contains(want)) { cl.add(want); }
          if (cl.contains(other)) { cl.remove(other); }
        }
      }
    }
    tb.__calDone = true;
  }

  // 增量扫描：只处理 root 自身（若为 table）与 root 子树内的表格
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    var list = [];
    if (root.tagName === 'TABLE') list.push(root);
    var sub = root.querySelectorAll('table');
    for (var i = 0; i < sub.length; i++) list.push(sub[i]);
    for (var j = 0; j < list.length; j++) {
      if (list[j].tHead) { try { processTable(list[j]); } catch (e) { /* 单表失败不影响其他 */ } }
    }
  }

  function run(root) { try { scan(root || document); } catch (e) { /* 静默 */ } }

  // 初始：全站扫一次
  if (document.readyState !== 'loading') run(document);
  else document.addEventListener('DOMContentLoaded', function () { run(document); });

  // 增量：只扫「新增到 DOM 的节点」，防抖 120ms 合并批量渲染
  if (typeof MutationObserver !== 'undefined' && document.body) {
    var pending = [];
    var scheduled = false;
    function flush() {
      scheduled = false;
      var list = pending; pending = [];
      for (var i = 0; i < list.length; i++) run(list[i]);
    }
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var nd = added[j];
          if (nd.nodeType === 1) pending.push(nd);   // 只收集元素节点（含表格容器/弹窗）
        }
      }
      if (pending.length && !scheduled) {
        scheduled = true;
        setTimeout(flush, 120);
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
})();
