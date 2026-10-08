import { get, post, put, del, must, money, esc, toast, dt, imgUrl } from '../api.js';
import { confirmBox } from '../ui.js';
import { openDetailModal, openExportPicker } from '../common-ui.js';
import { serialSendBase64 } from '../serialprint.js';
import { segHtml, bindSeg, hl, noResult } from '../ui-polish.js';   // V4.26.3：统一状态筛选 / 搜索命中高亮 / 空态

/* V5.0.16 商品属性「记库存」与「称重」互斥：勾选其一自动取消另一个，两者不可同时为真
 * （避免下游「是否入库/是否传秤/盘点口径」判定冲突）。均不勾选 = 既不记库存也不称重，允许。 */
function bindStockWeighExclusive(trackEl, weightedEl) {
  if (!trackEl || !weightedEl) return;
  const sync = (src) => {
    if (src.checked) {
      (src === trackEl ? weightedEl : trackEl).checked = false;
    }
  };
  trackEl.onchange = () => sync(trackEl);
  weightedEl.onchange = () => sync(weightedEl);
}

/* V4.9.8 跨页编辑商品：模块级监听 pd:edit 事件（如库存总览的商品详情弹窗点「编辑商品」）。
 * render() 时注入 pdEditCtx（view + openEdit），未渲染过则先跳转商品档案页触发渲染。 */
let pdEditCtx = null;   // { view, openEdit }
if (typeof window !== 'undefined' && !window.__pdEditHooked) {
  window.__pdEditHooked = true;
  window.addEventListener('pd:edit', e => {
    const pid = Number(e.detail);
    if (!pid) return;
    if (!pdEditCtx || !pdEditCtx.view.isConnected) location.hash = '#/products';
    const tryOpen = n => {
      if (pdEditCtx && pdEditCtx.view.isConnected) { pdEditCtx.openEdit(pid); return; }
      if (n > 0) setTimeout(() => tryOpen(n - 1), 80);
    };
    tryOpen(50);
  });
}

/** 商品档案（V4.9.2：功能区在上 · 分类树在主表格左侧 · 主表格列对齐批发/会员折扣/供货商）
 *  新增/编辑弹窗同一版式；进货价只读（仅调价单可改）；图片上传/删除；批量导入弹窗 */
/* ═══════════ 价签打印公共能力（模块顶层，供 label-print 等模块复用） ═══════════ */
/** V5.0.4：价签直发核心（网口直发 / 串口·USB WebSerial/WebUSB）；返回是否成功 */
export async function fireTags(printerId, items, copies) {
  const payload = { items: items.map(i => ({ ...i, copies })), jobType: '价签打印' };
  const r = await must(post(`/printers/${printerId}/labels`, payload));
  if (r.channel === 'network') { toast(`价签已发送（${items.length} 品 × ${copies} 张，网口直发）`); return true; }
  if (r.channel === 'serial' || r.channel === 'usb') { await serialSendBase64(r.dataBase64); toast(`价签已打印（${items.length} 品 × ${copies} 张，串口直驱）`); return true; }
  return false;
}

/** V5.0.5：价签商品导出 Excel（商品名称/单位/规格/保质期/条码/销售价/会员价/特价） */
function exportTagItems(items) {
  openExportPicker({ filename: '价签商品明细', columns: [
    {k:'name',t:'商品名称'},{k:'unit',t:'单位'},{k:'spec',t:'规格'},{k:'keepDays',t:'保质期(天)'},{k:'barcode',t:'条码'},{k:'price',t:'销售价'},{k:'memberPrice',t:'会员价'},{k:'promoPrice',t:'特价'}
  ], rows: items });
}

/** V5.0.4：单品快捷打签（取该商品 + 默认价签机 → 可改份数确认） */
export async function openOneTagModal(id) {
  const ps = await must(get('/printers')).catch(() => []);
  const labelPrinters = (Array.isArray(ps) ? ps : []).filter(p => (p.printer_type || '小票') === '标签');
  if (!labelPrinters.length) return toast('暂无标签机：请先到「打印中心」新增标签机（网口/串口）', false);
  const def = labelPrinters.find(p => p.is_default && p.default_for === 'pricetag');
  if (!def) return toast('请先在「打印中心」把某台标签机设为「价签」默认用途', false);
  const d = await must(post('/printers/price-tags', { ids: [id] }));
  const items = d.items || [];
  if (!items.length) return toast('未取到商品数据', false);
  const it = items[0];
  const { mask } = openDetailModal('🏷 打印价签', `
    <div class="muted" style="font-size:12.5px;padding:2px 0 8px">
      将用默认价签机 <b>${esc(def.name)}</b>（${esc(def.label_size || '40x30')}）打印：<b>${esc(it.name)}</b>
      ${it.promoPrice != null ? `（<b style="color:var(--warn)">有特价，自动印划线原价+促销价</b>）` : ''}。</div>
    <div class="fld" style="max-width:300px"><label>份数</label>
      <input id="ptCopies" type="number" min="1" max="50" value="1" style="width:100px"></div>
    <div class="bar" style="justify-content:flex-end;margin-top:10px;gap:10px">
      <span class="muted" id="ptTip"></span>
      <button class="btn" id="ptExport">📊 导出 Excel</button>
      <button class="btn" id="ptCancel">取消</button>
      <button class="btn pri" id="ptGo">🖨 打印</button>
    </div>`, { width: 460 });
  mask.querySelector('#ptCancel').onclick = () => mask.remove();
  mask.querySelector('#ptExport').onclick = () => exportTagItems(items);
  mask.querySelector('#ptGo').onclick = async () => {
    const copies = Math.min(Math.max(Number(mask.querySelector('#ptCopies').value) || 1, 1), 50);
    const tip = mask.querySelector('#ptTip'); tip.textContent = '发送中…';
    try { if (await fireTags(def.id, items, copies)) mask.remove(); }
    catch (e) { tip.textContent = ''; toast('打印失败：' + (e.message || e), false); }
  };
}

export async function render(view) {
  let cats = [];
  let all = [];           // 当前页商品
  let total = 0;          // 后端总数
  let catId = 0;          // 0 = 全部
  let tabK = '';          // ''全部 / on / blocked / expiry / off
  let selId = 0;          // 选中商品 id（详情弹窗）
  let selDetail = null;   // 选中商品详情
  let nearExpiry = new Set();   // 有临期批次的商品集合（/inventory/expiry-alerts）
  let curPage = 1;        // 当前页码
  const SIZE = 30;        // 每页最多 30 行
  let suppliers = [];     // 供应商下拉（建档/编辑/筛选共用）

  /* V5.0.0 连锁：连锁上下文与视图状态。chain 由 loadChain() 异步填充；
   * 这些是「总部/门店」连锁条所需的模块级状态，缺失会导致 loadProducts 读 chain.enabled 时 ReferenceError。 */
  const chain = { enabled: false, hq: false, myStore: 0, stores: [] };
  let vMode = 'sellable';   // 视图模式：sellable 本店在售 / browse 总部档案 / local 门店自建
  let vStore = 0;           // 总部跨店视角当前门店 id（loadChain 里置为本店）

  view.innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="bar" style="padding:12px 16px 8px;margin:0">
        <input id="pKw" placeholder="🔍 商品名称 / 条码 / 货号 / 拼音码"
               style="flex:1;min-width:240px;font:inherit;font-size:13px;padding:8px 12px;border:2px solid var(--line-2);border-radius:10px;background:#fff;outline:none">
        <span id="pSeg"></span>
        <span id="pChain"></span>
        <button class="btn" id="catToggle" title="收起/展开左侧分类栏（收起后表格铺满整窗）">🗂️</button>
        <button class="btn pri" id="pNew">＋ 新增商品</button>
        <button class="btn" id="pImport">📥 批量导入</button>
        <button class="btn" id="pPool">🌐 外部商品池</button>
        <button class="btn" id="pPublish" style="display:none">📤 下发到门店 (<b id="pPubN">0</b>)</button>
        <button class="btn" id="pApplyList" style="display:none">📥 申请上架 (<b id="pApplyN">0</b>)</button>
        <button class="btn" id="pAdopt" style="display:none">🧬 收编为总部品 (<b id="pAdoptN">0</b>)</button>
        <button class="btn pri" id="pTags" style="display:none">🏷 价签打印 (<b id="pTagN">0</b>)</button>
        <button class="btn" id="pDel" style="display:none;color:#c0392b;border-color:#e6b0aa">🗑 删除所选 (<b id="pDelN">0</b>)</button>
      </div>
      <div style="display:flex;height:calc(100dvh - 210px);min-height:520px;border-top:1px dashed var(--line)">
        <div id="catPanel" style="width:240px;flex:none;border-right:1px solid var(--line);display:flex;flex-direction:column">
          <div style="display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px dashed var(--line)">
            <b style="font-size:13px;flex:1">🗂️ 分类管理</b>
            <button class="btn sm" id="catNew" title="新增分类">＋ 新增分类</button>
          </div>
          <div id="catTree" style="padding:8px 10px 12px;overflow:auto;flex:1"></div>
          <div class="muted" style="padding:6px 12px 10px;border-top:1px dashed var(--line);font-size:10.5px;line-height:1.7">
            拖拽分类可排序/合并 · 双击改名 · 级首＋加子类 · 行末−删空类
          </div>
        </div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column">
          <div style="padding:0 14px;flex:1;min-height:0;overflow:auto" id="pList" class="tbl-min"></div>
          <div class="doc-foot" style="padding:9px 18px;margin-top:auto">
            <span class="muted">点行看详情 · 双击行直接编辑 · 扫码枪扫码 = 锁定商品</span>
            <span style="flex:1"></span>
            <span class="muted" id="pCount"></span>
            <button class="btn sm" id="pPrev" disabled>‹ 上一页</button>
            <span class="muted" style="display:flex;align-items:center;gap:4px;font-size:12px">第
              <input type="number" id="pJump" min="1" value="1" style="width:52px;text-align:center;padding:2px 4px"> /
              <span id="pPages">1</span> 页</span>
            <button class="btn sm" id="pNext" disabled>下一页 ›</button>
          </div>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="catModal" style="display:none;z-index:60">
      <div class="modal" style="max-width:400px">
        <h3 id="catMTitle">➕ 新增分类</h3>
        <div class="fld" style="margin-bottom:10px"><label>上级分类</label><select id="catMParent" style="flex:1"></select></div>
        <div class="fld"><label>分类名称</label><input id="catMName" style="flex:1" placeholder="如 饮料 / 碳酸饮料"></div>
        <div class="doc-foot">
          <button class="btn" id="catMCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="catMGo">💾 保存</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="pModal" style="display:none">
      <div class="modal" style="width:min(680px,94vw);max-height:88dvh;overflow:auto">
        <h3>➕ 新增商品</h3>
        <div class="doc-tip" style="padding:0 0 8px;margin-top:-6px">带 <b style="color:var(--err)">*</b> 为必填；「会员折扣」选「是」的商品才参与会员价（默认 9 折，具体会员价在会员业务中设置）；进货价 / 规格 / 供货商建议留空 —— 上传入库单后自动关联（多供应商主次自动维护）</div>
        <div class="doc-head" style="grid-template-columns:repeat(2,minmax(0,1fr));border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld" style="min-width:0"><label class="req">条码</label><input id="mBarcode" placeholder="扫码枪可直接扫入" style="font-family:var(--mono)"></div>
          <div class="fld" style="min-width:0"><label class="req">商品名称</label><input id="mName"></div>
          <div id="mBcHint" style="grid-column:1/-1;font-size:11.5px;color:var(--ink-3);min-height:0;margin:-6px 0 0"></div>
          <div class="fld" style="min-width:0"><label class="req">单位</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="mUnit" placeholder="输入查询（如 瓶/箱），无则自动新增" style="flex:1;min-width:0">
              <button class="btn sm" id="mUnitAdd" title="从单位字典选择/添加">＋</button>
            </div></div>
          <div class="fld" style="min-width:0"><label class="req">售价</label><input id="mPrice" type="number" step="0.01"></div>
          <div class="fld" style="min-width:0"><label>最低卖价</label><input id="mMinPrice" type="number" step="0.01" placeholder="留空/0 → 按进价兜底" title="收银员改价不得低于此价；留空则由进价兜底（不得低于进价销售）；店长可放行并留痕"></div>
          <div class="fld" style="min-width:0"><label>最低折扣（折）</label><input id="mMinDisc" type="number" step="1" min="1" max="100" placeholder="如 80 = 最低 8 折，留空不限" title="收银员单品/整单折扣不得低于此折扣；100=不允许打折；留空则受进价兜底"></div>
          <div class="fld" style="min-width:0"><label class="req">保质期</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="mKeep" type="number" min="1" max="32750" placeholder="必填" style="flex:1;min-width:90px;width:90px">
              <select id="mKeepUnit" style="flex:0 0 auto;width:84px"><option value="1">天</option><option value="30">月</option><option value="365">年</option></select>
            </div></div>
          <div class="fld" style="min-width:0"><label class="req">分类</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="mCatIn" placeholder="输入快速查询分类" style="flex:1;min-width:0">
              <button class="btn sm" id="mCatAdd" title="快速新增分类">＋</button>
              <datalist id="catDl"></datalist>
            </div></div>
          <div class="fld" style="min-width:0"><label>规格</label><input id="mSpec" placeholder="留空 → 入库单自动关联"></div>
          <div class="fld" style="min-width:0"><label>供货商</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="mSupIn" placeholder="输入快速查询，留空→入库单自动关联" style="flex:1;min-width:0">
              <datalist id="supDl"></datalist>
            </div></div>
          <div class="fld" style="min-width:0"><label>进货价</label><input id="mCost" type="number" step="0.01" placeholder="留空 → 入库单自动关联"></div>
          <div class="fld" style="min-width:0"><label>会员价</label><input id="mMember" type="number" step="0.01" placeholder="留空 → 会员业务自动关联"></div>
          <div class="fld" style="min-width:0"><label>批发价</label><input id="mWholesale" type="number" step="0.01"></div>
          <div class="fld" style="min-width:0"><label>会员折扣</label>
            <select id="mDiscount">
              <option value="">否（不参与会员价）</option>
              <option value="1">是（参与会员价）</option>
            </select></div>
          <div class="fld" style="min-width:0"><label class="req">属性</label>
            <label class="muted" style="min-width:0"><input type="checkbox" id="mTrack" checked> 记库存</label>
            <label class="muted" style="min-width:0"><input type="checkbox" id="mWeighted"> 称重</label></div>
          <div class="fld" style="min-width:0"><label>经营方式</label><select id="mBizMode"><option>购销</option><option>联营</option></select></div>
          <div class="fld" style="min-width:0"><label>库存下限</label><input id="mMinStock" type="number" min="0" step="1" placeholder="0 = 不预警" title="低于该库存触发补货提醒（AI 补货建议 / 库存预警）"></div>
          <div class="fld" style="min-width:0"><label>库存上限</label><input id="mMaxStock" type="number" min="0" step="1" placeholder="0 = 不限制" title="高于该库存触发超储提醒（占用资金预警）"></div>
        </div>
        <div style="border:1px dashed var(--line);border-radius:10px;padding:12px 16px;margin-top:8px">
          <div class="fld" style="min-width:0"><label>一品多码</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="mAliasIn" data-navskip placeholder="称重码 / 旧码 / 厂商多码，回车或扫码自动添加" style="flex:1;min-width:0;font-family:var(--mono)">
              <button class="btn sm pri" id="mAliasAdd" style="white-space:nowrap">添加</button>
            </div>
            <div id="mAliasChips" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
          </div>
          <div class="fld" style="margin-top:12px;min-width:0"><label>一品多包装</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="mPkgBarcode" data-navskip placeholder="包装条码（回车/扫码自动添加）" style="flex:1.1;min-width:0;font-family:var(--mono)">
              <input id="mPkgUnit" list="unitDl" data-navskip placeholder="包装单位（如 箱/提）" style="flex:1.1;min-width:0">
              <datalist id="unitDl"></datalist>
              <input id="mPkgRate" data-navskip type="number" placeholder="换算数量" title="1 包装单位 = ? 基本单位" style="flex:0.8;min-width:0">
              <button class="btn sm pri" id="mPkgAdd" style="white-space:nowrap">添加</button>
            </div>
            <div id="mPkgChips" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
          </div>
        </div>
        <div class="doc-foot">
          <button class="btn" id="mCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="mSave">💾 保存建档</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="unitModal" style="display:none;z-index:60">
      <div class="modal" style="max-width:400px">
        <h3>➕ 添加单位</h3>
        <input id="uSearch" placeholder="输入快速匹配（如 瓶 / 袋 / 箱 / 斤）" style="width:100%">
        <div id="uMatch" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;min-height:34px"></div>
        <div class="doc-foot">
          <button class="btn" id="uCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="uGo">＋ 添加并选用</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="impModal" style="display:none">
      <div class="modal" style="width:min(600px,94vw)">
        <h3>⬆ 商品批量导入</h3>
        <div class="bar" style="margin-bottom:10px">
          <button class="btn pri" id="pDlTpl">⬇ 下载模板（Excel）</button>
          <button class="btn" id="impPickFile">📂 选择文件导入（txt / csv / excel）</button>
          <input type="file" id="impFile" accept=".txt,.csv,.xls,.xlsx" style="display:none">
        </div>
        <div class="muted" style="margin-bottom:6px">或直接粘贴文本（每行一个商品，英文逗号分隔，列顺序与模板一致）：</div>
        <div class="muted" style="margin-bottom:6px"><code>商品名称,条码,单位,售价,保质期,保质期单位(天/月/年),规格,分类,进货价,会员价,批发价,会员折扣(是/否),供货商</code> —— 前 4 列必填（V4.9.12：保质期可留空）</div>
        <div class="muted" style="margin-bottom:6px">📌 条码已存在的商品将<b>按行覆盖更新</b>（文件为真相），并回写本店确认条码档案；适合供应商送货单/老系统导出的真实数据开局</div>
        <textarea id="impText" rows="7" style="width:100%;font-family:var(--mono);font-size:12.5px;padding:10px;border:1px solid var(--line);border-radius:8px;box-sizing:border-box" placeholder="农夫山泉550ml,6901234500011,瓶,2,365,天,550ml,饮料,1.2,1.8,,是,岳池娃哈哈&#10;乐事薯片,6901234500028,袋,6.5,6,月,104g,休闲食品,4.2,,,否,乐事经销商"></textarea>
        <div class="doc-foot" style="margin-top:10px">
          <button class="btn" id="impCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="impGo">📥 导入</button>
        </div>
        <div id="impResult" class="mt8"></div>
      </div>
    </div>

    <div class="modal-mask" id="detModal" style="display:none">
      <div class="modal" style="width:min(760px,94vw);max-height:88dvh;overflow:auto">
        <h3 id="dtTitle">商品详情</h3>
        <div id="dtBody"></div>
        <div class="doc-foot" style="margin-top:6px">
          
          <span style="flex:1"></span>
          <button class="btn" id="dtOnline">🛒 商城下架</button>
          <button class="btn" id="dtTag">🏷 打印价签</button>
          <button class="btn pri" id="dtEdit">✏️ 编辑档案</button>
        </div>
      </div>
    </div>

    <div class="modal-mask" id="editModal" style="display:none">
      <div class="modal" style="width:min(680px,94vw);max-height:88dvh;overflow:auto">
        <h3 id="emTitle">✏️ 编辑商品</h3>
        <div class="doc-head" style="grid-template-columns:repeat(2,minmax(0,1fr));border:1px dashed var(--line);border-radius:10px;padding:14px 16px">
          <div class="fld" style="min-width:0"><label class="req">条码</label><input id="eBarcode" style="font-family:var(--mono)"></div>
          <div class="fld" style="min-width:0"><label class="req">商品名称</label><input id="eName"></div>
          <div class="fld" style="min-width:0"><label class="req">单位</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="eUnit" placeholder="输入查询（如 瓶/箱），无则自动新增" style="flex:1;min-width:0">
            </div></div>
          <div class="fld" style="min-width:0"><label class="req">售价</label><input id="ePrice" type="number" step="0.01"></div>
          <div class="fld" style="min-width:0"><label>最低卖价</label><input id="eMinPrice" type="number" step="0.01" placeholder="留空/0 → 按进价兜底" title="收银员改价不得低于此价；留空则由进价兜底（不得低于进价销售）；店长可放行并留痕"></div>
          <div class="fld" style="min-width:0"><label>最低折扣（折）</label><input id="eMinDisc" type="number" step="1" min="1" max="100" placeholder="如 80 = 最低 8 折，留空不限" title="收银员单品/整单折扣不得低于此折扣；100=不允许打折；留空则受进价兜底"></div>
          <div class="fld" style="min-width:0"><label>进货价</label><input id="eCost" type="number" step="0.01" readonly disabled style="background:var(--paper-2);color:var(--ink-3);cursor:not-allowed" title="已产生业务的商品进价只能在「商品调价单」中调整"><div></div></div>
          <div class="fld" style="min-width:0"><label>会员价</label><input id="eMember" type="number" step="0.01"></div>
          <div class="fld" style="min-width:0"><label>批发价</label><input id="eWholesale" type="number" step="0.01"></div>
          <div class="fld" style="min-width:0"><label>会员折扣</label>
            <select id="eDiscount">
              <option value="">否（不参与会员价）</option>
              <option value="1">是（参与会员价）</option>
            </select></div>
          <div class="fld" style="min-width:0"><label class="req">保质期</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="eKeep" type="number" min="1" max="32750" placeholder="必填" style="flex:1;min-width:90px;width:90px">
              <select id="eKeepUnit" style="flex:0 0 auto;width:84px"><option value="1">天</option><option value="30">月</option><option value="365">年</option></select>
            </div></div>
          <div class="fld" style="min-width:0"><label class="req">分类</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="eCatIn" placeholder="输入快速查询分类" style="flex:1;min-width:0">
            </div></div>
          <div class="fld" style="min-width:0"><label>规格</label><input id="eSpec"></div>
          <div class="fld" style="min-width:0"><label>供货商</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="eSupIn" placeholder="输入快速查询，留空→未指定" style="flex:1;min-width:0">
            </div></div>
          <div class="fld" style="min-width:0"><label>经营方式</label><select id="eBizMode"><option>购销</option><option>联营</option></select></div>
          <div class="fld" style="min-width:0"><label>库存下限</label><input id="eMinStock" type="number" min="0" step="1" placeholder="0 = 不预警" title="低于该库存触发补货提醒（AI 补货建议 / 库存预警）"></div>
          <div class="fld" style="min-width:0"><label>库存上限</label><input id="eMaxStock" type="number" min="0" step="1" placeholder="0 = 不限制" title="高于该库存触发超储提醒（占用资金预警）"></div>
          <div class="fld" style="min-width:0"><label class="req">属性</label>
            <label class="muted" style="min-width:0"><input type="checkbox" id="eTrack"> 记库存</label>
            <label class="muted" style="min-width:0"><input type="checkbox" id="eWeighted"> 称重</label></div>
          <div class="fld" style="min-width:0"><label class="req">状态</label><select id="eStatus"><option value="1">在售</option><option value="2">禁售（待补保质期）</option><option value="0">停用</option></select></div>
          <div class="fld" style="min-width:0;grid-column:1/-1"><label>商品图片</label>
            <div style="display:flex;gap:10px;align-items:center;flex:1;min-width:0">
              <img id="ePhotoPrev" src="" style="width:56px;height:56px;border-radius:10px;object-fit:cover;border:1px solid var(--line);display:none">
              <span id="ePhotoEmpty" class="muted">暂无图片</span>
              <span style="flex:1"></span>
              <button class="btn sm" id="ePhotoUp">⬆ 上传图片</button>
              <input type="file" id="ePhotoFile" accept="image/*" style="display:none">
              <button class="btn sm" id="ePhotoDel" style="color:#c0392b;border-color:#e6b0aa">🗑 删除图片</button>
            </div></div>
          <div class="fld" style="min-width:0;grid-column:1/-1"><label>一品多码</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="eAliasIn" data-navskip placeholder="称重码 / 旧码 / 厂商多码，回车或扫码自动添加" style="flex:1;min-width:0;font-family:var(--mono)">
              <button class="btn sm pri" id="eAliasAdd" style="white-space:nowrap">添加</button>
            </div>
            <div id="eAliasChips" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
          </div>
          <div class="fld" style="min-width:0;grid-column:1/-1"><label>一品多包装</label>
            <div style="display:flex;gap:6px;flex:1;min-width:0">
              <input id="ePkgBarcode" data-navskip placeholder="包装条码（回车/扫码自动添加）" style="flex:1.1;min-width:0;font-family:var(--mono)">
              <input id="ePkgUnit" list="unitDl" data-navskip placeholder="包装单位（如 箱/提）" style="flex:1.1;min-width:0">
              <input id="ePkgRate" data-navskip type="number" placeholder="换算数量" title="1 包装单位 = ? 基本单位" style="flex:0.8;min-width:0">
              <button class="btn sm pri" id="ePkgAdd" style="white-space:nowrap">添加</button>
            </div>
            <div id="ePkgChips" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
          </div>
        </div>
        <div class="doc-foot">
          <button class="btn" id="emCancel">取消</button>
          <span style="flex:1"></span>
          <button class="btn pri" id="emSave">💾 保存修改</button>
        </div>
      </div>
    </div>`;

  /* ── 状态（统一状态色：绿=在售 · 黄=禁售待补/临期 · 红=需补货 · 灰=停用） ── */
  const statusOf = p => {
    if (p.status === 0) return { t: '停用', c: 'n' };
    if (p.status === 2 || !p.keep_days) return { t: '禁售·待补保质期', c: 'y' };
    if (Number(p.stock_qty || 0) <= 0 && p.track_inventory !== false) return { t: '补货', c: 'r' };
    if (nearExpiry.has(Number(p.id))) return { t: '临期·自动折扣', c: 'y' };
    return { t: '在售', c: 'g' };
  };
  const emojiOf = p => {
    const name = String(p.category_name || '');
    if (name.includes('水果') || name.includes('蔬菜')) return '🍎';
    if (name.includes('肉')) return '🥩';
    if (name.includes('蛋')) return '🥚';
    if (name.includes('粮油')) return '🍚';
    if (name.includes('零食')) return '🍬';
    if (name.includes('饮料')) return '🧃';
    if (name.includes('日配') || name.includes('乳')) return '🥛';
    if (name.includes('烟')) return '🚬';
    if (name.includes('百货')) return '🧻';
    return p.is_weighted ? '🥬' : '🏷️';
  };
  // 会员折扣显示：是 / 否
  const hasDiscount = p => p.member_discount != null && Number(p.member_discount) > 0 && Number(p.member_discount) < 1;

  /* ── 分类树（三级 · 树形 + ＋/− + 拖拽排序/合并 + 双击改名 → 弹窗） ── */
  const flatCats = () => {
    const out = [];
    const fa = (list, chain) => list.forEach(c => { out.push({ ...c, chain: chain.concat(c) }); fa(c.children || [], chain.concat(c)); });
    fa(cats, []);
    return out;
  };
  // 分类商品数固定统计：来自 /products/category-counts，不随当前筛选变化
  let catCounts = {};    // { categoryId: n }
  let fixedTotal = 0;    // 全部商品固定总数
  async function loadCatCounts() {
    try {
      const d = await must(get('/products/category-counts'));
      const m = {}; let sum = 0;
      for (const it of (d.items || [])) { m[it.categoryId] = Number(it.n); sum += Number(it.n); }
      // V4.9.5：全部商品须包含未分类商品
      const unc = Number(d.uncategorized || 0);
      catCounts = m; fixedTotal = sum + unc;
      uncatCount = unc;
    } catch { /* 统计失败不影响列表 */ }
  }
  let uncatCount = 0;   // 未分类商品数
  const countOf = cid => Number(catCounts[Number(cid)] || 0);
  const countDeep = node => {
    let n = countOf(node.id);
    (node.children || []).forEach(ch => { n += countDeep(ch); });
    return n;
  };
  const CAT_ICONS = ['🥤', '🍎', '🚬', '🧻', '🍚', '🍬', '🥩', '🥚', '🧃', '🥛', '📦'];
  const iconOf = (c, i) => c.icon || CAT_ICONS[i % CAT_ICONS.length];

  // 分类新增/改名弹窗（catModal）：mode=add（可选上级） / rename（固定目标）
  const catModal = view.querySelector('#catModal');
  let catEditId = 0;
  function openCatModal(mode, parentId = 0, cat = null) {
    catEditId = cat ? Number(cat.id) : 0;
    view.querySelector('#catMTitle').textContent = mode === 'add' ? '➕ 新增分类' : '✏️ 修改分类名称';
    const sel = view.querySelector('#catMParent');
    const opts = flatCats().map(c => `<option value="${c.id}">${esc(c.chain.map(x => x.name).join(' / '))}</option>`).join('');
    if (mode === 'add') {
      sel.disabled = false;
      sel.innerHTML = '<option value="">（一级分类）</option>' + opts;
      sel.value = parentId ? String(parentId) : '';
      view.querySelector('#catMName').value = '';
    } else {
      sel.disabled = true;
      sel.innerHTML = `<option>${esc(cat.chain.slice(0, -1).map(x => x.name).join(' / ') || '（一级分类）')}</option>`;
      view.querySelector('#catMName').value = cat.name;
    }
    catModal.style.display = 'flex';
    view.querySelector('#catMName').focus();
  }
  view.querySelector('#catNew').onclick = () => openCatModal('add', catId);
  view.querySelector('#catMCancel').onclick = () => { catModal.style.display = 'none'; };
  view.querySelector('#catMGo').onclick = async () => {
    const name = view.querySelector('#catMName').value.trim();
    if (!name) return toast('分类名称必填', false);
    try {
      if (catEditId) {
        await must(put(`/products/categories/${catEditId}`, { name }), '分类已改名');
      } else {
        const pv = view.querySelector('#catMParent').value;
        await must(post('/products/categories', { name, parentId: pv ? Number(pv) : undefined }), '分类已创建');
      }
      catModal.style.display = 'none';
      cats = (await must(get('/products/categories')).catch(() => [])) || [];
      drawTree();
    } catch (err) { toast(err.message, false); }
  };

  // 分类动作弹窗（拖拽投放后选择：排序 / 移动为子级 / 合并）
  function catDropDialog(src, tgt) {
    const m = document.createElement('div');
    m.style.cssText = 'position:fixed;inset:0;background:rgba(34,48,31,.45);z-index:60;display:grid;place-items:center';
    m.innerHTML = `<div style="background:var(--card);border-radius:12px;padding:18px 20px;width:min(360px,92vw);box-shadow:var(--shadow)">
      <b style="font-size:13.5px">「${esc(src.name)}」→「${esc(tgt.name)}」</b>
      <div class="muted" style="margin:8px 0 12px">请选择操作（均为可恢复操作：合并后源分类留痕停用）</div>
      <div style="display:grid;gap:8px">
        <button class="btn pri" data-act="sort">↕ 排到它后面（同级排序）</button>
        <button class="btn" data-act="move">📂 移动为它的子分类</button>
        <button class="btn" data-act="merge" style="color:#b34f18;border-color:#e6b0aa">🔗 合并到它（商品与子分类并入，源停用留痕）</button>
        <button class="btn" data-act="cancel">取消</button>
      </div></div>`;
    document.body.appendChild(m);
    m.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const act = b.dataset.act;
      m.remove();
      try {
        if (act === 'cancel') return;
        if (act === 'sort') {
          const sib = (Number(tgt.parent_id) ? flatCats().find(c => Number(c.id) === Number(tgt.parent_id))?.children : cats) || [];
          const ids = sib.filter(c => Number(c.id) !== Number(src.id)).map(c => Number(c.id));
          const idx = ids.indexOf(Number(tgt.id));
          ids.splice(idx + 1, 0, Number(src.id));
          await must(post('/products/categories/reorder', { parentId: tgt.parent_id ? Number(tgt.parent_id) : undefined, ids }), '排序已更新');
        } else if (act === 'move') {
          await must(put(`/products/categories/${src.id}`, { parentId: Number(tgt.id) }), '已移动为子分类');
        } else if (act === 'merge') {
          const r = await must(post('/products/categories/merge', { sourceId: Number(src.id), targetId: Number(tgt.id) }), '合并完成');
          toast(`已合并：移入商品 ${r.movedProducts} 个、子分类 ${r.movedChildren} 个`);
        }
        cats = (await must(get('/products/categories')).catch(() => [])) || [];
        drawTree();
      } catch (e) { toast(e.message, false); }
    });
    m.onclick = e => { if (e.target === m) m.remove(); };
  }

  function drawTree() {
    const box = view.querySelector('#catTree');
    const nodeRow = (c, depth, i) => {
      const isLeaf3 = Number(c.level) >= 3 || !(c.children || []).length;
      return `
      <div data-cat="${c.id}" data-cname="${esc(c.name)}" draggable="true"
        style="display:flex;align-items:center;gap:6px;padding:7px 10px 7px ${10 + depth * 22}px;
          border-radius:8px;cursor:grab;font-size:${depth === 0 ? '13.5px' : '13px'};font-weight:${depth === 0 ? 700 : 400};
          ${Number(c.id) === catId ? 'background:var(--green-soft);color:var(--pri);' : 'color:var(--ink-2)'}"
        ondragover="event.preventDefault();this.style.outline='2px dashed var(--pri)'" ondragleave="this.style.outline=''">
        <button data-cadd="${c.id}" title="在此分类下加子分类" style="flex:none;border:1px solid var(--line-2);background:#fff;border-radius:6px;width:20px;height:20px;line-height:17px;cursor:pointer;font-weight:700;color:var(--pri);padding:0">＋</button>
        <span style="flex:none">${depth === 0 ? iconOf(c, i) : '└'}</span>
        <span data-cname-t style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span>
        <span style="flex:1"></span>
        <span class="muted" style="font-size:10.5px">${countDeep(c)}</span>
        <button data-cdel="${c.id}" title="${isLeaf3 ? '删除该分类（仅空分类可删）' : '有子分类不可删'}" style="flex:none;border:1px solid var(--line-2);background:#fff;border-radius:6px;width:20px;height:20px;line-height:17px;cursor:pointer;font-weight:700;color:#c0392b;padding:0">−</button>
      </div>`;
    };
    const walk = (list, depth) => list.map((c, i) => nodeRow(c, depth, i) + walk(c.children || [], depth + 1)).join('');
    box.innerHTML = `
      <div data-cat="0" style="display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:8px;cursor:pointer;font-size:13.5px;
        ${catId === 0 ? 'background:var(--green-soft);color:var(--pri);font-weight:700' : 'color:var(--ink-2)'}">
        <span>🗂️</span><span>全部商品</span><span class="muted" style="margin-left:auto;font-size:11px">${fixedTotal}</span></div>
      ${walk(cats, 0)}`;
    // 点击行：筛选该分类商品；双击名称：改名弹窗
    box.querySelectorAll('[data-cat]').forEach(el => {
      const cid = Number(el.dataset.cat);
      el.onclick = e => {
        if (e.target.closest('[data-cadd]') || e.target.closest('[data-cdel]')) return;
        catId = cid; drawTree(); loadProducts(1);
      };
      el.ondblclick = e => {
        e.stopPropagation();
        if (cid === 0) return;
        const cat = flatCats().find(c => Number(c.id) === cid);
        if (cat) openCatModal('rename', 0, cat);
      };
    });
    // ＋ 加子分类 → 弹窗
    box.querySelectorAll('[data-cadd]').forEach(btn => btn.onclick = e => {
      e.stopPropagation();
      openCatModal('add', Number(btn.dataset.cadd));
    });
    // − 删空分类（后端校验：无子分类且无商品挂载）
    box.querySelectorAll('[data-cdel]').forEach(btn => btn.onclick = async e => {
      e.stopPropagation();
      const row = btn.closest('[data-cat]');
      if (!confirm(`确认删除分类「${row.dataset.cname}」？\n（仅可删除空分类：无子分类且无商品挂载）`)) return;
      try { await must(del(`/products/categories/${btn.dataset.cdel}`), '分类已删除（留痕）'); cats = (await must(get('/products/categories')).catch(() => [])) || []; drawTree(); }
      catch (err) { toast(err.message, false); }
    });
    // 拖拽：源分类 → 投放目标分类 → 选择 排序/移动/合并
    let dragSrc = null;
    box.querySelectorAll('[data-cat][draggable="true"]').forEach(el => {
      el.ondragstart = () => { dragSrc = { id: Number(el.dataset.cat), name: el.dataset.cname }; el.style.opacity = .5; };
      el.ondragend = () => { el.style.opacity = ''; };
      el.ondrop = async e => {
        e.preventDefault(); el.style.outline = '';
        if (!dragSrc || dragSrc.id === Number(el.dataset.cat)) { dragSrc = null; return; }
        const tgt = flatCats().find(c => Number(c.id) === Number(el.dataset.cat));
        const src = flatCats().find(c => Number(c.id) === dragSrc.id);
        dragSrc = null;
        if (!tgt || !src) return;
        catDropDialog(src, tgt);
      };
    });
    // V4.9.14 起分类候选改由自绘面板（attachCatPicker）惰性渲染，datalist 已弃用
  }

  /* ── 列表加载（分页：每页 30 行） ── */
  async function loadProducts(p) {
    curPage = Math.max(1, Number(p) || 1);
    const kw = view.querySelector('#pKw').value.trim();
    const ps = new URLSearchParams({ size: String(SIZE), page: String(curPage) });
    if (kw) ps.set('keyword', kw);
    if (catId) ps.set('categoryId', String(catId));
    // V5.0.0 连锁：视图模式（可售 / 可查）与门店视角；单店下后端自动等价本店全部
    if (chain.enabled && vMode === 'browse') ps.set('scope', 'browse');
    if (chain.enabled && vMode === 'local') ps.set('scope', 'local');
    if (chain.enabled && chain.hq && vStore) ps.set('storeId', String(vStore));
    const d = await must(get('/products?' + ps.toString()));
    all = d.items || [];
    total = Number(d.total || 0);
    refreshAll();
  }

  /* ── V5.0.0 连锁条：视图切换（本店在售 / 总部档案）+ 门店视角 + 下发/申请按钮显隐 ── */
  async function loadChain() {
    try {
      const me = await must(get('/auth/me'));
      chain.hq = !!me.hq;
      chain.myStore = Number(me.storeId || 0);
      vStore = chain.myStore;
      // 有连锁配置键且（总部或跨店）→ 显示连锁条；单店/门店账号保持原样，零学习成本
      const cfg = await get('/settings/chain.enabled').catch(() => null);
      const on = cfg && cfg.data && (cfg.data.value === true || String(cfg.data.value) === 'true');
      // 本节点已是总部（me.hq）就无条件显示连锁条 —— 防「建了总部却忘了打开开关 → 后台看不到连锁视图」
      chain.enabled = !!on || !!chain.hq;
      if (chain.enabled && chain.hq) {
        const st = await get('/hq/stores?size=200&status=1').catch(() => null);
        chain.stores = (st && st.data && st.data.items) ? st.data.items.filter(s => s.org_type !== 'hq') : [];
      }
    } catch { chain.enabled = false; }
    drawChainBar();
  }
  function drawChainBar() {
    const box = view.querySelector('#pChain');
    if (!box) return;
    if (!chain.enabled) { box.innerHTML = ''; syncDelBtn(); return; }
    const storeSel = (chain.hq && chain.stores.length)
      ? `<select id="pVStore" style="font:inherit;font-size:12.5px;padding:5px 8px;border:2px solid var(--line-2);border-radius:9px;background:#fff">
           <option value="0">总部视角（全部在售/未下发）</option>
           ${chain.stores.map(s => `<option value="${s.id}" ${Number(vStore) === Number(s.id) ? 'selected' : ''}>🏪 ${esc(s.name)}</option>`).join('')}
         </select>` : '';
    box.innerHTML = `
      <span id="pVMode"></span>
      ${storeSel}`;
    const mbox = box.querySelector('#pVMode');
    mbox.innerHTML = segHtml([
      { k: 'sellable', t: '本店在售' },
      { k: 'browse', t: '总部档案（可查）' },
      { k: 'local', t: chain.hq ? '门店自建品' : '本店自建' },
    ], vMode);
    bindSeg(mbox, k => { vMode = k; loadProducts(1); });
    const vs = box.querySelector('#pVStore');
    if (vs) vs.onchange = () => { vStore = Number(vs.value) || 0; loadProducts(1); };
    syncDelBtn();
  }
  function tabMatch(p, k) {
    if (k === 'on') return p.status === 1 && !(p.status === 2 || !p.keep_days) && !nearExpiry.has(Number(p.id));
    if (k === 'blocked') return p.status === 2 || !p.keep_days;
    if (k === 'expiry') return nearExpiry.has(Number(p.id)) && p.status !== 0;
    if (k === 'off') return p.status === 0;
    return true;
  }
  /* V4.26.3：状态筛选改用统一 .seg（带数量角标，选中态由组件管，不再手工描边） */
  function drawSeg() {
    const box = view.querySelector('#pSeg');
    if (!box) return;
    const c = k => all.filter(p => tabMatch(p, k)).length;
    box.innerHTML = segHtml([
      { k: '', t: '全部', n: all.length },
      { k: 'on', t: '在售', n: c('on') },
      { k: 'blocked', t: '禁售·待补保质期', n: c('blocked') },
      { k: 'expiry', t: '临期', n: c('expiry') },
      { k: 'off', t: '停用', n: c('off') },
    ], tabK);
    bindSeg(box, k => { tabK = k; drawSeg(); drawTable(); });
  }
  function refreshAll() {
    drawSeg();
    view.querySelector('#pCount').textContent = `共 ${total} 个商品 · 每页 ${SIZE} 行`;
    renderPager();
    drawTable();
  }
  function renderPager() {
    const tp = Math.max(1, Math.ceil(total / SIZE));
    view.querySelector('#pPages').textContent = String(tp);
    const jump = view.querySelector('#pJump');
    jump.max = String(tp); jump.value = String(curPage);
    view.querySelector('#pPrev').disabled = curPage <= 1;
    view.querySelector('#pNext').disabled = curPage >= tp;
  }
  // V4.14.9：手输页码跳页（Enter 或改完失焦生效）
  const jumpTo = () => {
    const inp = view.querySelector('#pJump');
    const tp = Math.max(1, Math.ceil(total / SIZE));
    const p = Math.min(Math.max(1, Number(inp.value) || 1), tp);
    if (p !== curPage) loadProducts(p);
  };
  view.querySelector('#pJump').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); jumpTo(); } });
  view.querySelector('#pJump').addEventListener('change', jumpTo);
  // V4.9.5 毛利润率 =（售价-最新进价）/ 售价（进价缺失不显示）
  const marginCell = p => {
    const sell = Number(p.sell_price), cost = Number(p.cost_price);
    if (!(sell > 0) || !(cost > 0)) return '<span class="muted">—</span>';
    const m = (sell - cost) / sell;
    const pct = (m * 100).toFixed(1) + '%';
    return m >= 0
      ? `<span style="color:var(--green,#1a8a4a);font-weight:600">${pct}</span>`
      : `<span style="color:#c0392b;font-weight:600">${pct}</span>`;
  };
  /* V5.0.0 连锁：商品归属标签（后端回带 owner_kind='hq'|'local' 与 owner_store_id）
   * 门店视图显示「总部 / 本店自建」；总部跨店视图下门店自建品标注来源门店名。 */
  function ownerTag(p) {
    if (p.owner_kind === 'hq')
      return ' <span class="tag g" style="font-size:10px;padding:1px 6px;margin-left:4px" title="总部统一建档并下发">总部</span>';
    const s = chain.hq ? chain.stores.find(x => Number(x.id) === Number(p.owner_store_id)) : null;
    return ` <span class="tag b" style="font-size:10px;padding:1px 6px;margin-left:4px" title="门店自建商品">${s ? esc(s.name) : '本店自建'}</span>`;
  }
  function drawTable() {
    const kw = (view.querySelector('#pKw')?.value || '').trim();   // V4.26.3：命中高亮
    const items = all.filter(p => tabK ? tabMatch(p, tabK) : true);
    view.querySelector('#pList').innerHTML = items.length ? `
      <table class="tb" style="width:100%;font-size:12.5px">
        <thead><tr>
          <th style="width:34px"><input type="checkbox" id="pChkAll" title="全选/取消全选本页" ${items.length && items.every(p => delSel.has(Number(p.id))) ? 'checked' : ''}></th>
          <th class="seq">序号</th>
          <th>商品名称</th><th>条码</th><th>规格</th><th>单位</th><th>分类</th>
          <th class="num">进货价</th><th class="num">售价</th><th class="num">会员价</th>
          <th class="num">批发价</th><th style="text-align:center">会员折扣</th><th class="num">利润率</th>          <th class="num">库存</th><th>供货商</th><th style="width:44px">打签</th>
        </tr></thead>
        <tbody>${items.map((p, i) => {
          const st = statusOf(p);
          return `<tr data-pid="${p.id}" style="cursor:pointer;${Number(p.id) === selId ? 'background:var(--green-soft)' : ''}" title="点击看详情，双击编辑">
            <td onclick="event.stopPropagation()"><input type="checkbox" data-pchk="${p.id}" ${delSel.has(Number(p.id)) ? 'checked' : ''}></td>
            <td class="num seq">${i + 1}</td>
            <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis"><b>${emojiOf(p)} ${hl(p.name, kw)}</b>
              <span class="tag ${st.c}" style="font-size:10px;padding:1px 6px;margin-left:4px">${st.t}</span>${p.is_weighted ? ' <span class="tag b" style="font-size:10px;padding:1px 6px">散称</span>' : ''}${chain.enabled ? ownerTag(p) : ''}</td>
            <td style="font-family:var(--mono)">${hl(p.barcode || (p.is_weighted ? 'PLU ' + (p.goods_no || '') : '—'), kw)}</td>
            <td class="muted">${esc(p.spec || '—')}</td>
            <td>${esc(p.base_unit || '—')}</td>
            <td class="muted" style="max-width:110px;overflow:hidden;text-overflow:ellipsis">${esc(p.category_name || '—')}</td>
            <td class="num">${Number(p.cost_price || 0) > 0 ? money(p.cost_price) : '—'}</td>
            <td class="num" style="color:var(--pri);font-weight:700">${money(p.sell_price)}${Number(p.store_price_stores) > 0 ? ` <span class="tag y" style="font-size:10px;padding:1px 6px;white-space:nowrap" title="该商品在 ${p.store_price_stores} 家门店设有门店特价（来自本地门店调价单）；此处显示的是默认价">🏪${p.store_price_stores}店特价</span>` : ''}</td>
            <td class="num" ${Number(p.price_warn) === 0 ? 'style="color:#c0392b;font-weight:700" title="⚠ 会员价低于进价，请调整会员价或进价"' : ''}>${p.member_price != null ? money(p.member_price) : '—'}${Number(p.price_warn) === 0 ? ' <span class="tag r" style="font-size:10px;padding:1px 6px">低于进价</span>' : ''}</td>
            <td class="num">${p.wholesale_price != null ? money(p.wholesale_price) : '—'}</td>
            <td style="text-align:center">${hasDiscount(p) ? '<span class="tag g" style="font-size:10px;padding:1px 8px">是</span>' : '<span class="muted">否</span>'}</td>
            <td class="num">${marginCell(p)}</td>
            <td class="num">${Number(p.stock_qty || 0)} ${esc(p.base_unit || '')}</td>
            <td class="muted" style="max-width:120px;overflow:hidden;text-overflow:ellipsis">${esc(p.supplier_name || '—')}</td>
            <td style="text-align:center"><button class="btn sm" data-tag="${p.id}" title="打印价签">🏷</button></td>
          </tr>`;
        }).join('')}</tbody></table>` : (kw
          ? noResult(`没有匹配「${kw}」的商品`, '可试试名称片段、条码后四位或拼音首字母（如「测试商品」→ cssp）')
          : noResult('没有符合条件的商品', '换个状态筛选，或点右上角「＋ 新增商品」建档'));
    view.querySelectorAll('[data-pid]').forEach(tr => {
      tr.onclick = () => selectRow(Number(tr.dataset.pid));
      tr.ondblclick = () => { selectRow(Number(tr.dataset.pid)); openEdit(Number(tr.dataset.pid)); };
    });
    // V5.0.4：行内打签图标 → 单品快捷打签（阻止冒泡，不触发行点击详情）
    view.querySelectorAll('[data-tag]').forEach(b => b.onclick = e => { e.stopPropagation(); if (Number(b.dataset.tag)) openOneTagModal(Number(b.dataset.tag)); });
    // 勾选（删除用）：不触发行点击
    view.querySelectorAll('[data-pchk]').forEach(cb => cb.onchange = () => {
      const pid = Number(cb.dataset.pchk);
      if (cb.checked) delSel.add(pid); else delSel.delete(pid);
      syncDelBtn();
    });
    const chkAll = view.querySelector('#pChkAll');
    if (chkAll) chkAll.onchange = () => {
      items.forEach(p => { if (chkAll.checked) delSel.add(Number(p.id)); else delSel.delete(Number(p.id)); });
      drawTable();
      syncDelBtn();   // V4.14.9 修复：全选/取消全选后同步「删除所选」按钮（此前漏调导致勾不动）
    };
  }

  /* ── 勾选删除（软删除留痕；有在库库存后端拒绝）。V4.14.9：样式化确认弹窗 + 人话文案 ── */
  const delSel = new Set();
  function syncDelBtn() {
    const btn = view.querySelector('#pDel');
    btn.style.display = delSel.size ? '' : 'none';
    view.querySelector('#pDelN').textContent = String(delSel.size);
    // V4.15.7 P2：价签批量打印按钮与勾选联动
    const tagBtn = view.querySelector('#pTags');
    tagBtn.style.display = delSel.size ? '' : 'none';
    view.querySelector('#pTagN').textContent = String(delSel.size);
    // V5.0.0 连锁：总部「下发到门店」/ 门店「申请上架」按钮（按视图与勾选联动）
    const pub = view.querySelector('#pPublish');
    const ap = view.querySelector('#pApplyList');
    if (pub) {
      const show = chain.enabled && chain.hq && vMode === 'sellable' && delSel.size > 0;
      pub.style.display = show ? '' : 'none';
      view.querySelector('#pPubN').textContent = String(delSel.size);
    }
    if (ap) {
      // 门店在「总部档案（可查）」视图勾选 → 批量申请上架（总控权在总部：默认需总部批准）
      const show = chain.enabled && !chain.hq && vMode === 'browse' && delSel.size > 0;
      ap.style.display = show ? '' : 'none';
      view.querySelector('#pApplyN').textContent = String(delSel.size);
    }
    // V5.0.0 R2：总部在「门店自建品」视图勾选 → 批量收编为总部品
    const ad = view.querySelector('#pAdopt');
    if (ad) {
      const show = chain.enabled && chain.hq && vMode === 'local' && delSel.size > 0;
      ad.style.display = show ? '' : 'none';
      view.querySelector('#pAdoptN').textContent = String(delSel.size);
    }
  }
  view.querySelector('#pDel').onclick = async () => {
    const ids = [...delSel];
    const names = all.filter(p => delSel.has(Number(p.id))).map(p => p.name).join('、');
    if (!ids.length) return;
    const ok = await confirmBox({
      title: '🗑 删除所选商品',
      okText: '确认删除',
      html: `确定删除选中的 <b>${ids.length}</b> 个商品吗？<br>
        <div style="margin:8px 0;padding:8px 12px;background:var(--paper-2,#f5f2e9);border-radius:8px;font-size:12.5px;max-height:120px;overflow:auto">${esc(names)}</div>
        <span class="muted" style="font-size:12.5px">删除后商品列表里不再显示（记录保留，可恢复）。<b style="color:#c0392b">还有库存的商品删不掉</b>——需要先通过报损/盘点把库存清零。</span>`,
    });
    if (!ok) return;
    let okN = 0; const errs = [];
    for (const id of ids) {
      try { await must(del(`/products/${id}`)); okN++; delSel.delete(id); }
      catch (e) { errs.push(e.msg || e.message || '未知错误'); }
    }
    syncDelBtn();
    if (errs.length) toast(`成功删除 ${okN} 个，${errs.length} 个未删除：${errs[0]}${errs.length > 1 ? ` 等 ${errs.length} 项` : ''}`, false);
    else toast(`已删除 ${okN} 个商品（可恢复）`);
    await loadCatCounts();
    drawTree();
    await loadProducts(curPage);
  };

  /* ── V5.0.0 连锁：总部「下发到门店」（勾选商品 → 选目标门店 → 写门店台账 = 可售） ── */
  view.querySelector('#pPublish').onclick = async () => {
    const ids = [...delSel];
    if (!ids.length) return;
    if (!chain.stores.length) return toast('没有可下发的门店（请先在「门店管理」新建门店）', false);
    const names = all.filter(p => delSel.has(Number(p.id))).map(p => p.name).join('、');
    const { mask } = openDetailModal('📤 下发商品到门店', `
      <div class="muted" style="font-size:12.5px;padding:2px 0 10px">
        下发后该门店即可**销售**这些商品（写入门店下发台账）。门店仍可自行沽清，但不可覆盖总部的强制停售。
      </div>
      <div class="fld"><label>目标门店</label>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto;padding:2px 0">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            <input type="checkbox" id="pbAll" checked> <b>全部门店</b>（含以后新开门店？仅当前营业门店）</label>
          ${chain.stores.map(s => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;padding-left:16px">
            <input type="checkbox" data-pbstore="${s.id}" checked> 🏪 ${esc(s.name)} <span class="muted">${esc(s.store_no || '')}</span></label>`).join('')}
        </div></div>
      <div class="fld"><label>下发后门店状态</label>
        <select id="pbListed">
          <option value="1" selected>立即上架（门店可售）</option>
          <option value="0">先下架（门店自行决定何时上架）</option>
        </select></div>
      <div style="margin:8px 0;padding:8px 12px;background:var(--paper-2,#f5f2e9);border-radius:8px;font-size:12.5px;max-height:110px;overflow:auto">
        <b>${ids.length}</b> 个商品：${esc(names)}</div>
      <div class="bar" style="justify-content:flex-end;margin-top:10px;gap:10px">
        <button class="btn" id="pbCancel">取消</button>
        <button class="btn pri" id="pbGo">📤 确认下发</button></div>`);
    mask.querySelector('#pbAll').onchange = e => {
      mask.querySelectorAll('[data-pbstore]').forEach(cb => { cb.checked = e.target.checked; cb.disabled = e.target.checked; });
    };
    mask.querySelector('#pbCancel').onclick = () => mask.remove();
    mask.querySelector('#pbGo').onclick = async () => {
      const all2 = mask.querySelector('#pbAll').checked;
      const sids = all2 ? 'all'
        : [...mask.querySelectorAll('[data-pbstore]')].filter(cb => cb.checked).map(cb => Number(cb.dataset.pbstore));
      if (!all2 && !sids.length) return toast('请至少选择一个门店', false);
      const listed = mask.querySelector('#pbListed').value === '1';
      try {
        const r = await must(post('/hq/products/publish', { productIds: ids, storeIds: sids, listed }));
        mask.remove(); delSel.clear(); syncDelBtn(); drawTable();
        toast(`✅ 已下发：${r.published} 个商品 × ${r.stores} 家门店${r.skipped ? `（跳过 ${r.skipped} 个门店自建品，需先收编）` : ''}`);
        await loadProducts(curPage);
      } catch { /* must 已提示 */ }
    };
  };

  /* ── V5.0.0 连锁：门店「申请上架」（可查总部档案 → 申请本店销售；默认需总部批准） ── */
  view.querySelector('#pApplyList').onclick = async () => {
    const ids = [...delSel];
    if (!ids.length) return;
    const names = all.filter(p => delSel.has(Number(p.id))).map(p => p.name).join('、');
    const ok = await confirmBox({
      title: '📥 申请上架',
      okText: '提交申请',
      html: `向总部申请在本店销售以下 <b>${ids.length}</b> 个总部商品？<br>
        <div style="margin:8px 0;padding:8px 12px;background:var(--paper-2,#f5f2e9);border-radius:8px;font-size:12.5px;max-height:110px;overflow:auto">${esc(names)}</div>
        <span class="muted" style="font-size:12.5px">总部批准后即可在本店收银台销售；总部可在「商品下发」里一键批量处理。</span>`,
    });
    if (!ok) return;
    let okN = 0, pending = 0, errs = [];
    for (const pid of ids) {
      try {
        const r = await must(post('/store/products/apply', { productId: pid }));
        if (r.status === 'approved') okN++; else pending++;
        delSel.delete(pid);
      } catch (e) { errs.push(e.msg || e.message || '未知错误'); }
    }
    syncDelBtn(); drawTable();
    const parts = [];
    if (okN) parts.push(`已通过 ${okN} 个`);
    if (pending) parts.push(`待总部审核 ${pending} 个`);
    if (errs.length) parts.push(`失败 ${errs.length} 个（${errs[0]}）`);
    toast(parts.join('，') || '未提交任何申请', !errs.length);
    if (okN) await loadProducts(curPage);
  };

  /* ── V5.0.0 连锁 R2：总部「收编门店自建品」（改归属为总部 → 成为全连锁档案） ── */
  view.querySelector('#pAdopt').onclick = async () => {
    const ids = [...delSel];
    if (!ids.length) return;
    const picked = all.filter(p => delSel.has(Number(p.id)));
    const names = picked.map(p => p.name).join('、');
    const { mask } = openDetailModal('🧬 收编为总部商品', `
      <div class="muted" style="font-size:12.5px;padding:2px 0 10px">
        收编后商品归属改为<b>总部</b>，成为全连锁共享档案，可下发到任意门店。<br>
        历史销售 / 库存 / 批次引用<b>不受影响</b>（商品 id 不变）。
      </div>
      <div class="fld"><label>标准进价 L1（可选）</label>
        <input id="adL1" type="number" step="0.01" placeholder="留空 → 保持原值（推荐）"
               style="flex:1">
        <div class="muted" style="font-size:11.5px;margin-top:4px;line-height:1.7">
          ⚠️ 留空是<b>安全默认</b>：不把某家门店拿到的价变成全连锁的红线兜底。<br>
          确实要采纳该店进价作为全连锁标准进价时再填。
        </div></div>
      <div class="fld"><label>同时下发到</label>
        <select id="adPub" style="flex:1">
          <option value="none" selected>仅原建店门店（保证不断货）</option>
          <option value="all">全部门店</option>
        </select></div>
      <div style="margin:8px 0;padding:8px 12px;background:var(--paper-2,#f5f2e9);border-radius:8px;font-size:12.5px;max-height:110px;overflow:auto">
        <b>${ids.length}</b> 个商品：${esc(names)}</div>
      <div class="bar" style="justify-content:flex-end;margin-top:10px;gap:10px">
        <button class="btn" id="adCancel">取消</button>
        <button class="btn pri" id="adGo">🧬 确认收编</button></div>`);
    mask.querySelector('#adCancel').onclick = () => mask.remove();
    mask.querySelector('#adGo').onclick = async () => {
      const l1v = mask.querySelector('#adL1').value.trim();
      const pubTo = mask.querySelector('#adPub').value;
      try {
        const r = await must(post('/hq/products/adopt', {
          productIds: ids,
          publishTo: pubTo === 'all' ? 'all' : 'none',
          adoptL1: l1v ? Number(l1v) : undefined,
        }));
        mask.remove(); delSel.clear(); syncDelBtn(); drawTable();
        toast(`✅ 已收编 ${r.adopted} 个商品（来自 ${r.stores} 家门店）${r.skipped ? `，跳过 ${r.skipped} 个（已是总部品）` : ''}${r.published ? `，追加下发 ${r.published} 次` : ''}`);
        await loadProducts(curPage);
      } catch { /* must 已提示 */ }
    };
  };

  /* ── 价签批量打印：勾选商品 → 优先默认价签机（可改份数即打）/ 否则选机 ── */
  view.querySelector('#pTags').onclick = async () => {
    const ids = [...delSel];
    if (!ids.length) return;
    const ps = await must(get('/printers')).catch(() => []);
    const labelPrinters = (Array.isArray(ps) ? ps : []).filter(p => (p.printer_type || '小票') === '标签');
    if (!labelPrinters.length) return toast('暂无标签机：请先到「打印中心」新增一台设备类型为「标签机」的打印机（网口/串口）', false);
    const d = await must(post('/printers/price-tags', { ids }));
    const items = d.items || [];
    if (!items.length) return toast('未取到可打印的商品数据', false);
    const promoN = items.filter(i => i.promoPrice != null).length;
    const def = labelPrinters.find(p => p.is_default && p.default_for === 'pricetag'); // V5.0.4 默认价签机
    // 有默认价签机：弹「可改份数」确认条，免选机直接打
    if (def) {
      const { mask } = openDetailModal('🏷 价签打印', `
        <div class="muted" style="font-size:12.5px;padding:2px 0 8px">
          将用默认价签机 <b>${esc(def.name)}</b>（${esc(def.brand || '通用')} · ${esc(def.label_size || '40x30')}）打印
          <b>${items.length}</b> 个商品${promoN ? `（<b style="color:var(--warn)">${promoN}</b> 个有特价，标签自动印划线原价+促销价）` : ''}。</div>
        <div class="fld" style="max-width:300px"><label>每品份数</label>
          <input id="ptCopies" type="number" min="1" max="50" value="1" style="width:100px"></div>
        <div class="bar" style="justify-content:flex-end;margin-top:10px;gap:10px">
          <span class="muted" id="ptTip"></span>
          <button class="btn" id="ptExport">📊 导出 Excel</button>
          <button class="btn" id="ptCancel">取消</button>
          <button class="btn pri" id="ptGo">🖨 打印 ${items.length} 品</button>
        </div>`, { width: 520 });
      mask.querySelector('#ptCancel').onclick = () => mask.remove();
      mask.querySelector('#ptExport').onclick = () => exportTagItems(items);
      mask.querySelector('#ptGo').onclick = () => doPrintTags(mask, def.id, items);
      return;
    }
    // 无默认价签机：回退选机弹窗（默认选中带 pricetag 用途的，否则第一台）
    const dflt = labelPrinters.find(p => p.default_for === 'pricetag') || labelPrinters[0];
    const { mask } = openDetailModal('🏷 价签批量打印', `
      <div class="muted" style="font-size:12.5px;padding:2px 0 8px">
        共 <b>${items.length}</b> 个商品${promoN ? `（其中 <b style="color:var(--warn)">${promoN}</b> 个有进行中促销价，标签自动印「划线原价 + 促销价」）` : ''}。
        价签含 品名/售价/促销价/条码/单位·规格·保质期，按标签机纸型排版。</div>
      <div class="fld" style="max-width:420px"><label>标签机</label>
        <select id="ptPrinter">${labelPrinters.map(p =>
          `<option value="${p.id}" ${p.id === dflt.id ? 'selected' : ''}>${esc(p.name)}（${esc(p.brand || '通用')} · ${esc(p.label_size || '40x30')} · ${esc(p.conn_type)}${p.conn_addr ? ' ' + esc(p.conn_addr) : ''}）</option>`).join('')}</select></div>
      <div class="fld" style="max-width:420px"><label>每品份数</label>
        <input id="ptCopies" type="number" min="1" max="50" value="1" style="width:100px"></div>
      <table style="margin-top:6px"><thead><tr><th class="seq">序号</th><th>商品</th><th>条码</th><th>单位</th><th>规格</th>
        <th class="num">售价</th><th class="num">促销价</th></tr></thead>
      <tbody>${items.map((i, idx) => `<tr>
        <td class="num seq">${idx + 1}</td><td><b>${esc(i.name)}</b></td><td class="mono">${esc(i.barcode || '—')}</td><td>${esc(i.unit || '—')}</td>
        <td class="muted">${esc(i.spec || '—')}</td><td class="num">${money(i.price)}</td>
        <td class="num" style="color:${i.promoPrice != null ? 'var(--warn)' : 'inherit'}">${i.promoPrice != null ? money(i.promoPrice) : '—'}</td></tr>`).join('')}</tbody></table>
      <div class="bar" style="justify-content:flex-end;margin-top:10px;gap:10px">
        <span class="muted" id="ptTip"></span>
        <button class="btn" id="ptExport">📊 导出 Excel</button>
        <button class="btn" id="ptCancel">取消</button>
        <button class="btn pri" id="ptGo">🖨 打印标签</button>
      </div>`, { width: 760 });
    mask.querySelector('#ptCancel').onclick = () => mask.remove();
    mask.querySelector('#ptExport').onclick = () => exportTagItems(items);
    mask.querySelector('#ptGo').onclick = () => doPrintTags(mask, Number(mask.querySelector('#ptPrinter').value), items);
  };

  /* V5.0.4：批量价签直发（份数从弹窗读取；发送逻辑见模块顶层 fireTags） */
  async function doPrintTags(mask, printerId, items) {
    const copies = Math.min(Math.max(Number(mask.querySelector('#ptCopies').value) || 1, 1), 50);
    const tip = mask.querySelector('#ptTip');
    tip.textContent = '发送中…';
    try {
      if (await fireTags(printerId, items, copies)) { mask.remove(); delSel.clear(); syncDelBtn(); }
    } catch {
      tip.textContent = '';
      toast('打印失败：网络或串口发送异常（已留痕，可重试或改用网口）', false);
    }
  }

  /* ── 详情弹窗（点行弹出；关键信息两列栅格，去冗余说明） ── */
  const detModal = view.querySelector('#detModal');
  const SAMPLE_MAX = 6;   // V4.9.8 详情弹窗样本图最多展示 6 张
  const sampleThumb = s => {
    const p = String(s.image_path || '');
    // V4.16.5：img:// 本机帧路径（未上传）渲染占位格子，不再出现破图
    if (p.startsWith('img://')) return `
    <div style="text-align:center;width:68px">
      <div style="width:64px;height:64px;margin:0 auto;border-radius:8px;border:1px dashed var(--line);display:grid;place-items:center;font-size:10.5px;color:var(--ink-3);text-align:center">本机帧<br>未上传</div>
      <div class="muted" style="font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.angle || '样本')} · ${esc(s.status)}${s.task_no ? ' · ' + esc(s.task_no) : ''}</div>
    </div>`;
    return `
    <div data-sample="${esc(imgUrl(s.image_path))}" style="cursor:zoom-in;text-align:center;width:68px">
      <img src="${esc(imgUrl(s.image_path))}" loading="lazy" style="width:64px;height:64px;border-radius:8px;object-fit:cover;border:1px solid var(--line)"
           onerror="this.style.opacity=.25">
      <div class="muted" style="font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.angle || '样本')} · ${esc(s.status)}${s.task_no ? ' · ' + esc(s.task_no) : ''}</div>
    </div>`;
  };
  const fmtSampleCnt = arr => `最近 ${Math.min(SAMPLE_MAX, arr.length)} 张 / 共 ${arr.length} 张，点击放大`;
  const dcell = (k, v) => `
    <div style="min-width:0;padding:6px 2px;border-bottom:1px dashed var(--line);font-size:12.5px">
      <div class="muted" style="font-size:11px;margin-bottom:2px">${k}</div>
      <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis">${v}</div>
    </div>`;
  async function selectRow(pid) {
    selId = pid;
    const d = await must(get('/products/' + pid));
    selDetail = d;
    const p = d.product || {};
    const st = statusOf(p);
    const catChain = flatCats().find(c => Number(c.id) === Number(p.category_id));
    const units = d.units || [];
    const samplesSorted = (d.aiSamples || []).slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0));   // V4.9.8 最新在前，最多展示 6 张
    // V4.16.5 左图 = 商城图（可点击上传/替换，右键清除）；四方端展示优先商城图
    const mallImg = p.mall_image || p.photo_path || '';
    const photo = mallImg
      ? `<img id="dtMallImg" src="${esc(imgUrl(mallImg))}" title="点击上传/替换商城图，右键清除" style="width:72px;height:72px;border-radius:12px;object-fit:cover;border:1px solid var(--line);cursor:pointer">`
      : `<div id="dtMallImg" title="点击上传商城图（会员商城/小票/收银展示）" style="width:72px;height:72px;border-radius:12px;background:linear-gradient(150deg,#e8f3ea,#d5e8f5);display:grid;place-items:center;font-size:36px;cursor:pointer">${emojiOf(p)}<span style="position:absolute;font-size:9px;color:var(--ink-3);margin-top:52px">上传商城图</span></div>`;
    // 供应商：主供应商 + 其他报价供应商
    const supSet = [];
    for (const s of (d.supplierPrices || [])) {
      const nm = s.supplier_name || ('供应商' + s.supplier_id);
      if (!supSet.includes(nm)) supSet.push(nm);
    }
    const mainSup = p.supplier_name || supSet[0] || '—';
    const otherSups = supSet.filter(n => n !== mainSup);
    const discountTxt = p.member_discount != null && Number(p.member_discount) > 0
      ? `${Number(p.member_discount) < 1 ? '是（' + (Number(p.member_discount) * 10).toFixed(1).replace(/\.0$/, '') + ' 折）' : '否'}` : '否';
    view.querySelector('#dtTitle').textContent = `🏷️ ${p.name || '商品详情'}`;
    view.querySelector('#dtBody').innerHTML = `
      <div style="display:flex;gap:14px;align-items:center;padding:8px 0 10px">
        ${photo}
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 18px;flex:1;min-width:0">
          ${dcell('状态', `<span class="tag ${st.c}">${st.t}</span>`)}
          ${dcell('商品名称', esc(p.name || '—'))}
          ${dcell('条码', `<span class="mono">${esc(p.barcode || (p.is_weighted ? 'PLU ' + (p.goods_no || '') : '—'))}</span>`)}
          ${dcell('货号（SPU）', esc(p.goods_no || '—'))}
          ${dcell('规格', esc(p.spec || '—'))}
          ${dcell('单位', esc(p.base_unit || '—'))}
          ${dcell('分类', catChain ? esc(catChain.chain.map(x => x.name).join(' ▸ ')) : '—')}
          ${dcell('进货价', Number(p.cost_price || 0) > 0 ? money(p.cost_price) + ' <span class="muted" style="font-weight:400;font-size:11px">（仅调价单可改）</span>' : '—')}
          ${dcell('售价', `<span style="color:var(--pri)">${money(p.sell_price)}</span>${Number(p.store_price_stores) > 0 ? ` <span class="muted" style="font-size:11px">（默认价；另有 <b style="color:#b5544a">${p.store_price_stores}</b> 家门店设了门店特价，收银按各店价结算）</span>` : ''}`)}
          ${dcell('会员价', (p.member_price != null && Number(p.cost_price || 0) > 0 && Number(p.member_price) > 0 && Number(p.member_price) < Number(p.cost_price))
            ? `<span style="color:#c0392b;font-weight:700">${money(p.member_price)} ⚠ 低于进价</span>`
            : (p.member_price != null ? money(p.member_price) : '—'))}
          ${dcell('批发价', p.wholesale_price != null ? money(p.wholesale_price) : '—')}
          ${dcell('最低卖价', Number(p.min_price) > 0 ? `<span style="color:#b5544a;font-weight:700">${money(p.min_price)}</span> <span class="muted" style="font-size:11px">（收银改价下限）</span>` : `<span class="muted">未设 → 按<b>进价</b>兜底${Number(p.cost_price) > 0 ? `（¥${money(p.cost_price)}）` : '（无进价记录则不限制）'}</span>`)}
          ${dcell('最低折扣', Number(p.min_discount_rate) > 0 ? `<span style="color:#b5544a;font-weight:700">${Number(p.min_discount_rate)} 折</span> <span class="muted" style="font-size:11px">（收银打折下限）</span>` : '<span class="muted">未设 → 受<b>进价</b>兜底（不得低于进价销售）</span>')}
          ${dcell('会员折扣', discountTxt)}
          ${dcell('供货商（主）', esc(mainSup))}
          ${dcell('其他供货商', otherSups.length ? esc(otherSups.join('、')) : '—')}
          ${dcell('保质期', p.keep_days ? `${p.keep_days} 天` : '<span class="tag y">未填 · 禁售拦截</span>')}
          ${dcell('库存', `${Number(p.stock_qty || 0)} ${esc(p.base_unit || '')}`)}
          ${dcell('库存上下限', `${Number(p.min_stock || 0)} ~ ${Number(p.max_stock || 0)}`)}
          ${dcell('经营方式', esc(p.biz_mode || '购销'))}
          ${dcell('商城', `<span class="tag ${p.online_visible === false ? 'y' : 'g'}">${p.online_visible === false ? '未上架' : '已上架'}</span>`)}
          ${dcell('AI 识别样本', `${Number(d.aiSampleCount || 0)} 张`)}
          ${dcell('记库存 / 称重', `${p.track_inventory === false ? '✗' : '✓'} / ${p.is_weighted ? '✓ 称重' : '✗'}`)}
        </div>
      </div>
      ${(d.aiSamples || []).length ? `
        <div style="padding:10px 0 2px;border-top:1px dashed var(--line)">
          <div class="muted" style="font-size:12px;margin-bottom:6px;display:flex;align-items:center;gap:10px">
            <span id="dtSampleCnt">${fmtSampleCnt(samplesSorted)}</span>
            <button class="btn" id="dtSampleRefresh" style="font-size:11.5px;padding:2px 10px">🔄 加载最新</button>
          </div>
          <div id="dtSampleGrid" style="display:flex;flex-wrap:wrap;gap:8px">
            ${samplesSorted.slice(0, SAMPLE_MAX).map(sampleThumb).join('')}
          </div>
        </div>` : ''}
      ${units.length ? `
        <div style="padding-top:12px;border-top:1px dashed var(--line);margin-top:10px">
          <div class="muted" style="font-size:12px;margin-bottom:6px">🔄 多单位换算</div>
          <table class="tb" style="width:100%;font-size:12px;text-align:left;table-layout:auto"><thead><tr>
              <th class="seq">序号</th><th style="white-space:nowrap">包装单位</th><th style="white-space:nowrap">换算到基本单位</th><th style="white-space:nowrap;min-width:150px">该包装条码</th></tr></thead>
          <tbody>
            <tr><td class="num">—</td><td style="white-space:normal"><b>${esc(p.base_unit || '')}</b>（基本）</td><td style="white-space:normal">1 ${esc(p.base_unit || '')}</td><td class="mono" style="white-space:normal;word-break:break-all;min-width:150px">${esc(p.barcode || '—')}</td></tr>
            ${units.map((u, i) => `<tr><td class="num seq">${i + 1}</td><td style="white-space:normal"><b>${esc(u.unit_name)}</b></td><td style="white-space:normal">1 ${esc(u.unit_name)} = ${Number(u.rate)} ${esc(p.base_unit || '')}</td>
              <td class="mono" style="white-space:normal;word-break:break-all;min-width:150px">${esc(u.barcode || '—')}</td></tr>`).join('')}
          </tbody></table>
        </div>` : ''}
      ${(d.supplierPrices || []).length ? `
        <div style="padding-top:12px">
          <div class="muted" style="font-size:12px;margin-bottom:6px">🚚 供应商进价历史（最近 ${Math.min(5, d.supplierPrices.length)} 次）</div>
          <table class="tb" style="width:100%;font-size:12px"><thead><tr><th class="seq">序号</th><th>供应商</th><th class="num">进价</th><th class="num">历史最低</th><th>来源单据</th><th>时间</th></tr></thead>
          <tbody>${d.supplierPrices.slice(0, 5).map((s, i) => `<tr>
            <td class="num seq">${i + 1}</td><td>${esc(s.supplier_name || '供应商' + s.supplier_id)}</td>
            <td class="num">${money(s.price)}</td>
            <td class="num muted">${money(s.min_price)}</td>
            <td class="muted mono">${esc(s.source_doc || '—')}</td>
            <td class="muted">${dt(s.created_at)}</td>
          </tr>`).join('')}</tbody></table>
        </div>` : ''}`;

    // 样本大图预览（点击缩略图 → 全屏遮罩，点击关闭）；抽成函数供「加载最新」刷新后重绑
    const bindDtSamples = () => view.querySelectorAll('#dtBody [data-sample]').forEach(el => el.onclick = () => {
      const lb = document.createElement('div');
      lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.78);z-index:9999;display:grid;place-items:center;cursor:zoom-out;padding:24px';
      lb.innerHTML = `<img src="${esc(el.dataset.sample)}" style="max-width:92vw;max-height:92vh;border-radius:12px;box-shadow:0 12px 48px rgba(0,0,0,.5)">`;
      lb.onclick = () => lb.remove();
      document.body.appendChild(lb);
    });
    bindDtSamples();

    // V4.16.5 商城图上传/替换（点击左图）与清除（右键）
    const mallEl = view.querySelector('#dtMallImg');
    if (mallEl) {
      const fileIn = document.createElement('input');
      fileIn.type = 'file'; fileIn.accept = 'image/png,image/jpeg,image/webp';
      fileIn.style.display = 'none';
      view.appendChild(fileIn);
      mallEl.onclick = () => fileIn.click();
      fileIn.onchange = () => {
        const f = fileIn.files && fileIn.files[0];
        if (!f) return;
        if (f.size > 6 * 1024 * 1024) return toast('图片过大（≤6MB）', false);
        const rd = new FileReader();
        rd.onload = async () => {
          try {
            await must(post(`/products/${selId}/mall-image`, { image: String(rd.result) }), '商城图已上传（会员商城/小票/收银同步展示）');
            selectRow(selId);
          } catch { /* must 已 toast */ }
        };
        rd.readAsDataURL(f);
      };
      mallEl.oncontextmenu = async e => {
        e.preventDefault();
        if (!p.mall_image) return toast('当前展示的是档案图/占位图，仅上传后的商城图可清除', false);
        const ok = await confirmBox({ title: '清除商城图？', html: '<div class="doc-tip">清除后四方端回退展示档案图（photo）。</div>', okText: '清除' });
        if (!ok) return;
        await must(del(`/products/${selId}/mall-image`), '商城图已清除');
        selectRow(selId);
      };
    }

    // V4.9.8 加载最新样本图片：重新拉取商品详情，仍最多展示 6 张（最新在前）
    const dtSampleRefresh = view.querySelector('#dtSampleRefresh');
    if (dtSampleRefresh) dtSampleRefresh.onclick = async () => {
      if (!selId) return;
      try {
        const nd = await must(get('/products/' + selId));
        const ns = (nd.aiSamples || []).slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
        const grid = view.querySelector('#dtSampleGrid'), cnt = view.querySelector('#dtSampleCnt');
        if (grid) grid.innerHTML = ns.slice(0, SAMPLE_MAX).map(sampleThumb).join('');
        if (cnt) cnt.textContent = fmtSampleCnt(ns);
        bindDtSamples();
        if (selDetail) selDetail.aiSamples = nd.aiSamples;
        toast('已加载最新图片');
      } catch { /* must 已 toast */ }
    };

    // 商城上/下架按钮：按当前状态显示对应动作（上架 ⇄ 下架）
    const dtOnline = view.querySelector('#dtOnline');
    const isOnline = p.online_visible !== false;
    dtOnline.textContent = isOnline ? '🛒 商城下架（停售）' : '🛒 商城上架';
    dtOnline.onclick = async () => {
      const r = await must(put(`/products/${selId}/online`, { visible: !isOnline }), !isOnline ? '已上架商城' : '已下架商城（会员端立即不可见）');
      selDetail.product.online_visible = r.onlineVisible;
      selectRow(selId);
    };
    detModal.style.display = 'flex';
  }
  // V4.14.2：去除「关闭」文字按钮（右上 ✕ / 遮罩点击关闭）

  /* ── 筛选（V4.26.3 改由 .seg 组件自管，选中态与数量角标都在 drawSeg 里） / 搜索即输即筛 ── */
  drawSeg();
  let kwTimer = null;
  view.querySelector('#pKw').addEventListener('input', () => {
    clearTimeout(kwTimer);
    kwTimer = setTimeout(() => loadProducts(1), 300);
  });
  view.querySelector('#pKw').addEventListener('keydown', e => { if (e.key === 'Enter') loadProducts(1); });
  view.querySelector('#pPrev').onclick = () => loadProducts(curPage - 1);
  view.querySelector('#pNext').onclick = () => loadProducts(curPage + 1);

  /* ── 新增商品弹窗 ── */
  const modal = view.querySelector('#pModal');
  const unitModal = view.querySelector('#unitModal');
  const $ = sel => view.querySelector(sel);

  // V5.0.3：库存下限/上限强制非负整数（step=1 仍可键入小数，此处统一取整）
  for (const id of ['mMinStock', 'mMaxStock', 'eMinStock', 'eMaxStock']) {
    const el = $('#' + id);
    if (el) el.onchange = () => { el.value = el.value === '' ? '' : String(Math.max(0, Math.floor(Number(el.value) || 0))); };
  }
  // V5.0.3：业务文本输入禁用浏览器账号/密码自动填充启发式（保存时误弹「保存密码」）
  view.querySelectorAll?.('#pModal input[type="text"], #pModal input:not([type])').forEach(inp => {
    if (!inp.hasAttribute('autocomplete') && !inp.hasAttribute('list')) inp.setAttribute('autocomplete', 'off');
  });

  // 基本单位字典（前端维护；「＋」弹窗可扩充，本次会话内全表单共用）
  const COMMON_UNITS = ['个', '瓶', '袋', '盒', '箱', '提', '罐', '听', '支', '桶', '包', '卷', '双', '套', '片', '块', '斤', '公斤', '克', '升', '毫升'];
  let unitList = [...COMMON_UNITS];
  let aliasChips = [];   // 一品多码：附加条码集合
  let pkgChips = [];     // 一品多包装：{ unitName, rate, barcode }

  function renderUnitSel() {
    const cur = $('#mUnit').value;
    // V4.9.13 起 mUnit/eUnit 改用自绘面板（attachUnitPicker），不再挂原生 datalist（双下拉）；unitDl 仅供一品多包装单位输入框使用
    $('#unitDl').innerHTML = unitList.map(u => `<option value="${esc(u)}">`).join('');
  }

  /* ── V4.9.13/V4.9.14 自绘选择面板：聚焦/点击显示全量候选，仅输入时过滤 ──
     取代原生 datalist：原生在输入框已有值时只显示过滤结果（误以为"只有填入的数据"），
     且与自绘面板并存会出现双下拉。泛化后单位/分类/供货商四处共用。 ── */
  function attachPickPanel(input, { getList, onPick, emptyHint = '无匹配——可直接输入', maxWidth = '360px', docRoot = document }) {
    const panel = docRoot.createElement('div');
    input.parentElement.style.position = 'relative';
    Object.assign(panel.style, {
      position: 'absolute', top: '100%', left: '0', zIndex: '70', display: 'none',
      flexWrap: 'wrap', gap: '6px', padding: '8px', background: 'var(--card)',
      border: '1px solid var(--line-2)', borderRadius: '10px', boxShadow: 'var(--shadow)',
      maxWidth, maxHeight: '190px', overflow: 'auto', boxSizing: 'border-box',
    });
    input.parentElement.appendChild(panel);
    const render = kw => {
      const list = getList(kw);
      panel.innerHTML = list.length
        ? list.map(v => `<button type="button" data-pick="${esc(v)}" style="padding:4px 12px;border:1px solid var(--line);border-radius:12px;background:var(--card);cursor:pointer;font-size:12.5px">${esc(v)}</button>`).join('')
        : `<span class="muted" style="font-size:11.5px;align-self:center">${esc(emptyHint)}</span>`;
    };
    input.addEventListener('focus', () => { render(''); panel.style.display = 'flex'; });
    input.addEventListener('input', () => { render(input.value.trim().toLowerCase()); panel.style.display = 'flex'; });
    input.addEventListener('blur', () => setTimeout(() => { panel.style.display = 'none'; }, 180));
    panel.addEventListener('mousedown', e => {
      const b = e.target.closest('[data-pick]');
      if (!b) return;
      e.preventDefault();                       // 防止抢焦点触发 blur 先收起面板
      input.value = b.dataset.pick;
      if (onPick) onPick(b.dataset.pick);
      panel.style.display = 'none';
    });
  }
  const attachUnitPicker = (input, docRoot) => attachPickPanel(input, {
    docRoot,
    getList: kw => kw ? unitList.filter(u => u.toLowerCase().includes(kw)) : unitList,
    onPick: v => { if (!unitList.includes(v)) { unitList.push(v); renderUnitSel(); } },
    emptyHint: '无匹配——可直接输入新单位，保存后自动加入单位库',
  });
  // 分类/供货商同款面板：getList 惰性取值，面板弹出时才读最新数据
  const catChainName = c => c.chain.map(x => x.name).join(' / ');
  const attachCatPicker = el => el && attachPickPanel(el, {
    getList: kw => {
      const all = flatCats().map(catChainName);
      return kw ? all.filter(n => n.toLowerCase().includes(kw) || n.split(' / ').some(x => x.toLowerCase().includes(kw))) : all;
    },
    emptyHint: '无匹配——可点右侧「＋」快速新增分类', maxWidth: '420px',
  });
  const attachSupPicker = el => el && attachPickPanel(el, {
    getList: kw => {
      const all = suppliers.map(s => s.name);
      return kw ? all.filter(n => n.toLowerCase().includes(kw)) : all;
    },
    emptyHint: '无匹配——请先到供应商档案建档', maxWidth: '420px',
  });
  function renderSupSels() {
    // V4.9.14 起供货商候选改由自绘面板（attachSupPicker）惰性渲染；supDl datalist 已无引用，保留空元素仅为兼容
  }
  function renderAliasChips() {
    // 条码换行显示（每行一条）
    $('#mAliasChips').innerHTML = aliasChips.length ? aliasChips.map((b, i) => `
      <span style="display:flex;align-items:center;gap:8px;padding:5px 8px 5px 10px;background:var(--green-soft);border:1px solid var(--line-2);border-radius:10px;font-family:var(--mono);font-size:12.5px;width:100%;box-sizing:border-box">
        <b style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b)}</b>
        <button data-adel="${i}" title="移除该条码" style="border:none;background:#fff;border-radius:50%;width:18px;height:18px;line-height:16px;cursor:pointer;color:#c0392b;font-weight:700;padding:0;flex:none">−</button>
      </span>`).join('') : '';
    $('#mAliasChips').querySelectorAll('[data-adel]').forEach(btn => btn.onclick = () => {
      aliasChips.splice(Number(btn.dataset.adel), 1); renderAliasChips();
    });
  }
  function renderPkgChips() {
    const base = $('#mUnit').value || '基本单位';
    $('#mPkgChips').innerHTML = pkgChips.length ? pkgChips.map((u, i) => `
      <span style="display:inline-flex;align-items:center;gap:8px;padding:5px 8px 5px 10px;background:#eef4fb;border:1px solid var(--line-2);border-radius:14px;font-size:12.5px;max-width:100%">
        ${u.barcode ? `<b class="mono">${esc(u.barcode)}</b>` : '<b class="mono muted">无码</b>'}
        <span>→</span>
        <b>1 ${esc(u.unitName)}</b><span>=</span><b class="num">${Number(u.rate)}</b><span>${esc(base)}</span>
        <button data-pdel="${i}" title="移除该包装" style="border:none;background:#fff;border-radius:50%;width:18px;height:18px;line-height:16px;cursor:pointer;color:#c0392b;font-weight:700;padding:0;flex:none">−</button>
      </span>`).join('') : '';
    $('#mPkgChips').querySelectorAll('[data-pdel]').forEach(btn => btn.onclick = () => {
      pkgChips.splice(Number(btn.dataset.pdel), 1); renderPkgChips();
    });
  }
  function resetForm() {
    for (const id of ['mBarcode', 'mName', 'mSpec', 'mPrice', 'mMember', 'mKeep', 'mCost', 'mWholesale', 'mUnit', 'mCatIn', 'mSupIn', 'mAliasIn', 'mPkgUnit', 'mPkgRate', 'mPkgBarcode']) $('#' + id).value = '';
    aliasChips = []; pkgChips = [];
    $('#mKeepUnit').value = '1';
    $('#mDiscount').value = '';
    $('#mBcHint').textContent = '';
    renderAliasChips(); renderPkgChips(); renderUnitSel();
  }

  view.querySelector('#pNew').onclick = () => { modal.style.display = 'flex'; resetForm(); $('#mBarcode').focus(); };
  // V5.0.16：新建商品「记库存/称重」互斥联动（勾其一自动取消另一个）
  bindStockWeighExclusive($('#mTrack'), $('#mWeighted'));

  /* ── V4.9.11 条码大数据自动填充：输码/扫码 → 查本店库+在线条码库 → 只填空位不覆盖已填，全部可改 ── */
  const bcHint = $('#mBcHint');
  let bcTimer = null, bcSeq = 0;
  const fillIfEmpty = (sel, val) => {
    const el = $(sel);
    if (!el || val === null || val === undefined || val === '') return false;
    if (String(el.value).trim()) return false;              // 已填不覆盖（用户可后续手动改）
    el.value = String(val);
    return true;
  };
  const lookupBarcodeFill = async () => {
    const code = String($('#mBarcode').value || '').trim();
    if (!/^\d{8,14}$/.test(code)) { bcHint.textContent = ''; return; }
    const seq = ++bcSeq;                                    // 防乱序回包
    bcHint.textContent = '🔎 正在查询条码库（本店库 → 在线条码库）…';
    try {
      const d = await must(get(`/products/barcode-lookup/${code}`));
      if (seq !== bcSeq) return;
      if (d.exists) {
        bcHint.innerHTML = `⚠️ 本店已有该条码商品：<b>${esc(d.name)}</b>（保存重复条码会被拦截；如需修改请到商品详情编辑）`;
        return;
      }
      const filled = [];
      if (fillIfEmpty('#mName', d.name)) filled.push('商品名称');
      if (fillIfEmpty('#mSpec', d.spec)) filled.push('规格');
      if (fillIfEmpty('#mUnit', d.unit)) filled.push('单位');
      if (fillIfEmpty('#mPrice', d.price)) filled.push('预估售价');
      const conf = d.confirmed ? `<b style="color:var(--ok)">♻️ 本店确认档案</b>（此前建档纠错回写，最真实）` : esc(d.source);
      const warn = d.unverified ? `<b style="color:#c07800">⚠️ 网络参考数据，请逐项核对</b>——确认保存后将自动回写为本店确认档案，下次直接采用` : '';
      bcHint.innerHTML = filled.length
        ? `✅ 已从【${conf}】自动填充：${filled.join(' / ')}${filled.includes('预估售价') ? '（在线预估价，请按本店定价核对）' : ''} —— 填充项均可直接修改；<b style="color:var(--err)">保质期</b>等其余必填项请人工补全${warn ? '<br>' + warn : ''}`
        : `ℹ️ 条码库有记录，但需填字段均已填，未覆盖（来源：${conf}）`;
    } catch (e) {
      if (seq !== bcSeq) return;
      bcHint.innerHTML = `ℹ️ 条码库未收录，请手工建档（${esc(e.message)}）`;
    }
  };
  $('#mBarcode').addEventListener('input', () => { clearTimeout(bcTimer); bcTimer = setTimeout(lookupBarcodeFill, 500); });
  $('#mBarcode').addEventListener('change', lookupBarcodeFill);
  $('#mBarcode').addEventListener('keydown', e => { if (e.key === 'Enter') setTimeout(lookupBarcodeFill, 0); });  // 扫码枪回车即查（不影响既有回车跳格）
  // 分类行「＋」快速新增分类（弹窗保存后自动刷新分类查询列表）
  $('#mCatAdd').onclick = () => openCatModal('add', catId);
  // 分类栏收起/展开：收起后主表格铺满整个窗口
  view.querySelector('#catToggle').onclick = () => {
    const cp = view.querySelector('#catPanel');
    const show = cp.style.display === 'none';
    cp.style.display = show ? 'flex' : 'none';
    view.querySelector('#catToggle').style.background = show ? '' : 'var(--green-soft)';
  };
  view.querySelector('#mCancel').onclick = () => { modal.style.display = 'none'; };

  // 基本单位「＋」→ 添加单位子弹窗（输入快速匹配，点选即用；无匹配可新增）
  function renderUnitMatch() {
    const kw = $('#uSearch').value.trim().toLowerCase();
    const hits = unitList.filter(u => !kw || u.toLowerCase().includes(kw));
    const isNew = $('#uSearch').value.trim() && !unitList.some(u => u === $('#uSearch').value.trim());
    $('#uMatch').innerHTML =
      `<span class="muted" style="font-size:11px;align-self:center;width:100%">${hits.length ? '点击选用：' : '无匹配，可新增：'}</span>` +
      hits.slice(0, 12).map(u => `<button data-upick="${esc(u)}" style="padding:4px 12px;border:1px solid var(--line-2);border-radius:14px;background:#fff;cursor:pointer;font-size:12.5px">${esc(u)}</button>`).join('') +
      (isNew ? `<button data-unew="1" style="padding:4px 12px;border:1px solid var(--pri);border-radius:14px;background:var(--green-soft);color:var(--pri);cursor:pointer;font-size:12.5px;font-weight:700">＋ 新增「${esc($('#uSearch').value.trim())}」</button>` : '');
    $('#uMatch').querySelectorAll('[data-upick]').forEach(b => b.onclick = () => {
      $('#mUnit').value = b.dataset.upick; unitModal.style.display = 'none';
    });
    const unew = $('#uMatch').querySelector('[data-unew]');
    if (unew) unew.onclick = () => { const v = $('#uSearch').value.trim(); unitList.push(v); renderUnitSel(); $('#mUnit').value = v; unitModal.style.display = 'none'; };
  }
  $('#mUnitAdd').onclick = () => { $('#uSearch').value = ''; renderUnitMatch(); unitModal.style.display = 'flex'; $('#uSearch').focus(); };
  attachUnitPicker($('#mUnit'));                                     // V4.9.13 新增弹窗单位面板
  attachUnitPicker(view.querySelector('#eUnit'));                    // V4.9.13 编辑弹窗同享
  attachCatPicker($('#mCatIn'));                                     // V4.9.14 分类面板（新增弹窗）
  attachCatPicker(view.querySelector('#eCatIn'));                    // V4.9.14 分类面板（编辑弹窗）
  attachSupPicker($('#mSupIn'));                                     // V4.9.14 供货商面板（新增弹窗）
  attachSupPicker(view.querySelector('#eSupIn'));                    // V4.9.14 供货商面板（编辑弹窗）
  $('#uSearch').addEventListener('input', renderUnitMatch);
  $('#uSearch').addEventListener('keydown', e => { if (e.key === 'Enter') $('#uGo').click(); });
  $('#uCancel').onclick = () => { unitModal.style.display = 'none'; };
  $('#uGo').onclick = () => {
    const v = $('#uSearch').value.trim();
    if (!v) return toast('请输入单位名称', false);
    if (!unitList.includes(v)) unitList.push(v);
    renderUnitSel(); $('#mUnit').value = v;
    unitModal.style.display = 'none';
  };

  // 一品多码：输入/扫码（回车自动添加）→ 逐行固定显示，− 移除；重复条码提示已存在
  const barcodeExists = b =>
    aliasChips.includes(b) || b === $('#mBarcode').value.trim() || pkgChips.some(u => u.barcode === b);
  const aliasAdd = () => {
    const b = $('#mAliasIn').value.trim();
    if (!b) return;
    if (barcodeExists(b)) { $('#mAliasIn').value = ''; return toast(`该条码已存在：${b}`, false); }
    aliasChips.push(b); $('#mAliasIn').value = ''; renderAliasChips(); $('#mAliasIn').focus();
  };
  $('#mAliasAdd').onclick = aliasAdd;
  $('#mAliasIn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); aliasAdd(); } });

  // 一品多包装：单位 + 换算数量 → 添加 → 逐行固定显示，− 移除；重复条码提示已存在
  const pkgAdd = () => {
    const unitName = $('#mPkgUnit').value.trim();
    const rate = Number($('#mPkgRate').value);
    const barcode = $('#mPkgBarcode').value.trim() || null;
    if (!unitName) return toast('请输入包装单位（如 箱/提）', false);
    if (!(rate > 0)) return toast('换算数量必填且大于 0（1 箱 = ? 个基本单位）', false);
    if (unitName === $('#mUnit').value) return toast('包装单位不能与基本单位相同', false);
    if (pkgChips.some(u => u.unitName === unitName)) return toast(`包装单位「${unitName}」已添加`, false);
    if (barcode && barcodeExists(barcode)) return toast(`该条码已存在：${barcode}`, false);
    pkgChips.push({ unitName, rate, barcode });
    for (const id of ['mPkgUnit', 'mPkgRate', 'mPkgBarcode']) $('#' + id).value = '';
    renderPkgChips(); $('#mPkgBarcode').focus();
  };
  $('#mPkgAdd').onclick = pkgAdd;
  // V4.9.5 一品多包装行内导航：回车逐格切换（条码→单位→换算数量→添加）；←/→ 左右键快速切格（光标在边界时）
  const pkgFields = ['mPkgBarcode', 'mPkgUnit', 'mPkgRate'];
  const pkgNav = (curId, dir) => {
    const i = pkgFields.indexOf(curId);
    const nx = $('#' + pkgFields[i + dir]);
    if (nx) { nx.focus(); return true; }
    return false;
  };
  // number 输入框 selectionStart 为 null → 视作始终在边界（允许 ←/→ 切格）
  const atEdge = (inp, dir) => {
    if (inp.selectionStart == null) return true;
    return dir < 0 ? (inp.selectionStart === 0 && inp.selectionEnd === 0)
      : (inp.selectionStart === inp.value.length && inp.selectionEnd === inp.value.length);
  };
  pkgFields.forEach((id, idx) => {
    $('#' + id).addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (idx < pkgFields.length - 1) pkgNav(id, 1);   // 行内回车 → 下一格
        else pkgAdd();                                    // 末格回车 → 添加
      } else if (e.key === 'ArrowRight' && atEdge(e.target, 1)) {
        e.preventDefault(); pkgNav(id, 1);
      } else if (e.key === 'ArrowLeft' && atEdge(e.target, -1)) {
        e.preventDefault(); pkgNav(id, -1);
      }
    });
  });

  // 回车跳下一行 / ↑↓ 快速切换输入行（一品多码/多包装条码格除外——回车=扫码自动添加）
  modal.addEventListener('keydown', e => {
    const t = e.target;
    if (!t || t.dataset === undefined || t.dataset.navskip !== undefined) return;
    if (t.tagName !== 'INPUT' && t.tagName !== 'SELECT') return;
    if (t.type === 'checkbox') return;
    const list = [...modal.querySelectorAll('input:not([data-navskip]),select:not([data-navskip])')]
      .filter(el => el.type !== 'checkbox' && el.offsetParent !== null);
    const i = list.indexOf(t);
    if (i < 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const nx = list[i + 1];
      nx ? nx.focus() : $('#mSave').focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[i + 1] && list[i + 1].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[i - 1] && list[i - 1].focus();
    }
  });

  $('#mSave').onclick = async () => {
    const barcode = $('#mBarcode').value.trim();
    const name = $('#mName').value.trim();
    const price = Number($('#mPrice').value);
    const keepNum = Number($('#mKeep').value);
    if (!barcode) return toast('条码必填（预包装商品请用扫码枪扫入或手输）', false);
    if (!/^\d+$/.test(barcode)) return toast('条码须为纯数字（不支持字母或字母+数字组合）', false);
    if (!name) return toast('商品名称必填', false);
    // 单位：输入式（查询选择，无的自动更新单位表）
    const unitName = $('#mUnit').value.trim();
    if (!unitName) return toast('单位必填', false);
    if (!unitList.includes(unitName)) { unitList.push(unitName); renderUnitSel(); }
    if (!(price > 0)) return toast('售价必填且大于 0', false);
    if (!(keepNum > 0)) return toast('保质期必填', false);
    const keepDaysNew = Math.round(keepNum * Number($('#mKeepUnit').value));
    if (keepDaysNew < 1 || keepDaysNew > 32750) return toast(`保质期换算成天须在 1～32750 天内（当前 ${keepDaysNew} 天，请检查数量×单位）`, false);
    const catQuery = $('#mCatIn').value.trim();
    const catHit = catQuery ? flatCats().find(c =>
      c.chain.map(x => x.name).join(' / ') === catQuery || c.name === catQuery) : null;
    if (!catHit) return toast('分类必填（输入查询选择；无合适分类点「＋」快速新增）', false);
    // 供货商：输入快速查询（名称命中即选用，留空 → 入库单自动关联）
    const supQuery = $('#mSupIn').value.trim();
    const supHit = supQuery ? suppliers.find(s => s.name === supQuery) : null;
    if (supQuery && !supHit) return toast(`供货商「${supQuery}」不存在（请输入查询选择，或先到供应商档案建档）`, false);
    // V4.9.7 价格红线：售价 / 会员价 严禁低于进价（活动价允许低于进价，走促销活动）
    const mCostV = Number($('#mCost').value);
    const mPriceV = Number($('#mPrice').value);
    const mMemberV = Number($('#mMember').value);
    if (mCostV > 0 && mPriceV > 0 && mPriceV < mCostV) return toast(`售价 ${mPriceV} 低于进价 ${mCostV}，严禁保存（活动低价请走「促销活动」）`, false);
    if (mCostV > 0 && mMemberV > 0 && mMemberV < mCostV) return toast(`会员价 ${mMemberV} 低于进价 ${mCostV}，严禁保存`, false);
    const keepDays = keepDaysNew;
    // V4.25.3 价格红线自检：最低卖价不得高于售价；最低折扣 1~100
    const mMinPriceV = Number($('#mMinPrice').value) || 0;
    const mMinDiscV = Number($('#mMinDisc').value) || 0;
    if (mMinPriceV > 0 && mMinPriceV > mPriceV) return toast(`最低卖价 ${mMinPriceV} 高于售价 ${mPriceV}，请检查`, false);
    if (mMinDiscV > 0 && (mMinDiscV < 1 || mMinDiscV > 100)) return toast('最低折扣须在 1~100 之间（如 80 = 最低 8 折）', false);
    if (mMinPriceV > 0 && mCostV > 0 && mMinPriceV < mCostV) toast(`提示：最低卖价 ${mMinPriceV} 低于进价 ${mCostV}，实际销售仍以进价兜底（不得低于进价销售）`, false);
    // V4.25.6 库存上下限自检：上限不得低于下限（0 = 未设）
    const mMinStk = Number($('#mMinStock').value) || 0;
    const mMaxStk = Number($('#mMaxStock').value) || 0;
    if (mMaxStk > 0 && mMinStk > mMaxStk) return toast(`库存上限 ${mMaxStk} 低于下限 ${mMinStk}，请检查`, false);
    const d = await must(post('/products', {
      name,
      barcode: barcode,
      spec: $('#mSpec').value.trim() || undefined,
      base_unit: unitName,
      sellPrice: price,
      minPrice: mMinPriceV,
      minDiscountRate: mMinDiscV,
      memberPrice: Number($('#mMember').value) || undefined,
      wholesalePrice: Number($('#mWholesale').value) || undefined,
      memberDiscount: $('#mDiscount').value === '1' ? 0.9 : undefined,
      costPrice: Number($('#mCost').value) > 0 ? Number($('#mCost').value) : undefined,
      supplierDefaultId: supHit ? Number(supHit.id) : undefined,
      categoryId: Number(catHit.id),
      bizMode: $('#mBizMode').value,
      minStock: Number($('#mMinStock').value) || 0,   // V4.25.6：库存上下限（0 = 不预警/不限制）
      maxStock: Number($('#mMaxStock').value) || 0,
      trackInventory: $('#mTrack').checked,
      isWeighted: $('#mWeighted').checked,
      keepDays,
      units: pkgChips.map(u => ({ unitName: u.unitName, rate: u.rate, barcode: u.barcode })),
    }), '建档成功');
    // 一品多码：建档成功后写入附加条码（被占用会明确报错；失败不阻断——主档已建成，可稍后编辑重试）
    if (d && d.id && aliasChips.length) {
      try { await must(post(`/products/${d.id}/barcodes`, { barcodes: aliasChips }), '附加条码已写入'); }
      catch (e) { toast(`商品已建档，但附加条码写入失败：${e.message}（可在编辑商品中重试）`, false); }
    }
    modal.style.display = 'none';
    resetForm();
    await loadCatCounts();
    drawTree();
    await loadProducts(1);
  };

  /* ── 批量导入（模板下载 / 文本粘贴 / 文件 txt·csv·xls·xlsx） ── */
  const impModal = view.querySelector('#impModal');
  view.querySelector('#pImport').onclick = () => { view.querySelector('#impResult').innerHTML = ''; impModal.style.display = 'flex'; };
  view.querySelector('#impCancel').onclick = () => { impModal.style.display = 'none'; };

  /* ── V4.16.3 外部商品池：导入（xlsx/CSV）+ 搜索列表；建档未命中本店库时先查池秒回补齐 ── */
  view.querySelector('#pPool').onclick = () => {
    const mask = document.createElement('div');
    mask.className = 'drawer-mask';
    mask.innerHTML = `
      <div class="drawer" style="max-width:860px">
        <h3>🌐 外部商品池 </h3>
        <div class="bar muted">供应商全量目录 / 行业条码库导入的「参考商品数据」——不进正式档案；
          建档/扫码未命中本店库时先查这里<b>本地秒回</b>补齐名称/规格/类目，再走在线查询，两者互补。</div>
        <div class="bar" style="margin:10px 0">
          <input id="poolQ" placeholder="🔍 条码 / 名称 / 品牌 / 类别" style="flex:1;min-width:200px">
          <button class="btn" id="poolSearch">🔍 搜索</button>
          <button class="btn" id="poolPick">📂 选择文件导入（csv / excel）</button>
          <input type="file" id="poolFile" accept=".csv,.xlsx,.xls" style="display:none">
          <span class="muted" id="poolCnt"></span>
        </div>
        <div id="poolList" style="max-height:56dvh;overflow:auto"></div>
        <div class="bar muted" style="margin-top:8px">表头需含 <b>条码/名称</b> 列（可选：规格/单位/品牌/类别/售价）；
          同条码重复导入自动更新；条码须 8~14 位数字，无效行自动跳过。</div>
        <div class="bar" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="poolClose">关闭</button></div>
      </div>`;
    document.body.appendChild(mask);
    mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
    mask.querySelector('#poolClose').onclick = () => mask.remove();
    const list = mask.querySelector('#poolList'), cnt = mask.querySelector('#poolCnt');
    const load = async () => {
      const kw = mask.querySelector('#poolQ').value.trim();
      const r = await must(get(`/products/pool?q=${encodeURIComponent(kw)}&size=100`));
      cnt.textContent = `共 ${r.total} 条`;
      list.innerHTML = r.items.length ? `
        <table><thead><tr><th class="seq">序号</th><th>条码</th><th>名称</th><th>规格</th><th>单位</th><th>品牌</th><th>类别</th><th class="num">参考价</th><th class="num">被查次数</th><th>批次</th></tr></thead>
        <tbody>${r.items.map((x, i) => `<tr>
          <td class="num seq">${i + 1}</td><td>${esc(x.barcode)}</td><td>${esc(x.name)}</td><td>${esc(x.spec || '—')}</td>
          <td>${esc(x.unit || '—')}</td><td>${esc(x.brand || '—')}</td><td>${esc(x.category || '—')}</td>
          <td class="num">${x.price != null ? money(x.price) : '—'}</td>
          <td class="num">${Number(x.hits || 0)}</td><td class="muted">${esc(x.batch_no || '—')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">池中暂无数据——选择供应商目录/行业条码库文件导入</div>';
    };
    mask.querySelector('#poolSearch').onclick = load;
    mask.querySelector('#poolQ').onkeydown = e => { if (e.key === 'Enter') load(); };
    const pick = mask.querySelector('#poolPick'), file = mask.querySelector('#poolFile');
    // 桌面端 Web 后台，file input 用 display:none 无兼容问题（安卓 WebView 相机意图坑仅限 PWA）
    pick.onclick = () => file.click();
    file.onchange = () => {
      const f = file.files?.[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = async () => {
        const b64 = String(rd.result).split(',')[1] || '';
        pick.disabled = true; pick.textContent = '⏳ 导入中…';
        try {
          const r = await must(post('/products/pool/import', { filename: f.name, b64 }), '导入完成');
          toast(`导入完成：新增 ${r.inserted} · 更新 ${r.updated} · 跳过 ${r.skipped}`);
          await load();
        } catch (e) { /* must 已 toast 错误 */ }
        pick.disabled = false; pick.textContent = '📂 选择文件导入（csv / excel）';
        file.value = '';
      };
      rd.readAsDataURL(f);
    };
    load();
  };

  // CSV 行解析（支持引号包裹、双写转义）
  const splitCsvLine = line => {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
      else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const csvJoin = fields => fields.map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',');
  // 条码规范化：Excel 长数字转科学计数 / 浮点尾巴 / 非数字字符 → 纯数字字符串
  const normBarcode = v => {
    let s = String(v ?? '').trim();
    if (!s) return '';
    if (/^\d+(\.\d+)?[eE]\+?\d+$/.test(s)) {           // 科学计数：6.901234500011e12
      const [m, e] = s.split(/[eE]\+?/);
      const [i, f = ''] = m.split('.');
      const exp = Number(e);
      s = i + f + '0'.repeat(Math.max(0, exp - f.length));
    }
    s = s.replace(/\.0+$/, '');                         // 6901234500011.0 → 去浮点尾
    s = s.replace(/\D/g, '');                           // 去空格/千分位/其他符号
    return s;
  };
  // 表头模糊匹配 → 标准字段（列与模板对齐；支持常见别名）
  const HEAD_MAP = [
    [/名称|品名|name/i, 'name'], [/条码|条形码|barcode/i, 'barcode'],
    [/单位|unit/i, 'baseUnit'], [/售价|零售价|价格|sellPrice|price/i, 'sellPrice'],
    [/保质期单位|keepUnit/i, 'keepUnit'], [/保质期(?!单位)|保质期天|keep/i, 'keepDays'],
    [/规格|spec/i, 'spec'],
    [/分类|类别|category/i, 'categoryName'], [/进货价|进价|cost/i, 'costPrice'],
    [/会员价|memberPrice/i, 'memberPrice'], [/批发价|wholesale/i, 'wholesalePrice'],
    [/会员折扣|discount/i, 'memberDiscount'], [/供货商|供应商|supplier/i, 'supplierName'],
  ];
  const mapRows = headRow => bodyRows => bodyRows.map(cells => {
    const o = {};
    headRow.forEach((h, i) => { const m = HEAD_MAP.find(([re]) => re.test(String(h || ''))); if (m) o[m[1]] = cells[i]; });
    const discRaw = String(o.memberDiscount ?? '').trim();
    return {
      name: o.name || '', barcode: normBarcode(o.barcode), baseUnit: o.baseUnit || '', sellPrice: o.sellPrice || '',
      keepDays: o.keepDays || '', keepUnit: String(o.keepUnit || '').trim(), spec: o.spec || '', categoryName: o.categoryName || '',
      costPrice: o.costPrice || '', memberPrice: o.memberPrice || '', wholesalePrice: o.wholesalePrice || '',
      memberDiscount: discRaw === '是' ? '0.9' : (/^(否|无|不参与|0)$/.test(discRaw) ? '' : discRaw),
      supplierName: o.supplierName || '',
    };
  }).filter(r => r.name);

  // ── 模板下载（Excel 格式：SpreadsheetML .xls；列与主表格对齐，必填列标注（必填），列宽保证列名完整显示，全列文本格式防条码变形） ──
  view.querySelector('#pDlTpl').onclick = () => {
    const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const head = ['商品名称（必填）', '条码（必填）', '单位（必填）', '售价（必填）', '保质期（必填）', '保质期单位（必填）',
                  '规格', '分类', '进货价', '会员价', '批发价', '会员折扣（是/否）', '供货商'];
    const widths = [140, 135, 70, 80, 90, 130, 95, 120, 85, 85, 85, 135, 160];
    const demo = [
      ['农夫山泉550ml', '6901234500011', '瓶', '2', '365', '天', '550ml', '饮料', '1.2', '1.8', '', '是', '岳池娃哈哈经贸部'],
      ['乐事薯片', '6901234500028', '袋', '6.5', '6', '月', '104g', '休闲食品', '4.2', '', '', '否', '乐事经销商'],
      ['红富士苹果', '2000000000021', '斤', '5.98', '30', '天', '80mm', '水果', '3.5', '', '', '', ''],
    ];
    const row = cells => `<Row>${cells.map(c => `<Cell><Data ss:Type="String">${escXml(c)}</Data></Cell>`).join('')}</Row>`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<?mso-application progid="Excel.Sheet"?>\n` +
      `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n` +
      `<Worksheet ss:Name="商品导入"><Table>` +
      widths.map(w => `<Column ss:Width="${w}"/>`).join('') +
      `${row(head)}${demo.map(row).join('')}</Table></Worksheet></Workbook>`;
    const url = URL.createObjectURL(new Blob(['\ufeff' + xml], { type: 'application/vnd.ms-excel' }));
    const a = document.createElement('a'); a.href = url; a.download = '商品批量导入模板.xls'; a.click();
    URL.revokeObjectURL(url);
  };

  // ── 文件读取：txt/csv 按行拆；xlsx 解压读 sheet1+sharedStrings；xls(SpreadsheetML) DOMParser ──
  async function fileToRows(file) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith('.xlsx')) {
      const buf = new Uint8Array(await file.arrayBuffer());
      const dv = new DataView(buf.buffer);
      // 定位 ZIP 中央目录（EOCD 记录 PK\x05\x06）
      let eocd = -1;
      for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
      }
      if (eocd < 0) throw new Error('xlsx 文件结构异常（找不到 ZIP 目录）');
      const count = dv.getUint16(eocd + 10, true);
      let off = dv.getUint32(eocd + 16, true);
      const files = {};
      for (let n = 0; n < count; n++) {
        if (dv.getUint32(off, true) !== 0x02014b50) break;
        const method = dv.getUint16(off + 10, true);
        const compSize = dv.getUint32(off + 20, true);
        const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), cmtLen = dv.getUint16(off + 32, true);
        const localOff = dv.getUint32(off + 42, true);
        const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
        files[name] = { method, compSize, localOff };
        off += 46 + nameLen + extraLen + cmtLen;
      }
      const inflate = async entry => {
        const { method, compSize, localOff } = entry;
        const lNameLen = dv.getUint16(localOff + 26, true), lExtraLen = dv.getUint16(localOff + 28, true);
        const data = buf.subarray(localOff + 30 + lNameLen + lExtraLen, localOff + 30 + lNameLen + lExtraLen + compSize);
        if (method === 0) return new TextDecoder().decode(data);
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([data]).stream().pipeThrough(ds);
        return new TextDecoder().decode(await new Response(stream).arrayBuffer());
      };
      if (!files['xl/worksheets/sheet1.xml']) throw new Error('xlsx 中未找到 sheet1 工作表');
      const shared = [];
      if (files['xl/sharedStrings.xml']) {
        const sx = new DOMParser().parseFromString(await inflate(files['xl/sharedStrings.xml']), 'text/xml');
        for (const si of sx.getElementsByTagName('si')) {
          shared.push([...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
        }
      }
      const sheet = new DOMParser().parseFromString(await inflate(files['xl/worksheets/sheet1.xml']), 'text/xml');
      const rows = [];
      for (const rowEl of sheet.getElementsByTagName('row')) {
        const cells = {};
        for (const c of rowEl.getElementsByTagName('c')) {
          const ref = (c.getAttribute('r') || '').match(/[A-Z]+/)?.[0] || '';
          let col = 0; for (const ch of ref) col = col * 26 + ch.charCodeAt(0) - 64;
          const t = c.getAttribute('t');
          let val = '';
          if (t === 's') { const v = c.getElementsByTagName('v')[0]?.textContent; val = v != null ? shared[Number(v)] ?? '' : ''; }
          else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
          else val = c.getElementsByTagName('v')[0]?.textContent ?? '';
          cells[col] = String(val ?? '').trim();
        }
        const arr = []; let max = 0; for (const k of Object.keys(cells)) max = Math.max(max, Number(k));
        for (let i = 1; i <= max; i++) arr.push(cells[i] || '');
        if (arr.some(Boolean)) rows.push(arr);
      }
      if (rows.length < 2) throw new Error('xlsx 中没有数据行');
      return mapRows(rows[0])(rows.slice(1));
    }
    const text = await file.text();
    if (lower.endsWith('.xls')) { // SpreadsheetML 2003
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      const rowEls = [...doc.getElementsByTagName('Row')];
      const lines = rowEls.map(r => [...r.getElementsByTagName('Cell')].map(c => (c.getElementsByTagName('Data')[0]?.textContent || '').trim()));
      if (lines.length < 2) throw new Error('xls 中没有数据行');
      return mapRows(lines[0])(lines.slice(1));
    }
    // txt / csv
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('文件为空');
    const hasHead = /名称|品名|name/i.test((lines[0] || '').split(',')[0] || '');
    const body = hasHead ? lines.slice(1) : lines;
    const head = hasHead ? splitCsvLine(lines[0]) : ['商品名称（必填）', '条码（必填）', '单位（必填）', '售价（必填）', '保质期（必填）', '保质期单位（必填）', '规格', '分类', '进货价', '会员价', '批发价', '会员折扣（是/否）', '供货商'];
    return mapRows(head)(body.map(splitCsvLine));
  }
  view.querySelector('#impPickFile').onclick = () => view.querySelector('#impFile').click();
  view.querySelector('#impFile').onchange = async () => {
    const f = view.querySelector('#impFile').files[0];
    if (!f) return;
    try {
      const rows = await fileToRows(f);
      view.querySelector('#impText').value = rows.map(r => csvJoin([r.name, r.barcode, r.baseUnit, r.sellPrice, r.keepDays, r.keepUnit || '天', r.spec, r.categoryName, r.costPrice, r.memberPrice, r.wholesalePrice, r.memberDiscount, r.supplierName])).join('\n');
      toast(`已解析 ${rows.length} 行，可预览/修改后点「导入」`);
    } catch (e) { toast(`文件解析失败：${e.message}（可另存为 csv 后重试）`, false); }
    view.querySelector('#impFile').value = '';
  };

  view.querySelector('#impGo').onclick = async () => {
    const text = view.querySelector('#impText').value.trim();
    if (!text) return toast('请粘贴内容或选择文件', false);
    const KEEP_MULT = { '天': 1, '日': 1, '月': 30, '年': 365 };
    const rows = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const c = splitCsvLine(line);
      const keepNum = Number(c[4]) || 0;
      const keepUnit = (c[5] || '天').trim();
      const mult = KEEP_MULT[keepUnit];
      const discRaw = (c[11] || '').trim();
      return {
        name: c[0], barcode: normBarcode(c[1]), baseUnit: c[2] || '个', sellPrice: Number(c[3]),
        keepDays: mult ? Math.round(keepNum * mult) : undefined,
        keepUnit, spec: c[6] || undefined, categoryName: c[7] || undefined,
        costPrice: Number(c[8]) > 0 ? Number(c[8]) : undefined,
        memberPrice: Number(c[9]) > 0 ? Number(c[9]) : undefined,
        wholesalePrice: Number(c[10]) > 0 ? Number(c[10]) : undefined,
        memberDiscount: discRaw === '是' ? 0.9 : (Number(discRaw) > 0 && Number(discRaw) < 1 ? Number(discRaw) : undefined),
        supplierName: c[12] || undefined,
      };
    });
    // 必填校验（V4.9.12 放宽保质期：文件即真相，已有商品按条码覆盖更新，缺保质期不拦）
    const bad = rows.filter(r => !r.name || !r.barcode || !r.baseUnit || !(r.sellPrice > 0));
    if (bad.length) return toast(`有 ${bad.length} 行必填项缺失（名称/条码/单位/售价），如：${bad[0].name || '(空名称)'}`, false);
    const d = await must(post('/products/import', { rows, upsert: true }), '导入完成');
    const okRows = (d.results || []).filter(x => x.ok), badRows = (d.results || []).filter(x => !x.ok);
    view.querySelector('#impResult').innerHTML = `
      <span class="tag g">新增 ${d.created ?? okRows.filter(x => x.action === 'created').length}</span>
      <span class="tag b">覆盖更新 ${d.updated ?? okRows.filter(x => x.action === 'updated').length}</span>
      <span class="tag r">失败 ${badRows.length}</span>
      ${badRows.map(x => `<div class="muted" style="font-size:12px">✗ ${esc(x.name || '(空行)')}：${esc(x.error || '')}</div>`).join('')}`;
    if (okRows.length) { view.querySelector('#impText').value = ''; await loadCatCounts(); drawTree(); await loadProducts(1); }
  };

  /* ── 编辑弹窗（与新增同版式；状态行 + 图片编辑；进价只读——仅调价单可改） ── */
  const editModal = view.querySelector('#editModal');
  let editPid = 0;
  function renderEditPhoto(photoPath, samples = []) {
    const prev = view.querySelector('#ePhotoPrev');
    const empty = view.querySelector('#ePhotoEmpty');
    // 图片三态：已设置主图 → 加载；无主图但有已审核样本 → 用已审核样本图；有样本但均未审核 → 审核中；否则 → 暂无图片
    const AUDITED = /已入库|合格|已审核|approved/i;
    const audited = samples.filter(s => s.image_path && AUDITED.test(String(s.status || '')));
    if (photoPath) {
      prev.src = imgUrl(photoPath); prev.style.display = ''; empty.style.display = 'none';
    } else if (audited.length) {
      prev.src = imgUrl(audited[0].image_path); prev.style.display = '';
      empty.style.display = ''; empty.textContent = '（主图未设置，暂用已审核识别样本图）';
    } else if ((samples || []).some(s => s.image_path)) {
      prev.src = ''; prev.style.display = 'none';
      empty.style.display = ''; empty.innerHTML = '<span class="tag y">图片审核中</span><span class="muted" style="font-size:11px">　样本经 AI 工单审核通过后自动启用</span>';
    } else {
      prev.src = ''; prev.style.display = 'none';
      empty.style.display = ''; empty.textContent = '暂无图片';
    }
  }
  /* ── V4.9.5 编辑弹窗：一品多码 / 一品多包装 chips（交互与新增弹窗一致，含重复条码互查） ── */
  let eAliasList = [], ePkgList = [];
  const eBarcodeConflict = b => !b || b === view.querySelector('#eBarcode').value.trim()
    || eAliasList.includes(b) || ePkgList.some(u => u.barcode === b);
  function renderEAlias() {
    const box = view.querySelector('#eAliasChips');
    box.innerHTML = eAliasList.map((b, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--green-soft);border:1px solid var(--line-2);border-radius:8px;font-family:var(--mono);font-size:12.5px">
        <span style="flex:1">${esc(b)}</span>
        <button data-earemove="${i}" title="移除该条码" style="border:none;background:#fff;border-radius:50%;width:20px;height:20px;line-height:18px;cursor:pointer;color:#c0392b;font-weight:700;padding:0">−</button>
      </div>`).join('');
    box.querySelectorAll('[data-earemove]').forEach(btn => btn.onclick = () => {
      eAliasList.splice(Number(btn.dataset.earemove), 1); renderEAlias();
    });
  }
  function renderEPkg() {
    const box = view.querySelector('#ePkgChips');
    box.innerHTML = ePkgList.map((u, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--paper-2);border:1px solid var(--line-2);border-radius:8px;font-size:12.5px">
        <span class="mono" style="min-width:118px">${esc(u.barcode || '—')}</span>
        <span><b>${esc(u.unitName)}</b> = ${u.rate} 基本单位</span>
        <span style="flex:1"></span>
        <button data-eiremove="${i}" title="移除该包装" style="border:none;background:#fff;border-radius:50%;width:20px;height:20px;line-height:18px;cursor:pointer;color:#c0392b;font-weight:700;padding:0">−</button>
      </div>`).join('');
    box.querySelectorAll('[data-eiremove]').forEach(btn => btn.onclick = () => {
      ePkgList.splice(Number(btn.dataset.eiremove), 1); renderEPkg();
    });
  }
  const eAliasAdd = () => {
    const b = view.querySelector('#eAliasIn').value.trim();
    if (!b) return;
    if (eBarcodeConflict(b)) { view.querySelector('#eAliasIn').value = ''; return toast('该条码已存在', false); }
    eAliasList.push(b); view.querySelector('#eAliasIn').value = ''; renderEAlias(); view.querySelector('#eAliasIn').focus();
  };
  view.querySelector('#eAliasAdd').onclick = eAliasAdd;
  view.querySelector('#eAliasIn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); eAliasAdd(); } });
  const ePkgAdd = () => {
    const barcode = view.querySelector('#ePkgBarcode').value.trim() || null;
    const unitName = view.querySelector('#ePkgUnit').value.trim();
    const rate = Number(view.querySelector('#ePkgRate').value);
    if (!unitName) return toast('请输入包装单位（如 箱/提）', false);
    if (!(rate > 0)) return toast('换算数量必填且大于 0（1 包装单位 = ? 个基本单位）', false);
    if (unitName === view.querySelector('#eUnit').value.trim()) return toast('包装单位不能与基本单位相同', false);
    if (ePkgList.some(u => u.unitName === unitName)) return toast(`包装单位「${unitName}」已添加`, false);
    if (barcode && eBarcodeConflict(barcode)) return toast('该条码已存在', false);
    ePkgList.push({ unitName, rate, barcode });
    for (const id of ['ePkgBarcode', 'ePkgUnit', 'ePkgRate']) view.querySelector('#' + id).value = '';
    renderEPkg(); view.querySelector('#ePkgBarcode').focus();
  };
  view.querySelector('#ePkgAdd').onclick = ePkgAdd;
  // 一品多包装行内导航：回车逐格（条码→单位→换算→添加）；←/→ 边界切格（与新增弹窗一致）
  const ePkgFields = ['ePkgBarcode', 'ePkgUnit', 'ePkgRate'];
  // number 输入框 selectionStart 为 null → 视作始终在边界（允许 ←/→ 切格）
  const eAtEdge = (inp, dir) => {
    if (inp.selectionStart == null) return true;
    return dir < 0 ? (inp.selectionStart === 0 && inp.selectionEnd === 0)
      : (inp.selectionStart === inp.value.length && inp.selectionEnd === inp.value.length);
  };
  ePkgFields.forEach((id, idx) => {
    view.querySelector('#' + id).addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const nx = view.querySelector('#' + ePkgFields[idx + 1]);
        if (nx) nx.focus(); else ePkgAdd();
      } else if (e.key === 'ArrowRight' && eAtEdge(e.target, 1)) {
        e.preventDefault(); const nx = view.querySelector('#' + ePkgFields[idx + 1]); if (nx) nx.focus();
      } else if (e.key === 'ArrowLeft' && eAtEdge(e.target, -1)) {
        e.preventDefault(); const pv = view.querySelector('#' + ePkgFields[idx - 1]); if (pv) pv.focus();
      }
    });
  });
  // 编辑弹窗：回车跳下一行 / ↑↓ 快速切换输入行（一品多码/多包装条码格除外——回车=扫码自动添加）
  editModal.addEventListener('keydown', e => {
    const t = e.target;
    if (!t || t.dataset === undefined || t.dataset.navskip !== undefined) return;
    if (t.tagName !== 'INPUT' && t.tagName !== 'SELECT') return;
    if (t.type === 'checkbox') return;
    const list = [...editModal.querySelectorAll('input:not([data-navskip]),select:not([data-navskip])')]
      .filter(el => el.type !== 'checkbox' && el.offsetParent !== null);
    const i = list.indexOf(t);
    if (i < 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const nx = list[i + 1];
      nx ? nx.focus() : view.querySelector('#emSave').focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); if (list[i + 1]) list[i + 1].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); if (list[i - 1]) list[i - 1].focus();
    }
  });

  async function openEdit(pid) {
    const d = await must(get(`/products/${pid}`));
    const p = d.product || {};
    editPid = Number(pid);
    // V4.9.5 一品多码/多包装回填（与新增弹窗同结构）
    eAliasList = (d.barcodes || []).slice();
    ePkgList = (d.units || [])
      .filter(u => u.unit_name !== (p.base_unit || '') && Number(u.rate) > 0)
      .map(u => ({ unitName: u.unit_name, rate: Number(u.rate), barcode: u.barcode || null }));
    renderEAlias(); renderEPkg();
    view.querySelector('#emTitle').textContent = '✏️ 编辑商品';
    view.querySelector('#eBarcode').value = p.barcode || '';
    view.querySelector('#eName').value = p.name || '';
    $('#eUnit').value = p.base_unit || '个';
    view.querySelector('#ePrice').value = p.sell_price ?? '';
    // V4.25.3 价格红线回填（0/NULL 视为未设）
    view.querySelector('#eMinPrice').value = Number(p.min_price) > 0 ? p.min_price : '';
    view.querySelector('#eMinDisc').value = Number(p.min_discount_rate) > 0 ? p.min_discount_rate : '';
    // 进货价 = 最新供应商进价（只读：进价变更只能走「商品调价单」，保证调价留痕可审）
    view.querySelector('#eCost').value = Number(p.cost_price || 0) > 0 ? p.cost_price : '';
    view.querySelector('#eMember').value = p.member_price ?? '';
    view.querySelector('#eWholesale').value = p.wholesale_price ?? '';
    view.querySelector('#eDiscount').value = (p.member_discount != null && Number(p.member_discount) > 0) ? '1' : '';
    view.querySelector('#eKeep').value = p.keep_days ?? '';
    // V5.0.3：保质期单位默认「天」（不再按整除自动切月/年，避免与录入习惯不一致）
    view.querySelector('#eKeepUnit').value = '1';
    // 分类/供货商：输入式回填（显示完整链名 / 供应商名）
    const catHit = flatCats().find(c => Number(c.id) === Number(p.category_id));
    view.querySelector('#eCatIn').value = catHit ? catHit.chain.map(x => x.name).join(' / ') : '';
    view.querySelector('#eSpec').value = p.spec || '';
    const supHit = suppliers.find(s => Number(s.id) === Number(p.supplier_default_id));
    view.querySelector('#eSupIn').value = supHit ? supHit.name : '';
    view.querySelector('#eBizMode').value = p.biz_mode || '购销';
    // V4.25.6 库存上下限回填（0/NULL 视为未设）
    view.querySelector('#eMinStock').value = Number(p.min_stock) > 0 ? p.min_stock : '';
    view.querySelector('#eMaxStock').value = Number(p.max_stock) > 0 ? p.max_stock : '';
    // V5.0.16：记库存/称重互斥回填；若历史数据两者同真（迁移前遗留），优先保留「称重」并取消「记库存」
    const eWeightedBox = view.querySelector('#eWeighted');
    const eTrackBox = view.querySelector('#eTrack');
    eWeightedBox.checked = !!p.is_weighted;
    eTrackBox.checked = eWeightedBox.checked ? false : (p.track_inventory !== false);
    bindStockWeighExclusive(eTrackBox, eWeightedBox);
    view.querySelector('#eStatus').value = String(p.status ?? 1);
    lastSamples = d.aiSamples || [];
    renderEditPhoto(p.photo_path || '', lastSamples);
    editModal.style.display = 'flex';
  }
  view.querySelector('#dtTag').onclick = () => { detModal.style.display = 'none'; if (selId) openOneTagModal(selId); };
  view.querySelector('#dtEdit').onclick = () => { detModal.style.display = 'none'; if (selId) openEdit(selId); };
  pdEditCtx = { view, openEdit };   // V4.9.8 供跨页「编辑商品」事件使用
  view.querySelector('#emCancel').onclick = () => { editModal.style.display = 'none'; };
  // 图片上传（base64 → POST /upload → 返回 /uploads/xxx 路径）
  view.querySelector('#ePhotoUp').onclick = () => view.querySelector('#ePhotoFile').click();
  view.querySelector('#ePhotoFile').onchange = async () => {
    const f = view.querySelector('#ePhotoFile').files[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast('图片不能超过 8MB', false); return; }
    try {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = () => rej(new Error('读取失败'));
        r.readAsDataURL(f);
      });
      const r = await must(post('/upload', { image: dataUrl }), '图片已上传');
      editPhotoPath = r.path;
      renderEditPhoto(editPhotoPath, lastSamples);
    } catch (e) { toast(e.message || '上传失败', false); }
    view.querySelector('#ePhotoFile').value = '';
  };
  let editPhotoPath;   // undefined=未改动；null=删除；字符串=新路径
  let lastSamples = [];  // 编辑商品当前样本（图片三态判断用）
  view.querySelector('#ePhotoDel').onclick = () => { editPhotoPath = null; renderEditPhoto('', lastSamples); };
  view.querySelector('#emSave').onclick = async () => {
    const name = view.querySelector('#eName').value.trim();
    const barcode = view.querySelector('#eBarcode').value.trim();
    const price = Number(view.querySelector('#ePrice').value);
    const unitVal = view.querySelector('#eUnit').value.trim();
    const keepNum = Number(view.querySelector('#eKeep').value);
    if (!barcode) return toast('条码必填', false);
    if (!/^\d+$/.test(barcode)) return toast('条码须为纯数字（不支持字母或字母+数字组合）', false);
    if (!name) return toast('名称必填', false);
    if (!unitVal) return toast('单位必填', false);
    if (!(price > 0)) return toast('售价必填（>0）', false);
    if (!(keepNum > 0)) return toast('保质期必填', false);
    const keepDaysEdit = Math.round(keepNum * Number(view.querySelector('#eKeepUnit').value));
    if (keepDaysEdit < 1 || keepDaysEdit > 32750) return toast(`保质期换算成天须在 1～32750 天内（当前 ${keepDaysEdit} 天，请检查数量×单位）`, false);
    const catStr = view.querySelector('#eCatIn').value.trim();
    const catHit = flatCats().find(c => c.chain.map(x => x.name).join(' / ') === catStr)
      || flatCats().find(c => c.name === catStr);
    if (!catHit) return toast('分类未匹配（请输入存在的分类名，支持快速查询）', false);
    const supStr = view.querySelector('#eSupIn').value.trim();
    const supHit = suppliers.find(s => s.name === supStr);
    if (supStr && !supHit) return toast('供应商未匹配（请输入存在的供应商名称）', false);
    // V4.9.7 价格红线：售价 / 会员价 严禁低于进价（进价只读取档案现值；活动价允许低于进价）
    const eCostV = Number(selDetail?.product?.cost_price ?? 0);
    const eMemberV = Number(view.querySelector('#eMember').value);
    if (eCostV > 0 && price > 0 && price < eCostV) return toast(`售价 ${price} 低于进价 ${eCostV}，严禁保存（活动低价请走「促销活动」）`, false);
    if (eCostV > 0 && eMemberV > 0 && eMemberV < eCostV) return toast(`会员价 ${eMemberV} 低于进价 ${eCostV}，严禁保存`, false);
    // V4.25.3 价格红线自检：最低卖价不得高于售价；最低折扣 1~100
    const eMinPriceV = Number(view.querySelector('#eMinPrice').value) || 0;
    const eMinDiscV = Number(view.querySelector('#eMinDisc').value) || 0;
    if (eMinPriceV > 0 && eMinPriceV > price) return toast(`最低卖价 ${eMinPriceV} 高于售价 ${price}，请检查`, false);
    if (eMinDiscV > 0 && (eMinDiscV < 1 || eMinDiscV > 100)) return toast('最低折扣须在 1~100 之间（如 80 = 最低 8 折）', false);
    if (eMinPriceV > 0 && eCostV > 0 && eMinPriceV < eCostV) toast(`提示：最低卖价 ${eMinPriceV} 低于进价 ${eCostV}，实际销售仍以进价兜底（不得低于进价销售）`, false);
    // V4.25.6 库存上下限自检：上限不得低于下限（0 = 未设）
    const eMinStk = Number(view.querySelector('#eMinStock').value) || 0;
    const eMaxStk = Number(view.querySelector('#eMaxStock').value) || 0;
    if (eMaxStk > 0 && eMinStk > eMaxStk) return toast(`库存上限 ${eMaxStk} 低于下限 ${eMinStk}，请检查`, false);
    await must(put(`/products/${editPid}`, {
      name, barcode,
      baseUnit: unitVal,
      sellPrice: price,
      minPrice: eMinPriceV,
      minDiscountRate: eMinDiscV,
      memberPrice: Number(view.querySelector('#eMember').value) || undefined,
      wholesalePrice: Number(view.querySelector('#eWholesale').value) || undefined,
      memberDiscount: view.querySelector('#eDiscount').value === '1' ? 0.9 : undefined,
      keepDays: keepDaysEdit,
      categoryId: Number(catHit.id),
      spec: view.querySelector('#eSpec').value.trim() || undefined,
      supplierDefaultId: supHit ? Number(supHit.id) : undefined,
      bizMode: view.querySelector('#eBizMode').value,
      minStock: Number(view.querySelector('#eMinStock').value) || 0,   // V4.25.6：库存上下限（0 = 不预警/不限制）
      maxStock: Number(view.querySelector('#eMaxStock').value) || 0,
      trackInventory: view.querySelector('#eTrack').checked,
      isWeighted: view.querySelector('#eWeighted').checked,
      status: Number(view.querySelector('#eStatus').value),
      // 图片：'' = 删除（后端置空）；新路径 = 上传后的 /uploads/xxx；undefined = 未改动
      photoPath: editPhotoPath === null ? '' : (editPhotoPath || undefined),
    }), '商品已更新');
    // 一品多码 / 一品多包装：全量提交（chips 清单）
    await must(post(`/products/${editPid}/barcodes`, { barcodes: eAliasList }), '附加条码已更新');
    await must(put(`/products/${editPid}/units`, {
      units: ePkgList.map(u => ({ unitName: u.unitName, rate: u.rate, barcode: u.barcode || undefined })),
    }), '一品多包装已更新');
    // 单位输入了新值 → 自动更新单位表（与新增弹窗一致）
    if (unitVal && !unitList.includes(unitVal)) { unitList.push(unitVal); renderUnitSel(); }
    editModal.style.display = 'none';
    await loadProducts(curPage);
    if (selId === editPid) selectRow(editPid);
  };

  /* ── 临期商品集合（批次到期 7 天内 → 状态列标黄） ── */
  try {
    const al = await get('/inventory/expiry-alerts');
    if (al.code === 0) nearExpiry = new Set((al.data || []).map(b => Number(b.product_id)));
  } catch (e) { nearExpiry = new Set(); }

  const supRes = await get('/purchase/suppliers').catch(() => null);
  suppliers = (supRes && supRes.code === 0 ? supRes.data : supRes) || [];
  renderSupSels();
  // V4.9.13 单位库 = 常用字典 + 店内在用单位（/products/units），下拉/面板全量展示
  try {
    const ur = await get('/products/units');
    const used = (ur && ur.code === 0 ? ur.data : ur) || [];
    if (Array.isArray(used) && used.length) { unitList = [...new Set([...unitList, ...used.map(String)])]; }
  } catch (e) { /* 拉不到就用字典兜底 */ }
  renderUnitSel();   // 初始化填充基本单位下拉（新增/编辑共用；此前从未初始化导致下拉空白）

  cats = (await must(get('/products/categories')).catch(() => [])) || [];
  await loadCatCounts();
  drawTree();
  await loadChain();        // V5.0.0 连锁：填充 chain 上下文并渲染连锁条（此前定义后从未调用）
  await loadProducts(1);
}
