'use strict';
/* 员工移动端 PWA · 一级收银台（cashier.js，V4.18.0 P14 收银台专项）
 * 设计：收银端专项设计方案 §4/§5-P14/§13（含 13.10 负库存容错）
 *  - 登录后直落全屏收银台（body.cashier-mode 隐藏 header/tabbar，横屏双栏 / 手机单栏响应式）
 *  - 复用底座：Pricebook 离线价目表、/sales/checkout（组合支付+clientRef 幂等+服务端计价）、
 *    /pay/micropay+轮询、/pos/held 挂单、/coupons/member 券、enqueueOffline/flushQueue 离线补传、
 *    PwaPrinters.autoPrint/reprint/kickDrawer、PwaReceipt、Scale、PwaTTS
 *  - 回退开关：system_settings pos.cashier.new_ui=0 → 走旧「作业-收银」（H3 一键回退） */
/* ── 收银台样式（自包含注入，cs- 前缀；跟随 PWA 主题变量） ── */
(function () {
  if (document.getElementById('csCashierCss')) return;
  const st = document.createElement('style');
  st.id = 'csCashierCss';
  st.textContent = `
  body.cashier-mode header, body.cashier-mode nav#tabbar{display:none;}
  #csRoot{position:fixed;inset:0;z-index:60;background:var(--paper);display:flex;flex-direction:column;font-size:15px;}
  /* 顶栏 */
  #csTop{display:flex;align-items:center;gap:10px;padding:8px 14px;background:var(--card);border-bottom:1px solid var(--line);flex-wrap:wrap;}
  .cs-brand{font-weight:800;color:var(--pri);font-size:16px;white-space:nowrap;}
  .cs-brand small{font-weight:400;color:var(--ink-3);font-size:11px;margin-left:6px;}
  .cs-ver{font-size:10.5px;color:var(--ink-3);border:1px solid var(--line);border-radius:8px;padding:1px 6px;}
  .cs-lamps{display:flex;gap:8px;}
  .cs-lamp{display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--ink-2);cursor:pointer;padding:3px 7px;border-radius:9px;background:var(--paper-2);}
  .cs-dot-l{width:9px;height:9px;border-radius:50%;background:#b6bcc3;display:inline-block;flex:none;}
  .cs-lamp.green .cs-dot-l{background:var(--ok);box-shadow:0 0 5px var(--ok);}
  .cs-lamp.red .cs-dot-l{background:var(--bad);box-shadow:0 0 5px var(--bad);}
  .cs-lamp.yellow .cs-dot-l{background:var(--warn);box-shadow:0 0 5px var(--warn);}
  .cs-mini{border:1px solid var(--line);background:var(--card);color:var(--pri);border-radius:9px;padding:6px 10px;font-size:12.5px;font-weight:600;cursor:pointer;position:relative;white-space:nowrap;}
  .cs-mini:active{background:var(--paper-2);}
  .cs-dot{position:absolute;top:-5px;right:-5px;background:var(--bad);color:#fff;font-size:10px;min-width:16px;height:16px;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:0 4px;font-weight:700;}
  .cs-actions{display:flex;gap:6px;flex-wrap:wrap;}
  .cs-user{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;line-height:1.2;}
  .cs-user b{font-size:13px;color:var(--ink);}
  .cs-user span{font-size:10.5px;color:var(--ink-3);}
  .cs-time{font-size:15px;font-weight:700;color:var(--ink-2);font-variant-numeric:tabular-nums;}
  .cs-exit{color:var(--ink-2);}
  /* 离线黄条 */
  #csOffline{display:flex;align-items:center;gap:10px;background:#fdf3d8;color:#8a6100;padding:7px 14px;font-size:12.5px;border-bottom:1px solid #ecd9a0;}
  #csOffline b{font-weight:700;}
  .cs-pill{margin-left:auto;background:#fff;border:1px solid #ecd9a0;border-radius:9px;padding:2px 8px;font-size:11px;}
  /* ═══ V4.22.3 ③ 收银台四周留白（用户报障：购物车白卡直接占满右侧屏幕、界面生硬） ═══
     做法：主区四周留 12px（左右对称、两栏底部对齐）+ 右栏限宽 ≤600px（对齐高保真原型）+ 两栏底部圆角 */
  /* 主区双栏 */
  #csMain{flex:1;display:flex;overflow:hidden;padding:0 12px 12px;}   /* V4.22.3：四周留白 12px（右侧不再顶满屏幕） */
  #csLeft{flex:1.618;display:flex;flex-direction:column;overflow:hidden;padding:10px 12px;min-width:0;border-radius:0 0 12px 12px;}   /* 黄金比例 1.618:1 */
  #csRight{flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--card);border-left:1px solid var(--line);min-width:320px;max-width:min(46%,600px);border-radius:0 0 12px 12px;}   /* V4.22.3：限宽对齐高保真原型（≤600px）+ 底部圆角 */
  /* 左栏底部扫码栏：与右栏 #csPayBar 同形态（深色满宽、同内边距，底部对齐） */
  #csScanBar{flex:none;display:flex;align-items:center;gap:10px;background:var(--pri-d);padding:12px 16px;margin:8px -12px -10px;height:78px;box-sizing:border-box;}
  .cs-search{flex:1;}
  .cs-search input{width:100%;padding:12px 14px;border:none;border-radius:11px;font-size:15px;background:#f7f3e6;color:var(--ink);}
  .cs-search input::placeholder{color:#8a8474;}
  .cs-scanbtn{background:#f7f3e6;color:var(--pri-d);border:none;border-radius:13px;padding:6px 26px;font-size:16px;font-weight:800;cursor:pointer;}
  .cs-sb-btn{position:relative;background:rgba(247,243,230,.15);color:#f7f3e6;border:1px solid rgba(247,243,230,.4);border-radius:11px;padding:0 15px;font-size:13.5px;font-weight:700;cursor:pointer;height:46px;white-space:nowrap;}
  .cs-sb-btn:active{background:rgba(247,243,230,.3);}
  .cs-scanbtn:active{transform:scale(.97);}
  .cs-scanbtn small{display:block;font-size:10px;font-weight:400;opacity:.7;}
  .cs-pri{background:var(--pri);color:#f7f3e6;border:none;border-radius:11px;padding:0 18px;font-size:14.5px;font-weight:700;cursor:pointer;}
  #csSug{position:absolute;bottom:80px;left:16px;z-index:70;background:var(--card);border:1px solid var(--line);border-radius:11px;box-shadow:var(--shadow);max-height:320px;overflow:auto;width:min(420px,80vw);}
  .cs-sug{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--paper-2);cursor:pointer;font-size:14px;}
  .cs-sug:last-child{border-bottom:none;}
  .cs-sug:active{background:var(--paper-2);}
  .cs-sug.out{color:var(--ink-3);}
  .cs-py{color:var(--ink-3);font-size:11px;}
  .cs-out-tag{color:var(--bad);font-size:11px;border:1px solid var(--bad);border-radius:7px;padding:0 5px;}
  .cs-sp{margin-left:auto;font-weight:700;color:var(--pri);}
  /* V4.26.3：右侧渐隐提示「还有分类」——滚到尽头自动撤掉，不吃掉最后一个胶囊 */
  #csCats{display:flex;gap:6px;overflow-x:auto;padding:2px 0 8px;flex:none;
    -webkit-mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 28px),transparent 100%);
    mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 28px),transparent 100%);}
  #csCats.cs-at-end{-webkit-mask-image:none;mask-image:none;}
  .cs-chip{flex:none;border:1px solid var(--line);background:var(--card);color:var(--ink-2);border-radius:16px;padding:5px 13px;font-size:12.5px;cursor:pointer;}
  .cs-chip.on{background:var(--pri);border-color:var(--pri);color:#f7f3e6;font-weight:700;}
  .cs-label{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--ink-3);font-weight:600;padding:4px 2px;flex:none;}
  #csQuickWrap{flex:none;}
  #csQuick{display:grid;grid-template-columns:repeat(8,1fr);gap:6px;padding:4px 0 8px;}
  .cs-qitem{position:relative;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 4px;text-align:center;cursor:pointer;overflow:hidden;}
  .cs-qitem.cs-hit{animation:cs-pop .34s ease;}
  .cs-qitem:active{background:var(--green-soft);}
  .cs-qn{font-size:12px;font-weight:700;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .cs-qp{font-size:11.5px;color:var(--pri);font-weight:600;}
  #csGrid{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:8px;align-content:start;padding:2px 0 2px;}
  .cs-pcard{position:relative;background:var(--card);border:1px solid var(--line);border-radius:11px;padding:9px 9px 7px;cursor:pointer;overflow:hidden;}
  .cs-pcard:active{border-color:var(--pri-2);background:var(--green-soft);}
  /* V4.26.3 ① 加车反馈：卡片轻缩一下 + 盖一层「✓ 已加入」，0.5s 自动消失（触屏收银不再靠猜） */
  .cs-pcard.cs-hit{animation:cs-pop .34s ease;}
  @keyframes cs-pop{0%{transform:scale(1)}32%{transform:scale(.955)}100%{transform:scale(1)}}
  .cs-added{
    position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
    background:rgba(23,74,46,.86);color:#f7f3e6;border-radius:13px;pointer-events:none;
    animation:cs-added-fade .6s ease forwards;
  }
  .cs-added b{font-size:19px;line-height:1;}
  .cs-added i{font-style:normal;font-size:11.5px;opacity:.85;max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  @keyframes cs-added-fade{0%{opacity:0}14%{opacity:1}70%{opacity:1}100%{opacity:0}}
  /* V4.26.3 ⑥ 沽清：去色 + 斜纹底，一眼能和「有货」分开（原来只降透明度，扫一眼看不出来） */
  .cs-pcard.out{opacity:1;background:var(--paper-2);border-style:dashed;}
  .cs-pcard.out::after{
    content:'';position:absolute;inset:0;pointer-events:none;border-radius:13px;
    background:repeating-linear-gradient(135deg,rgba(90,102,80,.07) 0 7px,transparent 7px 14px);
  }
  .cs-pcard.out .cs-n,.cs-pcard.out .cs-bar,.cs-pcard.out .cs-unit{color:var(--ink-3);}
  .cs-pcard.out .cs-price{color:var(--ink-3);font-weight:700;}
  .cs-pcard.out .cs-mem{background:var(--paper-2);color:var(--ink-3);}
  .cs-n{font-size:13px;font-weight:700;color:var(--ink);line-height:1.25;height:2.5em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
  .cs-bar{font-size:10px;color:var(--ink-3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .cs-prow{display:flex;align-items:baseline;gap:4px;margin-top:4px;}
  .cs-price{font-size:14.5px;font-weight:800;color:var(--pri);}
  .cs-unit{font-size:10.5px;color:var(--ink-3);}
  .cs-mem{font-size:10px;background:var(--green-soft);color:var(--pri);border-radius:6px;padding:0 5px;font-weight:600;}
  .cs-stock{position:absolute;top:6px;right:7px;font-size:10px;color:var(--ink-3);cursor:pointer;}
  .cs-stock.low{color:var(--warn);font-weight:700;}
  .cs-soldout{position:absolute;bottom:6px;right:7px;font-size:10px;color:var(--bad);font-weight:700;}
  .cs-star{position:absolute;top:5px;left:5px;z-index:2;border:none;background:#fff;color:#c9c1ab;border-radius:50%;width:24px;height:24px;font-size:13px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.12);}
  .cs-star.on{color:var(--warn);}
  .cs-empty{color:var(--ink-3);text-align:center;padding:36px 12px;font-size:13.5px;}
  /* 右栏：会员卡 / 购物车 / 合计 */
  #csMemCard{display:flex;align-items:center;gap:9px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap;flex:none;position:relative;}
  .cs-avatar{width:38px;height:38px;border-radius:50%;background:var(--pri);color:#f7f3e6;display:flex;align-items:center;justify-content:center;font-weight:800;flex:none;}
  .cs-avatar.off{background:var(--paper-2);color:var(--ink-3);}
  .cs-mi{display:flex;flex-direction:column;line-height:1.3;min-width:0;}
  .cs-mi b{font-size:14px;color:var(--ink);}
  .cs-mstats{font-size:11px;color:var(--ink-3);}
  .cs-mops{margin-left:auto;display:flex;gap:6px;align-items:center;}
  #csMemK{width:130px;padding:7px 10px;border:1px solid var(--line);border-radius:9px;font-size:12.5px;}
  .cs-mhit{flex-basis:100%;}
  #csCartHead{display:flex;align-items:center;gap:8px;padding:8px 14px;flex:none;}
  #csCartHead b{font-size:13.5px;color:var(--ink);}
  .cs-cnt{font-size:11.5px;color:var(--ink-3);}
  /* V4.26.3 ① 件数变化跳动一下，配合卡片浮层给「加进去了」的双确认 */
  .cs-cnt.cs-bump{animation:cs-bump .42s cubic-bezier(.3,1.6,.5,1);color:var(--pri);font-weight:800;}
  @keyframes cs-bump{0%{transform:scale(1)}35%{transform:scale(1.22)}100%{transform:scale(1)}}
  #csClear{margin-left:auto;border:none;background:none;color:var(--bad);font-size:12px;cursor:pointer;}
  #csDebounce{display:none;align-items:center;gap:10px;background:var(--green-soft);color:var(--pri);font-size:12.5px;padding:7px 14px;flex:none;}
  #csUndo{margin-left:auto;border:1px solid var(--pri);background:#fff;color:var(--pri);border-radius:9px;padding:4px 10px;font-size:12px;cursor:pointer;}
  #csCart{flex:1;overflow-y:auto;padding:2px 0;}
  .cs-crow{display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid var(--paper-2);}
  .cs-cn{flex:1;min-width:0;}
  .cs-cnm{font-size:13.5px;font-weight:600;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .cs-tag-o,.cs-tag-r,.cs-tag-b{font-size:10px;border-radius:6px;padding:0 5px;margin-left:5px;font-weight:600;}
  .cs-tag-o{background:var(--paper-2);color:var(--ink-2);}
  .cs-tag-r{background:#fbe4e1;color:var(--bad);}
  .cs-tag-b{background:#e5edf7;color:#2b5fa8;}
  .cs-csub{font-size:11px;color:var(--ink-3);margin-top:2px;display:flex;gap:6px;align-items:baseline;}
  .cs-plbl{cursor:pointer;text-decoration:underline dotted;color:var(--pri);font-weight:600;font-size:12.5px;}
  .cs-snap{font-size:10px;}
  .cs-qty{display:flex;align-items:center;gap:4px;flex:none;}
  /* V4.26.3 ② 触控目标：原 30×30 远低于 44px 规范，高峰期易点错（鼠标端 34×34 够用） */
  .cs-qty button{width:34px;height:34px;border-radius:8px;border:1px solid var(--line);background:var(--paper-2);font-size:17px;font-weight:700;color:var(--ink-2);cursor:pointer;}
  .cs-qty input{width:52px;text-align:center;border:1px solid var(--line);border-radius:8px;padding:6px 2px;font-size:14px;}
  .cs-amt{min-width:64px;text-align:right;font-weight:700;color:var(--ink);font-size:13.5px;flex:none;}
  .cs-del{border:none;background:none;color:var(--ink-3);font-size:16px;cursor:pointer;flex:none;width:34px;height:34px;border-radius:8px;}
  .cs-mini2{border:1px solid var(--line);background:var(--card);color:var(--ink-2);border-radius:8px;font-size:11px;padding:3px 7px;cursor:pointer;flex:none;}
  .cs-mini2:active{background:var(--green-soft);color:var(--pri);}
  .cs-sd-grid{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:13px;padding:6px 0;}
  .cs-sd-grid span{color:var(--ink-3);}
  .cs-sd-batch{max-height:180px;overflow-y:auto;}
  .cs-del:active{color:var(--bad);}
  #csSum{flex:none;border-top:1px dashed var(--line);padding:7px 14px;font-size:12px;color:var(--ink-2);max-height:180px;overflow-y:auto;}
  .cs-sline{display:flex;justify-content:space-between;padding:2px 0;}
  .cs-sline.save span:last-child{color:var(--ok);font-weight:700;}
  .cs-sline.hint{color:var(--ink-3);font-size:11px;}
  #csPayBar{flex:none;display:flex;align-items:center;gap:12px;background:var(--pri-d);color:#f7f3e6;padding:12px 16px;height:78px;box-sizing:border-box;}
  .cs-due small{font-size:11px;opacity:.75;display:block;}
  .cs-due .cs-num{font-size:26px;font-weight:800;line-height:1.1;}
  .cs-due em{font-style:normal;font-size:15px;margin-right:2px;opacity:.8;}
  #csGo{margin-left:auto;background:#f7f3e6;color:var(--pri-d);border:none;border-radius:13px;padding:12px 34px;font-size:17px;font-weight:800;cursor:pointer;}
  #csGo:active{transform:scale(.97);}
  #csGo small{display:block;font-size:10px;font-weight:400;opacity:.7;}
  /* 锁屏 */
  #csLockMask{position:absolute;inset:0;z-index:80;background:rgba(24,32,22,.55);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;}
  .cs-lock-card{background:var(--card);border-radius:16px;padding:24px 22px;width:min(320px,86vw);text-align:center;box-shadow:var(--shadow);}
  .cs-lock-avatar{width:52px;height:52px;border-radius:50%;background:var(--pri);color:#f7f3e6;font-size:22px;font-weight:800;display:flex;align-items:center;justify-content:center;margin:0 auto 8px;}
  .cs-lock-card b{font-size:16px;color:var(--ink);}
  .cs-lock-role{font-size:11.5px;color:var(--ink-3);margin:5px 0 10px;}
  .cs-lock-err{color:var(--bad);font-size:12.5px;min-height:18px;}
  .cs-lock-frozen{color:var(--bad);font-size:13px;font-weight:700;min-height:18px;}
  .cs-lock-tip{font-size:10.5px;color:var(--ink-3);margin-top:9px;}
  .cs-lock-card input{padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:15px;}
  /* 结算弹窗补充 */
  .cs-paytop{background:var(--paper-2);border-radius:12px;padding:12px 14px;margin-bottom:10px;}
  .cs-paynum{font-size:30px;font-weight:800;color:var(--pri-d);}
  .cs-paynum em{font-style:normal;font-size:17px;margin-right:3px;}
  .cs-paydetail{font-size:11.5px;color:var(--ink-3);margin-top:2px;}
  .seg{display:flex;gap:6px;margin-bottom:10px;}
  .seg button{flex:1;border:1px solid var(--line);background:var(--card);color:var(--ink-2);border-radius:10px;padding:10px 0;font-size:14px;font-weight:600;cursor:pointer;}
  .seg button.on{background:var(--pri);border-color:var(--pri);color:#f7f3e6;}
  .seg button.dis{opacity:.45;}
  .cs-cashq{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;}
  .cs-cashq button{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:8px 14px;font-size:13.5px;font-weight:700;color:var(--pri);cursor:pointer;}
  .cs-cashin{display:flex;align-items:center;gap:8px;}
  .cs-cashin label{font-size:13px;color:var(--ink-3);flex:none;}
  .cs-cashin input{flex:1;padding:11px 12px;border:1px solid var(--line);border-radius:10px;font-size:19px;font-weight:700;}
  .cs-change{display:flex;justify-content:space-between;align-items:baseline;margin-top:8px;}
  .cs-change span{font-size:13px;color:var(--ink-2);}
  .cs-change b{font-size:24px;color:var(--ok);}
  .cs-combo{display:flex;gap:8px;}
  .cs-cell{flex:1;}
  .cs-cell label{display:block;font-size:12px;color:var(--ink-3);margin-bottom:4px;}
  .cs-cell input{width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;font-size:16px;font-weight:600;}
  .cs-cell.auto input{background:var(--paper-2);}
  .cs-optrow{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px dashed var(--paper-2);font-size:13.5px;color:var(--ink);}
  .warn-bar{background:#fdf3d8;color:#8a6100;border-radius:10px;padding:9px 12px;font-size:12.5px;margin-bottom:10px;}
  .cs-stale{opacity:.55;}
  /* V4.18.2 修复①②③：.modal z-index(50) 低于收银台根 #csRoot(z60) 导致取单/设置/挂起单弹窗被盖住；
     收银台模式下统一抬高到 120 并桌面居中；pwaConfirm（modal-mask，z9998 本就可见）同样居中 + 正文加大加深 */
  body.cashier-mode .modal{z-index:120;align-items:center;}
  body.cashier-mode .modal .sheet{border-radius:16px;width:min(640px,94vw);}
  body.cashier-mode .modal-mask{align-items:center !important;}
  body.cashier-mode .modal-mask .sheet{border-radius:16px;background:var(--card);box-shadow:0 18px 50px rgba(10,25,15,.35);}
  /* V4.18.2 弹窗视觉重做：pc-* 体系在收银台模式下的桌面级微调 */
  body.cashier-mode .pc-card{width:min(420px,92vw);padding:22px 22px 18px;}
  body.cashier-mode .pc-body{font-size:14.5px;}
  body.cashier-mode .pc-btn{min-width:104px;padding:10px 20px;}
  /* V4.18.2 修复④：商品大卡（对齐高保真原型：库存徽标/更大字号/宽松间距）；列数由设置 pos.cashier.grid_cols 控制（默认 5） */
  #csGrid{grid-template-columns:repeat(var(--csCols,5),1fr);gap:10px;}
  .cs-pcard{padding:12px 12px 10px;border-radius:13px;}
  .cs-n{font-size:15px;}
  .cs-price{font-size:17px;}
  .cs-stockpill{position:absolute;top:8px;right:9px;font-size:10.5px;border-radius:8px;padding:1px 7px;background:var(--paper-2);color:var(--ink-2);font-weight:600;cursor:pointer;}
  .cs-stockpill.low{background:#fdf3d8;color:#b07207;}
  .cs-soldout{position:absolute;right:10px;bottom:8px;font-size:13px;color:var(--bad);font-weight:800;letter-spacing:3px;}
  /* V4.18.2 修复⑤：会员卡对齐高保真（等级徽标/脱敏手机号/余额·待分红·积分） */
  .cs-mline1{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;}
  .cs-lvl{font-size:10px;background:#f4ead8;color:#8a6100;border-radius:6px;padding:0 5px;font-weight:700;flex:none;}
  .cs-mphone{font-size:11px;color:var(--ink-3);}
  .cs-mstats b{color:var(--ink);font-weight:700;}
  .kv{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px dashed var(--paper-2);font-size:13.5px;}
  .kv .k{color:var(--ink);}
  .kv select,.kv input{padding:7px 10px;border:1px solid var(--line);border-radius:9px;font-size:13px;}
  /* 手机单栏 */
  @media (max-width:900px){
    #csMain{flex-direction:column;}
    #csRight{max-width:none;min-width:0;border-left:none;border-top:1px solid var(--line);flex:1.2;}
    #csLeft{flex:1;}
    #csQuick{grid-template-columns:repeat(4,1fr);}
    #csGrid{grid-template-columns:repeat(auto-fill,minmax(104px,1fr));}   /* 手机单栏：固定列数太挤，回到自适应 */
    .cs-user span,.cs-ver{display:none;}
  }
  /* ═══ V4.22.0 ① 低分辨率紧凑模式（双屏收银机 1024~1366 小屏/系统缩放失真根治） ═══
     触发：body.cs-compact（JS 按视口自动判定 or 本机设置强制）；列数改自适应、字号/内距降档、角标不再压住品名 */
  body.cs-compact #csGrid{grid-template-columns:repeat(auto-fill,minmax(122px,1fr)) !important;gap:8px;}
  body.cs-compact .cs-pcard{padding:9px 9px 7px;border-radius:10px;}
  body.cs-compact .cs-n{font-size:12.5px;padding-right:0;height:2.4em;}
  body.cs-compact .cs-price{font-size:14.5px;}
  body.cs-compact .cs-stockpill{position:static;display:inline-block;margin-top:4px;font-size:9.5px;padding:0 5px;}   /* 库存角标改随流排版，绝不遮挡 */
  body.cs-compact .cs-soldout{position:static;letter-spacing:1px;font-size:10.5px;margin-top:3px;}
  body.cs-compact .cs-star{width:28px;height:28px;font-size:12px;}
  body.cs-compact #csScanBar,body.cs-compact #csPayBar{height:62px;padding:8px 12px;}
  body.cs-compact .cs-search input{padding:9px 11px;font-size:14px;}
  body.cs-compact #csGo{padding:8px 22px;font-size:14.5px;}
  body.cs-compact .cs-due .cs-num{font-size:21px;}
  body.cs-compact .cs-brand{font-size:15px !important;}
  body.cs-compact .cs-topbtn,body.cs-compact .cs-mini{padding:5px 9px !important;font-size:12px !important;}
  body.cs-compact #csQuick{grid-template-columns:repeat(8,1fr);}
  body.cs-compact .cs-qitem{padding:5px 3px;}
  body.cs-compact .cs-qn{font-size:11px;}
  /* 标准分辨率下固定列数时，角标同样不压品名（首行留白） */
  .cs-n{padding-right:56px;}
  /* ═══ V4.22.0 ② 触屏适配（通用双屏收银机/平板 = pointer:coarse） ═══ */
  #csRoot{touch-action:manipulation;-webkit-tap-highlight-color:transparent;}
  #csRoot .cs-pcard,#csRoot .cs-qitem,#csRoot .cs-chip,#csRoot .cs-sug{-webkit-user-select:none;user-select:none;}
  @media (pointer:coarse){
    .cs-pcard:active{transform:scale(.97);}
    .cs-qitem:active{transform:scale(.96);}
    button{-webkit-touch-callout:none;}
    .cs-qty button{width:44px;height:44px;font-size:19px;}
    .cs-qty input{width:62px;padding:10px 2px;font-size:15px;}
    .cs-del{width:44px;height:44px;font-size:19px;}
    .cs-star{width:34px;height:34px;font-size:16px;}
    .cs-chip{padding:9px 16px;font-size:13.5px;}
    #csGo{padding:14px 38px;font-size:18px;}
    .cs-scanbtn{padding:8px 30px;}
    .cs-sb-btn{height:52px;font-size:14.5px;}
    #csMemK{width:150px;padding:10px 12px;font-size:14px;}
    .cs-cashq button{padding:12px 18px;font-size:15px;}
    .seg button{padding:13px 0;font-size:15px;}
    .cs-stockpill{padding:3px 9px;font-size:11.5px;}
    #csCartHead,#csClear{min-height:34px;}
    #csClear{padding:6px 10px;}
    .cs-mini2{padding:9px 13px;font-size:13px;}
  }
  /* 紧凑模式下 44px 会把购物车行撑得太高，降一档到 38px（仍高于原 30px） */
  body.cs-compact .cs-qty button{width:38px;height:38px;font-size:18px;}
  body.cs-compact .cs-del{width:38px;height:38px;font-size:18px;}
  body.cs-compact .cs-qty input{width:56px;padding:8px 2px;}
  /* V4.26.3 ⑦ 当前分类标识：让店员知道现在看的是哪一格 */
  .cs-catnow{color:var(--pri);font-weight:800;}
  .cs-catnow.filter{color:var(--orange);}
  /* V4.26.3 ③ 主次分层：左栏扫码栏降为浅色操作条，右栏结算栏是全场唯一深色锚点 */
  #csScanBar{background:var(--paper-2);border-top:1px solid var(--line);}
  .cs-search input{background:#fff;border:1px solid var(--line-2);box-shadow:inset 0 1px 2px rgba(40,50,30,.05);}
  .cs-scanbtn{background:var(--pri);color:#f7f3e6;box-shadow:0 2px 6px rgba(23,74,46,.22);}
  .cs-sb-btn{background:var(--card);color:var(--pri);border:1px solid var(--line-2);}
  .cs-sb-btn:active{background:var(--green-soft);}
  #csPayBar{box-shadow:0 -6px 18px rgba(23,74,46,.16);}
  `;
  document.head.appendChild(st);
})();

window.CashierShell = (function () {

  // ── 状态 ──
  let active = false;
  const cart = [];            // {p:{id,name,barcode,spec,unit,sellPrice,memberPrice,minPrice,isWeighted,pinyin,stockQty}, qty, manualPrice?, neg?}
  let member = null;          // {id,name,phone,balance}
  let coupon = null;          // {id,name,type,cut}（预估口径）
  let promo = { amount: 0, next: null };   // /pos/promo-preview 结果
  let manualRound = 0;
  let orderNote = '';         // V4.18.1 P15 批1：整单备注（结算弹窗录入，挂账原因/顾客称呼等）
  let orderDisc = null;       // V4.18.3 P15 批2：整单折扣 { rate, name, amount, custom }
  let ptsUse = 0;             // V4.18.3 P15 批2：积分抵现金额（元）
  let ptsCfg = { rate: 100, maxPct: 20 };   // pos.points.rate（多少积分=1元）/ pos.points.max_pct（%应收）
  let discPresets = [];       // 后台预设折扣规则 [{name,rate}]
  let categories = [];
  let curCat = 0;             // 0=全部
  let stockMap = new Map();   // productId -> stockQty（实时，不入价目表缓存）
  let stockOnline = true;     // 在线才查库存
  let lastSale = null;        // 上一个成功单快照（补打用）
  let pendingPays = [];       // 挂起单（USERPAYING 转挂起）{outTradeNo,amount,cartItems,memberId,savedAt}
  let negSales = [];          // 本班负库存清单 {t,name,stock,had,add}
  let debounceOn = true;
  let stockHard = false;
  let lockTimeoutMin = 5;
  let gridCols = 5;           // V4.18.2：商品区每行卡片数（设置 pos.cashier.grid_cols，4~8）
  let hotkeysOn = true;       // V4.18.2：键盘快捷键开关（F2挂单 F4取单 F6重复上一单 F8锁屏 F9结算）
  let ttsOn = true;           // V4.18.2：收款语音播报开关
  let printOn = true;         // V4.18.9：小票打印开关（F7 快捷切换，pos.cashier.print）
  let gridFilter = '';        // V4.18.2：搜索候选过滤（输入即筛选宫格，Enter 智能加车）
  let shiftState = null;      // V4.18.4 批3：{shift, summary} 当前班次（GET /shifts/current）
  let shiftTol = 5;           // 交接班现金容差（pos.shift.diff_tolerance）
  let floatDefault = 200;     // 开班备用金默认（pos.cashbox.float_default）
  let dayTickTimer = 0;       // 跨零点监测（分钟级）
  let roundUnitC = 1;         // 自动抹零单位（分）
  let CK = null;              // 当前视图根元素缓存 {root, topbar, ...}
  let lockState = { locked: false, errs: 0, frozenUntil: 0 };
  let idleTimer = 0;
  const lastScan = { id: 0, t: 0 };
  let quickIds = null;
  let quickMax = 8;               // VQA-D3：pos.cashier.quick_count 快捷格上限/默认数（8~12）
  let productVoiceOn = true;      // VQA-D3：voice.product.enabled 加购商品名播报子开关（tts 总开关之下）
  let hbTimeoutSec = 10;          // VQA-D3：pos.heartbeat_timeout 服务器不可达判阈（秒）
  let serverDown = false, hbDownSince = 0, hbTimer = 0;
  let quickEdit = false;
  let payInFlight = false;
  // V4.21.0 P16 批2：快捷键映射（pos.cashier.hotkey_map 可自定义）/ 客显推送 / 堂食台位
  let hkMap = { pay: 'F9', hold: 'F2', take: 'F4', repeat: 'F6', print: 'F7', lock: 'F8', stock: 'F10', price: 'P', disc: 'D' };   // V4.24.0：新增 stock=库存查询；V4.25.3：新增 price=改价 / disc=单品折扣（默认字母键，可自定义）
  let dispPush = true;        // 客显推送开关（pos.display.push）
  let dispClients = 0;        // 副屏连接数（/display/push 返回；-1=推送失败）
  let dispPushTimer = 0;      // 推送去抖
  let csTable = null;         // 当前挂的堂食台位 {id,name}（结算页选择，落单后复位）
  let memSearchResults = [];  // V4.25.8：会员搜索结果缓存（回车二次确认用）
  // V4.22.0 本机设置（按收银台隔离：存本机 localStorage，不入 system_settings、不串台）
  let LC = { gridCols: 0, printerId: 0, uiMode: 'auto', dispSer: '', dispBaud: 9600, dispProf: 'esc' };
  const loadLC = () => { try { Object.assign(LC, JSON.parse(localStorage.getItem('pwa_cashier_local') || '{}') || {}); } catch { /* 损坏则用默认 */ } };
  const saveLC = () => { try { localStorage.setItem('pwa_cashier_local', JSON.stringify(LC)); } catch { /* 忽略 */ } };
  // V4.22.0 低分辨率紧凑模式：自动判定（小视口/系统缩放大）或本机设置强制
  const applyCompact = () => {
    const w = window.innerWidth, h = window.innerHeight;
    const compact = LC.uiMode === 'compact' || (LC.uiMode !== 'normal' && (w <= 1180 || h <= 720));
    document.body.classList.toggle('cs-compact', compact);
  };

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => Number(n ?? 0).toFixed(2);
  const hasPerm = c => !!(typeof ME !== 'undefined' && ME && ME.perms && ME.perms.includes(c));   // ME 是 app.js 顶层 let（不在 window 上）
  const isW = p => !!(p.isWeighted || String(p.unit || '').toLowerCase() === 'kg');
  const minPriceOf = p => (p.minPrice != null && p.minPrice !== '' ? Number(p.minPrice) : Math.floor((Number(p.sellPrice) || 0) * 60) / 100);
  // V4.25.3：单品折扣 discRate（百分数，如 88 = 88 折）与改价互斥——manualPrice 优先，其次折扣，再会员价/售价
  // VQA（DEF-15 / Q5 裁决）：会员价生效门控与后端一致（member_discount>0）；折扣行取 min(零售×折数, 会员价)——更优单享、禁折上折
  const memberCandOf = p => {
    if (!member) return null;
    const d = Number(p.memberDiscount) || 0;
    if (!(d > 0)) return null;
    const mp = Number(p.memberPrice);
    return mp > 0 ? mp : Math.round((Number(p.sellPrice) || 0) * d * 100) / 100;
  };
  const lineBasePrice = l => (l.manualPrice != null ? l.manualPrice : (memberCandOf(l.p) != null ? memberCandOf(l.p) : Number(l.p.sellPrice) || 0));
  const linePrice = l => {
    if (!l.discRate) return lineBasePrice(l);
    const dp = Math.round((Number(l.p.sellPrice) || 0) * l.discRate) / 100;
    const mc = memberCandOf(l.p);
    return mc != null ? Math.min(dp, mc) : dp;
  };
  const lineAmount = l => linePrice(l) * l.qty;
  /** V4.25.3 商品最低折扣（百分数；0/null = 不限制折扣） */
  const minDiscOf = p => (p && p.minDiscountRate != null && Number(p.minDiscountRate) > 0 ? Number(p.minDiscountRate) : 0);
  /** V4.25.3 快捷键/按钮作用的当前行（默认最后一行；点击行会切换） */
  let curIdx = -1;
  // ── V4.25.5 店长授权（改价 / 单品折扣 / 赠品）：票据 120 秒有效，仅授权价格操作，不切换登录身份 ──
  let priceAuth = null;   // { ticket, exp(ms), name, empNo }
  const priceAuthValid = () => !!priceAuth && Date.now() < priceAuth.exp;
  // V4.25.7 授权策略（后台「设备管理」可配，收银端自动同步）：batch=复用 / once=每次都弹；authSelf=店长本人免输码
  let authReuse = 'batch';
  let authSelf = false;
  /** 确保存在有效店长授权票据；无则弹「店长授权」框。返回 Promise<boolean> */
  function ensurePriceAuth(scene) {
    // V4.25.7：店长本人免输授权码（后台 pos.price.auth_self=on 时）——静默自授权，免弹窗但仍留痕（授权人=操作人）
    if (authSelf && hasPerm('pos.price.authorize')) {
      return (async () => {
        if (priceAuthValid()) return true;
        try {
          const r = await call('POST', '/auth/authorize-self', {});
          priceAuth = { ticket: r.ticket, exp: Date.now() + (Number(r.expiresIn) || 120) * 1000,
                        name: r.authorizer?.name || '', empNo: r.authorizer?.empNo || '' };
          return true;
        } catch (e) { toast(e.message || '自授权失败'); return false; }
      })();
    }
    // V4.25.7：auth_reuse=once → 每次改价都强制弹窗（不复用已有票据）；batch → 120 秒内复用（默认）
    if (authReuse === 'batch' && priceAuthValid()) return Promise.resolve(true);
    return new Promise(resolve => {
      const m = document.createElement('div');
      m.className = 'modal';
      m.innerHTML = `<div class="sheet" style="width:min(430px,92vw)"><h3>🔐 店长授权</h3>
        <div class="hint">「<b>${esc(scene)}</b>」需店长现场授权。<b>仅授权本次价格操作，不会切换当前收银员身份</b>；授权后 120 秒内有效，可连续改价/打折。</div>
        <div class="field"><label>店长工号</label><input id="csAzNo" placeholder="店长工号" autocomplete="off"></div>
        <div class="field"><label>店长授权码</label><input id="csAzCode" type="password" inputmode="numeric" placeholder="4~8 位数字（非登录密码）" autocomplete="off"></div>
        <div class="hint" id="csAzHint">未设置授权码？请老板在后台「员工与角色」中为店长工号设置授权码。</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn ghost" id="csAzX" style="flex:1">取消</button>
          <button class="btn ok" id="csAzGo" style="flex:1">授权</button>
        </div></div>`;
      document.body.appendChild(m);
      const close = (ok) => { m.remove(); resolve(ok); };
      m.querySelector('#csAzX').onclick = () => close(false);
      const go = async () => {
        const empNo = m.querySelector('#csAzNo').value.trim();
        const code = m.querySelector('#csAzCode').value.trim();
        if (!empNo || !code) { toast('请填写店长工号与授权码'); return; }
        const btn = m.querySelector('#csAzGo');
        btn.disabled = true; btn.textContent = '验证中…';
        try {
          const r = await call('POST', '/auth/authorize', { empNo, authCode: code });
          priceAuth = { ticket: r.ticket, exp: Date.now() + (Number(r.expiresIn) || 120) * 1000,
                        name: r.authorizer?.name || '', empNo: r.authorizer?.empNo || '' };
          toast(`✅ 店长 ${priceAuth.name} 已授权（120 秒内有效）`);
          close(true);
        } catch (e) {
          m.querySelector('#csAzHint').innerHTML = `<span style="color:var(--bad)">${esc(e.message || '授权失败')}</span>`;
          btn.disabled = false; btn.textContent = '授权';
          m.querySelector('#csAzCode').select();
        }
      };
      m.querySelector('#csAzGo').onclick = go;
      ['#csAzNo', '#csAzCode'].forEach(sel =>
        m.querySelector(sel).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } }));
      setTimeout(() => m.querySelector('#csAzNo').focus(), 60);
    });
  }
  const targetLine = () => {
    if (!cart.length) return null;
    if (curIdx >= 0 && curIdx < cart.length) return { i: curIdx, l: cart[curIdx] };
    return { i: cart.length - 1, l: cart[cart.length - 1] };
  };
  const nowHM = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // ── 设置加载 ──
  async function loadSettings() {
    const num = (v, d) => { const n = Number(String(v ?? '').replace(/^"|"$/g, '')); return Number.isFinite(n) && n > 0 || n === 0 ? n : d; };
    try {
      // V4.21.2：收银台/收银两组合并为「设备管理」（兼容旧组名，防迁移未跑时拉空）
      let s = await call('GET', '/settings?group=' + encodeURIComponent('设备管理'));
      let rows = Array.isArray(s) ? s : (s.items || []);
      if (!rows.length) {
        s = await call('GET', '/settings?group=' + encodeURIComponent('收银台'));
        rows = Array.isArray(s) ? s : (s.items || []);
      }
      const get = k => { const r = (rows || []).find(x => x.key === k || x.setting_key === k); return r ? r.value : undefined; };
      // V4.21.2：防抖/库存硬拦改 bool（兼容旧 1/0 数字）
      const dvRaw = get('pos.cashier.debounce');
      debounceOn = dvRaw == null ? true : (dvRaw === true || String(dvRaw) === 'true' || num(dvRaw, 0) === 1);
      const shRaw = get('pos.cashier.stock_hard');
      stockHard = shRaw != null && (shRaw === true || String(shRaw) === 'true' || num(shRaw, 0) === 1);
      lockTimeoutMin = num(get('pos.cashier.lock_timeout'), 15);
      // V4.22.0：卡片数改本机设置（LC.gridCols 优先），后台 pos.cashier.grid_cols 仅作新机初始默认
      gridCols = Math.min(8, Math.max(4, num(LC.gridCols || get('pos.cashier.grid_cols'), 5) || 5));
      // VQA-D3：pos.cashier.quick_count 快捷格上限（8~12；本机 LC 覆盖同 gridCols 惯例）
      quickMax = Math.min(12, Math.max(4, num(LC.quickCount || get('pos.cashier.quick_count'), 8) || 8));
      try {
        const pv = await call('GET', '/settings/key/' + encodeURIComponent('voice.product.enabled')).then(r => r?.value).catch(() => null);
        productVoiceOn = pv == null || pv === true || String(pv).replace(/"/g, '') === 'true' || String(pv) === '1' || String(pv) === '开';
        const hb = await call('GET', '/settings/key/' + encodeURIComponent('pos.heartbeat_timeout')).then(r => r?.value).catch(() => null);
        hbTimeoutSec = Math.max(5, num(hb, 10) || 10);
      } catch { /* 读不到按默认（开/10秒） */ }
      const hk = get('pos.cashier.hotkeys'); hotkeysOn = hk == null || hk === true || String(hk) === 'true' || String(hk) === '1';
      // V4.21.0 P16 批2：快捷键映射 + 客显推送开关
      try {
        const hm = get('pos.cashier.hotkey_map');
        const obj = typeof hm === 'string' ? JSON.parse(hm) : hm;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          for (const k of ['pay', 'hold', 'take', 'repeat', 'print', 'lock', 'stock', 'price', 'disc']) {
            const v = String(obj[k] || '').toUpperCase();
            if (/^(F([1-9]|1[0-2])|[A-Z])$/.test(v)) hkMap[k] = v;
          }
        }
      } catch { /* 用默认键位 */ }
      const dp = get('pos.display.push'); dispPush = dp == null || dp === true || String(dp) === 'true' || String(dp) === '1';
      const tt = get('pos.cashier.tts'); ttsOn = tt == null || tt === true || String(tt) === 'true' || String(tt) === '1';
      const pr = get('pos.cashier.print'); printOn = pr == null || pr === true || String(pr) === 'true' || String(pr) === '1';
      // V4.25.7：店长授权策略（后台「设备管理」配置，收银端自动同步）
      authReuse = String(get('pos.price.auth_reuse') ?? 'batch').replace(/^"|"$/g, '') === 'once' ? 'once' : 'batch';
      authSelf = String(get('pos.price.auth_self') ?? 'off').replace(/^"|"$/g, '') === 'on';
      // V4.18.3 P15 批2：积分抵现比例/上限 + 整单折扣预设规则
      ptsCfg = { rate: num(get('pos.points.rate'), 100) || 100, maxPct: num(get('pos.points.max_pct'), 20) };
      // V4.18.4 批3：交接班容差 + 开班备用金默认
      shiftTol = num(get('pos.shift.diff_tolerance'), 5);
      floatDefault = num(get('pos.cashbox.float_default'), 200);
      // V4.26.3：液态玻璃总开关（后台「通用设置」组，按单键读）；关=支付弹层回退实底，省 backdrop-filter 开销
      try {
        const g = await call('GET', '/settings/key/ui.glass.enabled');
        const gv = g?.value;
        const glassOn = gv == null ? true : (gv === true || String(gv) === 'true' || String(gv) === '1');
        document.documentElement.classList.toggle('no-glass', !glassOn);
      } catch { /* 读不到按「开」处理 */ }
      try {
        const raw = get('pos.discount.presets');
        const arr = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
        discPresets = arr.filter(p => p && Number(p.rate) > 0 && Number(p.rate) < 100)
          .map(p => ({ name: String(p.name || '折扣'), rate: Number(p.rate) }));
      } catch { discPresets = []; }
    } catch { /* 默认值 */ }
    try {
      const rr = await call('GET', '/settings/key/' + encodeURIComponent('pos.round_rule'));
      const rule = String(rr?.value ?? '分').replace(/^"|"$/g, '');
      roundUnitC = ({ '分': 1, '角': 10, '5角': 50, '元': 100 })[rule] || 1;
    } catch { roundUnitC = 1; }
  }

  // ── 目录 / 库存 ──
  async function loadCategories() {
    try {
      const d = await call('GET', '/products/categories');
      categories = (Array.isArray(d) ? d : (d.items || [])).map(c => ({ id: Number(c.id), name: c.name }));
    } catch { categories = []; }
  }
  async function refreshStock(ids) {
    if (!navigator.onLine) { stockOnline = false; return; }
    stockOnline = true;
    // V4.18.2 修复④真因：此前无参调用默认取购物车行，空车时直接 return——商品宫格永远拉不到库存；
    // 现改为：空车时拉全价目表（前 500），有车时拉购物车行 + 补齐宫格可见商品
    const base = ids || (cart.length ? cart.map(l => l.p.id) : (Pricebook.items || []).map(p => Number(p.id)));
    const list = base.filter(Boolean).slice(0, 500);
    if (!list.length) return;
    try {
      const d = await call('GET', '/pos/stock?ids=' + list.join(','));
      (d.items || []).forEach(r => stockMap.set(Number(r.productId), Number(r.stockQty) || 0));
      for (const it of (Pricebook.items || [])) {
        const id = Number(it.id);
        if (!stockMap.has(id) && list.includes(id)) stockMap.set(id, 0);   // 无库存记录=0（未进货）
      }
    } catch { /* 库存查询失败：不阻塞收银，按未知处理 */ }
  }
  const stockOf = p => stockMap.has(Number(p.id)) ? stockMap.get(Number(p.id)) : null;

  // ── 车行 ⇄ 快照（V4.18.1 P15 批1：支持开放键临时行 / 赠品行 / 行备注，挂单·挂起·重复上一单共用） ──
  function snapFromCart() {
    return cart.map(l => l.custom
      ? { custom: true, customName: l.p.name, qty: l.qty, unitPrice: linePrice(l), ...(l.remark ? { lineRemark: l.remark } : {}) }
      : { productId: l.p.id, qty: l.qty,
          ...(l.gift ? { gift: true, unitPrice: 0 } : (l.manualPrice != null ? { unitPrice: l.manualPrice } : (l.discRate ? { discRate: l.discRate } : {}))),
          ...(l.remark ? { lineRemark: l.remark } : {}) });
  }
  function snapToLines(items) {
    return (items || []).map(it => {
      if (it.customEntry || it.custom) {
        return { custom: true, p: { id: 0, name: it.customName || it.name || '开放键商品', sellPrice: Number(it.unitPrice) || 0,
                                    memberPrice: 0, minPrice: 0, trackInventory: false, barcode: '' },
                qty: Number(it.qty) || 1, ...(it.lineRemark ? { remark: it.lineRemark } : {}) };
      }
      const pb = Pricebook.items.find(x => Number(x.id) === Number(it.productId));
      if (!pb) return null;
      const line = { p: { ...pb, id: Number(pb.id) }, qty: Number(it.qty) || 1 };
      if (it.gift) { line.gift = true; line.manualPrice = 0; }
      else if (it.unitPrice != null && Number(it.unitPrice) !== Number(pb.sellPrice)) line.manualPrice = Number(it.unitPrice);
      const rm = it.lineRemark || it.remark;
      if (rm) line.remark = rm;
      return line;
    }).filter(Boolean);
  }

  // ── 金额计算（分层展示 A1；促销/券为预估值，结账以服务端计价为准） ──
  function calc() {
    const goods = cart.reduce((s, l) => s + lineAmount(l), 0);
    const memSave = member ? cart.reduce((s, l) => {
      const mp = Number(l.p.memberPrice) || 0;
      return mp > 0 && l.manualPrice == null ? s + (Number(l.p.sellPrice) - mp) * l.qty : s;
    }, 0) : 0;
    let couponCut = 0;
    if (coupon && coupon.type === '满减券' && goods >= (Number(coupon.threshold) || 0)) couponCut = Number(coupon.discount) || 0;
    else if (coupon && coupon.type === '折扣券' && Number(coupon.discount) > 0 && Number(coupon.discount) < 1) couponCut = Math.round(goods * (1 - coupon.discount) * 100) / 100;
    const goodsC = Math.round(goods * 100), couponC = Math.round(couponCut * 100), promoC = Math.round((promo.amount || 0) * 100);
    const discC = orderDisc ? Math.round(orderDisc.amount * 100) : 0;
    let dueC = Math.max(0, goodsC - couponC - promoC - discC);
    const autoRoundC = roundUnitC > 1 && dueC > 0 ? dueC % roundUnitC : 0;   // 分口径取模（元口径浮点 % 有误差），向下去零
    dueC = Math.max(0, dueC - autoRoundC - Math.round(manualRound * 100));
    // V4.18.3 P15 批2 积分抵现：≤单笔上限比例、≤可用积分换算额、≤应收（服务端同口径二次校验）
    let ptsEff = 0;
    if (member && ptsUse > 0 && dueC > 0) {
      const rate = ptsCfg.rate > 0 ? ptsCfg.rate : 100;                      // 多少积分 = 1 元
      const capC = ptsCfg.maxPct > 0 ? Math.floor(dueC * ptsCfg.maxPct / 100) : dueC;
      const availC = Math.floor((Number(member.points) || 0) / rate * 100);  // 可用积分可抵金额（分）
      ptsEff = Math.max(0, Math.min(Math.round(ptsUse * 100), capC, availC, dueC));
      dueC -= ptsEff;
    }
    return { goods, memSave, couponCut, autoRound: autoRoundC / 100, discAmt: discC / 100, ptsCut: ptsEff / 100, due: dueC / 100 };
  }
  let promoTimer = 0;
  function schedulePromo() {
    if (!navigator.onLine || !cart.length) { promo = { amount: 0, next: promo.next }; renderSummary(); return; }
    clearTimeout(promoTimer);
    promoTimer = setTimeout(async () => {
      try {
        const d = await call('POST', '/pos/promo-preview', {
          items: cart.filter(l => !l.custom).map(l => ({ productId: l.p.id, qty: l.qty })), memberId: member ? member.id : undefined,
        });
        promo = { amount: Number(d.promoAmount) || 0, next: d.nextPromo || null };
      } catch { promo = { amount: 0, next: null }; }
      renderSummary();
    }, 350);
  }

  // ── 加车（防抖 / 库存容错 §13.10 / 价格快照） ──
  function stockShort(p, qty) {
    const hit = cart.find(l => l.p.id === Number(p.id));
    const inCart = hit ? hit.qty : 0;
    const st = stockOf(p);
    return { inCart, short: st != null && qty > st - inCart };
  }
  function tryAdd(p, qty, src, el) {
    const s = stockShort(p, qty);
    if (s.short && stockOnline) {
      if (stockHard) { toast(`库存硬拦已开启：${p.name} 账面仅剩 ${stockOf(p)}，不能超卖（收银设置可关）`); return; }
      pwaConfirm('负库存售卖确认',
        `<b>${esc(p.name)}</b> 账面库存 ${stockOf(p)}（已在车 ${s.inCart}），本次要加 <b>${qty}</b>，将超出账面 <b style="color:var(--bad)">${qty + s.inCart - stockOf(p)}</b> 件。<br>账实不符常见于未及时入库/退货未清点；确认后按负库存成交并留痕，进「本班负库存清单」。`,
        { okText: '按负库存继续卖（留痕）' }).then(ok => {
          if (!ok) return;
          negSales.unshift({ t: nowHM(), name: p.name, stock: stockOf(p), had: s.inCart, add: qty });
          doAdd(p, qty, src, true, el);
        });
      return;
    }
    doAdd(p, qty, src, false, el);
  }
  function doAdd(p, qty, src, neg, el) {
    if (neg) toast('已按负库存售卖并留痕（账面 ' + stockOf(p) + '）');
    else {
      const st = stockOf(p);
      if (st != null && st > 0 && st <= 5) toast(`库存偏低：${p.name} 仅剩 ${st}`);
    }
    const now = Date.now();
    if (src === 'scan' && debounceOn && lastScan.id === Number(p.id) && now - lastScan.t < 2000) {
      showDebounceBar(p); flashAdded(p, 0, el); lastScan.id = Number(p.id); lastScan.t = now; return;
    }
    if (src === 'scan') { lastScan.id = Number(p.id); lastScan.t = now; }
    const hit = cart.find(l => l.p.id === Number(p.id) && !l.manualPrice);
    if (hit) hit.qty = Math.round((hit.qty + qty) * 1000) / 1000;   // 价格快照：已加行不受后续调价影响
    else cart.push({ p: { ...p, id: Number(p.id) }, qty, ...(neg ? { neg: true } : {}) });
    flashAdded(p, qty, el);
    renderCart();
    refreshStock();
    if (!neg) toast(`已加车：${p.name}`);
    // V4.18.5 加车即报价；V4.25.7：只播「名称+价格」——库存信息留给「问价」（老板反馈加车报库存太吵）
    try {
      if (ttsOn && productVoiceOn && window.PwaTTS && src !== 'combo') { // VQA-D3：voice.product.enabled 子开关
        const price = member && Number(p.memberPrice) > 0 ? Number(p.memberPrice) : Number(p.sellPrice) || 0;
        window.PwaTTS.say(`${p.name}，${price}元`, { rate: 1.08 });
      }
    } catch { }
  }
  /* V4.26.3 ① 加车视觉反馈：卡片轻缩一下 + 盖一层「✓ 已加入」，0.6s 自动消失。
     触屏收银原来只有按下时的底色变化，松手就没了，店员不确定加没加、容易重复扫。
     el 为空时（扫码枪/搜索回车）按 data-id 在宫格里找对应卡片，找不到就只做件数跳动。 */
  function flashAdded(p, qty, el) {
    try {
      let node = el;
      if (!node || !node.isConnected) {
        const grid = $('#csGrid');
        if (grid) node = grid.querySelector('.cs-pcard[data-id="' + Number(p.id) + '"]');
      }
      if (!node) return;
      node.classList.remove('cs-hit'); void node.offsetWidth; node.classList.add('cs-hit');
      setTimeout(() => node.classList.remove('cs-hit'), 380);
      if (!node.classList.contains('cs-pcard')) return;   // 快捷格等小格只弹一下，不盖浮层
      const tip = document.createElement('div');
      tip.className = 'cs-added';
      tip.innerHTML = `<b>${qty > 0 ? '✓' : '·'}</b><i>${esc(qty > 0 ? (p.name || '已加入') : '2 秒内已加过')}</i>`;
      node.appendChild(tip);
      setTimeout(() => tip.remove(), 640);
    } catch (_) { /* 反馈失败不影响加车 */ }
  }

  let dbTimer = 0;
  function showDebounceBar(p) {
    const bar = $('#csDebounce');
    if (!bar) return;
    bar.style.display = 'flex';
    $('#csDbTxt').textContent = `已加过「${p.name}」— 2 秒内连扫不重复加件`;
    clearTimeout(dbTimer);
    dbTimer = setTimeout(() => { bar.style.display = 'none'; }, 4000);
  }

  // ── 扫码解析（复用 checkout 同链路：秤码 → 价目表 → 在线回退） ──
  async function resolveScan(key) {
    if (/^\d{10,18}$/.test(key) && !Pricebook.find(key)) {
      let sp = null;
      try {
        sp = unwrap(await call('GET', '/products/scale-parse/' + encodeURIComponent(key)));
      } catch {
        sp = window.QWScaleParseLocal ? window.QWScaleParseLocal(key) : { hit: false };   // VQA-P0（M8-02）：断网本地同口径解析
      }
      if (sp) {
        if (sp.ambiguous) {
          toast('⚖ 秤码命中多个商品：' + (sp.candidates || []).map(x => x.name).join('、') + '，请搜索/选品录入');
          return;
        }
        if (sp.hit && sp.product) {
          const base = Pricebook.find(String(sp.product.id)) ||
            { id: sp.product.id, name: sp.product.name, sellPrice: sp.product.sellPrice, unit: sp.product.baseUnit, isWeighted: true };
          const kg = Number(sp.weightKg) || 0;
          if (kg > 0.001) {
            if (sp.amount > 0) {
              const p2 = { ...base, id: Number(base.id) };
              cart.push({ p: p2, qty: Number(kg.toFixed(3)), manualPrice: Number((sp.amount / kg).toFixed(3)) });
              renderCart(); refreshStock();
            } else tryAdd(base, Number(kg.toFixed(3)), 'scan');
            toast(`⚖ 秤码识别${sp.offline ? '（离线）' : ''}：${sp.product.name} ${kg.toFixed(3)}kg`);
            return;
          }
        }
      }
    }
    const hit = Pricebook.find(key);
    if (hit) { tryAdd(hit, 1, 'scan'); return; }
    if (!navigator.onLine) { toast('离线：条码不在本地价目表，恢复联网后重试'); return; }
    try {
      const p = await lookupProduct(key);
      if (p) { tryAdd(p, 1, 'scan'); return; }
      toast('条码未建档：' + key + '（可挂开放键临时行，P15）');
    } catch (e) { toast(e.message || '识别失败'); }
  }
  // 全局 HID 扫码监听（收银台运行期常开；弹窗打开或输入框聚焦时暂停——评审定稿 I3）
  // V4.18.2：键盘快捷键（设置 pos.cashier.hotkeys 可关）；V4.21.0 P16 批2：键位映射 pos.cashier.hotkey_map 可自定义
  // F1=键位说明（固定，拦截浏览器帮助）；浏览器保留键 F3(查找)/F5(刷新)/F11(全屏)/F12(开发者工具) 不建议设
  let scanBuf = '', scanTimer = 0;
  document.addEventListener('keydown', e => {
    if (!active || lockState.locked) return;
    if (e.key === 'F1' && !document.querySelector('.modal') && !document.querySelector('.modal-mask')) {
      e.preventDefault(); showHotkeyHelp(); return;
    }
    if (hotkeysOn) {
      const act = Object.keys(hkMap).find(k => hkMap[k] === e.key);
      if (act) {
        if (document.querySelector('.modal') || document.querySelector('#csPayMask') || document.querySelector('.modal-mask')) return;
        // V4.25.3：字母键位（如 P=改价 / D=打折）在输入框聚焦时不劫持，避免影响录入；功能键照旧
        const tgAct = e.target;
        const inField = tgAct && (tgAct.tagName === 'INPUT' || tgAct.tagName === 'TEXTAREA' || tgAct.tagName === 'SELECT' || tgAct.isContentEditable);
        if (inField && /^[A-Za-z]$/.test(e.key)) return;
        e.preventDefault();
        if (act === 'hold') holdOrder();
        else if (act === 'take') takeOrder();
        else if (act === 'repeat') repeatLastOrder();
        else if (act === 'print') togglePrint();
        else if (act === 'lock') lockNow();
        else if (act === 'stock') openStockQuery();   // V4.24.0：库存查询（默认 F10）
        else if (act === 'pay') openPay();
        // V4.25.3：改价 / 单品折扣作用于当前选中行（默认最后一行；点行可切换）
        else if (act === 'price') { const t = targetLine(); if (!t) toast('购物车为空，无法改价'); else { curIdx = t.i; priceEdit(t.i); } }
        else if (act === 'disc') { const t = targetLine(); if (!t) toast('购物车为空，无法打折'); else { curIdx = t.i; discEdit(t.i); } }
        return;
      }
    }
    if (document.querySelector('.modal') || document.querySelector('#csPayMask') || document.querySelector('.modal-mask')) return;
    const tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT')) return;
    if (e.key === 'Enter' && scanBuf.length >= 6) {
      const code = scanBuf; scanBuf = '';
      resolveScan(code); return;
    }
    // V4.19.0 回车键盘流：购物车有商品 → 回车即「结算」；支付成功弹窗回车=「新的一单」（pwaConfirm enterOk）
    // 扫码枪结束回车因 scanBuf≥6 先命中上一分支，不受影响；空车回车不动作
    if (e.key === 'Enter' && cart.length) {
      e.preventDefault();
      openPay(); return;
    }
    if (/^[0-9]$/.test(e.key)) {
      scanBuf += e.key;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => { scanBuf = ''; }, 120);
    }
  });

  // ── 渲染 ──
  function render() {
    const v = $('#view');
    const info = Pricebook.info();
    v.innerHTML = `
    <div id="csRoot">
      <div id="csTop">
        <div class="cs-brand">${esc(localStorage.getItem('pwa_store_name') || '收银台')}<small>收银台</small></div>
        <span class="cs-ver">V4.25.7</span>
        <div class="cs-lamps" id="csLamps">
          ${csLamp('scanner', '扫码枪')}${csLamp('scale', '电子秤')}${csLamp('printer', '小票机')}${csLamp('drawer', '钱箱')}${csLamp('display', '客显')}
        </div>
        <button class="cs-mini" id="csSelf">一键自检</button>
        <div class="cs-actions">
          <button class="cs-mini" id="csVoiceAsk">🎤 问价</button>
          <button class="cs-mini" id="csStock">📦 库存查询</button>
          <button class="cs-mini" id="csBell">🔔 消息<b class="cs-dot" id="csBellDot" style="display:none;background:var(--bad)"></b></button>
          <button class="cs-mini" id="csNegList">负库存<b class="cs-dot" id="csNegDot" style="display:none"></b></button>
          <button class="cs-mini" id="csPending">挂起单<b class="cs-dot" id="csPendDot" style="display:none"></b></button>
          <button class="cs-mini" id="csRefund">退货</button>
          <button class="cs-mini" id="csShift">班次<b class="cs-dot" id="csShiftDot" style="display:none;background:var(--ok)"></b></button>
          <button class="cs-mini" id="csRepeat">重复上一单</button>
          <button class="cs-mini" id="csReprint">补打上一单</button>
          <button class="cs-mini" id="csLock">锁屏</button>
          <button class="cs-mini" id="csCfg">设置</button>
        </div>
        <div class="cs-user"><b>${esc(ME.name)}</b><span>${esc(ME.empNo)}</span></div>
        <div class="cs-time" id="csClock">--:--</div>
        <button class="cs-mini cs-exit" id="csExit">退出收银台</button>
      </div>
      <div id="csOffline" style="display:none">
        <b>离线收银模式</b><span>现金记账 + 暂存补传 · 扫码扣款/券/促销预览暂不可用</span>
        <span class="cs-pill" id="csStaged"></span>
      </div>
      <div id="csMain">
        <div id="csLeft">
          <div id="csCats"></div>
          <div id="csQuickWrap">
            <div class="cs-label"><span>快捷商品（点 ★ 在下方商品卡编辑，共 <span id="csQn">8</span> 格）</span><button class="cs-mini" id="csQEdit">编辑</button></div>
            <div id="csQuick"></div>
          </div>
          <div class="cs-label" style="padding:2px 14px 0"><span><b class="cs-catnow" id="csCurCat">全部</b><span id="csCatTail">类商品</span> <span id="csPbInfo"></span></span><button class="cs-mini" id="csOpenKey">开放键 · 手输杂货</button></div>
          <div id="csGrid"></div>
          <div id="csScanBar">
            <div id="csSug" style="display:none"></div>
            <div class="cs-search"><input id="csSearch" placeholder="扫码 / 商品名 / 拼音码（如 ysx）" autocomplete="off"></div>
            <button class="cs-scanbtn" id="csScanBtn">扫 码<small>扫码枪直接扫</small></button>
            <button class="cs-sb-btn" id="csPark">挂单</button>
            <button class="cs-sb-btn" id="csTake">取单<b class="cs-dot" id="csTakeDot" style="display:none"></b></button>
            <button class="cs-sb-btn" id="csSplit">分单</button>
          </div>
        </div>
        <div id="csRight">
          <div id="csMemCard"></div>
          <div id="csCartHead"><b>当前购物车</b><span class="cs-cnt" id="csCnt">0 件</span><button id="csClear">清空</button></div>
          <div id="csDebounce"><span id="csDbTxt"></span><button id="csUndo">撤销上一件</button></div>
          <div id="csCart"></div>
          <div id="csSum"></div>
          <div id="csPayBar">
            <div class="cs-due"><small>应收合计</small><div class="cs-num"><em>¥</em><span id="csDue">0.00</span></div></div>
            <button id="csGo">结 算<small>触屏点按</small></button>
          </div>
        </div>
      </div>
      <div id="csLockMask" style="display:none">   <!-- 遮罩层 id 不得与顶栏 csLock 按钮重复 -->
        <div class="cs-lock-card">
          <div class="cs-lock-avatar">${esc((ME.name || '员')[0])}</div>
          <b>${esc(ME.name)}</b><div class="cs-lock-role">收银台已锁定 · 购物车/挂单/设备连接原样保留</div>
          <div class="cs-lock-err" id="csLockErr"></div>
          <div class="cs-lock-frozen" id="csLockFrozen"></div>
          <div class="cs-field" style="display:flex;gap:8px">
            <input id="csLockNo" value="${esc(ME.empNo)}" style="width:90px;flex:none" readonly>
            <input id="csLockPw" type="password" placeholder="PIN 或 密码解锁" autocomplete="current-password" style="flex:1;min-width:0;width:auto">
          </div>
          <button class="cs-pri" id="csUnlock" style="width:100%;margin-top:10px">解锁</button>
          <div class="cs-lock-tip">连续错 5 次锁 5 分钟 · 优先 PIN，未设 PIN 则用登录密码</div>
        </div>
      </div>
    </div>`;
    CK = { root: v };
    bindTop();
    bindLeft();
    renderMemberCard();
    renderCart();
    renderLamps();
    startClock();
    armIdleLock();
    $('#csPbInfo').textContent = Pricebook.ready ? `（本地价目表 ${info.count} 条）` : '（价目表同步中…）';
    renderQuick(); renderCats(); renderGrid();
    // 联网数据：目录/库存/促销
    loadCategories().then(() => renderCats());
    Pricebook.ready ? refreshStock().then(() => { renderGrid(); renderQuick(); }) : null;
    refreshStagedBadge();
  }

  function csLamp(k, name) {
    return `<div class="cs-lamp" data-dev="${k}"><i class="cs-dot-l"></i>${name}</div>`;
  }
  function startClock() {
    clearInterval(window.__csClock);
    window.__csClock = setInterval(() => { const el = $('#csClock'); if (el) el.textContent = nowHM(); }, 1000);
    $('#csClock') && ($('#csClock').textContent = nowHM());
  }

  // ── 顶栏事件 ──
  /** V4.18.9：F7 小票打印开关（立即生效+留痕；与后台 pos.print.auto 总开关叠加） */
  async function togglePrint() {
    printOn = !printOn;
    try { await call('PUT', '/settings/' + encodeURIComponent('pos.cashier.print'), { value: printOn, reason: 'F7 快捷切换' }); } catch { /* 断网时本单内存生效 */ }
    toast(printOn ? '🖨 小票打印已开启（F7 再按关闭）' : '🔇 小票打印已关闭（F7 再按开启；收款/钱箱不受影响）');
  }
  function bindTop() {
    // V4.22.3：必须包一层箭头函数——直接 `= exit` 会把 click 事件当 silent 传入，导致确认框/挂单校验被跳过
    $('#csExit').onclick = () => exit();
    $('#csSelf').onclick = selfCheck;
    $('#csLock').onclick = lockNow;
    $('#csUnlock').onclick = unlockTry;
    $('#csLockPw').addEventListener('keydown', e => { if (e.key === 'Enter') unlockTry(); });
    $('#csReprint').onclick = reprintLast;
    $('#csRepeat').onclick = repeatLastOrder;
    $('#csOpenKey').onclick = openKeyAdd;
    $('#csNegList').onclick = showNegList;
    $('#csPending').onclick = showPending;
    $('#csRefund').onclick = () => openRefund();
    $('#csShift').onclick = openShiftModal;
    $('#csPark').onclick = holdOrder;
    $('#csTake').onclick = takeOrder;
    $('#csSplit').onclick = openSplit;
    $('#csVoiceAsk').onclick = openVoiceAsk;
    $('#csStock').onclick = openStockQuery;   // V4.24.0 ④：库存查询弹窗（另有热键，默认 F10）
    $('#csBell').onclick = showBellMsgs;
    $('#csCfg').onclick = openSettings;
    document.querySelectorAll('#csLamps .cs-lamp').forEach(el => {
      el.onclick = () => lampReconnect(el.dataset.dev);
    });
  }
  function bindLeft() {
    $('#csSearch').addEventListener('input', debounce2(csSuggest, 250));
    $('#csSearch').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        searchEnter();
        $('#csSug').style.display = 'none';
      }
      if (e.key === 'Escape') { $('#csSearch').value = ''; gridFilter = ''; renderGrid(); $('#csSug').style.display = 'none'; $('#csSearch').blur(); }
    });
    $('#csScanBtn').onclick = () => { $('#csSearch').focus(); toast('扫码枪直接对准商品扫即可（全局收码）'); };
    $('#csClear').onclick = async () => {
      if (!cart.length) return;
      if (await pwaConfirm('清空购物车', '确认清空当前购物车？（可先挂单暂存）')) { cart.length = 0; coupon = null; manualRound = 0; renderCart(); }
    };
    $('#csUndo').onclick = () => {
      const l = cart[cart.length - 1];
      if (l) { l.qty = Math.round((l.qty - (isW(l.p) ? 0.05 : 1)) * 1000) / 1000; if (l.qty <= 0) cart.pop(); renderCart(); toast('已撤销 1 件'); }
      $('#csDebounce').style.display = 'none';
    };
    $('#csQEdit').onclick = () => { quickEdit = !quickEdit; $('#csQEdit').textContent = quickEdit ? '完成' : '编辑'; renderGrid(); renderQuick(); };
    $('#csGo').onclick = openPay;
  }
  function debounce2(fn, ms) { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ── 分类 / 宫格 / 快捷格 ──
  function renderCats() {
    const box = $('#csCats'); if (!box) return;
    const chips = [{ id: 0, name: '全部' }].concat(categories);
    box.innerHTML = chips.map(c => `<button class="cs-chip${c.id === curCat ? ' on' : ''}" data-c="${c.id}">${esc(c.name)}</button>`).join('');
    box.querySelectorAll('.cs-chip').forEach(b => b.onclick = () => { curCat = Number(b.dataset.c); gridFilter = ''; const s = $('#csSearch'); if (s) s.value = ''; renderCats(); renderGrid(); });
    // V4.26.3 ④：分类条右侧渐隐提示「右边还有」；滚到尽头撤掉遮罩，选中项自动滚入视野
    box.onscroll = () => updateCatsFade(box);
    requestAnimationFrame(() => {
      updateCatsFade(box);
      const on = box.querySelector('.cs-chip.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  function updateCatsFade(box) {
    if (!box) return;
    box.classList.toggle('cs-at-end', box.scrollLeft + box.clientWidth >= box.scrollWidth - 4);
  }
  function renderGrid() {
    const grid = $('#csGrid'); if (!grid) return;
    grid.style.setProperty('--csCols', String(gridCols || 5));
    // V4.26.3 ⑤：商品区标出当前分类/搜索态，切了类不会「不知道自己在哪」
    const ccEl = $('#csCurCat');
    if (ccEl) {
      const hitCat = (categories || []).find(c => Number(c.id) === Number(curCat));
      ccEl.textContent = gridFilter ? `“${gridFilter}”` : (hitCat ? hitCat.name : '全部');
      ccEl.classList.toggle('filter', !!gridFilter);
      const tail = $('#csCatTail');
      if (tail) tail.textContent = gridFilter ? '的搜索结果' : '类商品';
    }
    let list = Pricebook.items || [];
    let filtering = false;
    if (gridFilter) {   // V4.18.2：搜索候选过滤态（相关度排序，放大展示于商品区）
      list = searchHits(gridFilter);
      filtering = true;
    } else if (curCat) list = list.filter(p => Number(p.categoryId) === curCat);
    if (!Pricebook.ready || !list.length) {
      grid.innerHTML = filtering ? `<div class="cs-empty">未找到「${esc(gridFilter)}」相关商品<br>可试试名称片段或拼音首字母（如“测试商品”→ cssp）</div>`
        : '<div class="cs-empty">价目表为空/未同步：联网后自动同步；离线可用已缓存数据收银</div>';
      return;
    }
    grid.innerHTML = list.slice(0, 60).map(p => {
      const st = stockOf(p);
      const out = stockOnline && st != null && st <= 0;
      const low = stockOnline && st != null && st > 0 && st <= 5;
      const inQuick = (quickIds || []).includes(Number(p.id));
      const price = member && Number(p.memberPrice) > 0 ? p.memberPrice : p.sellPrice;
      return `<div class="cs-pcard${out ? ' out' : ''}" data-id="${p.id}">
        ${quickEdit ? `<button class="cs-star${inQuick ? ' on' : ''}" data-q="${p.id}">★</button>` : ''}
        <span class="cs-stockpill${low ? ' low' : ''}">${stockOnline ? (st == null ? '库存 —' : (out ? '库存 0' : (low ? '仅剩 ' + st : '库存 ' + st))) : '库存 —'}</span>
        <div class="cs-n">${esc(p.name)}</div><div class="cs-bar">${esc(p.barcode || '')}${p.pinyin ? ' · ' + esc(p.pinyin) : ''}</div>
        <div class="cs-prow"><span class="cs-price">¥${money(price)}</span><span class="cs-unit">/${esc(p.unit || '件')}</span>
          ${Number(p.memberPrice) > 0 ? '<span class="cs-mem">会员价</span>' : ''}</div>
        ${out ? '<div class="cs-soldout">沽清·可负库存卖</div>' : ''}
      </div>`;
    }).join('');
    grid.querySelectorAll('.cs-pcard').forEach(c => c.onclick = e => {
      if (e.target.classList.contains('cs-star')) return;
      if (e.target.classList.contains('cs-stockpill')) { showStockDetail(c.dataset.id); return; }   // V4.18.1 P15：点库存角标查详情（批次/到期+顺手加车）
      const p = (Pricebook.items || []).find(x => Number(x.id) === Number(c.dataset.id));
      if (p) tryAdd(p, 1, 'grid', c);   // V4.26.3：带上来源节点，用于「已加入」浮层
    });
    grid.querySelectorAll('.cs-star').forEach(b => b.onclick = e => {
      e.stopPropagation();
      const id = Number(b.dataset.q);
      quickIds = quickIds || [];
      const i = quickIds.indexOf(id);
      if (i >= 0) quickIds.splice(i, 1); else { if (quickIds.length >= quickMax) { toast('快捷格最多 ' + quickMax + ' 格（后台「设备管理 → 快捷格数量」可调 8~12）'); return; } quickIds.push(id); }
      localStorage.setItem('pwa_cashier_quick', JSON.stringify(quickIds));
      renderGrid(); renderQuick();
    });
    const pbInfo = $('#csPbInfo');   // V4.18.2：搜索过滤态提示
    if (pbInfo) pbInfo.textContent = filtering ? `（搜索「${gridFilter}」：${list.length} 个候选，点选加车）`
      : (Pricebook.ready ? `（本地价目表 ${(Pricebook.items || []).length} 条）` : '（价目表同步中…）');
  }
  function renderQuick() {
    const box = $('#csQuick'); if (!box) return;
    if (!quickIds) {
      quickIds = JSON.parse(localStorage.getItem('pwa_cashier_quick') || 'null');
      if (!Array.isArray(quickIds)) quickIds = (Pricebook.items || []).slice(0, quickMax).map(p => Number(p.id));
    }
    const list = quickIds.slice(0, quickMax).map(id => (Pricebook.items || []).find(p => Number(p.id) === id)).filter(Boolean); // VQA-D3：quick_count 上限
    box.innerHTML = list.length ? list.map(p => `
      <div class="cs-qitem" data-id="${p.id}"><div class="cs-qn">${esc(String(p.name).replace(/\s+/g, ''))}</div>
      <div class="cs-qp">¥${money(member && Number(p.memberPrice) > 0 ? p.memberPrice : p.sellPrice)}</div></div>`).join('')
      : '<div class="cs-empty" style="padding:8px">点右侧「编辑」添加常用商品</div>';
    box.querySelectorAll('.cs-qitem').forEach(q => q.onclick = () => {
      const p = (Pricebook.items || []).find(x => Number(x.id) === Number(q.dataset.id));
      if (p) tryAdd(p, 1, 'quick', q);
    });
    $('#csQn') && ($('#csQn').textContent = list.length);
  }
  // 搜索（V4.18.2 重构）：名称/拼音/条码模糊匹配 + 相关度排序；输入即筛选宫格，Enter 智能加车
  // 相关度：拼音或名称前缀(0) > 拼音/名称包含(1) > 条码包含(2)；修复：此前 Enter 会取隐藏的旧联想列表第一行误加车
  function searchHits(kw) {
    const k = kw.toLowerCase();
    return (Pricebook.items || [])
      .map(p => {
        const py = String(p.pinyin || '').toLowerCase();
        const nm = String(p.name || '').toLowerCase();
        const bc = String(p.barcode || '');
        let score = -1;
        if ((py && py.startsWith(k)) || nm.startsWith(k)) score = 0;
        else if ((py && py.includes(k)) || nm.includes(k)) score = 1;
        else if (bc.includes(k)) score = 2;
        return { p, score };
      })
      .filter(x => x.score >= 0)
      .sort((a, b) => a.score - b.score || String(a.p.name).localeCompare(String(b.p.name), 'zh'))
      .slice(0, 30)
      .map(x => x.p);
  }
  function csSuggest() {
    const kw = $('#csSearch').value.trim();
    const box = $('#csSug');
    gridFilter = kw || '';
    renderGrid();
    if (!kw || !Pricebook.ready) { box.style.display = 'none'; return; }
    const hits = searchHits(kw).slice(0, 8);
    if (!hits.length) { box.style.display = 'none'; return; }
    box.innerHTML = hits.map((p, i) => {
      const st = stockOf(p);
      const out = stockOnline && st != null && st <= 0;
      const price = member && Number(p.memberPrice) > 0 ? p.memberPrice : p.sellPrice;
      return `<div class="cs-sug${out ? ' out' : ''}" data-id="${p.id}" data-first="${i === 0 ? 1 : 0}"><span>${esc(p.name)}</span>
        ${p.pinyin ? `<span class="cs-py">${esc(p.pinyin)}</span>` : ''}
        ${out ? '<span class="cs-out-tag">沽清</span>' : ''}<span class="cs-sp">¥${money(price)}</span></div>`;
    }).join('');
    box.style.display = 'block';
    box.querySelectorAll('.cs-sug').forEach(s => s.onclick = () => {
      const p = (Pricebook.items || []).find(x => Number(x.id) === Number(s.dataset.id));
      if (p) tryAdd(p, 1, 'search', s);
      $('#csSearch').value = ''; box.style.display = 'none'; gridFilter = ''; renderGrid();
    });
  }
  function searchEnter() {
    const kw = ($('#csSearch').value || '').trim();
    const box = $('#csSug');
    if (!kw) return;
    // 条码/秤码：纯数字长码走扫码解析链路
    if (/^\d{6,}$/.test(kw)) { $('#csSearch').value = ''; box.style.display = 'none'; gridFilter = ''; resolveScan(kw); return; }
    const hits = searchHits(kw);
    if (!hits.length) { toast(`未找到「${kw}」：可试试名称片段或拼音首字母（如“测试商品”→ cssp）`); return; }
    if (hits.length === 1) {
      tryAdd(hits[0], 1, 'search');
      $('#csSearch').value = ''; box.style.display = 'none'; gridFilter = ''; renderGrid();
      return;
    }
    // 多候选：宫格保持筛选态，由收银员点选（不再自动加第一件）
    const st = stockOf(hits[0]);
    const out0 = stockOnline && st != null && st <= 0;
    toast(`「${kw}」匹配 ${hits.length} 个商品，已筛选展示，请点选（首候选：${hits[0].name}${out0 ? '·沽清' : ''}）`);
    $('#csSearch').value = ''; box.style.display = 'none';
  }

  // ── 会员 ──
  function renderMemberCard() {
    const box = $('#csMemCard'); if (!box) return;
    if (!member) {
      box.innerHTML = `<div class="cs-avatar off">散</div>
        <div class="cs-mi"><b>散客</b><span class="cs-mstats">挂会员享会员价/积分/储值支付</span></div>
        <div class="cs-mops"><input id="csMemK" placeholder="手机号/卡号/姓名" autocomplete="off"></div>
        ${hasPerm('member.register') ? '<button class="cs-mini" id="csMemNew">秒建会员</button>' : ''}`;
      $('#csMemK').addEventListener('input', debounce2(csMemSearch, 300));
      $('#csMemK').addEventListener('keydown', onMemKey);
      $('#csMemNew') && ($('#csMemNew').onclick = () => memberRegister());
    } else {
      const phoneMasked = String(member.phone || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
      box.innerHTML = `<div class="cs-avatar">${esc((member.name || '会')[0])}</div>
        <div class="cs-mi">
          <div class="cs-mline1"><b>${esc(member.name || '会员')}</b>
            ${member.level_name && member.level_name !== '普通会员' ? `<span class="cs-lvl">${esc(member.level_name)}</span>` : ''}
            <span class="cs-mphone">${esc(phoneMasked || (member.card_no ? '卡号 ' + member.card_no : ''))}</span></div>
          <div class="cs-mstats">余额 <b>¥${money(member.balance)}</b> · 待分红 <b>¥${money(member.dividend_balance)}</b> · 积分 <b>${esc(member.points ?? 0)}</b></div>
        </div>
        <div class="cs-mops"><button class="cs-mini" id="csCredBtn">挂账/还款</button><button class="cs-mini" id="csMemSwap">换会员</button></div>`;
      $('#csMemSwap').onclick = () => { member = null; coupon = null; renderMemberCard(); renderCart(); };
      $('#csCredBtn').onclick = () => openCreditsModal();
    }
  }
  function selectMemberById(id) {
    const m = memSearchResults.find(x => Number(x.id) === Number(id));
    if (!m) return false;
    member = m; coupon = null; renderMemberCard(); renderCart(); schedulePromo(); loadCoupons();
    return true;
  }
  function onMemKey(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // V4.25.8：第一次回车执行查找；结果已展示时第二次回车直接选中第一个/唯一会员
    if (memSearchResults.length) {
      const first = memSearchResults[0];
      if (selectMemberById(first.id)) return;
    }
    csMemSearch();
  }
  function csMemSearch() {
    const kw = $('#csMemK').value.trim();
    const box = $('#csMemCard');
    memSearchResults = [];
    if (!kw) { renderMemberCard(); return; }
    call('GET', '/members?keyword=' + encodeURIComponent(kw) + '&size=6').then(d => {
      const list = d.items || [];
      memSearchResults = list;
      if (!document.body.contains($('#csMemK'))) return;
      box.querySelectorAll('.cs-mhit').forEach(x => x.remove());
      box.insertAdjacentHTML('beforeend', (list.length ? list.map(m => {
        const mp = String(m.phone || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2');
        return `<button class="cs-mini cs-mhit" data-m="${m.id}">${esc(m.name || mp)} · ${esc(mp)} · ${esc(m.level_name || '普通会员')} · ¥${money(m.balance)}</button>`;
      }).join('')
        : '<span class="cs-mini cs-mhit" style="color:var(--ink-3)">无匹配会员</span>'));
      box.querySelectorAll('[data-m]').forEach(b => b.onclick = () => selectMemberById(b.dataset.m));
    }).catch(() => { memSearchResults = []; });
  }
  function memberRegister() {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>➕ 秒建会员</h3>
      <div class="field"><label>手机号*</label><input id="csMrPhone" inputmode="numeric" maxlength="11" placeholder="11 位手机号"></div>
      <div class="field"><label>称呼*</label><input id="csMrName" maxlength="20" placeholder="如：李女士 / 杨先生 / 王阿姨"></div>
      <div class="field"><label>生日（可空，生日营销用）</label><input id="csMrBirth" type="date"></div>
      <button class="btn ok" id="csMrGo" style="width:100%">建档并挂到本单</button>
      <button class="btn ghost" id="csMrClose" style="width:100%;margin-top:8px">取消</button></div>`;
    document.body.appendChild(m);
    m.querySelector('#csMrClose').onclick = () => m.remove();
    setTimeout(() => m.querySelector('#csMrPhone').focus(), 60);
    m.querySelector('#csMrGo').onclick = async () => {
      const phone = m.querySelector('#csMrPhone').value.trim(), name = m.querySelector('#csMrName').value.trim();
      const birthday = m.querySelector('#csMrBirth').value || undefined;
      if (!/^1\d{10}$/.test(phone)) { toast('请输入 11 位手机号'); return; }
      if (!name) { toast('请填写称呼（如：李女士）'); return; }
      try {
        await call('POST', '/members', { phone, name, ...(birthday ? { birthday } : {}), privacyAgreed: true, registerChannel: '收银台' });
        const q = await call('GET', '/members?keyword=' + encodeURIComponent(phone) + '&size=1');
        if (q.items && q.items.length) { member = q.items[0]; renderMemberCard(); renderCart(); schedulePromo(); }
        toast('会员建档成功'); m.remove();
      } catch (e) { toast(e.message || e); }
    };
  }
  // 会员可用券（在线）
  async function loadCoupons() {
    if (!member || !navigator.onLine) return;
    try {
      const d = await call('GET', '/coupons/member/' + member.id);
      const list = (Array.isArray(d) ? d : (d.items || [])).filter(c => c.status === '未使用');
      if (list.length) toast(`会员有 ${list.length} 张可用券，结算页可选用`);
    } catch { /* 静默 */ }
  }

  // ── 购物车 / 合计 ──
  function renderCart() {
    const box = $('#csCart'); if (!box) return;
    if (!cart.length) {
      box.innerHTML = '<div class="cs-empty">扫码或点选商品开始收银</div>';
    } else {
      box.innerHTML = cart.map((l, i) => {
        const w = isW(l.p);
        const qtyTxt = w ? Number(l.qty).toFixed(3) : l.qty;
        const step = w ? 0.05 : 1;
        const price = linePrice(l);
        const st = stockOf(l.p);
        const isNeg = stockOnline && st != null && l.qty > st;
        return `<div class="cs-crow" data-row="${i}"${curIdx === i ? ' style="box-shadow:inset 0 0 0 2px var(--pri,#20663f);border-radius:8px"' : ''}>
          <div class="cs-cn">
            <div class="cs-cnm">${esc(l.p.name)}${l.gift ? '<span class="cs-tag-r">赠</span>' : ''}${l.custom ? '<span class="cs-tag-b">开放键</span>' : ''}${l.discRate ? `<span class="cs-tag-o">${l.discRate}折</span>` : ''}${l.manualPrice != null && !l.gift ? '<span class="cs-tag-o">改价</span>' : ''}${isNeg ? '<span class="cs-tag-r">负库存</span>' : ''}${w ? '<span class="cs-tag-b">称重</span>' : ''}${l.remark ? '<span class="cs-tag-b" title="' + esc(l.remark) + '">注</span>' : ''}</div>
            <div class="cs-csub"><span class="cs-plbl" data-e="${i}" title="点击改价（快捷键 P）">¥${money(price)}</span>
              ${l.gift ? '<span style="color:var(--bad)">赠品 0 元</span>' : (l.discRate ? `<span style="color:var(--warn)">${l.discRate} 折</span>` : (member && Number(l.p.memberPrice) > 0 && l.manualPrice == null ? '<span style="color:var(--warn)">会员价</span>' : (l.custom ? '<span style="color:var(--ink-3)">手输价</span>' : '<span class="cs-snap">快照</span>')))}
              ${(l.manualPrice != null || l.discRate) && !l.gift && price < Number(l.p.sellPrice) ? `<span style="text-decoration:line-through;color:var(--ink-3)">¥${money(l.p.sellPrice)}</span>` : ''}${l.remark ? `<span style="color:var(--ink-3)">· ${esc(l.remark)}</span>` : ''}</div>
          </div>
          <div class="cs-qty">
            <button data-m="${i}" data-st="${step}">−</button>
            <input data-q="${i}" value="${qtyTxt}" inputmode="decimal">
            <button data-p="${i}" data-st="${step}">＋</button>
          </div>
          <div class="cs-amt">¥${money(lineAmount(l))}</div>
          ${!l.custom && !l.gift ? `<button class="cs-mini2" data-f="${i}" title="打折（快捷键 D；本商品最低 ${minDiscOf(l.p) || '不限'} 折）">折</button>` : ''}
          ${!l.custom ? `<button class="cs-mini2" data-g="${i}" title="手工赠品（0元出库·留痕）">赠</button>` : ''}
          <button class="cs-mini2" data-r="${i}" title="行备注">注</button>
          <button class="cs-del" data-d="${i}">✕</button>
        </div>`;
      }).join('');
      box.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
        const l = cart[+b.dataset.m];
        l.qty = Math.round((l.qty - Number(b.dataset.st)) * 1000) / 1000;
        if (l.qty <= 0) cart.splice(+b.dataset.m, 1);
        renderCart();
      });
      box.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
        const i = +b.dataset.p, l = cart[i];
        const nv = Math.round((l.qty + Number(b.dataset.st)) * 1000) / 1000;
        const st = stockOf(l.p);
        if (stockOnline && st != null && nv > st) {
          if (stockHard) { toast(`库存硬拦：${l.p.name} 账面仅剩 ${st}`); return; }
          pwaConfirm('负库存售卖确认', `<b>${esc(l.p.name)}</b> 账面 ${st} 件，加到 <b>${nv}</b> 件将超出账面 <b style="color:var(--bad)">${nv - st}</b> 件。按负库存继续？`, { okText: '按负库存卖（留痕）' }).then(ok => {
            if (!ok) return;
            negSales.unshift({ t: nowHM(), name: l.p.name, stock: st, had: l.qty, add: Math.round((nv - l.qty) * 1000) / 1000 });
            l.qty = nv; renderCart();
          });
          return;
        }
        l.qty = nv; renderCart();
      });
      box.querySelectorAll('[data-q]').forEach(inp => inp.onchange = () => {
        const l = cart[+inp.dataset.q];
        let v = Number(inp.value);
        if (!v || v <= 0) { renderCart(); return; }
        v = isW(l.p) ? Math.round(v * 1000) / 1000 : Math.round(v);
        const st = stockOf(l.p);
        if (stockOnline && st != null && v > l.qty && v > st) {
          if (stockHard) { toast(`库存硬拦：${l.p.name} 账面仅剩 ${st}`); renderCart(); return; }
          pwaConfirm('负库存售卖确认', `<b>${esc(l.p.name)}</b> 账面 ${st} 件，改为 <b>${v}</b> 件将超出账面 <b style="color:var(--bad)">${v - st}</b> 件。按负库存继续？`, { okText: '按负库存卖（留痕）' }).then(ok => {
            if (!ok) { renderCart(); return; }
            negSales.unshift({ t: nowHM(), name: l.p.name, stock: st, had: l.qty, add: Math.round((v - l.qty) * 1000) / 1000 });
            l.qty = v; renderCart();
          });
          return;
        }
        l.qty = v; renderCart();
      });
      box.querySelectorAll('[data-e]').forEach(s => s.onclick = () => { curIdx = +s.dataset.e; priceEdit(+s.dataset.e); });
      // V4.25.3：单品折扣按钮（快捷键 D 同效）
      box.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { curIdx = +b.dataset.f; discEdit(+b.dataset.f); });
      // V4.25.3：点击行 → 设为当前行（改价/打折快捷键的目标），再次点击取消选中
      box.querySelectorAll('[data-row]').forEach(r => r.addEventListener('click', e => {
        if (e.target.closest('button') || e.target.tagName === 'INPUT') return;
        const i = +r.dataset.row;
        curIdx = (curIdx === i) ? -1 : i;
        renderCart();
      }));
      box.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { curIdx = +b.dataset.g; giftEdit(+b.dataset.g); });
      box.querySelectorAll('[data-r]').forEach(b => b.onclick = () => remarkEdit(+b.dataset.r));
      box.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { cart.splice(+b.dataset.d, 1); renderCart(); });
    }
    const cnt = cart.reduce((s, l) => s + l.qty, 0);
    // V4.26.3：件数有变化才跳动（避免每次重绘都闪）
    const cntEl = $('#csCnt');
    if (cntEl) {
      const txt = `${cart.length} 行 · ${Number.isInteger(cnt) ? cnt : cnt.toFixed(3)} 件`;
      if (cntEl.textContent !== txt) {
        cntEl.textContent = txt;
        cntEl.classList.remove('cs-bump'); void cntEl.offsetWidth; cntEl.classList.add('cs-bump');
        setTimeout(() => cntEl.classList.remove('cs-bump'), 460);
      }
    }
    renderSummary(); schedulePromo();
  }
  function renderSummary() {
    const c = calc();
    let html = `<div class="cs-sline"><span>商品总额</span><span>¥${money(c.goods)}</span></div>`;
    if (c.memSave > 0) html += `<div class="cs-sline save"><span>会员价已省</span><span>-¥${money(c.memSave)}</span></div>`;
    if (c.couponCut > 0 && coupon) html += `<div class="cs-sline save"><span>券抵扣（${esc(coupon.name)}·预估）</span><span>-¥${money(c.couponCut)}</span></div>`;
    if (c.discAmt > 0 && orderDisc) html += `<div class="cs-sline save"><span>整单折扣（${esc(orderDisc.name || orderDisc.rate + '折')}·留痕）</span><span>-¥${money(c.discAmt)}</span></div>`;
    if (promo.amount > 0) html += `<div class="cs-sline save"><span>促销优惠（预估）</span><span>-¥${money(promo.amount)}</span></div>`;
    if (c.ptsCut > 0) html += `<div class="cs-sline save"><span>积分抵现（${Math.round(ptsCfg.rate)} 分=1 元）</span><span>-¥${money(c.ptsCut)}</span></div>`;
    if (promo.next) html += `<div class="cs-sline hint"><span>再买 ¥${money(promo.next.threshold - c.goods)} 可用「${esc(promo.next.name)}」</span></div>`;
    if (c.autoRound > 0) html += `<div class="cs-sline"><span>自动抹零</span><span>-¥${money(c.autoRound)}</span></div>`;
    if (manualRound > 0) html += `<div class="cs-sline save"><span>手动抹零（店长·留痕）</span><span>-¥${money(manualRound)}</span></div>`;
    $('#csSum').innerHTML = html;
    $('#csDue').textContent = money(c.due);
    pushDisplay();   // V4.21.0：车变即推客显（350ms 去抖；断连/关闭静默跳过）
  }
  // 改价（最低售价硬拦，§5.1）
  function priceEdit(i) {
    const l = cart[i]; if (!l) return;
    const m = document.createElement('div');
    m.className = 'modal';
    const minP = minPriceOf(l.p);
    m.innerHTML = `<div class="sheet"><h3>改价：${esc(l.p.name)}</h3>
      <div class="field"><label>新单价（元）· 最低售价 ¥${money(minP)}</label><input id="csPeIn" inputmode="decimal" value="${money(linePrice(l))}"></div>
      <div class="hint" id="csPeHint">低于最低售价将被拒绝（未设最低卖价时按<b>进价</b>兜底）；店长可放行并留痕。</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="csPeNo" style="flex:1">取消</button>
        <button class="btn ok" id="csPeOk" style="flex:1">确定</button>
      </div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csPeNo').onclick = () => m.remove();
    setTimeout(() => m.querySelector('#csPeIn').focus(), 60);
    m.querySelector('#csPeOk').onclick = async () => {
      const v = Number(m.querySelector('#csPeIn').value);
      if (!(v > 0)) { toast('请输入有效价格'); return; }
      if (v < minP) {
        if (!hasPerm('pos.emergency.manual')) {
          m.querySelector('#csPeHint').innerHTML = `<span style="color:var(--bad)">低于最低售价 ¥${money(minP)}，已拒绝（需店长放行）</span>`;
          return;
        }
        if (!confirm(`低于最低售价 ¥${money(minP)}，店长放行并留痕？`)) return;
      }
      // V4.25.5：改价须店长现场授权（授权码），仅授权本次价格操作
      if (!(await ensurePriceAuth('改价'))) return;
      l.manualPrice = v; delete l.discRate;
      m.remove(); renderCart(); toast('已改价（店长已授权）');
    };
  }

  // V4.25.3 单品折扣（行级折扣率）：双红线 —— ① ≥ 商品最低折扣 minDiscountRate；② 折后价 ≥ 最低售价 minPrice
  //   越线需店长（pos.emergency.manual）放行并留痕；服务端同口径二次校验（前端仅体验层）
  function discEdit(i) {
    const l = cart[i];
    if (!l) return;
    if (l.custom) { toast('开放键商品无最低价红线；如需减价请用改价'); return; }
    if (l.gift) { toast('赠品行已是 0 元，无需打折'); return; }
    if (!hasPerm('pos.price.manual')) { toast('单品折扣需改价权限（pos.price.manual）'); return; }
    const m = document.createElement('div');
    m.className = 'modal';
    const base = lineBasePrice(l);
    const minD = minDiscOf(l.p);
    const minP = minPriceOf(l.p);
    const curD = l.discRate || 0;
    m.innerHTML = `<div class="sheet"><h3>打折：${esc(l.p.name)}</h3>
      <div class="field"><label>折扣（如 88 = 88 折）${minD ? `· 本商品最低 ${minD} 折` : ''}</label>
        <input id="csDcIn" inputmode="decimal" value="${curD > 0 ? curD : ''}" placeholder="88"></div>
      <div class="hint" id="csDcHint">原价 ¥${money(base)} · 折后 ¥<b id="csDcPrev">${money(curD > 0 ? base * curD / 100 : base)}</b><br>
        ${minD ? `本商品最低折扣 <b style="color:#b5544a">${minD} 折</b>；` : ''}折后单价不得低于 ¥${money(minP)}<span style="color:#8a8577">（未设最低卖价/折扣时按进价兜底）</span>；越线需店长放行留痕。</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="csDcNo" style="flex:1">取消</button>
        ${curD > 0 ? '<button class="btn ghost" id="csDcClr" style="flex:1">恢复原价</button>' : ''}
        <button class="btn ok" id="csDcOk" style="flex:1">确定</button>
      </div></div>`;
    document.body.appendChild(m);
    const inp = m.querySelector('#csDcIn'), prev = m.querySelector('#csDcPrev');
    inp.addEventListener('input', () => {
      const r = Number(inp.value) || 0;
      prev.textContent = r > 0 ? money(base * r / 100) : money(base);
    });
    m.querySelector('#csDcNo').onclick = () => m.remove();
    const clr = m.querySelector('#csDcClr');
    if (clr) clr.onclick = () => { delete l.discRate; m.remove(); renderCart(); toast('已恢复原价'); };
    setTimeout(() => inp.focus(), 60);
    m.querySelector('#csDcOk').onclick = async () => {
      const r = Number(inp.value);
      if (!(r > 0)) { toast('请输入折扣率（如 88）'); return; }
      if (r >= 100) { delete l.discRate; m.remove(); renderCart(); toast('100 折即原价，已取消折扣'); return; }
      const newP = Math.round(base * r) / 100;
      const badDisc = minD > 0 && r < minD;
      const badPrice = newP < minP;
      if (badDisc || badPrice) {
        if (!hasPerm('pos.emergency.manual')) {
          m.querySelector('#csDcHint').innerHTML = `<span style="color:var(--bad)">${badDisc
            ? `低于本商品最低折扣 ${minD} 折`
            : `折后 ¥${money(newP)} 低于最低售价 ¥${money(minP)}`}，已拒绝（需店长放行）</span>`;
          return;
        }
        if (!confirm(`低于${badDisc ? `最低折扣 ${minD} 折` : `最低售价 ¥${money(minP)}`}，店长放行并留痕？`)) return;
      }
      // V4.25.5：打折须店长现场授权（授权码），仅授权本次价格操作
      if (!(await ensurePriceAuth('单品折扣'))) return;
      delete l.manualPrice;   // 折扣与改价互斥：折扣生效即清除改价
      l.discRate = r;
      m.remove(); renderCart(); toast(`已按 ${r} 折销售（店长已授权）`);
    };
  }

  // ── V4.18.1 P15 批1：赠品行 / 行备注 / 开放键 / 重复上一单 / 扫码查库存 ──
  // 赠品行（0 元出库·库存照扣·权限+留痕，§13 A3 手工赠）
  function giftEdit(i) {
    const l = cart[i]; if (!l || l.custom) return;
    if (!hasPerm('pos.price.manual')) { toast('手工赠品需改价权限（pos.price.manual）'); return; }
    if (l.gift) {   // 已是赠品 → 撤销
      l.gift = false; delete l.manualPrice; l.remark = ''; renderCart(); toast('已撤销赠品，恢复原价'); return;
    }
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>🎁 设为赠品：${esc(l.p.name)}</h3>
      <div class="hint">0 元出库，库存照扣、成本照记；需改价权限，服务端留痕。行备注记赠送原因。</div>
      <div class="field"><label>赠送原因（留痕）</label><input id="csGfRm" placeholder="如：客诉补偿 / 促销搭赠"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="csGfNo" style="flex:1">取消</button>
        <button class="btn ok" id="csGfOk" style="flex:1">设为赠品</button></div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csGfNo').onclick = () => m.remove();
    setTimeout(() => m.querySelector('#csGfRm').focus(), 60);
    m.querySelector('#csGfOk').onclick = async () => {
      // V4.25.5：0 元赠品属价格操作，须店长现场授权（撤销赠品无需授权）
      if (!(await ensurePriceAuth('手工赠品（0 元出库）'))) return;
      l.gift = true; l.manualPrice = 0; l.remark = m.querySelector('#csGfRm').value.trim();
      m.remove(); renderCart(); toast('该行已设为赠品（0 元·店长已授权）');
    };
  }
  // 行备注
  function remarkEdit(i) {
    const l = cart[i]; if (!l) return;
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>✏️ 行备注：${esc(l.p.name)}</h3>
      <div class="field"><input id="csRmIn" maxlength="100" placeholder="赠品原因 / 口味要求 / 顾客称呼等" value="${esc(l.remark || '')}"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="csRmNo" style="flex:1">取消</button>
        <button class="btn ok" id="csRmOk" style="flex:1">保存</button></div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csRmNo').onclick = () => m.remove();
    setTimeout(() => m.querySelector('#csRmIn').focus(), 60);
    m.querySelector('#csRmOk').onclick = () => {
      l.remark = m.querySelector('#csRmIn').value.trim();
      m.remove(); renderCart();
    };
  }
  // 开放键：无码杂货手输（不建档案不碰库存，行落占位商品）
  function openKeyAdd() {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>⌨️ 开放键 · 手输杂货</h3>
      <div class="hint">无条码商品（如散装杂货）临时行：不建档案、不碰库存，营收照记。品名/价格记入行，历史单按行备注可查。</div>
      <div class="field"><label>品名*</label><input id="csOkName" maxlength="50" placeholder="如：散装甘草梅"></div>
      <div style="display:flex;gap:8px">
        <div class="field" style="flex:1"><label>单价（元）*</label><input id="csOkPrice" inputmode="decimal" placeholder="0.00"></div>
        <div class="field" style="width:90px"><label>数量</label><input id="csOkQty" inputmode="decimal" value="1"></div>
      </div>
      <div class="field"><label>备注</label><input id="csOkRm" maxlength="100" placeholder="可空"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn ghost" id="csOkNo" style="flex:1">取消</button>
        <button class="btn ok" id="csOkGo" style="flex:1">加入购物车</button></div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csOkNo').onclick = () => m.remove();
    setTimeout(() => m.querySelector('#csOkName').focus(), 60);
    m.querySelector('#csOkGo').onclick = () => {
      const name = m.querySelector('#csOkName').value.trim();
      const price = Number(m.querySelector('#csOkPrice').value);
      const qty = Number(m.querySelector('#csOkQty').value) || 1;
      if (!name) { toast('请输入品名'); return; }
      if (!(price > 0)) { toast('请输入有效单价'); return; }
      if (!(qty > 0)) { toast('数量必须大于 0'); return; }
      cart.push({ custom: true, p: { id: 0, name, sellPrice: Math.round(price * 100) / 100, memberPrice: 0, minPrice: 0, trackInventory: false, barcode: '' },
                  qty, remark: m.querySelector('#csOkRm').value.trim() });
      m.remove(); renderCart(); toast('开放键行已加入：' + name);
    };
  }
  // 重复上一单（一键重上车，行价按上单成交价；V4.18.2：缺失行在线补档/跳过，不再整体失败）
  async function repeatLastOrder() {
    let d;
    try { d = await call('GET', '/pos/last-order'); } catch (e) { toast(e.message); return; }
    const o = d && d.order;
    if (!o || !(o.items || []).length) { toast('没有可重复的上一单'); return; }
    const ok = await pwaConfirm('重复上一单',
      `上一单 ${esc(o.orderNo)}（${dt(o.createdAt)} · ${o.items.length} 行）的商品将按原成交价重新上车。继续？`, { okText: '重上车' });
    if (!ok) return;
    const lines = [];
    const skipped = [];
    for (const it of o.items) {
      if (it.customEntry || it.custom) { lines.push(...snapToLines([it]).filter(Boolean)); continue; }
      const hit = snapToLines([it]).filter(Boolean);
      if (hit.length) { lines.push(...hit); continue; }
      // 价目表缺失：在线补档一次（下架商品仍不可补）
      const p = await productById(Number(it.productId)).catch(() => null);
      if (p) lines.push({ p: { ...p, id: Number(p.id) }, qty: Number(it.qty) || 1, ...(it.unitPrice != null && Number(it.unitPrice) !== Number(p.sellPrice) ? { manualPrice: Number(it.unitPrice) } : {}) });
      else skipped.push(it.name || ('商品#' + it.productId));
    }
    if (!lines.length) { toast('上一单商品均已下架/不在本店价目表，无法重上车'); return; }
    lines.forEach(l => cart.push(l));
    renderCart(); refreshStock();
    toast(`已按上一单重上车（${lines.length} 行）${skipped.length ? `；跳过 ${skipped.length} 行缺失商品：${skipped.join('、')}` : ''}`);
  }
  // 扫码查库存（商品卡点库存角标弹出，查完可顺手加车）
  async function showStockDetail(pid) {
    const pb = Pricebook.items.find(x => Number(x.id) === Number(pid));
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = '<div class="sheet"><h3>📦 库存详情</h3><div class="empty">加载中…</div></div>';
    document.body.appendChild(m);
    try {
      const d = await call('GET', '/pos/product-detail?productId=' + Number(pid));
      const p = d.product || {};
      const st = d.stockQty;
      const batches = d.batches || [];
      m.innerHTML = `<div class="sheet"><h3>📦 ${esc(p.name)}<button class="mini-btn" id="csSdX" style="float:right">关闭</button></h3>
        <div class="cs-sd-grid">
          <span>条码</span><b>${esc(p.barcode || '—')}</b>
          <span>规格</span><b>${esc(p.spec || '—')} / ${esc(p.baseUnit || '')}</b>
          <span>零售价</span><b>¥${money(p.sellPrice)}</b>
          <span>账面库存</span><b style="color:${st != null && st <= 0 ? 'var(--bad)' : (st != null && st <= 5 ? 'var(--warn)' : 'var(--ok)')}">${st == null ? '未知' : st}${p.isWeighted ? '（称重）' : ''}</b>
        </div>
        <div class="cs-label" style="margin-top:8px"><span>在库批次（先进先出）</span></div>
        <div class="cs-sd-batch">${batches.length ? batches.map(b => `
          <div class="row"><div class="grow"><div class="t">${b.expiryDate ? '到期 ' + b.expiryDate : '无到期日'} · 余 <b>${b.remainQty}</b></div>
          <div class="s">入库 ${b.inboundDate || '—'}</div></div></div>`).join('') : '<div class="empty">无在库批次（账实可能不符，售卖走负库存确认）</div>'}</div>
        <button class="btn ok" id="csSdAdd" style="width:100%;margin-top:10px">加入购物车 ×1</button></div>`;
      m.querySelector('#csSdX').onclick = () => m.remove();
      m.querySelector('#csSdAdd').onclick = () => { if (pb) tryAdd(pb, 1, 'search'); m.remove(); };
    } catch (e) { m.innerHTML = `<div class="sheet"><h3>📦 库存详情</h3><div class="empty">${esc(e.message || '查询失败')}</div><button class="btn ghost" id="csSdX" style="width:100%">关闭</button></div>`; m.querySelector('#csSdX').onclick = () => m.remove(); }
  }

  // ── V4.24.0 ④：库存查询弹窗（顶栏「库存查询」/ 热键，默认 F10） ──
  //  场景：收货核对、顾客问「还有多少」、找货——不离开收银台即可查库存与批次明细。
  //  口径：纯数字长码走条码解析；否则先本地价目表模糊（支持拼音码），再服务端 /products 兜底。
  async function openStockQuery() {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet" style="width:min(560px,96vw)">
      <h3>📦 库存查询<button class="mini-btn" id="csSqX" style="float:right">关闭</button></h3>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:9px">
        <input id="csSqK" class="mini-input" style="flex:1;min-width:0" placeholder="条码 / 商品名 / 拼音码（如 ysx）" autocomplete="off">
        <button class="mini-btn ok" id="csSqGo">查询</button>
      </div>
      <div id="csSqRes"><div class="hint">输入条码或名称后回车；点结果可看批次明细，也可直接加车。</div></div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csSqX').onclick = () => m.remove();
    const inp = m.querySelector('#csSqK'), res = m.querySelector('#csSqRes');
    const norm = typeof normProduct === 'function' ? normProduct : (x => x);

    const detail = async pid => {
      res.innerHTML = '<div class="empty">加载批次…</div>';
      try {
        const d = await call('GET', '/pos/product-detail?productId=' + Number(pid));
        const p = d.product || {}, st = d.stockQty, batches = d.batches || [];
        const stColor = st != null && st <= 0 ? 'var(--bad)' : (st != null && st <= 5 ? 'var(--warn)' : 'var(--ok)');
        res.innerHTML = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <button class="mini-btn" id="csSqBack">‹ 返回</button>
            <b style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name || '')}</b>
            <button class="mini-btn ok" id="csSqAdd">加入购物车 ×1</button></div>
          <div class="cs-sd-grid">
            <span>条码</span><b>${esc(p.barcode || '—')}</b>
            <span>规格</span><b>${esc(p.spec || '—')} / ${esc(p.baseUnit || '')}</b>
            <span>零售价</span><b>¥${money(p.sellPrice)}${Number(p.memberPrice) > 0 ? '（会员 ¥' + money(p.memberPrice) + '）' : ''}</b>
            <span>账面库存</span><b style="color:${stColor}">${st == null ? '未知' : st}${p.isWeighted ? '（称重）' : ''}</b>
          </div>
          <div class="cs-label" style="margin-top:8px"><span>在库批次（先进先出）</span></div>
          <div class="cs-sd-batch">${batches.length ? batches.map(b => `
            <div class="row"><div class="grow"><div class="t">${b.expiryDate ? '到期 ' + esc(b.expiryDate) : '无到期日'} · 余 <b>${b.remainQty}</b></div>
            <div class="s">入库 ${esc(b.inboundDate || '—')}</div></div></div>`).join('') : '<div class="empty">无在库批次（账实可能不符，售卖走负库存确认）</div>'}</div>`;
        res.querySelector('#csSqBack').onclick = () => run();
        res.querySelector('#csSqAdd').onclick = () => {
          const pb = (Pricebook.items || []).find(x => Number(x.id) === Number(pid));
          if (pb) { tryAdd(pb, 1, 'search'); toast('已加入购物车'); m.remove(); }
          else toast('该商品不在本地价目表：请用扫码枪扫描条码加入');
        };
      } catch (e) {
        res.innerHTML = `<div class="empty">${esc(e.message || '查询失败')}</div>`;
      }
    };

    const run = async () => {
      const kw = (inp.value || '').trim();
      if (!kw) { res.innerHTML = '<div class="hint">请输入条码或商品名。</div>'; return; }
      res.innerHTML = '<div class="empty">查询中…</div>';
      if (/^\d{6,}$/.test(kw)) {           // 条码 / 秤码：走扫码解析链路
        const p = await lookupProduct(kw).catch(() => null);
        if (!p) { res.innerHTML = `<div class="empty">未找到条码「${esc(kw)}」<br>可试试商品名或拼音码</div>`; return; }
        return detail(Number(p.id));
      }
      let hits = searchHits(kw).slice(0, 20);
      if (!hits.length) {                  // 本地价目表未命中 → 服务端兜底（价目表同步不全时）
        try {
          const list = unwrap(await call('GET', '/products?keyword=' + encodeURIComponent(kw) + '&size=20'));
          hits = (Array.isArray(list) ? list : []).map(norm).filter(Boolean).slice(0, 20);
        } catch { /* 兜底失败按未找到处理 */ }
      }
      if (!hits.length) { res.innerHTML = `<div class="empty">未找到「${esc(kw)}」<br>可试试名称片段或拼音首字母（如“测试商品”→ cssp）</div>`; return; }
      res.innerHTML = hits.map(p => {
        const st = stockOf(p);
        const cls = stockOnline && st != null ? (st <= 0 ? 'color:var(--bad)' : st <= 5 ? 'color:var(--warn)' : 'color:var(--ok)') : '';
        return `<div class="cs-sq-row" data-id="${p.id}" style="display:flex;gap:10px;align-items:center;padding:9px 10px;border:1px solid var(--line);border-radius:10px;margin-bottom:6px;cursor:pointer">
          <div style="flex:1;min-width:0"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</div>
            <div style="font-size:12px;color:var(--ink-3)">${esc(p.barcode || '—')}${p.pinyin ? ' · ' + esc(p.pinyin) : ''}</div></div>
          <div style="text-align:right;min-width:52px"><div style="font-size:11.5px;color:var(--ink-3)">库存</div><b style="${cls}">${stockOnline && st != null ? st : '—'}</b></div>
          <div style="text-align:right;min-width:66px"><div style="font-size:11.5px;color:var(--ink-3)">售价</div><b>¥${money(p.sellPrice)}</b></div></div>`;
      }).join('');
      res.querySelectorAll('.cs-sq-row').forEach(row => row.onclick = () => detail(Number(row.dataset.id)));
    };

    m.querySelector('#csSqGo').onclick = run;
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    setTimeout(() => { try { inp.focus(); } catch { /* noop */ } }, 60);
  }

  // ── V4.18.3 P15 批2：挂账/还款管理（欠款列表 + 收款销账 + 店长关闭/核销，§13.2 B2/B3） ──
  async function openCreditsModal() {
    if (!member) { toast('请先选择会员'); return; }
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>📒 挂账/还款：${esc(member.name || member.phone || '')}<button class="mini-btn" id="csCmX" style="float:right">关闭</button></h3>
      <div id="csCmBody" class="hint">加载中…</div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csCmX').onclick = () => m.remove();
    const closeable = hasPerm('pos.credit.close');
    const load = async () => {
      const body = m.querySelector('#csCmBody');
      try {
        const d = await call('GET', '/pos/credits?memberId=' + member.id);
        const list = d.items || [];
        const total = Number(d.total) || 0;
        body.innerHTML = `
          <div class="kv"><span class="k">在途欠款合计</span><span class="v" style="color:${total > 0 ? 'var(--bad)' : 'var(--ok)'}">¥${money(total)}${d.overdueCount ? ` · 超期 ${d.overdueCount} 笔` : ''}</span></div>
          ${list.length ? `<div style="max-height:200px;overflow-y:auto;margin:8px 0">${list.map(cr => `
            <div class="kv"><span class="k">${cr.overdue ? '<span style="color:var(--bad)">超期</span> · ' : ''}${new Date(cr.created_at).toLocaleDateString('zh-CN')} 挂账
              ${closeable ? `<button class="mini-btn" data-cl="${cr.id}" data-act="关闭">关闭</button> <button class="mini-btn" data-cl="${cr.id}" data-act="核销">核销</button>` : ''}</span>
              <span class="v">¥${money(cr.due_amount)} <span style="color:var(--ink-3);font-weight:400">/ ¥${money(cr.amount)}</span></span></div>`).join('')}</div>`
            : '<div class="empty">无在途欠款</div>'}
          ${total > 0 ? `<div class="cs-combo" style="margin-top:10px">
            <div class="cs-cell"><label>收款金额（元）</label><input id="csCmAmt" inputmode="decimal" value="${money(total)}"></div>
            <div class="cs-cell"><label>收款方式</label><select id="csCmCh"><option>现金</option><option>微信</option><option>支付宝</option><option>余额</option></select></div>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn ghost" id="csCmOldest" style="flex:1">结清最旧一笔</button>
            <button class="btn ok" id="csCmGo" style="flex:1.4">收款销账</button>
          </div>
          <div class="hint" style="margin-top:6px">默认最旧优先自动分摊；部分销账自动记 partial，逐笔留痕。</div>`
            : ''}`;
        body.querySelectorAll('[data-cl]').forEach(b => b.onclick = async () => {
          const reason = prompt(`${b.dataset.act}该笔挂账？请填写原因（留痕）`);
          if (!reason || !reason.trim()) return;
          try {
            await call('POST', `/pos/credits/${b.dataset.cl}/close`, { action: b.dataset.act, reason: reason.trim() });
            toast(`已${b.dataset.act}并留痕`); load();
          } catch (e) { toast(e.message || e); }
        });
        const go = body.querySelector('#csCmGo'), oldest = body.querySelector('#csCmOldest');
        const settle = async amount => {
          if (!(amount > 0)) { toast('请输入有效金额'); return; }
          try {
            const r = await call('POST', '/pos/credits/settle', { memberId: member.id, amount: Number(amount.toFixed(2)), channel: body.querySelector('#csCmCh').value });
            toast(`销账成功：¥${money(r.amount)}（${r.settledCount} 笔分摊）`); load(); renderMemberCard();
          } catch (e) { toast(e.message || e); }
        };
        go && (go.onclick = () => settle(Number(body.querySelector('#csCmAmt').value) || 0));
        oldest && (oldest.onclick = async () => {
          try {
            const first = list[0];
            await call('POST', '/pos/credits/settle', { memberId: member.id, amount: Number(first.due_amount), channel: body.querySelector('#csCmCh').value });
            toast(`已结清最旧一笔（¥${money(first.due_amount)}）`); load();
          } catch (e) { toast(e.message || e); }
        });
      } catch (e) { body.textContent = e.message || '查询失败'; }
    };
    load();
  }

  // ── V4.18.4 P15 批3：交接班 / 钱箱过程管理 / 日结 / 跨零点（§13 B3/B4/E1） ──
  /** 班次状态刷新（顶栏「班次」按钮：进行中显示时长绿点） */
  async function refreshShift() {
    try { shiftState = await call('GET', '/shifts/current'); } catch { shiftState = null; }
    const btn = $('#csShift');
    if (!btn) return;
    const has = !!(shiftState && shiftState.shift);
    let label = '班次';
    if (has) {
      const mins = Math.max(0, Math.round((Date.now() - new Date(shiftState.shift.opened_at).getTime()) / 60000));
      label = `班中 ${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
    }
    btn.innerHTML = `${esc(label)}<b class="cs-dot" id="csShiftDot" style="display:${has ? '' : 'none'};background:var(--ok)"></b>`;
  }

  /** 58/80mm 自包含打印（交接单/日报专用，不走小票模版） */
  async function csPrintHtml(inner) {
    const w = Number(localStorage.getItem('pwa_receipt_width')) || 80;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:${w}mm auto;margin:3mm}
      body{width:${w - 6}mm;font:12px/1.55 "Microsoft YaHei",sans-serif;color:#000;margin:0}
      h1{font-size:15px;text-align:center;margin:2px 0 6px;letter-spacing:2px}
      .m div{display:flex;justify-content:space-between;font-size:11px}
      table{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px}
      td{padding:1.5px 0;border-bottom:1px dotted #ddd}.r{text-align:right;white-space:nowrap}
      .big{display:flex;justify-content:space-between;font-size:13.5px;font-weight:700;border-top:1px dashed #000;margin-top:6px;padding-top:6px}
      .foot{text-align:center;font-size:10.5px;margin-top:8px;color:#333}
      .cut{text-align:center;letter-spacing:6px;margin:6px 0 0;font-size:10px}
    </style></head><body>${inner}</body></html>`;
    // V4.20.0 P16：EXE 端走 Electron 静默打印（无预览）；失败/浏览器端走 iframe（弹预览属正常）
    if (window.DesktopShell && window.DesktopShell.silentPrintHtml) {
      try { await window.DesktopShell.silentPrintHtml(html, { widthMm: w }); return; } catch { /* 失败落回 iframe */ }
    }
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(f); f.srcdoc = html;
    await new Promise(r => { f.onload = r; setTimeout(r, 800); });
    try { f.contentWindow.focus(); f.contentWindow.print(); } catch { /* 打印被拒不阻断 */ }
    setTimeout(() => f.remove(), 60000);
  }

  function openShiftModal() {
    if (shiftState && shiftState.shift) openShiftPanel();
    else openShiftStart();
  }

  /** 开班确认框（V4.25.0 登录即开班 / 班次按钮共用）
   *  字段：收银员(只读) / 机号 / 班次号 / 开班备用金(本机记忆优先于后台默认)。
   *  fromLogin=true 时强制开班（登录后须先开班才能进收银台；离线紧急可「暂不开班进入」）。 */
  function openShiftStart(opts = {}) {
    const fromLogin = !!opts.fromLogin;
    let memFloat = floatDefault, memPos = 'POS-01', memShift = '1';
    try {
      memFloat = Number(localStorage.getItem('pwa_last_float')) || floatDefault;
      memPos = localStorage.getItem('pwa_last_pos') || 'POS-01';
      memShift = localStorage.getItem('pwa_last_shiftno') || '1';
    } catch { /* 隐私模式忽略 */ }
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>🟢 开班${fromLogin ? '' : '<button class="mini-btn" id="csShX" style="float:right">关闭</button>'}</h3>
      <div class="hint">${fromLogin ? '登录后需先开班，方可进入收银台' : '开班登记备用金，作为当日钱箱应答口径起点'}</div>
      <div class="field"><label>收银员</label><input id="csShEmp" value="${esc(ME.name)}（${esc(ME.empNo)}）" readonly style="background:#f4f5f3;color:var(--ink-2)"></div>
      <div class="field"><label>机号</label><input id="csShPos" value="${esc(memPos)}" maxlength="32" placeholder="如 POS-01"></div>
      <div class="field"><label>班次号</label><input id="csShNo" value="${esc(memShift)}" maxlength="16" placeholder="如 1 / A / 早班"></div>
      <div class="field"><label>开班备用金（元，记忆上次值）</label><input id="csShFloat" inputmode="decimal" value="${memFloat}"></div>
      <button class="btn ok" id="csShGo" style="width:100%;margin-top:10px">开班并进入收银台</button>
      ${fromLogin ? '<button class="cs-link" id="csShSkip" style="width:100%;margin-top:8px;background:none;border:0;color:var(--ink-3);font-size:12px;cursor:pointer">网络异常？暂不开班进入</button>' : '<button class="btn ghost" id="csShDy2" style="width:100%;margin-top:8px">📊 查日结（不开班也可查）</button>'}</div>`;
    document.body.appendChild(m);
    const fl = m.querySelector('#csShFloat');
    setTimeout(() => fl.focus(), 60);
    const doOpen = async () => {
      const f = Number(fl.value) || 0;
      const pos = (m.querySelector('#csShPos').value || 'POS-01').trim() || 'POS-01';
      const sh = (m.querySelector('#csShNo').value || '').trim();
      try {
        await call('POST', '/shifts/open', { posNo: pos, shiftNo: sh, openingFloat: f });
        try { localStorage.setItem('pwa_last_float', String(f)); localStorage.setItem('pwa_last_pos', pos); localStorage.setItem('pwa_last_shiftno', sh); } catch { /* 忽略 */ }
        m.remove(); toast('已开班：机号 ' + pos + ' · 班次 ' + (sh || '-') + ' · 备用金 ¥' + money(f) + ' 已入钱箱流水');
        try { window.logShiftLocal && window.logShiftLocal({ shiftId: '', cashier: (ME && ME.name) || '', kind: '开班', text: `机号 ${pos} · 班次 ${sh || '-'} · 备用金 ¥${money(f)}` }); } catch { /* 忽略 */ }
        await refreshShift();
      } catch (e) { toast(e.message || e); }
    };
    m.querySelector('#csShGo').onclick = doOpen;
    ['#csShFloat', '#csShPos', '#csShNo'].forEach(sel => m.querySelector(sel).addEventListener('keydown', e => { if (e.key === 'Enter') doOpen(); }));
    if (!fromLogin) {
      m.querySelector('#csShX').onclick = () => m.remove();
      m.querySelector('#csShDy2').onclick = () => { m.remove(); openDailyModal(); };
    } else {
      m.querySelector('#csShSkip').onclick = () => { m.remove(); toast('已暂不开班进入收银台（退出时仍将提示无班次）'); };
    }
  }

  /** 班次面板：实时汇总 + 钱箱流水 + 存取/开箱/交班/日结 */
  async function openShiftPanel() {
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>📋 班次管理<button class="mini-btn" id="csShX" style="float:right">关闭</button></h3>
      <div id="csShBody">加载中…</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button class="btn ok" id="csShClose" style="flex:2;min-width:120px">🧾 交班</button>
        <button class="btn ghost" id="csShDaily" style="flex:1;min-width:88px">📊 日结</button>
        <button class="btn ghost" id="csShDrawer" style="flex:1;min-width:88px">开钱箱</button>
      </div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csShX').onclick = () => m.remove();
    const body = m.querySelector('#csShBody');
    const kv = (k, v, strong) => `<div class="kv"><span class="k">${k}</span><span class="v" ${strong ? 'style="font-weight:700"' : ''}>${v}</span></div>`;
    const load = async () => {
      let cur, cb;
      try { cur = await call('GET', '/shifts/current'); } catch (e) { body.innerHTML = `<div class="hint" style="color:var(--bad)">${esc(e.message || e)}</div>`; return; }
      shiftState = cur;
      if (!cur.shift) { body.innerHTML = '<div class="hint">当前没有进行中的班次，请先开班。</div>'; return; }
      try { cb = await call('GET', '/shifts/cashbox'); } catch { cb = { flows: [] }; }
      const s = cur.shift, sum = cur.summary || {};
      const mins = Math.max(0, Math.round((Date.now() - new Date(s.opened_at).getTime()) / 60000));
      body.innerHTML = `
        <div class="hint" style="margin-bottom:6px">#${s.id} · ${esc(s.cashier_name || '')} · 开班 ${dt(s.opened_at)}（${Math.floor(mins / 60)}小时${mins % 60}分）· ${esc(s.pos_no || 'POS-01')}</div>
        ${kv('订单数 / 退款', `${sum.orderCount ?? 0} 单 / ${sum.refundCount ?? 0} 笔 -¥${money(sum.refundCash)}`)}
        ${kv('现金收入', '¥' + money(sum.cashSales))}
        ${kv('扫码（微信/支付宝）', '¥' + money(sum.scanSales))}
        ${kv('余额支付', '¥' + money(sum.balanceSales))}
        ${kv('会员挂账（不进钱箱）', '¥' + money(sum.creditSales))}
        ${kv('积分抵现', '¥' + money(sum.pointsSales))}
        ${kv('备用金 / 存入 / 取出', `¥${money(sum.openingFloat)} / +¥${money(sum.cashboxIn)} / -¥${money(sum.cashboxOut)}`)}
        <div class="kv"><span class="k"><b>应答金额（钱箱应有余现金）</b></span><span class="v" style="font-size:18px;font-weight:800;color:var(--pri)">¥${money(sum.cashboxTotal)}</span></div>
        <div style="margin-top:8px;font-size:12.5px;color:var(--ink-2)">钱箱流水（近 ${Math.min((cb.flows || []).length, 8)} 条）：
          ${(cb.flows || []).slice(0, 8).map(f => `<div class="kv" style="padding:3px 0"><span class="k">${esc(f.type)} ¥${money(f.amount)} · ${esc(f.reason)}</span><span class="v" style="color:var(--ink-3)">${dt(f.createdAt)}</span></div>`).join('') || '暂无'}
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="mini-btn" id="csCbIn">💰 存入</button>
          <button class="mini-btn" id="csCbOut">📤 取出</button>
        </div>`;
      body.querySelector('#csCbIn').onclick = () => openCashboxFlow('存入', load);
      body.querySelector('#csCbOut').onclick = () => openCashboxFlow('取出', load);
    };
    await load();
    m.querySelector('#csShClose').onclick = () => openShiftClose(() => { m.remove(); });
    m.querySelector('#csShDaily').onclick = () => openDailyModal();
    m.querySelector('#csShDrawer').onclick = noTradeOpenDrawer;
  }

  /** 钱箱存入/取出（原因必选，服务端校验留痕） */
  function openCashboxFlow(type, after) {
    const reasons = type === '存入' ? ['换零', '备用金补充', '对账调整'] : ['取现', '换零', '对账调整'];
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>💰 钱箱${type}<button class="mini-btn" id="csCbX" style="float:right">关闭</button></h3>
      <div class="field"><label>金额（元）</label><input id="csCbAmt" inputmode="decimal" placeholder="0.00"></div>
      <div class="field"><label>原因（必选，留痕）</label><select id="csCbReason">${reasons.map(r => `<option>${r}</option>`).join('')}</select></div>
      <button class="btn ok" id="csCbGo" style="width:100%;margin-top:10px">确认${type}并留痕</button></div>`;
    document.body.appendChild(m);
    m.querySelector('#csCbX').onclick = () => m.remove();
    setTimeout(() => m.querySelector('#csCbAmt').focus(), 60);
    m.querySelector('#csCbGo').onclick = async () => {
      const amt = Number(m.querySelector('#csCbAmt').value);
      if (!(amt > 0)) { toast('请输入大于 0 的金额'); return; }
      try {
        await call('POST', '/shifts/cashbox', { type, amount: amt, reason: m.querySelector('#csCbReason').value });
        m.remove(); toast(`钱箱${type} ¥${money(amt)} 已留痕`);
        after && after();
      } catch (e) { toast(e.message || e); }
    };
  }

  /** 无交易开钱箱（对钱/放零；pos.cashbox.open 权限；弹箱失败也留痕 E1） */
  async function noTradeOpenDrawer() {
    if (!hasPerm('pos.cashbox.open')) { toast('无交易开钱箱需要「无交易开钱箱」权限'); return; }
    const reason = await pwaPrompt('无交易开钱箱', '原因（对钱 / 放零 / 核对备用金…）', { okText: '开箱' });
    if (reason == null) return;
    let failed = false;
    try {
      if (window.PwaReceipt && window.PwaReceipt.drawerConnected()) await window.PwaReceipt.kickDrawer();
      else if (window.PwaPrinters) await window.PwaPrinters.kickDrawer();
      else failed = true;
    } catch { failed = true; }
    try { await call('POST', '/shifts/open-drawer', { reason: reason || '', failed }); } catch { /* 留痕失败不阻断 */ }
    toast(failed ? '弹箱失败：请手动开箱（已留痕）' : '钱箱已弹出（已留痕）');
  }

  /** V4.24.0：交班落库 + 打印交接单（交班弹窗 / 退班向导共用一份口径）；成功返回 {closed, csum} */
  async function shiftCloseAndPrint(s, counted, reason) {
    const d = await call('POST', `/shifts/${s.id}/close`, { cashCounted: counted, reason: reason || '' });
    const closed = d.shift, csum = d.summary;
    try {
      await csPrintHtml(`<h1>交接班单</h1>
        <div class="m"><div><span>班次</span><span>#${closed.id} · ${esc(s.cashier_name || '')}</span></div>
        <div><span>开班</span><span>${dt(closed.opened_at)}</span></div>
        <div><span>交班</span><span>${dt(closed.closed_at || Date.now())}</span></div></div>
        <table><tbody>
          <tr><td>订单数</td><td class="r">${csum.orderCount}</td></tr>
          <tr><td>现金收入</td><td class="r">¥${money(csum.cashSales)}</td></tr>
          <tr><td>扫码（微信/支付宝）</td><td class="r">¥${money(csum.scanSales)}</td></tr>
          <tr><td>余额支付</td><td class="r">¥${money(csum.balanceSales)}</td></tr>
          <tr><td>会员挂账</td><td class="r">¥${money(csum.creditSales)}</td></tr>
          <tr><td>积分抵现</td><td class="r">¥${money(csum.pointsSales)}</td></tr>
          <tr><td>退款（现金冲减）</td><td class="r">-¥${money(csum.refundCash)} / ${csum.refundCount} 笔</td></tr>
          <tr><td>备用金</td><td class="r">¥${money(csum.openingFloat)}</td></tr>
          <tr><td>钱箱存入 / 取出</td><td class="r">+¥${money(csum.cashboxIn)} / -¥${money(csum.cashboxOut)}</td></tr>
        </tbody></table>
        <div class="big"><span>应答 / 实点 / 差异</span><span>¥${money(csum.cashboxTotal)} / ¥${money(Number(closed.cash_counted))} / ${Number(closed.diff_amount) >= 0 ? '+' : '-'}¥${money(Math.abs(Number(closed.diff_amount)))}</span></div>
        ${closed.close_reason ? `<div class="m" style="margin-top:4px"><div><span>差异原因</span><span>${esc(closed.close_reason)}</span></div></div>` : ''}
        <div class="foot">交接双方签字确认 · 后端已留档<div class="cut">✂</div></div>`);
    } catch { /* 打印失败不阻断交班 */ }
    try {
      window.logShiftLocal && window.logShiftLocal({ shiftId: Number(closed.id), cashier: s.cashier_name || (ME && ME.name) || '',
        kind: '交班',
        text: `应答 ¥${money(csum.cashboxTotal)} / 实点 ¥${money(Number(closed.cash_counted))} / 差异 ${Number(closed.diff_amount) >= 0 ? '+' : '-'}¥${money(Math.abs(Number(closed.diff_amount)))}` });
    } catch { /* 本机留痕失败忽略 */ }
    await refreshShift();
    return { closed, csum };
  }

  /** V4.24.0：打印营业日报（日结弹窗 / 退班向导共用） */
  async function dailyPrint(data) {
    const t = data.totals;
    await csPrintHtml(`<h1>营业日报</h1>
      <div class="m"><div><span>门店</span><span>${esc(localStorage.getItem('pwa_store_name') || '')}</span></div>
      <div><span>日期</span><span>${data.date}（自然日 · 支付完成口径）</span></div></div>
      <table><tbody>
        <tr><td>订单数</td><td class="r">${t.orders}</td></tr>
        <tr><td>商品金额</td><td class="r">¥${money(t.goods)}</td></tr>
        <tr><td>促销 / 券 / 整单折扣</td><td class="r">-¥${money(t.promo)} / -¥${money(t.coupon)} / -¥${money(t.discount)}</td></tr>
        <tr><td>抹零</td><td class="r">-¥${money(t.round)}</td></tr>
        ${(data.channels || []).map(c => `<tr><td>${esc(c.channel)}</td><td class="r">¥${money(c.amount)}（${c.orders} 单）</td></tr>`).join('')}
        <tr><td>退款</td><td class="r">-¥${money(data.refunds.amount)} / ${data.refunds.count} 笔</td></tr>
        <tr><td>成本 / 毛利</td><td class="r">¥${money(t.cost)} / ¥${money(t.profit)}</td></tr>
        ${data.negativeCount > 0 ? `<tr><td>负库存售卖</td><td class="r">${data.negativeCount} 笔（待入库/盘盈）</td></tr>` : ''}
      </tbody></table>
      <div class="foot">日结结「店」· 交接班结「人」<div class="cut">✂</div></div>`);
  }

  /** 交班：应答 vs 实点 → 差异；超容差强制原因；成功打印交接单 */
  async function openShiftClose(after) {
    let cur;
    try { cur = await call('GET', '/shifts/current'); } catch (e) { toast(e.message || e); return; }
    if (!cur.shift) { toast('没有进行中的班次'); return; }
    const s = cur.shift, sum = cur.summary;
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>🧾 交班结算<button class="mini-btn" id="csScX" style="float:right">关闭</button></h3>
      <div class="kv"><span class="k">应答金额（备用金 + 现金收入 ± 存取）</span><span class="v" style="font-size:18px;font-weight:800">¥${money(sum.cashboxTotal)}</span></div>
      <div class="field"><label>现金实点（清点钱箱现金）</label><input id="csScCnt" inputmode="decimal" value="${sum.cashboxTotal.toFixed(2)}"></div>
      <div class="kv"><span class="k">差异（实点 − 应答）</span><span class="v"><b id="csScDiff" style="color:var(--ok)">¥0.00</b></span></div>
      <div class="field" id="csScReasonRow" style="display:none"><label>差异原因（超容差 ¥${money(shiftTol)} 必填）</label><input id="csScReason" maxlength="200" placeholder="如：找零误差 / 疑似少收已核查"></div>
      <div class="hint">本班 ${sum.orderCount} 单 · 退款 ${sum.refundCount} 笔 ¥${money(sum.refundCash)}；挂账/余额/扫码不进钱箱。</div>
      <button class="btn ok" id="csScGo" style="width:100%;margin-top:10px">确认交班并打印交接单</button></div>`;
    document.body.appendChild(m);
    m.querySelector('#csScX').onclick = () => m.remove();
    const cntInp = m.querySelector('#csScCnt'), diffEl = m.querySelector('#csScDiff'), row = m.querySelector('#csScReasonRow');
    const upd = () => {
      const d = (Number(cntInp.value) || 0) - sum.cashboxTotal;
      diffEl.textContent = (d >= 0 ? '+' : '-') + '¥' + money(Math.abs(d));
      diffEl.style.color = Math.abs(d) > shiftTol ? 'var(--bad)' : 'var(--ok)';
      row.style.display = Math.abs(d) > shiftTol ? '' : 'none';
    };
    cntInp.addEventListener('input', upd); upd();
    m.querySelector('#csScGo').onclick = async () => {
      const counted = Number(cntInp.value);
      if (!Number.isFinite(counted)) { toast('请输入实点金额'); return; }
      try {
        const { closed } = await shiftCloseAndPrint(s, counted, (m.querySelector('#csScReason') || {}).value || '');
        m.remove();
        toast(`已交班：差异 ${Number(closed.diff_amount) >= 0 ? '+' : '-'}¥${money(Math.abs(Number(closed.diff_amount)))}（已留档）`);
        after && after();
      } catch (e) { toast(e.message || e); }
    };
  }

  /** 日结（独立于交接班：结店不结人；自然日口径 + 支付完成时间归属） */
  async function openDailyModal() {
    const today = new Date(Date.now() - 8 * 3600e3).toISOString().slice(0, 10);
    const m = document.createElement('div'); m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>📊 日结（全店日报）<button class="mini-btn" id="csDyX" style="float:right">关闭</button></h3>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <input id="csDyDate" type="date" value="${today}" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--card);color:var(--ink)">
        <button class="mini-btn ok" id="csDyGo">查询</button>
      </div>
      <div id="csDyBody">选择日期后点「查询」。</div>
      <button class="btn ok" id="csDyPrint" style="width:100%;margin-top:10px;display:none">🖨 打印日报</button></div>`;
    document.body.appendChild(m);
    m.querySelector('#csDyX').onclick = () => m.remove();
    let data = null;
    const kv = (k, v, strong) => `<div class="kv"><span class="k">${k}</span><span class="v" ${strong ? 'style="font-weight:700"' : ''}>${v}</span></div>`;
    m.querySelector('#csDyGo').onclick = async () => {
      const d = m.querySelector('#csDyDate').value;
      if (!d) return;
      const body = m.querySelector('#csDyBody');
      body.innerHTML = '加载中…';
      try { data = await call('GET', '/pos/daily?date=' + d); } catch (e) { body.innerHTML = `<div class="hint" style="color:var(--bad)">${esc(e.message || e)}</div>`; return; }
      const t = data.totals, chans = data.channels || [];
      body.innerHTML = `
        ${kv('营业额 / 成本 / 毛利', `¥${money(t.payable)} / ¥${money(t.cost)} / <b style="color:var(--ok)">¥${money(t.profit)}</b>`, true)}
        ${kv('订单数 / 退款', `${t.orders} 单 / ${data.refunds.count} 笔 -¥${money(data.refunds.amount)}`)}
        ${kv('商品金额（原价合计）', '¥' + money(t.goods))}
        ${kv('促销 / 券 / 整单折扣 / 抹零', `¥${money(t.promo)} / ¥${money(t.coupon)} / ¥${money(t.discount)} / ¥${money(t.round)}`)}
        ${chans.map(c => kv('· ' + esc(c.channel) + `（${c.orders} 单）`, '¥' + money(c.amount))).join('') || '<div class="hint">当日无渠道流水</div>'}
        ${data.negativeCount > 0 ? `<div class="hint" style="color:var(--bad)">⚠ 本日负库存售卖 ${data.negativeCount} 笔——请及时入库/盘盈调整</div>` : ''}
        ${(data.shifts || []).length ? `<div class="hint">本日班次：${data.shifts.map(sh => `#${sh.id} ${esc(sh.cashier_name)}（${sh.status}${sh.status === '已交班' ? `，差异 ${Number(sh.diff) >= 0 ? '+' : '-'}¥${money(Math.abs(Number(sh.diff)))}` : ''}）`).join('；')}</div>` : ''}`;
      m.querySelector('#csDyPrint').style.display = '';
    };
    m.querySelector('#csDyPrint').onclick = async () => {
      if (!data) return;
      const t = data.totals;
      try {
        await csPrintHtml(`<h1>营业日报</h1>
          <div class="m"><div><span>门店</span><span>${esc(localStorage.getItem('pwa_store_name') || '')}</span></div>
          <div><span>日期</span><span>${data.date}（自然日 · 支付完成口径）</span></div></div>
          <table><tbody>
            <tr><td>订单数</td><td class="r">${t.orders}</td></tr>
            <tr><td>商品金额</td><td class="r">¥${money(t.goods)}</td></tr>
            <tr><td>促销 / 券 / 整单折扣</td><td class="r">-¥${money(t.promo)} / -¥${money(t.coupon)} / -¥${money(t.discount)}</td></tr>
            <tr><td>抹零</td><td class="r">-¥${money(t.round)}</td></tr>
            ${(data.channels || []).map(c => `<tr><td>${esc(c.channel)}</td><td class="r">¥${money(c.amount)}（${c.orders} 单）</td></tr>`).join('')}
            <tr><td>退款</td><td class="r">-¥${money(data.refunds.amount)} / ${data.refunds.count} 笔</td></tr>
            <tr><td>成本 / 毛利</td><td class="r">¥${money(t.cost)} / ¥${money(t.profit)}</td></tr>
            ${data.negativeCount > 0 ? `<tr><td>负库存售卖</td><td class="r">${data.negativeCount} 笔（待入库/盘盈）</td></tr>` : ''}
          </tbody></table>
          <div class="foot">日结结「店」· 交接班结「人」<div class="cut">✂</div></div>`);
      } catch { /* 打印失败不阻断 */ }
    };
  }

  /** 跨零点日切提示（B4：班次按开班时间计，日结按自然日归属） */
  function startDayTick() {
    if (dayTickTimer) clearInterval(dayTickTimer);
    let curDay = new Date().getDate();
    dayTickTimer = setInterval(() => {
      const d = new Date().getDate();
      if (d !== curDay) {
        curDay = d;
        if (active && !lockState.locked) toast('🕛 已跨零点：新自然日开始；班次仍按开班时间计，日结按自然日归属（B4）');
      }
    }, 60000);
  }

  // ── 结算 ──
  function openPay() {
    if (!cart.length) { toast('购物车为空'); return; }
    if (payInFlight) return;
    const c = calc();
    const m = document.createElement('div');
    m.className = 'modal';
    const offline = !navigator.onLine;
    m.innerHTML = `<div class="sheet" id="csPaySheet">
      <h3>结算收款 <button class="mini-btn" id="csPayX" style="float:right">关闭</button></h3>
      <div class="cs-paytop">
        <div class="cs-paynum"><em>¥</em>${money(c.due)}</div>
        <div class="cs-paydetail">${esc(`商品 ¥${money(c.goods)}${c.memSave > 0 ? ` · 会员省 ¥${money(c.memSave)}` : ''}${c.couponCut > 0 ? ` · 券 ¥${money(c.couponCut)}` : ''}${c.discAmt > 0 ? ` · 整单折扣 ¥${money(c.discAmt)}` : ''}${promo.amount > 0 ? ` · 促销 ¥${money(promo.amount)}` : ''}${c.ptsCut > 0 ? ` · 积分抵现 ¥${money(c.ptsCut)}` : ''}${c.autoRound > 0 ? ` · 抹零 ¥${money(c.autoRound)}` : ''}${manualRound > 0 ? ` · 手动抹零 ¥${money(manualRound)}` : ''}`)}</div>
      </div>
      <div class="cs-optrow"><span>整单备注</span><input id="csOrderNote" maxlength="100" placeholder="挂账原因 / 顾客称呼等（可空）" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:13px;background:var(--card);color:var(--ink)"></div>
      <div class="cs-optrow" id="csTableRow" style="display:none"><span>堂食台位</span><select id="csTableSel" style="flex:1;max-width:240px;border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:13px;background:var(--card);color:var(--ink)"><option value="">不用台位</option></select></div>
      ${offline ? '<div class="warn-bar">📴 离线收银模式：仅现金记账（暂存补传），扫码扣款/券/促销预览暂不可用</div>' : ''}
      <div class="seg" id="csPaySeg">
        <button data-ch="cash" class="on">现金</button>
        <button data-ch="scan" ${offline ? 'class="dis"' : ''}>扫码收款</button>
        <button data-ch="combo" ${offline ? 'class="dis"' : ''}>组合支付</button>
        <button data-ch="balance" ${(!member || offline) ? 'class="dis"' : ''}>余额</button>
      </div>
      <div id="csPaneCash">
        <div class="cs-cashq" id="csCashQ"></div>
        <div class="cs-cashin"><label>顾客实收</label><input id="csCashIn" inputmode="decimal" placeholder="0.00"></div>
        <div class="cs-change"><span>找零</span><b id="csChange">¥0.00</b></div>
      </div>
      <div id="csPaneScan" style="display:none">
        <div class="hint">扫顾客付款码（微信 10~15 / 支付宝 25~30 开头），通道扣款成功自动落单；顾客输密码时自动轮询查单。</div>
        <div class="field"><input id="csScanCode" inputmode="numeric" placeholder="扫码枪直扫，回车确认"></div>
        <div class="hint" id="csScanMsg" style="min-height:20px"></div>
      </div>
      <div id="csPaneCombo" style="display:none">
        <div class="cs-combo">
          <div class="cs-cell"><label>现金部分</label><input id="csComboCash" inputmode="decimal" placeholder="0.00"></div>
          <div class="cs-cell auto"><label>扫码部分（自动补余）</label><input id="csComboScan" readonly placeholder="0.00"></div>
        </div>
        <div class="hint" style="color:var(--bad)" id="csComboErr"></div>
        <div class="hint">退款时按各通道支付占比自动拆分（现金退现金、电子原路回）。</div>
      </div>
      <div id="csPaneBalance" style="display:none">
        <div class="hint" id="csBalInfo">加载会员余额…</div>
        <div class="cs-combo" id="csBalCombo" style="display:none">
          <div class="cs-cell auto"><label>余额抵扣（自动）</label><input id="csBalUse" readonly placeholder="0.00"></div>
          <div class="cs-cell"><label>剩余部分收款</label><select id="csBalRestCh"><option value="cash">收现金</option><option value="scan">扫顾客付款码</option></select></div>
        </div>
        <div class="field" id="csBalScanRow" style="display:none;margin-top:8px"><input id="csBalCode" inputmode="numeric" placeholder="顾客付款码（支付剩余部分，微信 10~15 / 支付宝 25~30 开头）"></div>
        <div class="hint" style="color:var(--bad)" id="csBalErr"></div>
        <div class="hint">余额不足时自动组合支付：余额抵一部分 + 现金/扫码当场结清，不赊账（2026-09-18 口径）。</div>
      </div>
      <div class="cs-optrow"><span>自动抹零</span><span style="color:var(--ink-3)">按后台「抹零规则」服务端执行</span></div>
      <div class="cs-optrow"><span>手动抹零</span>
        <span><button class="mini-btn ${manualRound > 0 ? 'ok' : ''}" id="csMrBtn">${manualRound > 0 ? '已抹 -¥' + money(manualRound) : '抹零至元（店长）'}</button>
        ${hasPerm('pos.price.manual') ? '' : '<span class="pill red">需改价权限</span>'}</span></div>
      <div class="cs-optrow"><span>整单折扣</span><span id="csDiscSlot" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"></span></div>
      <div class="cs-optrow"><span>积分抵现</span><span id="csPtsSlot" style="display:flex;gap:6px;align-items:center"></span></div>
      <div class="cs-optrow"><span>挂账/还款</span><span id="csCreditSlot" style="display:flex;gap:6px;align-items:center"></span></div>
      ${member ? `<div class="cs-optrow"><span>优惠券</span><span id="csCpSlot"><button class="mini-btn" id="csCpBtn">选用券</button>
        <button class="mini-btn" id="csCpCode">输券码</button></span></div>` : ''}
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn ghost" id="csPayCancel" style="flex:1">取消（ESC）</button>
        <button class="btn ok" id="csPayGo" style="flex:1.6;font-size:16px">确认收款</button>
      </div>
      <div class="hint" style="margin-top:8px">回车=收款打小票 · 空格=收款但不打小票（小额免票省纸，可「补打上一单」补票）</div>
    </div>`;
    document.body.appendChild(m);
    const sheet = m.querySelector('#csPaySheet');
    let payType = 'cash';
    let skipPrintOnce = false;   // V4.21.0：空格收款一次有效（仅现金通道）
    pushDisplay({ status: 'pay', guide: '请选择支付方式' }, true);   // 客显：进入结算
    // V4.21.0 P16 批2：堂食台位下拉（空闲/使用中/预留可选，停用除外；落单后台自动转使用中）
    (async () => {
      try {
        const ts = await call('GET', '/tables');
        const list = (Array.isArray(ts) ? ts : (ts.items || [])).filter(t => t.status !== '停用');
        if (!list.length || !document.body.contains(m)) return;
        m.querySelector('#csTableRow').style.display = '';
        const sel = m.querySelector('#csTableSel');
        sel.innerHTML = '<option value="">不用台位</option>' + list.map(t =>
          `<option value="${t.id}"${csTable && Number(csTable.id) === Number(t.id) ? ' selected' : ''}>${esc(t.name)}${t.area ? '（' + esc(t.area) + '）' : ''}${t.status === '使用中' ? ' · 使用中' : ''}</option>`).join('');
        sel.onchange = () => {
          const t = list.find(x => String(x.id) === sel.value);
          csTable = t ? { id: Number(t.id), name: t.name } : null;
          pushDisplay({ tableName: csTable ? csTable.name : null }, true);
        };
      } catch { /* 台位模块不可用则隐藏该行 */ }
    })();
    const updCashQ = () => {
      const opts = [c.due, 50, 100, 200].filter((v, i, a) => a.indexOf(v) === i && v > 0);
      m.querySelector('#csCashQ').innerHTML = opts.map(v => `<button data-v="${v}">¥${v % 1 === 0 ? v : money(v)}</button>`).join('');
      m.querySelectorAll('#csCashQ [data-v]').forEach(b => b.onclick = () => {
        m.querySelector('#csCashIn').value = Number(b.dataset.v).toFixed(2); updChange();
      });
    };
    const updChange = () => {
      const paid = Number(m.querySelector('#csCashIn').value) || 0;
      const diff = paid - c.due;
      const el = m.querySelector('#csChange');
      el.textContent = diff < -0.005 ? '还差 ¥' + money(-diff) : '¥' + money(Math.max(0, diff));
      el.style.color = diff < -0.005 ? 'var(--bad)' : 'var(--ok)';
      // V4.21.0：客显现金引导——应收/实收/找零大字
      pushDisplay({ status: 'pay_cash', due: c.due, paid, change: Math.max(0, diff), guide: diff < -0.005 ? '还需支付 ¥' + money(-diff) : (paid > 0 ? '请收好找零' : '请递给收银员现金') });
    };
    m.querySelector('#csCashIn').addEventListener('input', updChange);
    // V4.21.0 P16 收款双键：结算弹窗空格 = 收款但不打小票（仅现金通道；输入框/按钮聚焦时不劫持）
    sheet.addEventListener('keydown', e => {
      if (e.key !== ' ' || payType !== 'cash') return;
      const tg = e.target;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'BUTTON')) return;
      e.preventDefault();
      if (payInFlight) return;
      skipPrintOnce = true;
      toast('空格收款：本单不打小票（可补打）');
      m.querySelector('#csPayGo').click();
    });
    // V4.18.9：实收行自动聚焦 + 回车即确认收款（免鼠标点击）
    m.querySelector('#csCashIn').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); m.querySelector('#csPayGo').click(); }
    });
    setTimeout(() => { const inp = m.querySelector('#csCashIn'); if (inp) { inp.focus(); inp.select(); } }, 80);
    updCashQ();
    m.querySelector('#csPayX').onclick = () => m.remove();
    m.querySelector('#csPayCancel').onclick = () => m.remove();
    m.querySelectorAll('#csPaySeg button').forEach(b => b.onclick = () => {
      if (b.classList.contains('dis')) { toast(b.dataset.ch === 'balance' ? '余额支付需先选会员（且在线）' : '离线模式此通道不可用'); return; }
      payType = b.dataset.ch;
      m.querySelectorAll('#csPaySeg button').forEach(x => x.classList.toggle('on', x === b));
      m.querySelector('#csPaneCash').style.display = payType === 'cash' ? '' : 'none';
      m.querySelector('#csPaneScan').style.display = payType === 'scan' ? '' : 'none';
      m.querySelector('#csPaneCombo').style.display = payType === 'combo' ? '' : 'none';
      m.querySelector('#csPaneBalance').style.display = payType === 'balance' ? '' : 'none';
      if (payType === 'scan') setTimeout(() => m.querySelector('#csScanCode').focus(), 60);
      if (payType === 'balance') renderBalanceInfo();
      // V4.21.0：客显支付引导大字（出示付款码/备好现金/组合支付）
      pushDisplay({
        status: payType === 'scan' ? 'pay_scan' : 'pay',
        guide: payType === 'cash' ? '请备好现金' : payType === 'scan' ? '请出示付款码' : payType === 'combo' ? '请出示付款码（组合支付）' : payType === 'balance' ? '会员余额支付中' : '请递给收银员现金',
      }, true);
    });
    // 顾客付款码输入时客显引导（收银员扫顾客码场景）
    m.querySelector('#csScanCode').addEventListener('input', () => {
      pushDisplay({ status: 'pay_scan', guide: '请出示付款码 · 扫码后请输密码' });
    });
    // ── V4.18.3 P15 批2：整单折扣 / 积分抵现 / 挂账信息 ──
    const refreshDue = () => {
      const c2 = calc();
      m.querySelector('.cs-paynum').innerHTML = `<em>¥</em>${money(c2.due)}`;
      m.querySelector('.cs-paydetail').textContent = `商品 ¥${money(c2.goods)}${c2.memSave > 0 ? ` · 会员省 ¥${money(c2.memSave)}` : ''}${c2.couponCut > 0 ? ` · 券 ¥${money(c2.couponCut)}` : ''}${c2.discAmt > 0 ? ` · 整单折扣 ¥${money(c2.discAmt)}` : ''}${promo.amount > 0 ? ` · 促销 ¥${money(promo.amount)}` : ''}${c2.ptsCut > 0 ? ` · 积分抵现 ¥${money(c2.ptsCut)}` : ''}${c2.autoRound > 0 ? ` · 抹零 ¥${money(c2.autoRound)}` : ''}${manualRound > 0 ? ` · 手动抹零 ¥${money(manualRound)}` : ''}`;
      updCashQ(); updChange(); renderSummary();
    };
    // 整单折扣：预设规则直接套用；自定义折扣率需 pos.discount.custom 权限（服务端同口径校验+留痕）
    const renderDiscSlot = () => {
      const slot = m.querySelector('#csDiscSlot');
      if (!discPresets.length && !hasPerm('pos.discount.custom')) { slot.innerHTML = '<span class="pill gray">未配置预设规则</span>'; return; }
      let html = discPresets.map(p =>
        `<button class="mini-btn${orderDisc && orderDisc.rate === p.rate ? ' ok' : ''}" data-rate="${p.rate}" data-name="${esc(p.name)}">${esc(p.name)} ${p.rate}折</button>`).join('');
      if (hasPerm('pos.discount.custom')) html += `<button class="mini-btn${orderDisc && orderDisc.custom ? ' ok' : ''}" id="csDiscCustom">自定义</button>`;
      if (orderDisc) html += `<button class="mini-btn" id="csDiscClear">取消</button>`;
      slot.innerHTML = html;
      slot.querySelectorAll('[data-rate]').forEach(b => b.onclick = () => {
        const rate = Number(b.dataset.rate);
        openDiscReason(rate, b.dataset.name, false);
      });
      const cbtn = slot.querySelector('#csDiscCustom');
      cbtn && (cbtn.onclick = () => {
        const mm = document.createElement('div');
        mm.className = 'modal';
        mm.innerHTML = `<div class="sheet"><h3>自定义整单折扣（店长）</h3>
          <div class="field"><label>折扣率（如 88 = 88 折）</label><input id="csDcR" inputmode="decimal" placeholder="88"></div>
          <div class="hint">非预设规则需授权（pos.discount.custom）并留痕；折后单价不得低于商品最低售价、折扣不得低于商品最低折扣，越线需店长放行。</div>
          <button class="btn ok" id="csDcGo" style="width:100%">套用</button>
          <button class="btn ghost" id="csDcX" style="width:100%;margin-top:8px">取消</button></div>`;
        document.body.appendChild(mm);
        mm.querySelector('#csDcX').onclick = () => mm.remove();
        setTimeout(() => mm.querySelector('#csDcR').focus(), 60);
        mm.querySelector('#csDcGo').onclick = () => {
          const rate = Number(mm.querySelector('#csDcR').value);
          if (!(rate > 0 && rate < 100)) { toast('折扣率须在 0~100 之间'); return; }
          mm.remove();
          openDiscReason(rate, rate + '折(自定义)', true);
        };
      });
      const clr = slot.querySelector('#csDiscClear');
      clr && (clr.onclick = () => { orderDisc = null; renderDiscSlot(); refreshDue(); });
    };
    const openDiscReason = (rate, name, custom) => {
      const mm = document.createElement('div');
      mm.className = 'modal';
      mm.innerHTML = `<div class="sheet"><h3>整单折扣：${esc(name)}（${rate} 折）</h3>
        <div class="field"><label>折扣原因（必填，留痕）</label><input id="csDcRs" placeholder="如：员工折扣 / 会员日 / 审批人张三"></div>
        <button class="btn ok" id="csDcGo" style="width:100%">套用折扣</button>
        <button class="btn ghost" id="csDcX" style="width:100%;margin-top:8px">取消</button></div>`;
      document.body.appendChild(mm);
      mm.querySelector('#csDcX').onclick = () => mm.remove();
      setTimeout(() => mm.querySelector('#csDcRs').focus(), 60);
      mm.querySelector('#csDcGo').onclick = () => {
        const reason = mm.querySelector('#csDcRs').value.trim();
        if (!reason) { toast('折扣原因必填（留痕要求）'); return; }
        mm.remove();
        applyDisc(rate, name, custom, reason);
      };
    };
    const applyDisc = async (rate, name, custom, reason) => {
      const c2 = calc();
      const amount = Math.round(c2.goods * (100 - rate)) / 100;   // 按商品总额估算，服务端按应收链路精确计算
      if (!(amount > 0)) { toast('折扣金额为 0，无需套用'); return; }
      // V4.25.3 双红线预校验（服务端同口径二次校验）：① 折扣率 ≥ 商品最低折扣；② 折后单价 ≥ 最低卖价
      const offenders = [];
      for (const l of cart) {
        if (l.custom) continue;
        const base = lineBasePrice(l);
        const minD = minDiscOf(l.p);
        const minP = minPriceOf(l.p);
        const after = Math.round(base * rate) / 100;
        const badDisc = minD > 0 && rate < minD;
        if (badDisc || after < minP) {
          offenders.push(`${l.p.name}（${badDisc ? `最低 ${minD} 折` : `最低价 ¥${money(minP)}`}）`);
        }
      }
      if (offenders.length) {
        const listTxt = offenders.slice(0, 3).join('、') + (offenders.length > 3 ? ` 等 ${offenders.length} 项` : '');
        if (!hasPerm('pos.emergency.manual')) {
          toast(`整单折扣 ${rate} 折越线：${listTxt}，已拒绝（需店长放行）`);
          return;
        }
        if (!confirm(`以下商品低于最低折扣/售价：${listTxt}\n店长放行并留痕？`)) return;
      }
      // V4.25.5：整单折扣须店长现场授权（授权码），仅授权本次价格操作
      if (!(await ensurePriceAuth('整单折扣'))) return;
      orderDisc = { rate, name, amount, custom, reason };
      renderDiscSlot(); refreshDue();
      toast(`已套用整单折扣：${name} ${rate} 折（结账时服务端校验留痕）`);
    };
    // 积分抵现：需会员；上限=应收×pos.points.max_pct；比例 pos.points.rate（N 分=1 元）
    const renderPtsSlot = () => {
      const slot = m.querySelector('#csPtsSlot');
      if (!member) { slot.innerHTML = '<span class="pill gray">需选会员</span>'; return; }
      const c2 = calc();
      const avail = Number(member.points) || 0;
      const yuanOfPts = v => Math.floor(v / (ptsCfg.rate > 0 ? ptsCfg.rate : 100) * 100) / 100;
      slot.innerHTML = ptsUse > 0
        ? `<span class="pill gray">已抵 -¥${money(c2.ptsCut)}</span><button class="mini-btn" id="csPtsClear">清除</button>`
        : `<span class="pill gray">可用 ${avail} 分</span><button class="mini-btn" id="csPtsUse">用积分抵现</button>`;
      const btn = slot.querySelector('#csPtsUse');
      btn && (btn.onclick = () => {
        const rate = ptsCfg.rate > 0 ? ptsCfg.rate : 100;
        const dueNet = Math.max(0, c2.due);
        const capC = ptsCfg.maxPct > 0 ? Math.floor(dueNet * 100 * ptsCfg.maxPct / 100) : Math.round(dueNet * 100);
        const maxAmt = Math.min(yuanOfPts(avail), capC / 100, dueNet);
        if (!(maxAmt > 0)) { toast('本单无可抵扣金额（积分不足或已达上限比例）'); return; }
        const mm = document.createElement('div');
        mm.className = 'modal';
        mm.innerHTML = `<div class="sheet"><h3>积分抵现</h3>
          <div class="kv"><span class="k">会员可用积分</span><span class="v">${avail} 分</span></div>
          <div class="kv"><span class="k">抵现比例</span><span class="v">${rate} 分 = 1 元</span></div>
          <div class="kv"><span class="k">本单上限（${ptsCfg.maxPct > 0 ? '应收 ' + ptsCfg.maxPct + '%' : '不设上限'}）</span><span class="v">¥${money(maxAmt)}</span></div>
          <div class="field" style="margin-top:8px"><label>抵扣金额（元，≤ ¥${money(maxAmt)}）</label><input id="csPtsIn" inputmode="decimal" value="${money(maxAmt)}"></div>
          <button class="btn ok" id="csPtsGo" style="width:100%">确认抵扣</button>
          <button class="btn ghost" id="csPtsX" style="width:100%;margin-top:8px">取消</button></div>`;
        document.body.appendChild(mm);
        mm.querySelector('#csPtsX').onclick = () => mm.remove();
        setTimeout(() => mm.querySelector('#csPtsIn').focus(), 60);
        mm.querySelector('#csPtsGo').onclick = () => {
          const v = Number(mm.querySelector('#csPtsIn').value);
          if (!(v > 0)) { toast('请输入有效金额'); return; }
          if (v > maxAmt + 0.005) { toast(`超出本单可抵上限 ¥${money(maxAmt)}`); return; }
          ptsUse = v;
          mm.remove(); renderPtsSlot(); refreshDue();
        };
      });
      const clr = slot.querySelector('#csPtsClear');
      clr && (clr.onclick = () => { ptsUse = 0; renderPtsSlot(); refreshDue(); });
    };
    // ── P2-3 余额组合支付（2026-09-18 口径）：余额抵一部分 + 现金/扫码当场结清，不赊账 ──
    const renderBalanceInfo = () => {
      const bal = member ? Math.round(Number(member.balance || 0) * 100) / 100 : 0;
      const due = calc().due;
      const info = m.querySelector('#csBalInfo');
      const combo = m.querySelector('#csBalCombo');
      const scanRow = m.querySelector('#csBalScanRow');
      const restCh = m.querySelector('#csBalRestCh');
      if (!member) { info.textContent = '请先选择会员'; combo.style.display = 'none'; scanRow.style.display = 'none'; return; }
      if (bal >= due) {
        info.innerHTML = `会员余额 <b>¥${money(bal)}</b> ≥ 应收 <b>¥${money(due)}</b>：将从余额全额扣除。`;
        combo.style.display = 'none'; scanRow.style.display = 'none';
      } else if (bal > 0) {
        info.innerHTML = `会员余额 <b>¥${money(bal)}</b> < 应收 <b>¥${money(due)}</b>：余额抵 ¥${money(bal)}，剩余 <b>¥${money(Math.round((due - bal) * 100) / 100)}</b> 需当场收现金/扫码结清（不赊账）。`;
        combo.style.display = '';
        m.querySelector('#csBalUse').value = money(bal);
        scanRow.style.display = restCh.value === 'scan' ? '' : 'none';
      } else {
        info.innerHTML = `会员余额 ¥0.00，余额支付不可用：请用现金/扫码收款（不赊账）。`;
        combo.style.display = 'none'; scanRow.style.display = 'none';
      }
    };
    m.querySelector('#csBalRestCh').addEventListener('change', () => {
      renderBalanceInfo();
      if (m.querySelector('#csBalRestCh').value === 'scan') setTimeout(() => m.querySelector('#csBalCode').focus(), 60);
    });
    const renderCreditSlot = () => {
      const slot = m.querySelector('#csCreditSlot');
      slot.innerHTML = member
        ? '<button class="mini-btn" id="csCredMng">挂账/还款</button>'
        : '<span class="pill gray">需选会员</span>';
      const btn = slot.querySelector('#csCredMng');
      btn && (btn.onclick = () => openCreditsModal());
    };
    renderDiscSlot(); renderPtsSlot(); renderCreditSlot();
    // 手动抹零
    m.querySelector('#csMrBtn').onclick = () => {
      if (!hasPerm('pos.price.manual')) { toast('手动抹零需改价权限（pos.price.manual）'); return; }
      manualRound = manualRound > 0 ? 0 : Math.max(0, Math.round((calc().due - Math.floor(calc().due)) * 100) / 100);
      const c2 = calc();
      m.querySelector('.cs-paynum').innerHTML = `<em>¥</em>${money(c2.due)}`;
      const btn = m.querySelector('#csMrBtn');
      btn.textContent = manualRound > 0 ? '已抹 -¥' + money(manualRound) : '抹零至元（店长）';
      btn.className = 'mini-btn' + (manualRound > 0 ? ' ok' : '');
      updCashQ(); updChange(); renderSummary();
    };
    // 组合支付联动
    m.querySelector('#csComboCash').addEventListener('input', () => {
      const cash = Number(m.querySelector('#csComboCash').value) || 0;
      m.querySelector('#csComboScan').value = (c.due - cash) > 0 ? money(c.due - cash) : '0.00';
      m.querySelector('#csComboErr').textContent = cash >= c.due ? '现金部分需小于应收（否则直接用纯现金）' : '';
    });
    // 券选择
    const cpBtn = m.querySelector('#csCpBtn');
    cpBtn && (cpBtn.onclick = async () => {
      try {
        const d = await call('GET', '/coupons/member/' + member.id);
        const list = (Array.isArray(d) ? d : (d.items || [])).filter(x => x.status === '未使用');
        if (!list.length) { toast('该会员暂无可用券'); return; }
        const mm = document.createElement('div');
        mm.className = 'modal';
        mm.innerHTML = `<div class="sheet"><h3>选用优惠券（预估展示，核销以结账为准）</h3>
          ${list.map(cp => `<div class="row" data-cp="${cp.id}" style="cursor:pointer"><div class="grow">
            <div class="t">${esc(cp.name || cp.cpName || '券')} · ${esc(cp.type || '')}</div>
            <div class="s">门槛 ¥${money(cp.threshold || 0)} · ${cp.type === '满减券' ? '减 ¥' + money(cp.discount) : cp.type === '折扣券' ? Number(cp.discount) * 10 + ' 折' : esc(cp.type || '')}</div></div></div>`).join('')}
          <button class="btn ghost" id="csCpClose" style="width:100%;margin-top:8px">不使用</button></div>`;
        document.body.appendChild(mm);
        mm.querySelector('#csCpClose').onclick = () => { coupon = null; cpBtn.textContent = '选用券'; mm.remove(); };
        mm.querySelectorAll('[data-cp]').forEach(r => r.onclick = () => {
          const cp = list.find(x => Number(x.id) === Number(r.dataset.cp));
          coupon = { id: Number(cp.id), name: cp.name || cp.cpName || '券', type: cp.type, threshold: Number(cp.threshold) || 0, discount: Number(cp.discount) || 0 };
          cpBtn.textContent = '已选：' + coupon.name;
          mm.remove(); renderSummary();
          toast('已选用券（结账时服务端核销）');
        });
      } catch (e) { toast(e.message || e); }
    });
    // V4.19.0 P15.5 #8 券码手输兜底：无可用券列表/纸质券时按券码核销（服务端校验归属+状态）
    const cpCodeBtn = m.querySelector('#csCpCode');
    cpCodeBtn && (cpCodeBtn.onclick = async () => {
      const code = await pwaPrompt('券码手输', '输入纸质券上的券码（MC + 8 位数字）', { okText: '核验券码' });
      const c2 = String(code || '').trim().toUpperCase();
      if (!c2) return;
      try {
        const d = await call('POST', '/coupons/lookup-code', { code: c2, memberId: member.id });
        coupon = { id: d.mcId, name: d.name || '券', type: d.type, threshold: Number(d.threshold) || 0, discount: Number(d.discount) || 0 };
        cpBtn.textContent = '已选：' + coupon.name + '（券码）';
        renderSummary();
        toast(`已核验券码：${coupon.name}（结账时服务端核销）`);
      } catch (e) { toast(e.message || e); }
    });
    // 组合支付：付款码输入框注入到 combo 面板（确认收款时读取）
    m.querySelector('#csPaneCombo').insertAdjacentHTML('beforeend',
      '<div class="field" style="margin-top:8px"><input id="csComboCode" inputmode="numeric" placeholder="顾客付款码（支付扫码部分）"></div>');
    // 确认收款
    m.querySelector('#csPayGo').onclick = async () => {
      orderNote = (m.querySelector('#csOrderNote') || {}).value?.trim() || '';
      const due = calc().due;
      const ptsCut = calc().ptsCut;
      const ptsPay = ptsCut > 0 ? [{ channel: '积分抵扣', amount: Number(ptsCut.toFixed(2)) }] : [];
      if (payType === 'cash') {
        const paid = Number(m.querySelector('#csCashIn').value) || 0;
        if (paid < due - 0.005) { toast('实收不足应收：请补足或改组合支付'); return; }
        m.remove();
        await doCheckout([{ channel: '现金', amount: Number(due.toFixed(2)) }, ...ptsPay], paid - due, { skipPrint: skipPrintOnce });
      } else if (payType === 'balance') {
        // ── P2-3（2026-09-18 口径）：余额支付 / 组合支付 —— 余额抵一部分 + 现金/扫码当场结清，不赊账 ──
        if (!member) { toast('余额支付需先选会员'); return; }
        if (!(due > 0)) { toast('应收为 0，无需支付'); return; }
        const bal = Math.round(Number(member.balance || 0) * 100) / 100;
        if (bal >= due) {
          m.remove();
          await doCheckout([{ channel: '余额', amount: Number(due.toFixed(2)) }, ...ptsPay], 0, { memberId: member.id });
        } else if (bal > 0) {
          const rest = Math.round((due - bal) * 100) / 100;
          const restCh = m.querySelector('#csBalRestCh').value;
          if (restCh === 'cash') {
            m.remove();
            await doCheckout([{ channel: '余额', amount: bal }, { channel: '现金', amount: rest }, ...ptsPay], 0, { memberId: member.id });
          } else {
            const code = m.querySelector('#csBalCode').value.trim();
            if (!/^\d{16,32}$/.test(code)) { m.querySelector('#csBalErr').textContent = '请扫顾客付款码（支付剩余部分，微信 10~15 / 支付宝 25~30 开头）'; return; }
            m.querySelector('#csPayGo').disabled = true;
            await micropayFlow(m, code, rest, { pre: [{ channel: '余额', amount: bal }] });
          }
        } else {
          m.querySelector('#csBalErr').textContent = '会员余额不足（¥0.00）：余额支付不可用，请用现金/扫码收款（不赊账）';
        }
      } else if (payType === 'scan') {
        const code = m.querySelector('#csScanCode').value.trim();
        if (!/^\d{16,32}$/.test(code)) { m.querySelector('#csScanMsg').textContent = '请扫顾客付款码（16~32 位数字）'; return; }
        m.querySelector('#csScanMsg').textContent = '通道扣款中…';
        m.querySelector('#csPayGo').disabled = true;
        await micropayFlow(m, code, due, null);
      } else {
        const cash = Number(m.querySelector('#csComboCash').value) || 0;
        const rest = Math.round((due - cash) * 100) / 100;
        if (!(cash > 0) || cash >= due) { m.querySelector('#csComboErr').textContent = '请输入 0 ~ 应收之间的现金金额'; return; }
        const code = m.querySelector('#csComboCode').value.trim();
        if (!/^\d{16,32}$/.test(code)) { m.querySelector('#csComboErr').textContent = '请扫顾客付款码（支付扫码部分）'; return; }
        m.querySelector('#csPayGo').disabled = true;
        await micropayFlow(m, code, rest, { cash, rest });
      }
    };
  }

  /** 通道扣款流程（被扫 B-scan-C）：micropay → SUCCESS 落单 / USERPAYING 轮询→90s 转挂起 / 记账式回退 */
  async function micropayFlow(m, code, amount, combo) {
    const msgEl = m.querySelector('#csScanMsg') || m.querySelector('#csComboErr');
    const outTradeNo = 'C' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const suspendTimer = setTimeout(() => {   // D3：90 秒未完成自动转挂起
      if (document.body.contains(m)) m.remove();
      pendingPays.push({ outTradeNo, amount, combo, items: snapFromCart(), memberId: member ? member.id : undefined, savedAt: new Date().toISOString() });
      cart.length = 0; member = null; coupon = null; manualRound = 0;
      renderCart(); updatePendBadge(); toast('扫码 90 秒未完成，已转挂起单（顶栏可查单续付）'); orderNote = '';
    }, 90000);
    try {
      const d = await call('POST', '/pay/micropay', { authCode: code, amount: Number(amount.toFixed(2)), outTradeNo });
      if (!d?.success && d?.pending) {
        msgEl && (msgEl.textContent = '⏳ 顾客支付确认中（输入密码）…自动轮询查单');
        const ok = await pollPayTxn(outTradeNo, 40);
        clearTimeout(suspendTimer);
        if (ok?.success) {
          if (document.body.contains(m)) m.remove();
          await finishAfterGateway({ ...ok, authCode: code }, amount, combo);
        } else {
          msgEl && (msgEl.textContent = ok ? '顾客未完成支付，可重新扫码或转挂起' : '查单超时：可稍后在「挂起单」查单续付');
          m.querySelector('#csPayGo').disabled = false;
        }
        return;
      }
      if (!d?.success) {
        clearTimeout(suspendTimer);
        msgEl && (msgEl.textContent = d?.failMsg || '通道扣款失败，请重新扫码或换收款方式');
        m.querySelector('#csPayGo').disabled = false;
        return;
      }
      clearTimeout(suspendTimer);
      if (document.body.contains(m)) m.remove();
      await finishAfterGateway({ channel: d.channel, outTradeNo: d.outTradeNo, transaction_id: d.transactionId, authCode: code }, amount, combo);
    } catch (e) {
      clearTimeout(suspendTimer);
      if (/通道未启用/.test(e.message || '')) {
        // 记账式通道（V4.13.1 二次确认口径）：提示改走「现金」或在后台启用通道；避免伪造到账
        msgEl && (msgEl.textContent = '扫码通道未启用（记账式）：请改用现金收款，或在后台「支付通道」启用真实通道');
        m.querySelector('#csPayGo').disabled = false;
        return;
      }
      msgEl && (msgEl.textContent = e.message || '网络异常');
      m.querySelector('#csPayGo').disabled = false;
    }
  }
  async function pollPayTxn(outTradeNo, maxTries = 40) {
    for (let i = 0; i < maxTries; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const t = await call('GET', '/pay/txn/' + encodeURIComponent(outTradeNo));
        if (t?.status === 'SUCCESS') return t;
        if (['FAIL', 'CLOSED', 'REVOKED', 'PAYERROR', 'NOT_PAY'].includes(t?.status)) return null;
      } catch { /* 网络抖动继续 */ }
    }
    return undefined;
  }
  // 通道枚举安全：sale_payments.channel 是 pay_channel_t 枚举（现金/微信/支付宝/余额/分红抵扣/积分/赊账/应收/积分抵扣/预存余额），
  // 兜底值绝不能写「扫码」这类非法枚举——按付款码前缀推导（与网关 detectChannel 同规则），再兜底微信
  const chanOfCode = code => /^1[0-5]/.test(String(code || '')) ? '微信' : (/^(2[5-9]|30)/.test(String(code || '')) ? '支付宝' : null);
  const enumScanChannel = (ch, code) => ['微信', '支付宝'].includes(ch) ? ch : (chanOfCode(code) || '微信');
  async function finishAfterGateway(txn, amount, combo, memberId) {
    const scanCh = enumScanChannel(txn.channel, txn.authCode);
    const ptsCut = calc().ptsCut;
    const ptsPay = ptsCut > 0 ? [{ channel: '积分抵扣', amount: Number(ptsCut.toFixed(2)) }] : [];
    // P2-3：combo.pre = 余额组合的前置支付行（余额部分已当场确认）；旧结构 {cash, rest} 兼容
    const prePays = combo
      ? (combo.pre ? combo.pre.map(p => ({ ...p }))
                   : [{ channel: '现金', amount: Number(combo.cash.toFixed(2)) }])
      : [];
    const payments = [...prePays,
      { channel: scanCh, amount: Number(amount.toFixed(2)), externalNo: txn.transaction_id, gatewayOutTradeNo: txn.outTradeNo },
      ...ptsPay];
    await doCheckout(payments, 0, { gateway: txn, memberId });
  }

  /** 落单（组合支付数组 + clientRef 幂等 + 手动抹零 + 券；离线现金单走暂存队列） */
  async function doCheckout(payments, changeDue, opt = {}) {
    if (payInFlight) return;
    payInFlight = true;
    const c = calc();
    const payload = {
      items: snapFromCart(),
      payments,
      ...(member ? { memberId: member.id } : {}),
      ...(opt.memberId ? { memberId: opt.memberId } : {}),
      ...(coupon ? { couponId: coupon.id } : {}),
      ...(manualRound > 0 ? { manualRound } : {}),
      ...(orderDisc ? { orderDiscount: orderDisc.amount, discountRate: orderDisc.rate, discountReason: orderDisc.reason } : {}),
      // V4.25.5：含改价/折扣/赠品时随单提交店长授权票据（服务端强制校验，票过期即拒）
      ...(priceAuthValid() ? { priceAuthTicket: priceAuth.ticket } : {}),
      ...(csTable ? { tableId: csTable.id } : {}),   // V4.21.0 P16 批2：堂食台位（服务端校验+落单即占用）
      channel: '收银台',
      remark: `收银台 · ${ME.name}${orderNote ? ' · ' + orderNote : ''}`,
      clientRef: 'C' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    };
    const cartSnapshot = cart.map(l => ({ p: l.p, qty: l.qty, manualPrice: l.manualPrice }));
    const memberSnapshot = member;
    try {
      const d = await call('POST', '/sales/checkout', payload);
      await afterSaleSuccess(d, payload, cartSnapshot, changeDue, memberSnapshot, opt);
    } catch (e) {
      const offline = /网络异常|failed to fetch|networkerror|load failed|fetch failed/i.test(String(e.message || '')) || (!navigator.onLine && !/^\d{5}/.test(String(e.code || '')));
      if (offline && !opt.gateway) {
        // 离线暂存（现金记账单）：复用全局补传队列（clientRef 幂等防重）；含浏览器原生 fetch 错误（Failed to fetch/Load failed）
        enqueueOffline(payload);
        cart.length = 0; coupon = null; manualRound = 0; member = null; orderNote = '';
        renderCart(); renderMemberCard(); refreshStagedBadge();
        toast('📴 网络不可用：本单已离线暂存，恢复联网自动补传');
        payInFlight = false;
        return;
      }
      if (offline && opt.gateway) {
        toast('⚠️ 通道已扣款但单据未生成：请恢复联网后重试结账（同流水幂等不重复扣款），顾客请稍候勿离场');
        payInFlight = false;
        return;
      }
      toast(e.message || e);
    } finally { payInFlight = false; }
  }
  async function afterSaleSuccess(d, payload, cartSnapshot, changeDue, memberSnapshot, opt = {}) {
    const snap = {
      orderNo: d.orderNo, payable: d.payable, roundAmount: d.roundAmount,
      lines: cartSnapshot.map(l => ({ name: l.p.name, qty: l.qty, price: l.manualPrice ?? (memberSnapshot && Number(l.p.memberPrice) > 0 ? l.p.memberPrice : l.p.sellPrice) })),
      channel: (payload.payments[0] || {}).channel || '现金', member: memberSnapshot ? (memberSnapshot.name || memberSnapshot.phone) : null, time: new Date(),
    };
    lastSale = snap;
    // 打印 / 钱箱 / 语音（硬件异常不阻断）；V4.18.9 F7 开关只管小票，收款与钱箱不受影响
    let printNote = '打印通道：';
    if (opt.skipPrint) {
      printNote = '本单未打小票（空格收款）· 可补打';
    } else if (!printOn) {
      printNote = '小票打印已关（F7 开启）';
    } else try {
      if (window.PwaPrinters) { const r = await window.PwaPrinters.autoPrint(snap); printNote += (r && r.printer ? r.printer : '未出票（已留痕）'); }
      else { await window.PwaReceipt?.printReceipt(snap); printNote += '浏览器打印'; }
    } catch { printNote += '失败（可补打）'; csMsg('小票打印异常（单 ' + snap.orderNo + '）：可补打上一单', 'warn');
      toast('⚠️ 小票打印失败：本单已收款，可在「补打上一单」或打印历史重打（打印降级已明示）'); }
    const cashPay = (payload.payments || []).find(p => p.channel === '现金');
    let drawerNote = '';
    if (cashPay) {
      try {
        if (window.PwaReceipt && window.PwaReceipt.drawerConnected()) await window.PwaReceipt.kickDrawer();
        else if (window.PwaPrinters) { const r = await window.PwaPrinters.kickDrawer(); drawerNote = `钱箱已弹（${r.printer} · 网口）`; }
        else drawerNote = '钱箱未连接';
        if (!drawerNote) drawerNote = '钱箱已弹出';
      } catch { drawerNote = '弹箱失败，请手动开箱（已留痕）'; toast('弹箱失败：请手动开箱（已记无交易开箱留痕）');
        try { await call('POST', '/shifts/open-drawer', { reason: '收现弹箱失败', failed: true }); } catch { /* 静默 */ } }
    }
    try { if (ttsOn && window.PwaTTS) window.PwaTTS.cash(d.payable, snap.channel); } catch { }
    cart.length = 0; coupon = null; manualRound = 0; member = memberSnapshot; orderNote = '';
    orderDisc = null; ptsUse = 0;   // V4.18.3 P15 批2：整单折扣/积分抵现单次有效，落单后重置
    priceAuth = null;              // V4.25.5：店长授权票随单作废（下一单改价需重新授权）
    const soldTable = csTable; csTable = null;   // 台位单次有效（服务端已转「使用中」，清台走台位管理）
    renderCart(); renderSummary();
    pushDisplay({ status: 'done', orderNo: d.orderNo, paidAmount: d.payable, change: changeDue,
      guide: changeDue > 0 ? '找零 ¥' + money(changeDue) : '欢迎再次光临', tableName: soldTable ? soldTable.name : null }, true);
    // V4.19.0 回车键盘流：支付成功弹窗回车=「新的一单」（enterOk 捕获回车，弹窗即关、车已清空）
    pwaConfirm('✅ 收款成功',
      `<div style="text-align:center">
        <div class="hint">应收 ¥${money(d.payable)} · ${esc(snap.channel)}${changeDue > 0 ? `<br>找零 <b style="font-size:24px;color:var(--ok)">¥${money(changeDue)}</b>` : ''}</div>
        <div class="hint">小票 ${esc(d.orderNo)} · ${esc(printNote)}${drawerNote ? '<br>' + esc(drawerNote) : ''}</div>
      </div>`, { okText: '新的一单', enterOk: true });
  }
  async function reprintLast() {
    // V4.18.2：内存无快照（重开页面/换班）时从服务端取本收银员上一单组装补打
    if (!lastSale) {
      try {
        const d = await call('GET', '/pos/last-order');
        const o = d && d.order;
        if (!o || !(o.items || []).length) { toast('暂无上一单记录'); return; }
        lastSale = {
          orderNo: o.orderNo, payable: o.payable, roundAmount: 0,
          lines: (o.items || []).map(it => ({ name: it.name, qty: Number(it.qty) || 1, price: Number(it.unitPrice) || 0 })),
          channel: o.channel || '现金', member: null, time: new Date(o.createdAt),
        };
        toast('已从服务端载入上一单（本页面此前未打过单）');
      } catch (e) { toast('载入上一单失败：' + (e.message || e)); return; }
    }
    (window.PwaPrinters ? window.PwaPrinters.reprint(lastSale) : window.PwaReceipt.printReceipt(lastSale, false))
      .then(() => toast('已补打上一单小票')).catch(e => toast('补打失败：' + (e.message || e)));
  }

  // ── 挂单 / 取单（/pos/held 底座，>24h 灰显 I1） ──
  /** V4.18.2：取单角标统一刷新（进入收银台/取出/删除后调用） */
  async function refreshHeldBadge() {
    try {
      const n = (await call('GET', '/pos/held')).length;
      const d = $('#csTakeDot');
      if (d) { d.style.display = n ? '' : 'none'; d.textContent = n; }
    } catch { /* 离线忽略 */ }
  }
  async function holdOrder() {
    if (!cart.length) { toast('购物车为空，无可挂单'); return; }
    const ok = await pwaConfirm('挂单', '确认挂起当前购物车？挂单后可随时「取单」调出。');
    if (!ok) return;
    try {
      const d = await call('POST', '/pos/held', {
        items: snapFromCart(),
        memberId: member ? member.id : undefined, remark: `收银台挂单 · ${ME.name}`,
      });
      toast(`已挂单 ${d.order_no || '#' + d.id}`);
      cart.length = 0; coupon = null; manualRound = 0; member = null;
      renderCart(); renderMemberCard();
      refreshHeldBadge();   // V4.18.2：挂单后即时刷新取单角标
    } catch (e) { toast(e.message); }
  }
  async function takeOrder() {
    // V4.25.0 ④：取单默认范围读后台开关 pos.held.default_scope（本人/全店），可临时切换
    let curScope = 'mine';
    try {
      const s = await call('GET', '/settings/key/' + encodeURIComponent('pos.held.default_scope'));
      curScope = String(s?.value || '').replace(/^"|"$/g, '') || 'mine';
    } catch { curScope = 'mine'; }
    let rows = [];
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet" style="width:min(560px,94vw)"><h3>📥 取单（<span id="csTkN">0</span> 单）
      <button class="mini-btn" id="csTkX" style="float:right">关闭</button></h3>
      <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
        <button class="mini-btn" id="tkScope" style="flex:none">范围：本人</button>
        <input id="csTkQ" placeholder="搜索单号 / 会员 / 商品名 / 挂单人" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:13px;background:var(--card);color:var(--ink)">
        <button class="mini-btn" id="csTkSort">⏳ 按时间↑</button>
      </div>
      <div id="csTkList"></div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csTkX').onclick = () => m.remove();
    const load = async () => {
      try { rows = await call('GET', '/pos/held' + (curScope ? '?scope=' + encodeURIComponent(curScope) : '')); }
      catch (e) { toast(e.message); return; }
      renderList();
    };
    // V4.19.0 P15.5 #7：搜索（单号/会员/商品名/挂单人）+ 时间/金额排序切换
    let sortBy = 'time';
    const amtOf = h => (h.items || []).reduce((a, i) => a + Number(i?.lineTotal ?? (Number(i?.unitPrice) || 0) * (Number(i?.qty) || 0)), 0);
    const renderList = () => {
      const kw = (m.querySelector('#csTkQ').value || '').trim().toLowerCase();
      let list = rows.filter(h => {
        if (!kw) return true;
        const hay = [h.order_no, h.member_name, h.held_by_name, ...(h.items || []).map(i => i?.productName || i?.name)]
          .join(' ').toLowerCase();
        return hay.includes(kw);
      });
      list.sort((a, b) => sortBy === 'time'
        ? String(a.created_at).localeCompare(String(b.created_at))
        : amtOf(b) - amtOf(a));
      m.querySelector('#csTkN').textContent = list.length;
      m.querySelector('#csTkList').innerHTML = list.length ? list.map(h => {
        const stale = (Date.now() - new Date(h.created_at).getTime()) > 86400000;
        const amt = amtOf(h);
        return `<div class="row${stale ? ' cs-stale' : ''}">
          <div class="grow"><div class="t">${esc(h.order_no || '挂单#' + h.id)} · ${(h.items || []).length} 行${amt ? ' · ¥' + money(amt) : ''}${stale ? ' <span class="pill orange">超24h 建议清理</span>' : ''}</div>
          <div class="s">${esc(h.member_name || '散客')} · ${esc(h.held_by_name || '')} · ${dt(h.created_at)}</div></div>
          <button class="mini-btn ok" data-tk="${h.id}">取出</button>
          <button class="mini-btn danger" data-hx="${h.id}">删</button></div>`;
      }).join('') : '<div class="empty">无匹配挂单</div>';
      bindRows();
    };
    const bindRows = () => {
      m.querySelectorAll('[data-tk]').forEach(b => b.onclick = async () => {
        try {
          const d = await call('GET', '/pos/held/' + b.dataset.tk);
          cart.length = 0;
          snapToLines(d.items).forEach(l => cart.push(l));
          for (const it of (d.items || [])) {   // 价目表缺失的行在线补（snapToLines 会跳过）
            if (!it.custom && !Pricebook.items.find(x => Number(x.id) === Number(it.productId))) {
              const p = await productById(Number(it.productId));
              if (p) cart.push({ p: { ...p, id: Number(p.id) }, qty: Number(it.qty) || 1, ...(it.unitPrice != null ? { manualPrice: Number(it.unitPrice) } : {}) });
            }
          }
          member = null; coupon = null;
          call('POST', `/pos/held/${d.id}/pick`).catch(() => {});
          m.remove(); renderCart(); renderMemberCard(); refreshStock();
          refreshHeldBadge();   // V4.18.2：取出后即时刷新角标
          toast('已取出挂单：核对后结账（挂单已即时销单）');
        } catch (e) { toast(e.message); }
      });
      m.querySelectorAll('[data-hx]').forEach(b => b.onclick = async () => {
        const ok = await pwaConfirm('删除挂单', '确认删除该挂单？（留痕，不恢复库存）');
        if (!ok) return;
        try { await call('DELETE', '/pos/held/' + b.dataset.hx); rows = rows.filter(h => Number(h.id) !== Number(b.dataset.hx)); renderList(); refreshHeldBadge(); } catch (e) { toast(e.message); }
      });
    };
    m.querySelector('#csTkQ').addEventListener('input', renderList);
    // V4.25.0 ④：本人 / 全店 临时切换（后台开关决定默认态）
    m.querySelector('#tkScope').onclick = () => {
      curScope = curScope === 'mine' ? 'all' : 'mine';
      const b = m.querySelector('#tkScope');
      b.textContent = '范围：' + (curScope === 'mine' ? '本人' : '全店');
      b.classList.toggle('on', curScope === 'all');
      load();
    };
    m.querySelector('#csTkSort').onclick = () => {
      sortBy = sortBy === 'time' ? 'amount' : 'time';
      m.querySelector('#csTkSort').textContent = sortBy === 'time' ? '⏳ 按时间↑' : '💰 按金额↓';
      renderList();
    };
    await load();
  }

  // ── 挂起单（半支付 D3 + V4.18.5 启动查漏） ──
  function updatePendBadge() {
    const d = $('#csPendDot');
    if (d) { d.style.display = pendingPays.length ? '' : 'none'; d.textContent = pendingPays.length; }
  }
  /** V4.18.5 P15批4 半支付恢复：进收银台时从服务端查漏 PENDING 卡单（页面重开不丢） */
  async function syncPendingFromServer() {
    if (!navigator.onLine) return;
    let list;
    try { list = await call('GET', '/pay/pending'); } catch { return; }
    if (!Array.isArray(list) || !list.length) return;
    let added = 0;
    for (const t of list) {
      if (pendingPays.some(p => p.outTradeNo === t.outTradeNo)) continue;
      pendingPays.push({ outTradeNo: t.outTradeNo, amount: Number(t.amount), channel: t.channel,
        items: [], combo: null, memberId: undefined, savedAt: t.createdAt, serverOnly: true });
      added++;
    }
    if (added) { updatePendBadge(); toast(`⏳ 查到 ${added} 笔未完成的扫码收款（服务端卡单），请在「挂起单」查单处理`); }
  }
  function showPending() {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>⏳ 挂起单（扫码 90 秒未完成自动转入）<button class="mini-btn" id="csPdX" style="float:right">关闭</button></h3>
      <div id="csPdList">${pendingPays.length ? pendingPays.map((p, i) => `
        <div class="row"><div class="grow"><div class="t">¥${money(p.amount)} · ${esc(p.outTradeNo)}</div>
        <div class="s">${dt(p.savedAt)}${p.serverOnly ? ' · <span style="color:var(--warn)">服务端卡单（本机无商品明细）</span>' : ` · ${p.items.length} 行`}</div></div>
        <button class="mini-btn ok" data-q="${i}">查单</button>
        <button class="mini-btn danger" data-r="${i}">释放</button></div>`).join('')
      : '<div class="empty">暂无挂起单</div>'}</div>
      <div class="hint">「查单」向支付通道确认结果：已支付自动续流程（服务端卡单无明细时提示人工处理）；确认未付可释放（留痕）。</div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csPdX').onclick = () => m.remove();
    m.querySelectorAll('[data-q]').forEach(b => b.onclick = async () => {
      const p = pendingPays[+b.dataset.q];
      b.textContent = '查单中…';
      const t = await call('GET', '/pay/txn/' + encodeURIComponent(p.outTradeNo)).catch(() => null);
      if (t && t.status === 'SUCCESS') {
        if (p.serverOnly) {
          // 服务端卡单已扣款但本机无购物明细：不能自动落单，明示人工处理（防重复扫码）
          pwaConfirm('⚠️ 该笔已实际扣款',
            `流水 ${esc(p.outTradeNo)} 通道确认已支付 <b>¥${money(p.amount)}</b>，但本机没有对应购物明细（可能页面重开）。<br>请<b style="color:var(--bad)">勿重复扫码</b>；核实顾客商品后，按小票手工补录或在收银台重新走该金额现金记账，并联系店长核对。`,
            { okText: '我知道了' });
          pendingPays.splice(+b.dataset.q, 1); updatePendBadge(); m.remove();
          return;
        }
        // 已支付：先恢复快照到车（finishAfterGateway→doCheckout 按当前 cart 落单），再续流程
        pendingPays.splice(+b.dataset.q, 1); updatePendBadge(); m.remove();
        snapToLines(p.items).forEach(l => cart.push(l));
        renderCart();
        await finishAfterGateway({ channel: t.channel, outTradeNo: p.outTradeNo, transaction_id: t.transaction_id }, p.amount, p.combo || null, p.memberId);
      } else if (t && ['FAIL', 'CLOSED', 'REVOKED', 'PAYERROR', 'NOT_PAY'].includes(t.status)) {
        // 通道确认未支付：恢复购物车，释放挂起
        pendingPays.splice(+b.dataset.q, 1); updatePendBadge(); m.remove();
        if (p.serverOnly) { toast('通道确认未支付：该卡单已可释放'); showPending(); }
        else {
          snapToLines(p.items).forEach(l => cart.push(l));
          renderCart(); refreshStock();
          toast('通道确认未支付：商品已恢复购物车');
        }
      } else {
        b.textContent = '仍待支付，可稍后再查';
      }
    });
    m.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
      const p = pendingPays[+b.dataset.r];
      pwaConfirm('释放挂起单', '确认顾客未支付并释放？释放会向服务端留痕（仅待支付流水可释放）。').then(async ok => {
        if (!ok) return;
        try { await call('POST', '/pay/txn/' + encodeURIComponent(p.outTradeNo) + '/abandon'); } catch (e) { toast(e.message || e); return; }
        pendingPays.splice(+b.dataset.r, 1); updatePendBadge(); m.remove();
        if (!p.serverOnly) {
          snapToLines(p.items).forEach(l => cart.push(l));
          renderCart(); refreshStock();
        }
        toast('已释放（服务端已留痕）');
      });
    });
  }
  // ── V4.18.5 P15批4 内置退货：输小票号带原单 → 勾行按可退数退 → 原因必选留痕 → 限额内直退/超限转店长 ──
  async function openRefund(prefillNo) {
    let no = prefillNo;
    if (!no) {
      no = await pwaPrompt('内置退货 · 第 1 步', '扫小票条码或输入单号（GD2026…）', { okText: '查询原单' });
      no = (no || '').trim();
      if (!no) return;
    }
    let d;
    try { d = await call('GET', '/pos/refund-lookup?no=' + encodeURIComponent(no)); }
    catch (e) { toast(e.message || e); return; }
    const refundableLines = (d.lines || []).filter(l => l.refundable > 0);
    if (!refundableLines.length) { toast('该单没有可退商品（可能已整单退过）'); return; }
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet" style="width:min(560px,94vw)"><h3>↩ 内置退货 · ${esc(d.order.orderNo)}<button class="mini-btn" id="csRfX" style="float:right">关闭</button></h3>
      <div class="hint">小票 ¥${money(d.order.payable)} · ${dt(d.order.createdAt)}${d.order.memberName ? ' · 会员 ' + esc(d.order.memberName) : ''}${d.refundLimit > 0 ? ` · 免审限额 ¥${money(d.refundLimit)}` : ''}</div>
      <div id="csRfLines" style="max-height:260px;overflow:auto;margin:8px 0">
        ${refundableLines.map((l, i) => `
        <div class="row"><label style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
          <input type="checkbox" class="cs-rfck" data-i="${i}" checked style="width:16px;height:16px">
          <span class="grow" style="min-width:0"><span class="t">${esc(l.name)}</span>
          <span class="s">¥${money(l.unitPrice)} × ${l.qty} · 已退 ${l.refunded} · 可退 <b>${l.refundable}</b></span></span>
          <input type="number" class="cs-rfq" data-i="${i}" min="0" max="${l.refundable}" step="1" value="${l.refundable}"
                 style="width:64px;border:1px solid var(--line);border-radius:6px;padding:4px 6px;font-size:13px">
        </label></div>`).join('')}
      </div>
      <div class="field"><label>退货原因（必选，留痕）</label>
        <select id="csRfReason" style="width:100%">
          <option value="">请选择原因…</option>
          <option>质量问题</option><option>顾客反悔</option><option>错扫/多扫</option>
          <option>规格不符</option><option>临期处理</option><option value="__other">其他（填说明）</option>
        </select></div>
      <div class="hint">退货金额按原成交价+分摊优惠逐行计算；商品自动回库存（FIFO 原批次价）。超免审限额自动转店长审核。</div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn ghost" id="csRfNo" style="flex:1">取消</button>
        <button class="btn ok" id="csRfGo" style="flex:1">提交退货</button>
      </div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csRfX').onclick = () => m.remove();
    m.querySelector('#csRfNo').onclick = () => m.remove();
    // 勾选联动数量（取消勾选数量清零，勾选恢复可退数）
    m.querySelectorAll('.cs-rfck').forEach(ck => ck.onchange = () => {
      const q = m.querySelector(`.cs-rfq[data-i="${ck.dataset.i}"]`);
      if (q) q.value = ck.checked ? q.max : 0;
    });
    m.querySelector('#csRfGo').onclick = async () => {
      const items = refundableLines.map((l, i) => ({
        saleItemId: l.saleItemId, qty: Number(m.querySelector(`.cs-rfq[data-i="${i}"]`).value) || 0,
      })).filter(x => x.qty > 0);
      if (!items.length) { toast('请至少勾选一行并填写退货数量'); return; }
      let reason = m.querySelector('#csRfReason').value;
      if (!reason) { toast('请选择退货原因'); return; }
      if (reason === '__other') {
        const other = await pwaPrompt('退货原因说明', '请输入具体原因（留痕）');
        reason = '其他：' + String(other || '').trim();
        if (reason === '其他：') { toast('已选「其他」需填写说明'); return; }
      }
      // 预估金额（行单价×数量，整单优惠分摊由服务端精确计算）
      const est = refundableLines.filter((l, i) => items.some(x => x.saleItemId === l.saleItemId))
        .reduce((s, l, i, arr) => s + l.unitPrice * (items.find(x => x.saleItemId === l.saleItemId).qty), 0);
      const estR = Math.round(est * 100) / 100;
      const ok = await pwaConfirm('确认退货',
        `原单 ${esc(d.order.orderNo)} 退 <b>${items.length}</b> 行，预估退款 <b style="color:var(--bad)">¥${money(estR)}</b>${estR > d.refundLimit && d.refundLimit > 0 ? '<br><span style="color:var(--warn)">超过免审限额 ¥' + money(d.refundLimit) + '，提交后' + (hasPerm('sales.refund.audit') ? '可由您（店长）即时放行' : '需店长审核') + '</span>' : ''}<br>原因：${esc(reason)}。继续？`,
        { okText: '提交退货', danger: true });
      if (!ok) return;
      // V4.19.0 P15.5 #3 离线退货（C2）：现金单断网 → 暂存补传（clientRef 幂等）；电子通道退款强制在线
      const clientRef = 'R' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const refundPayload = { orderId: d.order.id, items, reason, restock: true, clientRef };
      if (!navigator.onLine) {
        const ch = d.order.payChannel || '现金';
        if (ch === '现金') {
          enqueueOffline({ kind: 'refund', ...refundPayload, queuedAt: new Date().toISOString() });
          refreshStagedBadge();
          toast('📴 网络不可用：现金退货已离线暂存，恢复联网自动补传入账（clientRef 幂等防重）');
          m.remove();
          return;
        }
        toast(`⚠ ${ch} 退款须在线原路退回：请恢复网络后重试（电子通道不支持离线退款）`);
        return;
      }
      let res;
      try { res = await call('POST', '/refunds', refundPayload); }
      catch (e) {
        // 提交瞬间断网：同口径分流（现金暂存 / 电子明示）
        if (/网络异常|failed to fetch|networkerror|load failed|fetch failed/i.test(String(e.message || ''))) {
          if ((d.order.payChannel || '现金') === '现金') {
            enqueueOffline({ kind: 'refund', ...refundPayload, queuedAt: new Date().toISOString() });
            refreshStagedBadge();
            toast('📴 提交时断网：现金退货已离线暂存，恢复联网自动补传');
            m.remove();
            return;
          }
          toast('⚠ 电子通道退款须在线：请恢复网络后重试');
          return;
        }
        toast(e.message || e); return;
      }
      if (res.status === '待审核') {
        if (hasPerm('sales.refund.audit')) {
          const go = await pwaConfirm('店长放行',
            `退款 ¥${money(res.amount)} 超过免审限额，已转审核单 ${esc(res.refundNo)}。<br>您有审核权限，是否<b style="color:var(--ok)">即时放行执行退款</b>？（也可稍后在后台「退款管理」处理）`,
            { okText: '放行并退款', danger: true });
          if (go) {
            try {
              await call('POST', `/refunds/${res.refundId}/audit`, { approve: true });
              toast(`✅ 已放行退款 ¥${money(res.amount)}（${res.refundNo}）`);
            } catch (e) { toast('放行失败：' + (e.message || e) + '（可稍后审核）'); m.remove(); return; }
          } else toast('已留审核单：' + res.msg || ('审核单 ' + res.refundNo));
        } else toast('超过免审限额：已转店长审核（' + res.refundNo + '）');
      } else {
        toast(`✅ 退货成功 ¥${money(res.amount)}（${res.refundNo}），商品已回库存`);
      }
      m.remove();
      refreshStock();
    };
  }

  // 负库存清单
  function showNegList() {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>📋 本班负库存清单（盘点线索）<button class="mini-btn" id="csNgX" style="float:right">关闭</button></h3>
      <div id="csNgList">${negSales.length ? negSales.map(o => `
        <div class="row"><div class="grow"><div class="t">${esc(o.name)}</div>
        <div class="s">${o.t} · 账面 ${o.stock} 件 · 车上 ${o.had} → 卖至 <b style="color:var(--bad)">${o.had + o.add}</b> 件（超 ${o.had + o.add - o.stock}）</div></div></div>`).join('')
      : '<div class="empty">本班暂无负库存单</div>'}</div>
      <div class="hint">交接班/日结时提示本班负库存笔数——差异要暴露，驱动及时入库或盘盈调整。</div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csNgX').onclick = () => m.remove();
    const dot = $('#csNegDot');
    if (dot) { dot.style.display = negSales.length ? '' : 'none'; dot.textContent = negSales.length; }
  }

  // ── V4.19.0 P15.5 #6 消息静默收纳：告警/补传结果收进铃铛列表（红点提示），点开查看不弹窗打断 ──
  const bellMsgs = [];   // {t, text, level}
  function csMsg(text, level = 'info') {
    bellMsgs.unshift({ t: nowHM(), text: String(text || ''), level });
    if (bellMsgs.length > 50) bellMsgs.pop();
    const d = $('#csBellDot');
    if (d) { d.style.display = ''; d.textContent = bellMsgs.filter(m => m.level === 'warn').length || bellMsgs.length; }
  }
  window.CsMsg = csMsg;   // 供 app.js 补传队列复用
  function showBellMsgs() {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>🔔 收银消息（静默收纳，不打断收银）<button class="mini-btn" id="csBlX" style="float:right">关闭</button></h3>
      <div id="csBlList">${bellMsgs.length ? bellMsgs.map(x => `
        <div class="row"><div class="grow"><div class="t" style="${x.level === 'warn' ? 'color:var(--bad)' : ''}">${esc(x.text)}</div>
        <div class="s">${esc(x.t)}</div></div></div>`).join('') : '<div class="empty">暂无消息（打印失败/补传结果/设备告警会收在这里）</div>'}</div>
      <button class="btn ghost" id="csBlClr" style="width:100%;margin-top:8px" ${bellMsgs.length ? '' : 'disabled'}>全部已读（清空红点）</button></div>`;
    document.body.appendChild(m);
    m.querySelector('#csBlX').onclick = () => m.remove();
    m.querySelector('#csBlClr').onclick = () => {
      bellMsgs.length = 0;
      const d = $('#csBellDot'); if (d) d.style.display = 'none';
      m.remove();
    };
  }

  // ── V4.19.0 P15.5 #5 语音查价（独立入口）：识别 → 命中商品播报售价+库存，不打断购物车 ──
  // V4.22.0：自然语言问价——"今天益达56g西瓜味卖多钱？"式问话直接解答（去寒暄/疑问词后多 token 打分匹配）
  function openVoiceAsk() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet"><h3>🎤 问价 · 查库存（像说话一样问）<button class="mini-btn" id="csVaX" style="float:right">关闭</button></h3>
      <div id="csVaBody" style="min-height:110px">
        <div class="hint">直接问：「今天益达56g西瓜味卖多钱？」「可乐还有几瓶？」「红富士多少钱」——识别商品后语音播报<b>售价与库存</b>；多候选列出点选。不影响当前购物车。</div>
        <div style="display:flex;gap:8px;margin:10px 0">
          <button class="btn ok" id="csVaGo" style="flex:1">🎙 开始听</button>
          <input id="csVaTxt" placeholder="也可直接输入，如：益达56g西瓜味多少钱" style="flex:1.6;border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--card);color:var(--ink)">
        </div>
        <div id="csVaList"></div>
      </div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csVaX').onclick = () => { try { rec && rec.stop(); } catch { /* noop */ } m.remove(); };
    let rec = null;
    // 寒暄/疑问词剥离表：命中即从问句中删除，剩下的碎片视为商品关键词
    const STOP = ['今天','昨天','现在','请问','问一下','问下','查询','查一下','查查','看看','帮忙','帮我','麻烦','一下',
      '多少','多少钱','多钱','几个','几瓶','几袋','几盒','几包','几块','还有','有没有','没','卖','售价','价格','价钱','单价','价',
      '什么价','怎么卖','咋卖','啥价','贵吗','便宜','库存','还剩','剩','剩余','吗','呢','吧','啊','的','了','么','是',
      '请问一下','告诉','说','我','你','想','要','买','这个','那个','它','看','下','先','都','和','跟','与'];
    const norm = s => String(s || '').toLowerCase().replace(/[？?！!。，,．.\s~～·、"'（）()【】\[\]]+/g, '');
    const extractKeys = q => {
      let t = norm(q);
      for (const w of STOP.sort((a, b) => b.length - a.length)) t = t.split(w).join('');
      return t;
    };
    const tokScore = (p, t) => {
      // t=去疑问词后的串：名称前缀命中 > 名称包含 > 规格/拼音包含 > 条码等于/包含
      const name = norm(p.name), spec = norm([p.spec, p.brand, p.flavor, p.pinyin, p.pinyin_code].join(' '));
      if (!t) return -1;
      if (p.barcode && String(p.barcode) === t) return 100;
      if (name === t) return 90;
      if (name.startsWith(t)) return 80;
      if (name.includes(t)) return 70;
      if (t.length >= 2 && spec.includes(t)) return 55;
      if (p.barcode && String(p.barcode).includes(t)) return 40;
      // 逐字符包含度（问句乱序也能凑）：t 的字符被名称吃掉的比例
      let hit = 0; for (const ch of t) if (name.includes(ch)) hit++;
      return t.length >= 2 && hit / t.length >= 0.6 ? 30 + Math.round(hit / t.length * 20) : -1;
    };
    const answer = q => {
      const t = extractKeys(q);
      if (!t) return [];
      const all = (Pricebook.items || []).filter(p => !p.deleted);
      return all.map(p => ({ p, s: tokScore(p, t) }))
        .filter(x => x.s >= 30)
        .sort((a, b) => b.s - a.s || String(a.p.name).length - String(b.p.name).length)
        .slice(0, 8).map(x => x.p);
    };
    const announce = p => {
      const st = stockOf(p);
      const stockTxt = st == null ? '库存未知' : (st > 0 ? `库存 ${Number.isInteger(st) ? st : st.toFixed(3)}` : '库存为 0（沽清）');
      const price = member && Number(p.memberPrice) > 0 ? p.memberPrice : p.sellPrice;
      const txt = `${p.name}，售价 ${money(price)} 元，${stockTxt}`;
      m.querySelector('#csVaList').innerHTML = `<div class="hint" style="font-size:15px"><b>${esc(p.name)}</b> · ¥${money(price)} · ${esc(stockTxt)}</div>`;
      try { if (window.PwaTTS && PwaTTS.supported()) PwaTTS.speak(txt); else toast(txt); } catch { toast(txt); }
    };
    const showList = list => {
      const box = m.querySelector('#csVaList');
      if (!list.length) { box.innerHTML = '<div class="hint">没听懂商品名，试试只说品牌+规格（如“益达56g”）</div>'; return; }
      if (list.length === 1) { announce(list[0]); return; }
      box.innerHTML = list.map((p, i) => `<div class="row" data-va="${i}" style="cursor:pointer"><div class="grow">
        <div class="t">${esc(p.name)}</div><div class="s">¥${money(member && Number(p.memberPrice) > 0 ? p.memberPrice : p.sellPrice)} · 库存 ${stockOf(p) ?? '未知'}</div></div></div>`).join('');
      box.querySelectorAll('[data-va]').forEach(r => r.onclick = () => announce(list[+r.dataset.va]));
    };
    const doAsk = t => { m.querySelector('#csVaTxt').value = t; showList(answer(t)); };
    m.querySelector('#csVaGo').onclick = () => {
      if (!SR) { toast('当前浏览器不支持语音识别：请用输入框查价'); return; }
      try {
        rec = new SR();
        rec.lang = 'zh-CN'; rec.interimResults = false; rec.maxAlternatives = 1;
        m.querySelector('#csVaList').innerHTML = '<div class="hint">🎧 正在听…请自然提问</div>';
        rec.onresult = ev => doAsk(ev.results[0][0].transcript);
        rec.onerror = () => m.querySelector('#csVaList').innerHTML = '<div class="hint">识别失败：靠近一点重试，或直接输入商品名</div>';
        rec.start();
      } catch (e) { toast('语音识别启动失败：' + (e.message || e)); }
    };
    m.querySelector('#csVaTxt').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); doAsk(m.querySelector('#csVaTxt').value); }
    });
  }

  // ── V4.19.0 P15.5 #1 分单（拆出另结，B1 先分单后算优惠）：勾行拆出 → 服务端校验 → 生成新挂起单 ──
  function openSplit() {
    if (!cart.length) { toast('购物车为空，无可拆分行'); return; }
    if (cart.length < 2) { toast('仅 1 行商品无需分单（直接整单结账即可）'); return; }
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet" style="width:min(520px,94vw)"><h3>✂ 分单（勾选行拆出，生成新挂起单）<button class="mini-btn" id="csSpX" style="float:right">关闭</button></h3>
      <div class="hint">拆出的行按<b>拆分后各自小票</b>重算优惠（先分单后算优惠）；剩余行留在本车继续结账。新挂起单在「取单」中调出。</div>
      <div id="csSpList" style="max-height:280px;overflow:auto;margin:8px 0">
        ${cart.map((l, i) => `
        <div class="row"><label style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">
          <input type="checkbox" class="cs-spck" data-i="${i}" style="width:16px;height:16px">
          <span class="grow" style="min-width:0"><span class="t">${esc(l.p.name)}${l.gift ? '（赠）' : ''}</span>
          <span class="s">¥${money(linePrice(l))} × ${l.qty}</span></span>
          <input type="number" class="cs-spq" data-i="${i}" min="0" max="${l.qty}" step="${isW(l.p) ? 0.05 : 1}" value="${l.qty}" disabled
                 style="width:70px;border:1px solid var(--line);border-radius:6px;padding:4px 6px;font-size:13px">
        </label></div>`).join('')}
      </div>
      <div class="hint" style="color:var(--bad)" id="csSpErr"></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn ghost" id="csSpNo" style="flex:1">取消</button>
        <button class="btn ok" id="csSpGo" style="flex:1">拆出并挂新单</button>
      </div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csSpX').onclick = () => m.remove();
    m.querySelector('#csSpNo').onclick = () => m.remove();
    m.querySelectorAll('.cs-spck').forEach(ck => ck.onchange = () => {
      const q = m.querySelector(`.cs-spq[data-i="${ck.dataset.i}"]`);
      if (q) { q.disabled = !ck.checked; q.value = ck.checked ? q.max : 0; }
    });
    m.querySelector('#csSpGo').onclick = async () => {
      // 以勾选态为准收集拆出行（勾选 + 数量>0）
      const rows = [];
      cart.forEach((l, i) => {
        const ck = m.querySelector(`.cs-spck[data-i="${i}"]`);
        if (ck && ck.checked) {
          const qv = Number(m.querySelector(`.cs-spq[data-i="${i}"]`).value) || 0;
          if (qv > 0) rows.push({ l, qty: qv });
        }
      });
      if (!rows.length) { toast('请勾选要拆出的行并填写数量'); return; }
      // 校验：拆出后每行余量 ≥ 0，且必须留至少一件在车内（整单挂车请用「挂单」）
      for (const r of rows) {
        if (r.qty > r.l.qty + 0.0001) { m.querySelector('#csSpErr').textContent = `「${r.l.p.name}」拆出数量超过车内数量`; return; }
      }
      const totalRemainQty = cart.reduce((s, l) => {
        const r = rows.find(x => x.l === l);
        return s + (r ? (l.qty - r.qty) : l.qty);
      }, 0);
      if (totalRemainQty <= 0) { toast('整单拆出等于挂单：请直接用「挂单」，或留至少一行在车内'); return; }
      const items = rows.map(r => ({
        productId: Number(r.l.p.id), qty: r.qty,
        ...(r.l.manualPrice != null ? { unitPrice: Number(r.l.manualPrice) } : {}),
        ...(r.l.remark ? { lineRemark: r.l.remark } : {}),
      }));
      m.querySelector('#csSpGo').disabled = true;
      try {
        await call('POST', '/pos/held/split-validate', { items });   // 后端校验：防 0 行/超量/商品不存在
        const d = await call('POST', '/pos/held', {
          items, memberId: member ? member.id : undefined, remark: `分单拆出 · ${ME.name}`,
        });
        // 从本车扣减拆出量（拆完的行移除）
        for (const r of rows) {
          const idx = cart.indexOf(r.l);
          if (idx >= 0) {
            r.l.qty = Math.round((r.l.qty - r.qty) * 1000) / 1000;
            if (r.l.qty <= 0.0001) cart.splice(idx, 1);
          }
        }
        coupon = null; manualRound = 0; orderDisc = null; ptsUse = 0;   // 优惠随拆分重算：原车已套优惠清空
        m.remove();
        renderCart(); renderSummary();
        refreshHeldBadge();
        csMsg(`已分单：${rows.length} 行拆出新挂起单 ${d.order_no || '#' + d.id}（各自小票重算优惠）`);
        toast(`✂ 已拆出新挂起单 ${d.order_no || '#' + d.id}（取单可调出）`);
      } catch (e) {
        m.querySelector('#csSpGo').disabled = false;
        m.querySelector('#csSpErr').textContent = e.message || String(e);
      }
    };
  }

  // ── V4.19.0 P15.5 #4 蓝牙音箱语音出口（Web BLE 按机型评估）──
  // A2DP 音频流浏览器不可直达；探测 GATT 可写特征（部分 BLE 音箱/语音模块有厂商写通道），不可用明确提示并回落本机喇叭
  let bleSpeaker = null;   // {name}
  async function connectBleSpeaker() {
    if (!navigator.bluetooth) {
      toast('当前浏览器不支持 Web Bluetooth（请用电脑 Chrome/Edge，且 HTTPS/localhost）');
      return;
    }
    try {
      const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ['battery_service'] });
      csMsg(`已选择蓝牙设备「${dev.name || '未命名'}」，探测语音通道…`);
      const gatt = await dev.gatt.connect();
      // 探测常见厂商写通道（FFE0/AE00/FF00 系列；纯 A2DP 音箱无 GATT 写特征）
      let found = false;
      for (const sv of await gatt.getPrimaryServices()) {
        for (const ch of await sv.getCharacteristics()) {
          if (ch.properties && (ch.properties.write || ch.properties.writeWithoutResponse)) { found = true; break; }
        }
        if (found) break;
      }
      if (found) {
        bleSpeaker = { name: dev.name || 'BLE设备' };
        toast(`已连接「${bleSpeaker.name}」：检测到厂商写通道；当前机型协议未收录，播报暂仍走本机喇叭（协议适配征集阶段）`);
      } else {
        toast(`「${dev.name || '未命名'}」为纯音频（A2DP）音箱：浏览器无法转发语音流，播报继续走本机喇叭`);
        try { await gatt.disconnect(); } catch { /* noop */ }
      }
    } catch (e) {
      if (/cancel|取消|choose/i.test(String(e && e.message))) return;   // 用户取消选择
      toast('蓝牙音箱连接失败：' + (e.message || e) + '（播报继续走本机喇叭）');
      csMsg('蓝牙音箱连接失败：' + String(e && e.message || e).slice(0, 60), 'warn');
    }
  }

  // ── 设备灯 / 自检 / 重连 ──
  function lampState(k) {
    if (k === 'scanner') return active ? 'green' : 'red';
    if (k === 'scale') return (typeof Scale !== 'undefined' && Scale.connected && Scale.connected()) ? 'green' : 'red';
    if (k === 'printer') {
      if (window.PwaPrinters && window.PwaPrinters.printerConnected && window.PwaPrinters.printerConnected()) return 'green';
      return 'yellow';   // 网口小票机（后台配置）无法本地探测：黄色=网口通道待验证
    }
    if (k === 'drawer') {
      if (window.PwaReceipt && window.PwaReceipt.drawerConnected && window.PwaReceipt.drawerConnected()) return 'green';
      return 'yellow';   // RJ11 网口联动
    }
    if (k === 'display') {   // V4.21.0：客显连接灯（绿=副屏在线；黄=暂无副屏连接；红=推送失败/已关闭）
      if (!dispPush) return 'red';
      if (dispClients > 0) return 'green';
      if (dispClients === -1) return 'red';
      return 'yellow';
    }
    return 'red';
  }
  function renderLamps() {
    document.querySelectorAll('#csLamps .cs-lamp').forEach(el => {
      el.classList.remove('green', 'red', 'yellow');
      el.classList.add(lampState(el.dataset.dev));
    });
  }
  async function lampReconnect(k) {
    const st = lampState(k);
    if (st === 'green') { toast(({ scanner: '扫码枪', scale: '电子秤', printer: '小票机', drawer: '钱箱', display: '客显' })[k] + '：在线'); return; }
    if (k === 'display') {   // V4.21.0：客显状态/打开副屏页
      if (!dispPush) { toast('客显推送已关闭（收银设置可开启）'); return; }
      toast(dispClients > 0 ? `客显在线（${dispClients} 台副屏）` : '暂无副屏连接：在副屏/浏览器打开「客显」页即可（收银设置内一键打开）');
      return;
    }
    if (k === 'scale') {
      if (typeof Scale === 'undefined') { toast('电子秤组件未加载'); return; }
      try { const d = await Scale.connect(); toast(`电子秤已连接（${d.baud}bps）`); }
      catch (e) { toast('电子秤连接失败：' + (e.message || e) + '（串口需一次点击授权）'); }
      renderLamps(); return;
    }
    if (k === 'printer') {
      if (window.PwaPrinters && !window.PwaPrinters.printerConnected()) {
        try { await window.PwaPrinters.connectPrinter(); toast('小票机串口已连接'); }
        catch (e) { toast('串口未连上：将使用网口直发（后台「打印中心」配置 IP:9100）'); }
      }
      renderLamps(); return;
    }
    if (k === 'drawer') {
      try { await window.PwaReceipt.connectDrawer(); toast('钱箱串口已连接：收现金自动弹箱'); }
      catch (e) { toast('钱箱串口未连上：RJ11 接网口小票机时可网口联动弹箱'); }
      renderLamps();
    }
  }
  async function selfCheck() {
    const names = { scanner: '扫码枪', scale: '电子秤', printer: '小票机', drawer: '钱箱' };
    toast('自检中：正在探测设备…');
    for (const k of Object.keys(names)) {
      await new Promise(r => setTimeout(r, 250));
      renderLamps();
    }
    let net = '网口打印：';
    try { const ps = await call('GET', '/printers'); net += (unwrap(ps).length ? '已配置 ' + unwrap(ps).length + ' 台' : '未配置'); }
    catch { net += '不可达'; }
    toast(`自检完成：电子秤${lampState('scale') === 'green' ? '已连' : '未连'} · 小票机${lampState('printer') === 'green' ? '串口直驱' : '走网口'} · 钱箱${lampState('drawer') === 'green' ? '已连' : '网口联动'} · ${net}`);
    renderLamps();
  }

  // ── 锁屏（F2：错 5 次锁 5 分钟；闲置自动锁） ──
  function armIdleLock() {
    clearInterval(idleTimer);
    if (!lockTimeoutMin) return;
    idleTimer = setInterval(() => {
      if (!active || lockState.locked) return;
      lockNow();
    }, lockTimeoutMin * 60000);
    ['click', 'keydown', 'touchstart'].forEach(ev =>
      document.addEventListener(ev, () => { if (active) resetIdle(); }, { capture: true, passive: true }));
  }
  function resetIdle() {
    clearInterval(idleTimer);
    if (!lockTimeoutMin) return;
    idleTimer = setInterval(() => { if (active && !lockState.locked) lockNow(); }, lockTimeoutMin * 60000);
  }
  function lockNow() {
    if (!active) return;
    lockState.locked = true; lockState.errs = 0;
    const el = $('#csLockMask'); if (el) el.style.display = 'flex';
    const pw = $('#csLockPw'); if (pw) { pw.value = ''; setTimeout(() => pw.focus(), 80); }
  }
  /** 锁屏解锁（V4.25.0 ③：优先用 PIN 免密解锁；未设 PIN → 自动回落登录密码） */
  async function unlockTry() {
    if (Date.now() < lockState.frozenUntil) {
      $('#csLockFrozen').textContent = '已锁定，请等待 ' + Math.ceil((lockState.frozenUntil - Date.now()) / 1000) + ' 秒';
      return;
    }
    const pw = $('#csLockPw').value;
    if (!pw) { $('#csLockErr').textContent = '请输入 PIN 或密码'; return; }
    const fail = (msg) => {
      lockState.errs++;
      if (/网络/.test(msg || '')) { $('#csLockErr').textContent = '离线状态无法校验，请恢复网络后解锁'; return; }
      if (lockState.errs >= 5) {
        lockState.frozenUntil = Date.now() + 5 * 60000;
        $('#csLockFrozen').textContent = '连续错 5 次，已锁定 5 分钟';
      } else {
        $('#csLockErr').textContent = `PIN/密码错误（已错 ${lockState.errs}/5 次）`;
      }
      $('#csLockPw').value = '';
    };
    // V4.25.0：先试 PIN（工号 + PIN 免密）；未设 PIN(41011) 回落登录密码
    try {
      await call('POST', '/auth/pin-login', { empNo: ME.empNo, pin: pw });
    } catch (e) {
      const msg = e.message || '';
      if (/未设置 PIN|41011/.test(msg)) {
        try { await call('POST', '/auth/login', { empNo: ME.empNo, password: pw }); }
        catch (e2) { fail(e2.message || ''); return; }
      } else { fail(msg); return; }
    }
    lockState.locked = false; lockState.errs = 0;
    $('#csLockMask').style.display = 'none';
    $('#csLockErr').textContent = ''; $('#csLockFrozen').textContent = '';
    toast('已解锁：购物车/挂单/设备连接原样保留');
    armIdleLock();
  }

  // ── 设置（店长面板，sys.settings 权限） ──
  async function openSettings() {
    const m = document.createElement('div');
    m.className = 'modal';
    const canWrite = hasPerm('sys.settings');
    // V4.18.7：音色/语速现值（空=跟随老板端）；本机中文音色枚举
    const vk = await call('GET', '/settings/key/pos.cashier.tts.voice').catch(() => null);
    const rk = await call('GET', '/settings/key/pos.cashier.tts.rate').catch(() => null);
    const curVoice = String((vk && vk.value) ?? '');
    const curRate = String((rk && rk.value) ?? '');
    const vs = (window.PwaTTS && PwaTTS.zhVoices() || []);
    // V4.22.2：标出自动择优会选中的音色（⭐）+ 是否拟真（Windows 自然语音 / Edge 在线声都算拟真）
    const autoPick = (window.PwaTTS && PwaTTS.pickVoice && PwaTTS.pickVoice()) || null;
    const autoName = autoPick ? autoPick.name : '';
    // V4.25.7：新增「引擎语音」项（服务端神经语音 piper）——此前下拉只有浏览器音色，看不到引擎语音
    const ENGINE = (window.PwaTTS && PwaTTS.ENGINE_VOICE) || '__engine__';
    const engineOk = !!(window.PwaTTS && PwaTTS.serverInfo && PwaTTS.serverInfo().available);
    const voiceOpts = ['<option value=""' + (curVoice ? '' : ' selected') + '>跟随老板端设置' + (autoName ? '（自动择优）' : '') + '</option>',
      `<option value="${ENGINE}"${curVoice === ENGINE ? ' selected' : ''}>🔊 引擎语音（服务器神经语音·离线拟真）${engineOk ? '' : '·未就绪'}</option>`]
      .concat(vs.map(v => `<option value="${v.name.replace(/"/g, '&quot;')}"${v.name === curVoice ? ' selected' : ''}>${v.name === autoName ? '⭐ ' : ''}${v.name}${PwaTTS.isNatural(v) ? '（拟真）' : /Google/i.test(v.name) ? '（需联网）' : '（本地）'}</option>`));
    // V4.19.0：浏览器兜底打印现值（默认开=未配小票机时弹预览兜底；关=绝不弹预览）
    const fbk = await call('GET', '/settings/key/pos.print.browser_fallback').catch(() => null);
    const curFb = String((fbk && fbk.value) ?? '1') !== '0';
    // V4.22.0：本机小票机下拉（/printers 列表；本机绑定优先于后台默认机）
    let prRows = [];
    try { const pd = await call('GET', '/printers'); prRows = Array.isArray(pd) ? pd : (pd.items || []); } catch { /* 离线忽略 */ }
    const prOpts = ['<option value="0"' + (!LC.printerId ? ' selected' : '') + '>跟随后台默认机</option>']
      .concat(prRows.map(p => `<option value="${Number(p.id)}"${Number(LC.printerId) === Number(p.id) ? ' selected' : ''}>${esc(p.name)}（${esc(p.conn_type || '—')}${p.is_default ? '·后台默认' : ''}）</option>`));
    m.innerHTML = `<div class="sheet" style="padding-bottom:56px;max-width:min(680px,96vw)"><h3>⚙ 收银设置（店长面板）<button class="mini-btn" id="csCfgX" style="float:right">关闭</button></h3>
      <div class="kv"><span class="k">重复扫防抖（2 秒同码不重复加件）</span><span class="v"><select id="csCfgDb"><option value="1"${debounceOn ? ' selected' : ''}>开</option><option value="0"${!debounceOn ? ' selected' : ''}>关</option></select></span></div>
      <div class="kv"><span class="k">库存硬拦（账实不符时禁止售卖）</span><span class="v"><select id="csCfgHard"><option value="0"${!stockHard ? ' selected' : ''}>关（容许负库存+留痕）</option><option value="1"${stockHard ? ' selected' : ''}>开（一律拒绝）</option></select></span></div>
      <div class="kv"><span class="k">锁屏闲置超时（分钟，0=不自动锁）</span><span class="v"><input id="csCfgLock" type="number" min="0" max="30" value="${lockTimeoutMin}" style="width:70px"></span></div>
      <div class="kv"><span class="k">商品区每行卡片数<b style="color:var(--pri)">（本机）</b></span><span class="v"><select id="csCfgCols">${[4,5,6,7,8].map(n => `<option value="${n}"${gridCols === n ? ' selected' : ''}>${n} 个/行</option>`).join('')}</select></span></div>
      <div class="kv"><span class="k">显示模式<b style="color:var(--pri)">（本机）</b></span><span class="v"><select id="csCfgUi"><option value="auto"${LC.uiMode === 'auto' ? ' selected' : ''}>自动（小屏自动紧凑）</option><option value="normal"${LC.uiMode === 'normal' ? ' selected' : ''}>标准</option><option value="compact"${LC.uiMode === 'compact' ? ' selected' : ''}>紧凑（低分辨率收银机）</option></select></span></div>
      <div class="kv"><span class="k">本机小票机<b style="color:var(--pri)">（本机）</b></span><span class="v"><select id="csCfgPrnDev">${prOpts.join('')}</select></span></div>
      <div class="kv"><span class="k">键盘快捷键</span><span class="v"><select id="csCfgHk"><option value="1"${hotkeysOn ? ' selected' : ''}>开</option><option value="0"${!hotkeysOn ? ' selected' : ''}>关</option></select></span></div>
      <div class="kv"><span class="k">收款语音播报</span><span class="v"><select id="csCfgTts"><option value="1"${ttsOn ? ' selected' : ''}>开</option><option value="0"${!ttsOn ? ' selected' : ''}>关</option></select></span></div>
      <div class="kv"><span class="k">小票打印（<b>F7</b> 快捷开关）</span><span class="v"><select id="csCfgPrn"><option value="1"${printOn ? ' selected' : ''}>开</option><option value="0"${!printOn ? ' selected' : ''}>关</option></select></span></div>
      <div class="kv"><span class="k">浏览器兜底打印（弹预览）</span><span class="v"><select id="csCfgFb"><option value="1"${curFb ? ' selected' : ''}>开（未配小票机时兜底）</option><option value="0"${!curFb ? ' selected' : ''}>关（绝不弹预览）</option></select></span></div>
      <div class="kv"><span class="k">蓝牙音箱（语音出口探测）</span><span class="v"><button class="mini-btn" id="csCfgBle">连接/探测</button></span></div>
      <div class="kv"><span class="k">客显推送（顾客副屏）</span><span class="v"><select id="csCfgDisp"><option value="1"${dispPush ? ' selected' : ''}>开</option><option value="0"${!dispPush ? ' selected' : ''}>关</option></select> <button class="mini-btn" id="csCfgDispOpen">🖥 打开副屏</button></span></div>
      <div class="kv"><span class="k">串口客显杆屏<b style="color:var(--pri)">（本机）</b></span><span class="v"><select id="csCfgSerProf">${[['esc', 'ESC/POS 双行'], ['cd522', 'VFD（CD5220）'], ['txt', '纯文本']].map(([v, t]) => `<option value="${v}"${LC.dispProf === v ? ' selected' : ''}>${t}</option>`).join('')}</select> <button class="mini-btn" id="csCfgSer">${window.CDisp && CDisp.connected() ? '断开' : '连接'}</button></span></div>
      <div class="kv"><span class="k">堂食台位管理</span><span class="v"><button class="mini-btn" id="csCfgTables">管理</button></span></div>
      <div class="kv"><span class="k">快捷键自定义（点击改键）</span><span class="v" id="csHkEdit" style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"></span></div>
      ${hasPerm('pos.price.authorize') ? `<div class="kv"><span class="k">店长授权码（改价/打折现场授权）</span><span class="v"><span class="muted" style="font-size:12px">在后台「员工与角色 → 授权码」设置/修改/清除</span></span></div>` : ''}
      <div class="kv"><span class="k">设备异常记录（埋点）</span><span class="v"><button class="mini-btn" id="csCfgDev">查询</button></span></div>
      <div class="kv"><span class="k">播报音色（默认跟随老板端）</span><span class="v"><select id="csCfgVoice">${voiceOpts.join('')}</select></span></div>
      <div class="kv"><span class="k">播报语速（默认跟随老板端）</span><span class="v"><select id="csCfgRate"><option value=""${curRate ? '' : ' selected'}>跟随老板端</option>${[0.85,1,1.1,1.25].map(r => `<option value="${r}"${curRate === String(r) ? ' selected' : ''}>${r} 倍</option>`).join('')}</select></span></div>
      <button class="mini-btn" id="csCfgTtsTry" style="margin-top:6px">🔊 试听当前音色</button>
      <div class="hint" id="csTtsInfo">音色诊断加载中…</div>
      <div class="hint">音色说明：能用哪些音色由「运行环境 + 系统语音包」决定——Edge 浏览器自带拟真晓晓（云端、需联网）；<b>收银端 EXE 与 Chrome 只能用本机已安装的系统音色</b>。电脑端要拟人音色，请在 Windows「设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 语音」安装中文语音包，或在「设置 → 辅助功能 → 讲述人 → 添加自然语音」安装自然语音（离线可用），装完重启收银端即可在上方选中。试听不影响已保存设置。</div>
      <div class="hint">快捷键：<b>F1</b>=键位说明（固定）· 其余键位在上方「快捷键自定义」点击修改，保存后立即生效；EXE 桌面端自动同步为全局键。结算弹窗回车=收款、空格=收款不打小票。<b>改价（默认 P）/ 单品折扣（默认 D）</b>作用于当前选中行（点购物车行选中）。F3/F5/F11/F12 为浏览器保留键不建议设。</div>
      <div class="hint">标注<b>（本机）</b>的项（卡片数/显示模式/本机小票机）只存在本机、不传给其他收银台；其余存 system_settings（收银台组）全店共享，修改留痕。</div>
      ${canWrite ? '<button class="btn ok" id="csCfgSave" style="width:100%;margin-top:10px;position:sticky;bottom:-18px;padding:12px 0;box-shadow:0 -6px 14px rgba(20,40,25,.18)">保存</button>'
        : '<div class="hint" style="color:var(--bad)">无 sys.settings 权限：仅可查看，请在后台设置页修改。</div>'}</div>`;
    document.body.appendChild(m);
    m.querySelector('#csCfgX').onclick = () => m.remove();
    // V4.25.7：店长授权码管理已移到后台「员工与角色」（收银端只读提示，见上方 kv 行）
    // V4.22.2 音色诊断：显示「当前生效音色 + 本机可用音色数」，两端音色不一致时可直接比对定位
    const infoEl = m.querySelector('#csTtsInfo');
    if (infoEl && window.PwaTTS) {
      try {
        const vi = PwaTTS.voiceInfo();
        const sv = await PwaTTS.ensureServerProbe();   // V4.24.1：服务端离线神经语音（piper）可用性
        if (sv && sv.available) {
          infoEl.innerHTML = `当前引擎：<b style="color:var(--ok)">服务端神经语音（${esc(sv.voice || '花言 · 中文女声')}，全离线）</b> · 全端统一拟人声`
            + `<div class="hint" style="margin-top:4px">本机音色仅作回落（${vi.count} 个：${vi.natural ? esc(vi.current) + '（拟真）' : '机械音'}）；服务端异常时自动切换，播报不中断。</div>`;
        } else {
          const cur = vi.current || '浏览器默认音色';
          infoEl.innerHTML = `当前生效音色：<b>${esc(cur)}</b>（${vi.natural ? '拟真' : '本地机械音'}）· 本机可用中文音色 <b>${vi.count}</b> 个`
            + (vi.natural ? '' : ' · <b style="color:var(--bad)">未检测到拟真人声</b>'
              + '<div class="hint" style="margin-top:4px">说明：「讲述人 → 添加自然语音」装的音色（如 晓晓 Natural HD）<b>仅限讲述人自己使用</b>，不注册为系统 TTS，Chrome/收银台内核枚举不到（已实测确认）；且服务端语音引擎（backend/tts/）未就绪——部署 piper 后即自动切换为服务端拟人声。</div>');
        }
      } catch { infoEl.textContent = ''; }
    }
    // V4.18.7b 试听：同步 speak（保住点击手势，Chrome 否则静默拦截）+ 失败明示原因
    const tryBtn = m.querySelector('#csCfgTtsTry');
    tryBtn && (tryBtn.onclick = () => {
      if (!(window.PwaTTS && PwaTTS.supported())) { toast('当前浏览器不支持语音合成'); return; }
      PwaTTS.cfg.voice = m.querySelector('#csCfgVoice').value || PwaTTS.cfg.voice;   // 空=跟随老板端（loadCfg 已缓存老板端音色）
      const r = m.querySelector('#csCfgRate').value;
      PwaTTS.cfg.rate = r === '' ? 1 : Number(r);
      const ok = PwaTTS.speak('您好，收款十二元，谢谢惠顾', {
        onFail: (why, vn) => toast(`「${vn || '当前音色'}」无声（${why}）：在线音色需联网，Edge 拟真声仅 Edge 可用，建议换「本地」音色`, false),
      });
      if (!ok) toast('当前浏览器不支持语音合成');
    });
    // V4.19.0 #4 蓝牙音箱探测 + #9 设备埋点查询
    const bleBtn = m.querySelector('#csCfgBle');
    bleBtn && (bleBtn.onclick = () => connectBleSpeaker());
    const devBtn = m.querySelector('#csCfgDev');
    devBtn && (devBtn.onclick = async () => {
      const mm = document.createElement('div');
      mm.className = 'modal';
      mm.innerHTML = `<div class="sheet" style="width:min(560px,94vw)"><h3>📈 设备异常记录（近 20 条）<button class="mini-btn" id="csDevX" style="float:right">关闭</button></h3>
        <div id="csDevList">加载中…</div>
        <div class="hint">打印失败/连接失败/补传失败/秤离线统一埋点；warn 级同步推送老板端消息中心。</div></div>`;
      document.body.appendChild(mm);
      mm.querySelector('#csDevX').onclick = () => mm.remove();
      try {
        const d = await call('GET', '/device/events?size=20');
        const CN = { print_fail: '打印失败', connect_fail: '连接失败', sync_fail: '补传失败', scale_offline: '秤离线', low_paper: '缺纸' };
        const DT = { printer: '小票机', drawer: '钱箱', scale: '电子秤', scanner: '扫码枪', sync: '补传' };
        mm.querySelector('#csDevList').innerHTML = (d.items || []).length ? (d.items || []).map(x => `
          <div class="row"><div class="grow"><div class="t" style="${x.severity === 'warn' ? 'color:var(--bad)' : ''}">
            ${esc(DT[x.device_type] || x.device_type)} · ${esc(CN[x.event_type] || x.event_type)}${x.device_name ? '（' + esc(x.device_name) + '）' : ''}</div>
          <div class="s">${dt(x.created_at)}${x.detail && x.detail.msg ? ' · ' + esc(String(x.detail.msg).slice(0, 60)) : ''}</div></div></div>`).join('')
          : '<div class="empty">暂无设备异常记录</div>';
      } catch (e) { mm.querySelector('#csDevList').innerHTML = `<div class="hint" style="color:var(--bad)">${esc(e.message || e)}</div>`; }
    });
    // V4.21.0 P16 批2：客显副屏一键打开（第二窗口/副屏镜像均可）+ 台位管理入口
    const dispBtn = m.querySelector('#csCfgDispOpen');
    dispBtn && (dispBtn.onclick = () => {
      window.open(location.origin + '/display/', 'csDisplay',
        'width=960,height=640,left=' + (screen.availWidth + 10) + ',top=0,menubar=no,toolbar=no');
      toast('已打开客显副屏：拖到副显示器后按 F11 全屏（EXE 端副屏自动全屏）');
    });
    const tblBtn = m.querySelector('#csCfgTables');
    tblBtn && (tblBtn.onclick = () => openTables());
    // V4.22.0 P16 批3：串口客显连接（requestPort 须在点击手势内；协议档案选择即存本机）
    const serBtn = m.querySelector('#csCfgSer'), serProf = m.querySelector('#csCfgSerProf');
    serProf && (serProf.onchange = () => { LC.dispProf = serProf.value; saveLC(); });
    serBtn && (serBtn.onclick = async () => {
      try {
        if (window.CDisp && CDisp.connected()) { await CDisp.disconnect(); serBtn.textContent = '连接'; toast('串口客显已断开'); return; }
        if (!(window.CDisp && CDisp.supported())) { toast('当前环境不支持 WebSerial：请用 EXE 或电脑 Chrome/Edge'); return; }
        await CDisp.connect(serProf.value, LC.dispBaud || 9600);
        serBtn.textContent = '断开';
        toast('串口客显已连接：收银金额将同步显示在杆屏');
      } catch (e) { toast('串口客显连接失败：' + (e.message || e)); }
    });
    // 快捷键自定义编辑器（V4.21.0）：点击捕获按键；冲突自动互换；ESC 取消
    let hkDraft = { ...hkMap };
    const HK_CN = { pay: '结算', hold: '挂单', take: '取单', repeat: '重复上一单', print: '打印开关', lock: '锁屏', stock: '库存查询', price: '改价', disc: '单品折扣' };   // V4.25.3：price/disc 作用于当前选中行
    const hkSlot = m.querySelector('#csHkEdit');
    const renderHkEdit = () => {
      if (!hkSlot) return;
      hkSlot.innerHTML = Object.keys(HK_CN).map(k =>
        `<button class="mini-btn" data-hk="${k}"${canWrite ? '' : ' disabled'}>${HK_CN[k]} <b>${esc(hkDraft[k])}</b></button>`).join('');
      hkSlot.querySelectorAll('[data-hk]').forEach(b => b.onclick = () => captureHk(b));
    };
    const captureHk = btn => {
      const k = btn.dataset.hk;
      btn.innerHTML = HK_CN[k] + ' 按键…';
      const onKey = ev => {
        ev.preventDefault(); ev.stopPropagation();
        document.removeEventListener('keydown', onKey, true);
        const key = ev.key.length === 1 ? ev.key.toUpperCase() : ev.key;
        if (ev.key === 'Escape') { renderHkEdit(); return; }
        if (key === 'F1') { toast('F1=键位说明，固定不可改'); renderHkEdit(); return; }
        if (!/^(F([1-9]|1[0-2])|[A-Z])$/.test(key)) { toast('仅支持 F1~F12 或单个字母键'); renderHkEdit(); return; }
        const other = Object.keys(hkDraft).find(x => x !== k && hkDraft[x] === key);
        if (other) { toast(`「${key}」已用于${HK_CN[other]}，两键已互换`); hkDraft[other] = hkDraft[k]; }
        hkDraft[k] = key;
        renderHkEdit();
      };
      document.addEventListener('keydown', onKey, true);
    };
    renderHkEdit();
    const save = m.querySelector('#csCfgSave');
    save && (save.onclick = async () => {
      try {
        // V4.21.0：逐项保存 + 失败收集明示（避免单项 40404 静默中断导致整包丢失、弹窗滞留）
        const puts = [
          ['pos.cashier.debounce', m.querySelector('#csCfgDb').value === '1'],
          ['pos.cashier.stock_hard', Number(m.querySelector('#csCfgHard').value)],
          ['pos.cashier.lock_timeout', Number(m.querySelector('#csCfgLock').value) || 0],
          ['pos.cashier.hotkeys', m.querySelector('#csCfgHk').value === '1'],
          ['pos.cashier.tts', m.querySelector('#csCfgTts').value === '1'],
          ['pos.cashier.print', m.querySelector('#csCfgPrn').value === '1'],
          ['pos.print.browser_fallback', m.querySelector('#csCfgFb').value === '1'],
          ['pos.cashier.tts.voice', m.querySelector('#csCfgVoice').value],
          ['pos.cashier.tts.rate', m.querySelector('#csCfgRate').value],
          ['pos.cashier.hotkey_map', hkDraft],
          ['pos.display.push', m.querySelector('#csCfgDisp').value === '1'],
        ];
        // V4.22.0：本机三项（卡片数/显示模式/本机小票机）只写本机 localStorage，不入库不串台
        LC.gridCols = Number(m.querySelector('#csCfgCols').value) || 5;
        LC.uiMode = m.querySelector('#csCfgUi').value || 'auto';
        LC.printerId = Number(m.querySelector('#csCfgPrnDev').value) || 0;
        saveLC();
        const failed = [];
        for (const [k, v] of puts) {
          try { await call('PUT', '/settings/' + encodeURIComponent(k), { value: v, reason: '收银设置' }); }
          catch (e) { failed.push(k.split('.').pop() + '：' + String(e.message || e).slice(0, 40)); }
        }
        if (failed.length) { toast('⚠ 部分设置保存失败：' + failed.join(' · ')); return; }
        toast('收银设置已保存并留痕');
        // V4.21.1：音色/界面刷新不阻塞保存反馈（异常也不吞 toast/关窗）
        if (window.PwaTTS) { const p = PwaTTS.loadCfg(true); if (p && p.catch) p.catch(() => { }); }
        try { await loadSettings(); armIdleLock(); renderGrid(); syncExeHotkeys(); applyCompact(); } catch (e) { console.warn('设置刷新异常', e); }
        m.remove();
      } catch (e) {
        // V4.21.1 兜底：任何未预期异常都必须给用户反馈（不再可能出现「点了没反应」）
        toast('保存异常：' + String(e.message || e).slice(0, 60));
      }
    });
  }

  // ── 客显推送（V4.21.0 P16 批2 · §13.16）：购物明细/支付引导/会员卡/台位 → 顾客副屏 ──
  //  E3 断连不中断交易：推送失败只亮红灯，收银流程不受影响；副屏恢复连接自动收到最新一帧
  function dispFrame(extra) {
    const c = calc();
    return {
      items: cart.map(l => ({ name: l.p.name, qty: l.qty, amount: lineAmount(l), weighted: isW(l.p), unit: l.p.unit || '件', image: l.p.photoPath || '' })),
      payable: c.due,
      saved: Math.round((c.memSave + c.couponCut + c.discAmt + promo.amount) * 100) / 100,
      member: member ? { ...member, balance: Number(member.balance) || 0 } : null,
      cashierName: ME.name || '', storeName: localStorage.getItem('pwa_store_name') || '',
      tableName: csTable ? csTable.name : null,
      ...(extra || {}),
    };
  }
  function pushDisplay(extra, immediate) {
    if (!dispPush || !active) return;
    clearTimeout(dispPushTimer);
    const go = () => {
      const f = dispFrame(extra);
      // SSE 副屏（在线才推；离线时副屏同样收不到）
      if (navigator.onLine) {
        call('POST', '/display/push', f).then(d => {
          dispClients = Number(d && d.clients) || 0; renderLamps();
        }).catch(() => { dispClients = -1; renderLamps(); });
      }
      cdispFrame(f);   // V4.22.0 P16 批3：串口杆屏同步驱动（未连接时内部直返）
    };
    if (immediate) go(); else dispPushTimer = setTimeout(go, 350);
  }
  /** V4.22.0 P16 批3：串口客显两行内容映射——合计/应收/支付引导/找零；未连接/不支持静默跳过 */
  function cdispFrame(f) {
    if (!(window.CDisp && CDisp.connected())) return;
    const n = (f.items || []).reduce((s, i) => s + Number(i.qty || 0), 0);
    let l1 = `合计 ${money(f.payable)}元`, l2 = `${n}件 应收${money(f.payable)}`;
    const st = String(f.status || '');
    if (st === 'pay_cash') { l2 = `请付现金 ${money(f.payable)}`; }
    else if (st === 'pay_scan') { l2 = '请出示付款码'; }
    else if (st === 'done') { l1 = '谢谢惠顾'; l2 = f.change != null ? `找零 ${money(f.change)}元` : `实收 ${money(f.payable)}元`; }
    else if (st === 'idle') { l1 = f.storeName || '欢迎光临'; l2 = f.welcome || '欢迎光临'; }
    CDisp.show(l1, l2).catch(() => { });   // 杆屏失败静默（副屏灯不含串口状态，避免误报）
  }
  function startDispPing() {   // 空闲期心跳：副屏连接数变化实时反映到主屏客显灯（E3）
    clearInterval(window.__csDispPing);
    window.__csDispPing = setInterval(() => { if (active && dispPush && navigator.onLine) pushDisplay({ ping: true }, true); }, 15000);
  }

  // V4.21.0：EXE 桌面端全局快捷键同步（浏览器端为页面内生效，无需注册）
  function syncExeHotkeys() {
    try {
      // V4.25.3：只把功能键（F1~F12）注册为 EXE 全局键；字母键（如 P/D）不注册——
      //   globalShortcut 单字母会全局劫持系统输入（在别的窗口按 P 也会被拦），故字母键仅页面内生效
      const keys = [...new Set(Object.values(hkMap).filter(Boolean).filter(k => /^F([1-9]|1[0-2])$/.test(k)))];
      if (window.DesktopShell && DesktopShell.registerHotkeys) DesktopShell.registerHotkeys(keys);
    } catch { /* 非 EXE 环境 */ }
  }

  // ── 台位管理面板（V4.21.0 P16 批2 · sys.settings 写权限；占用/释放登录即可） ──
  async function openTables() {
    const m = document.createElement('div');
    m.className = 'modal';
    const canWrite = hasPerm('sys.settings');
    m.innerHTML = `<div class="sheet" style="width:min(680px,94vw);padding-bottom:56px"><h3>🍽 堂食台位管理<button class="mini-btn" id="csTblX" style="float:right">关闭</button></h3>
      <div id="csTblList">加载中…</div>
      ${canWrite ? `<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
        <input id="csTblName" placeholder="编号（如 A01）" style="width:100px;border:1px solid var(--line);border-radius:8px;padding:5px 8px;background:var(--card);color:var(--ink)">
        <input id="csTblArea" placeholder="区域（可空）" style="width:100px;border:1px solid var(--line);border-radius:8px;padding:5px 8px;background:var(--card);color:var(--ink)">
        <input id="csTblSeats" type="number" min="0" placeholder="座位" style="width:64px;border:1px solid var(--line);border-radius:8px;padding:5px 8px;background:var(--card);color:var(--ink)">
        <select id="csTblDev" style="max-width:180px;border:1px solid var(--line);border-radius:8px;padding:5px 8px;background:var(--card);color:var(--ink)"></select>
        <button class="mini-btn ok" id="csTblAdd">新增台位</button></div>
      <div class="hint">落单选台位自动「使用中」；结清后在此「清台」释放。绑定设备=该台位副屏/收银机（设备管理建档后可选）。</div>`
        : '<div class="hint" style="color:var(--bad)">无 sys.settings 权限：仅可查看与清台。</div>'}</div>`;
    document.body.appendChild(m);
    m.querySelector('#csTblX').onclick = () => m.remove();
    const devs = await call('GET', '/devices').catch(() => []);
    const devList = (Array.isArray(devs) ? devs : (devs.items || []));
    const devSel = m.querySelector('#csTblDev');
    if (devSel) devSel.innerHTML = '<option value="">绑定设备（可空）</option>' + devList.map(d => `<option value="${d.id}">${esc(d.name)}（${esc(d.kind)}）</option>`).join('');
    const stColor = { '空闲': 'var(--ok)', '使用中': 'var(--warn, #d90)', '预留': '#26c', '停用': 'var(--bad)' };
    const reload = async () => {
      const box = m.querySelector('#csTblList');
      try {
        const ts = await call('GET', '/tables');
        const list = (Array.isArray(ts) ? ts : (ts.items || []));
        box.innerHTML = list.length ? list.map(t => `
          <div class="row"><div class="grow"><div class="t"><b>${esc(t.name)}</b>${t.area ? ' <span class="pill gray">' + esc(t.area) + '</span>' : ''}
            ${t.seats ? `<span class="pill gray">${t.seats} 座</span>` : ''} ${t.device_name ? `<span class="pill gray">🖥 ${esc(t.device_name)}</span>` : ''}</div></div>
          <div style="display:flex;gap:5px;align-items:center">
            <span class="pill" style="color:${stColor[t.status] || 'inherit'}">${esc(t.status)}</span>
            ${t.status !== '空闲' ? `<button class="mini-btn" data-act="release" data-id="${t.id}">清台</button>` : `<button class="mini-btn" data-act="occupy" data-id="${t.id}">开台</button>`}
            ${canWrite ? `<button class="mini-btn" data-act="reserve" data-id="${t.id}">预留</button>
            <button class="mini-btn" data-act="disable" data-id="${t.id}">停用</button>
            <button class="mini-btn" data-act="del" data-id="${t.id}" style="color:var(--bad)">删</button>` : ''}
          </div></div>`).join('') : '<div class="empty">暂无台位，先在下方新增</div>';
        box.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
          const id = b.dataset.id, act = b.dataset.act;
          try {
            if (act === 'release') await call('POST', `/tables/${id}/release`);
            else if (act === 'occupy') await call('POST', `/tables/${id}/occupy`);
            else if (act === 'reserve') await call('POST', `/tables/${id}/mark`, { status: '预留' });
            else if (act === 'disable') await call('POST', `/tables/${id}/mark`, { status: '停用' });
            else if (act === 'del') { if (!confirm('删除台位？历史订单不受影响')) return; await call('DELETE', `/tables/${id}`); }
            reload();
          } catch (e) { toast(e.message || e); }
        });
      } catch (e) { box.innerHTML = `<div class="hint" style="color:var(--bad)">加载失败：${esc(e.message || e)}</div>`; }
    };
    const addBtn = m.querySelector('#csTblAdd');
    addBtn && (addBtn.onclick = async () => {
      const name = m.querySelector('#csTblName').value.trim();
      if (!name) { toast('请输入台位编号'); return; }
      try {
        await call('POST', '/tables', {
          name, area: m.querySelector('#csTblArea').value.trim(),
          seats: Number(m.querySelector('#csTblSeats').value) || 0,
          deviceId: devSel && devSel.value ? Number(devSel.value) : undefined,
        });
        m.querySelector('#csTblName').value = ''; m.querySelector('#csTblArea').value = ''; m.querySelector('#csTblSeats').value = '';
        reload();
      } catch (e) { toast(e.message || e); }
    });
    reload();
  }

  // ── F1 键位说明弹窗（固定键，不可自定义） ──
  function showHotkeyHelp() {
    const CN = { pay: '结算（开收款）', hold: '挂单', take: '取单', repeat: '重复上一单', print: '小票打印开关', lock: '锁屏', stock: '库存查询', price: '改价（当前行）', disc: '单品折扣（当前行）' };
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="sheet" style="width:min(430px,92vw)"><h3>⌨ 快捷键说明<button class="mini-btn" id="csHkX" style="float:right">关闭</button></h3>
      ${Object.keys(CN).map(k => `<div class="kv"><span class="k">${CN[k]}</span><span class="v"><b>${esc(hkMap[k] || '未设')}</b></span></div>`).join('')}
      <div class="kv"><span class="k">快捷键说明（本弹窗）</span><span class="v"><b>F1</b></span></div>
      <div class="kv"><span class="k">结算弹窗 · 确认收款</span><span class="v">回车</span></div>
      <div class="kv"><span class="k">结算弹窗 · 收款但不打小票</span><span class="v">空格</span></div>
      <div class="kv"><span class="k">购物车有商品时</span><span class="v">回车 = 直接结算</span></div>
      <div class="kv"><span class="k">收款成功弹窗</span><span class="v">回车 = 新的一单</span></div>
      <div class="hint">「改价 / 单品折扣」默认作用于<b>当前选中行</b>（点一下购物车行选中，再按快捷键）；未选则作用于最后一行。改价不得低于最低卖价、折扣不得低于最低折扣，越线需店长放行留痕。<br>键位可在「设置 → 快捷键自定义」修改（F1 固定）；改后立即生效，EXE 桌面端自动同步为全局键。F3/F5/F11/F12 为浏览器保留键，不建议设。</div></div>`;
    document.body.appendChild(m);
    m.querySelector('#csHkX').onclick = () => m.remove();
  }

  // ── 离线状态 ──
  function refreshStagedBadge() {
    const el = $('#csStaged');
    if (el) { const q = queueList(); el.textContent = `待补传 ${q.length} 笔`; }
    const ob = $('#csOffline');
    const netOk = navigator.onLine && !serverDown;
    if (ob) {
      ob.style.display = netOk ? 'none' : 'flex';
      const b = ob.querySelector('b');
      if (b) b.textContent = serverDown && navigator.onLine ? '服务器不可达（应急收银）' : '离线收银模式';
    }
    stockOnline = netOk;
  }
  /** VQA-D3：pos.heartbeat_timeout——收银端与服务器断联超过该时长弹窗引导应急收银。
   *  专治「WiFi 已连但路由器断/服务挂」：navigator.onLine 在此场景恒真，只有主动 ping 能发现 */
  async function hbProbe() {
    if (!active) { hbDownSince = 0; serverDown = false; return; }
    let ok = false;
    try {
      ok = await Promise.race([
        call('GET', '/health').then(() => true).catch(() => false),
        new Promise(r => setTimeout(() => r(false), 4000)),
      ]);
    } catch { ok = false; }
    if (ok) {
      if (serverDown) { serverDown = false; toast('服务器恢复：可正常收银，暂存单将自动补传'); flushQueue().catch(() => { }); }
      hbDownSince = 0;
    } else {
      if (!hbDownSince) hbDownSince = Date.now();
      else if (!serverDown && Date.now() - hbDownSince >= hbTimeoutSec * 1000) {
        serverDown = true;
        try {
          const m = document.createElement('div'); m.className = 'modal';
          m.innerHTML = `<div class="sheet"><h3>⚠️ 服务器不可达</h3>
            <div class="hint">已连店内网络，但连续 ${hbTimeoutSec} 秒无法连接收银服务器（常见原因：路由器断、服务未运行、网线松）。
            现金收款可先走「应急收银」：本单记账 + 自动暂存，恢复后补传；电子通道（扫码/券/余额）需服务器在线。</div>
            <button class="btn ok" id="csHbOk" style="width:100%;margin-top:10px">知道了，先按应急处理</button>
            <button class="cs-link" id="csHbRetry" style="width:100%;margin-top:8px;background:none;border:0;color:var(--ink-3);font-size:12px;cursor:pointer">立即重试连接</button></div>`;
          document.body.appendChild(m);
          m.querySelector('#csHbOk').onclick = () => m.remove();
          m.querySelector('#csHbRetry').onclick = () => { m.remove(); hbDownSince = 0; hbProbe(); };
        } catch { toast('服务器不可达：现金单可暂存补传（应急收银）'); }
      }
    }
    refreshStagedBadge();
  }
  setInterval(hbProbe, 5000); // 5s 一探测，阈值判定用 hbTimeoutSec（阈值到→弹窗一次，恢复→自动收起）
  window.addEventListener('online', () => { if (active) { refreshStagedBadge(); flushQueue(); toast('网络恢复：暂存单自动补传'); } });
  window.addEventListener('offline', () => { if (active) { refreshStagedBadge(); toast('网络断开：进入离线收银模式（现金记账）'); } });
  window.addEventListener('resize', () => { if (active) applyCompact(); });   // V4.22.0：视口变化重判紧凑模式

  // ── 进入 / 退出 ──
  async function enter() {
    if (active) { render(); return; }
    active = true;
    document.body.classList.add('cashier-mode');
    loadLC();             // V4.22.0：先读本机设置（卡片数/显示模式/本机小票机/客显串口）
    applyCompact();       // V4.22.0：低分辨率紧凑模式判定
    await loadSettings();
    if (!Pricebook.ready) await Pricebook.load();
    try { await Pricebook.sync(); } catch { /* 离线用缓存 */ }
    render();
    ensurePricebook().then(() => { if (active) { renderCats(); renderGrid(); renderQuick(); $('#csPbInfo') && ($('#csPbInfo').textContent = `（本地价目表 ${Pricebook.items.length} 条）`); } }).catch(() => { });
    refreshStock();
    refreshHeldBadge();   // V4.18.2：替代进入时一次性角标（取出/删除后也能刷新）
    await refreshShift(); // V4.18.4 批3：班次状态（顶栏时长/绿点）
    // V4.25.0 ① 登录即开班：进入收银台时若无进行中班次，强制弹「开班确认框」（收银员/机号/班次号/备用金，回车即开班）
    if (!shiftState || !shiftState.shift) openShiftStart({ fromLogin: true });
    startDayTick();       // V4.18.4 批3：跨零点日切提示
    syncPendingFromServer();   // V4.18.5 批4：半支付恢复——启动查漏服务端 PENDING 卡单
    syncExeHotkeys();     // V4.21.0 P16 批2：EXE 全局快捷键按当前映射注册
    startDispPing();      // V4.21.0：客显心跳（副屏连接灯）
    pushDisplay({ status: 'idle' }, true);
  }
  /** V4.24.0 ⑧：后台「挂单中」笔数——只算本人 / 本班（后端 scope=shift 过滤），
   *  别人的挂单不再把收银员锁死在收银台。查询失败→0：断网/离线时不能困死收银员。 */
  async function heldPendingCount() {
    try { const rows = await call('GET', '/pos/held?scope=shift'); return Array.isArray(rows) ? rows.length : 0; }
    catch { return 0; }
  }

  /** V4.24.0 ②：退班向导 —— 交接班（打印交接单）→ 日结（打印日报）→ 退出登录。
   *  每步都可「返回收银台」或「跳过」；「无异常，自动交班」= 实点即系统应答（差异 0）一键交班+打印。 */
  async function openExitWizard() {
    const m = document.createElement('div');
    m.className = 'modal-mask';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(15,25,18,.5);z-index:9998;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px)';
    document.body.appendChild(m);
    const close = () => m.remove();
    const H = t => '<div class="pc-head"><span class="pc-ico"><svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg></span><h3>' + esc(t) + '</h3></div>';
    const chip = n => `<div class="pc-hint" style="margin:0 0 8px">退班流程 · 第 ${n}/3 步</div>`;

    const doLogout = () => {
      // V4.25.8：退出前先清空副屏（避免下次登录显示上次购物车/会员缓存）
      try { pushDisplay({ status: 'idle', items: [], payable: 0, saved: 0, member: null, guide: '欢迎光临' }, true); } catch { }
      active = false;
      document.body.classList.remove('cashier-mode');
      clearInterval(window.__csClock);
      stack.length = 0;
      try { sessionStorage.setItem('pwa_cashier_exited', '1'); } catch { }
      let ok = true;
      try { logout(); } catch { ok = false; }
      if (!ok) openTab('work');   // 极端兜底：logout 异常时退回旧路径，不白屏
      toast('已退出登录；需要关闭程序请点登录界面右上角 ✕');
    };

    // ── 第 1 步：交接班 ──
    const step1 = async () => {
      let cur = null;
      try { cur = await call('GET', '/shifts/current'); } catch { cur = null; }
      const s = cur && cur.shift, sum = (cur && cur.summary) || {};
      if (!s) {
        m.innerHTML = `<div class="sheet pc-card">${H('退班 · 交接班')}${chip(1)}
          <div class="pc-body">当前<b>没有进行中的班次</b>，无需交接班，可直接进入日结。</div>
          <div class="pc-actions">${pcBtn('rwCancel', '返回收银台', 'ghost')}${pcBtn('rwNext', '下一步：日结', 'pri')}</div></div>`;
        m.querySelector('#rwCancel').onclick = close;
        m.querySelector('#rwNext').onclick = () => step2();
        return;
      }
      const total = Number(sum.cashboxTotal || 0);
      m.innerHTML = `<div class="sheet pc-card" style="width:min(470px,94vw)">${H('退班 · 交接班')}${chip(1)}
        <div class="pc-body">
          <div class="kv"><span class="k">班次 / 收银员</span><span class="v">#${s.id} · ${esc(s.cashier_name || '')}</span></div>
          <div class="kv"><span class="k">订单数 / 退款</span><span class="v">${sum.orderCount ?? 0} 单 / ${sum.refundCount ?? 0} 笔</span></div>
          <div class="kv"><span class="k"><b>应答金额（钱箱应有）</b></span><span class="v" style="font-size:17px;font-weight:800;color:var(--pri)">¥${money(total)}</span></div>
          <div class="field" style="margin-top:10px"><label>现金实点（清点钱箱现金）</label>
            <input id="rwCnt" class="mini-input" style="width:100%;padding:9px 12px" inputmode="decimal" value="${total.toFixed(2)}"></div>
          <div class="kv"><span class="k">差异（实点 − 应答）</span><span class="v"><b id="rwDiff" style="color:var(--ok)">¥0.00</b></span></div>
          <div class="field" id="rwReasonRow" style="display:none"><label>差异原因（超容差 ¥${money(shiftTol)} 必填）</label>
            <input id="rwReason" class="mini-input" style="width:100%;padding:9px 12px" maxlength="200" placeholder="如：找零误差 / 疑似少收已核查"></div>
          <div class="pc-hint">交班结「人」：确认后自动打印交接单并留档；「无异常」表示钱箱与系统应答一致。</div>
        </div>
        <div class="pc-actions">${pcBtn('rwCancel', '返回收银台', 'ghost')}${pcBtn('rwSkip', '无异常，自动交班', 'ghost')}${pcBtn('rwNext', '确认交班并打印', 'pri')}</div></div>`;
      const cnt = m.querySelector('#rwCnt'), diffEl = m.querySelector('#rwDiff'), row = m.querySelector('#rwReasonRow');
      const upd = () => {
        const d = (Number(cnt.value) || 0) - total;
        diffEl.textContent = (d >= 0 ? '+' : '-') + '¥' + money(Math.abs(d));
        diffEl.style.color = Math.abs(d) > shiftTol ? 'var(--bad)' : 'var(--ok)';
        row.style.display = Math.abs(d) > shiftTol ? '' : 'none';
      };
      cnt.addEventListener('input', upd); upd();
      m.querySelector('#rwCancel').onclick = close;
      m.querySelector('#rwSkip').onclick = () => doClose(total, '无异常（实点=系统应答）');
      m.querySelector('#rwNext').onclick = () => {
        const counted = Number(cnt.value);
        if (!Number.isFinite(counted)) { toast('请输入实点金额'); return; }
        const reason = (m.querySelector('#rwReason') || {}).value || '';
        if (Math.abs(counted - total) > shiftTol && !String(reason).trim()) { toast(`差异超容差 ¥${money(shiftTol)}，请填写差异原因`); return; }
        doClose(counted, reason);
      };
      async function doClose(counted, reason) {
        const ids = ['rwCancel', 'rwSkip', 'rwNext'];
        const setDis = on => ids.forEach(id => { const b = m.querySelector('#' + id); if (b) b.disabled = on; });
        setDis(true);
        const go = m.querySelector('#rwNext'); if (go) go.textContent = '交班中…';
        try {
          await shiftCloseAndPrint(s, counted, reason);
          toast('已交班并打印交接单');
        } catch (e) {
          toast('交班失败：' + (e.message || e));
          setDis(false); if (go) go.textContent = '确认交班并打印';
          return;
        }
        step2();
      }
    };

    // ── 第 2 步：日结（全店日报） ──
    const step2 = async () => {
      m.innerHTML = `<div class="sheet pc-card" style="width:min(470px,94vw)">${H('退班 · 日结')}${chip(2)}
        <div class="pc-body" id="rwDyBody"><div class="hint">正在汇总本日全店数据…</div></div>
        <div class="pc-actions">${pcBtn('rwBack', '上一步', 'ghost')}${pcBtn('rwDySkip', '跳过日结', 'ghost')}${pcBtn('rwDyGo', '打印日报并继续', 'pri')}</div></div>`;
      m.querySelector('#rwBack').onclick = () => step1();
      m.querySelector('#rwDySkip').onclick = () => step3();
      let data = null;
      try {
        const day = new Date(Date.now() - 8 * 3600e3).toISOString().slice(0, 10);
        data = await call('GET', '/pos/daily?date=' + day);
      } catch { data = null; }
      const body = m.querySelector('#rwDyBody');
      if (data) {
        const t = data.totals;
        body.innerHTML = `
          <div class="kv"><span class="k">营业额 / 成本 / 毛利</span><span class="v">¥${money(t.payable)} / ¥${money(t.cost)} / <b style="color:var(--ok)">¥${money(t.profit)}</b></span></div>
          <div class="kv"><span class="k">订单数 / 退款</span><span class="v">${t.orders} 单 / ${data.refunds.count} 笔 -¥${money(data.refunds.amount)}</span></div>
          <div class="pc-hint">日结结「店」：按自然日 + 支付完成时间归属，与个人班次无关。</div>`;
      } else {
        body.innerHTML = '<div class="hint">日结数据读取失败（断网或权限不足），可跳过后继续退出。</div>';
      }
      m.querySelector('#rwDyGo').onclick = async () => {
        const b = m.querySelector('#rwDyGo'); b.disabled = true; b.textContent = '打印中…';
        if (data) { try { await dailyPrint(data); toast('已打印营业日报'); } catch { toast('日报打印失败（不影响退出）'); } }
        step3();
      };
    };

    // ── 第 3 步：退出登录 ──
    const step3 = () => {
      m.innerHTML = `<div class="sheet pc-card">${H('退班 · 完成')}${chip(3)}
        <div class="pc-body">交接班与日结已处理完毕。确认<b>退出登录</b>返回登录界面？
          <div class="pc-hint">需要彻底关闭程序，请在登录界面点右上角 ✕。</div></div>
        <div class="pc-actions">${pcBtn('rwBack2', '返回收银台', 'ghost')}${pcBtn('rwDone', '退出登录', 'pri')}</div></div>`;
      m.querySelector('#rwBack2').onclick = close;
      m.querySelector('#rwDone').onclick = () => { close(); doLogout(); };
    };

    await step1();
  }

  async function exit(silent) {
    // ── V4.24.0 ⑧：只拦「本人/本班」的挂单（后端 scope=shift）——别人的挂单不再锁死收银员 ──
    if (!silent) {
      const held = await heldPendingCount();
      if (held > 0) {
        if (window.IS_DESKTOP) { toast(`你（本班）还有 ${held} 笔挂单未处理：请先「取单」结账或在取单列表删除后再退出`); return; }
        toast(`提示：你（本班）还有 ${held} 笔挂单未处理`);
      }
    }
    // ── V4.24.0 ②：桌面端（EXE）退出收银台 = 退班向导（交接班 → 日结 → 退出登录回登录页）──
    //  每步都有「返回收银台」，向导本身就是确认流程，不再叠加原生 confirm。
    //  浏览器/手机端行为完全不变（退到工作台，可随时再进）。
    if (window.IS_DESKTOP) {
      await openExitWizard();
      return;
    }
    active = false;
    document.body.classList.remove('cashier-mode');
    clearInterval(window.__csClock);
    stack.length = 0;
    try { sessionStorage.setItem('pwa_cashier_exited', '1'); } catch { }
    openTab('work');
    if (!silent) toast('已退出收银台（后台开关 pos.cashier.new_ui 可改默认直落）');
  }

  /** 登录直落判断：pos.cashier.new_ui=1（默认）且本班未手动退出 → 进收银台（H3 回退开关=0 走旧收银） */
  async function maybeEnter() {
    if (active || !ME) return;   // ME：app.js 顶层 let 全局（window.ME 不存在，不能写 window.ME）
    try { if (sessionStorage.getItem('pwa_cashier_exited') === '1') return; } catch { }
    try {
      const s = await call('GET', '/settings/key/' + encodeURIComponent('pos.cashier.new_ui'));
      const nv = s?.value;
      // V4.21.2：开关改 bool 落库（兼容旧 1/0 数字）
      if (nv === false || String(nv) === 'false' || Number(String(nv ?? '1').replace(/^"|"$/g, '')) === 0) return;
    } catch { /* 拉不到设置（罕见）：按默认开 */ }
    await enter();
  }

  return { enter, exit, maybeEnter, isActive: () => active, openStockQuery, openExitWizard };   // V4.24.0：库存查询/退班向导对外可调用（自动化实测与后续扩展）
})();

// 小工具兜底（cashier.js 独立可用：work.js 若未加载则本地实现）
if (typeof unwrap === 'undefined') {
  window.unwrap = d => Array.isArray(d) ? d : (d && Array.isArray(d.items) ? d.items : (d && Array.isArray(d.data) ? d.data : (d || [])));
}
if (typeof productById === 'undefined') {
  window.productById = async function (id) {
    try {
      const d = await call('GET', '/products/' + Number(id));
      const p = d && d.product ? d.product : d;
      return p ? { id: Number(p.id), name: p.name, barcode: p.barcode || '', spec: p.spec || '', unit: p.baseUnit || p.base_unit || '', sellPrice: Number(p.sellPrice ?? p.sell_price ?? 0), memberPrice: Number(p.memberPrice ?? p.member_price ?? 0) || 0, minPrice: p.minPrice ?? null, minDiscountRate: p.minDiscountRate ?? null, pinyin: p.pinyin_code || '' } : null;
    } catch { return null; }
  };
}
