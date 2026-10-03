/* 日历范围选择器：
 * 自动把页面里成对的「开始日期 / 结束日期」输入（id 形如 XFrom + XTo，或 开始+结束、起始+截止）
 * 升级为一个日历范围控件——一次在日历上点选起止，即可选出完整时间范围。
 * 原 <input type="date"> 仅改为隐藏（保留 id 与 value），因此所有既有的查询函数（读 .value）无需改动。
 * 单日期输入（无对应 To 字段）不受影响，仍可用浏览器原生日期选择。
 * 通过 MutationObserver 自动覆盖动态渲染的屏幕，无需逐屏改造。 */
(function () {
  'use strict';

  if (!document.getElementById('drp-style')) {
    var st = document.createElement('style');
    st.id = 'drp-style';
    st.textContent = [
      '.drp{position:relative;display:inline-block;vertical-align:middle}',
      '.drp-trigger{font:inherit;font-size:13px;line-height:1.4;padding:6px 10px;border:1px solid var(--line,#e3ddcf);border-radius:8px;background:#fff;color:var(--ink,#222);cursor:pointer;white-space:nowrap}',
      '.drp-trigger.empty{color:var(--ink-3,#9a9486)}',
      '.drp-trigger:hover{border-color:var(--pri,#2f7d4f)}',
      '.drp-pop{position:absolute;top:calc(100% + 4px);left:0;z-index:99999;background:#fff;border:1px solid var(--line,#e3ddcf);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:10px;max-width:calc(100vw - 20px)}',
      '.drp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}',
      '.drp-nav{font:inherit;width:28px;height:28px;border:1px solid var(--line,#e3ddcf);border-radius:6px;background:#fff;cursor:pointer;color:var(--ink,#222)}',
      '.drp-nav:hover{border-color:var(--pri,#2f7d4f)}',
      '.drp-hint{font-size:12px;color:var(--ink-3,#9a9486)}',
      '.drp-months{display:flex;gap:16px;overflow-x:auto}',
      '.drp-month{min-width:210px}',
      '.drp-mtitle{font-size:12.5px;font-weight:600;text-align:center;margin-bottom:4px;color:var(--ink,#222)}',
      '.drp-grid{display:grid;grid-template-columns:repeat(7,30px);gap:2px}',
      '.drp-wd{text-align:center;font-size:11px;color:var(--ink-3,#9a9486);padding:2px 0}',
      '.drp-cell{text-align:center;font-size:12.5px;line-height:28px;height:28px;border-radius:6px;cursor:pointer;color:var(--ink,#222)}',
      '.drp-cell:hover{background:#f1f5f9}',
      '.drp-cell.out{color:#cbc6ba}',
      '.drp-cell.in{background:#eaf3ff;color:#1c5fbf}',
      '.drp-cell.sel{background:var(--pri,#2f7d4f);color:#fff;font-weight:600}',
      '.drp-cell.sel.in{color:#fff}',
      '.drp-bar{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center}',
      '.drp-preset{font:inherit;font-size:12px;padding:4px 9px;border:1px solid var(--line,#e3ddcf);border-radius:14px;background:#fff;cursor:pointer;color:var(--ink,#222)}',
      '.drp-preset:hover{border-color:var(--pri,#2f7d4f)}',
      '.drp-ok{font:inherit;font-size:12px;padding:4px 14px;border:1px solid var(--pri,#2f7d4f);border-radius:14px;background:var(--pri,#2f7d4f);color:#fff;cursor:pointer;margin-left:auto}',
      '.drp-mtitle{cursor:pointer;user-select:none}',
      '.drp-mtitle:hover{color:var(--pri,#2f7d4f);text-decoration:underline}',
      '.drp-grid.pick{grid-template-columns:repeat(3,1fr);padding:2px 8px;gap:4px}',
      '.drp-grid.pick .drp-cell{height:32px;line-height:32px;font-size:12.5px;border-radius:8px}',
      '@media (max-width:640px){',
      '  .drp-pop{width:min(360px,calc(100vw - 16px));max-width:none;left:auto;right:0}',
      '  .drp-months{flex-direction:column;gap:10px}',
      '  .drp-month{min-width:0;width:100%}',
      '  .drp-month:nth-child(2){display:none}',
      '  .drp-grid{grid-template-columns:repeat(7,1fr)}',
      '  .drp-cell{height:38px;line-height:38px;font-size:14px}',
      '  .drp-wd{padding:4px 0}',
      '}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parse(s) { if (!s) return null; var p = String(s).split('-'); if (p.length < 3) return null; return new Date(+p[0], +p[1] - 1, +p[2]); }
  function today() { return fmt(new Date()); }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  function sameDay(a, b) { return a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function firstOfMonth(s) { var d = parse(s) || new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }
  var WD = ['一', '二', '三', '四', '五', '六', '日'];

  /* 区间快捷预设：f() 返回 [起始, 结束]。默认集用于普通屏幕；
     某屏可用 data-drp-presets="m,lm,q,h1" 指定自定义集（键名逗号分隔），如对账单。 */
  var PRESETS = {
    today: { t: '今天', f: function () { var d = new Date(); return [fmt(d), fmt(d)]; } },
    yday:  { t: '昨天', f: function () { var d = new Date(); d.setDate(d.getDate() - 1); return [fmt(d), fmt(d)]; } },
    d7:    { t: '近7天', f: function () { var d = new Date(), s = new Date(d); s.setDate(d.getDate() - 6); return [fmt(s), fmt(d)]; } },
    d30:   { t: '近30天', f: function () { var d = new Date(), s = new Date(d); s.setDate(d.getDate() - 29); return [fmt(s), fmt(d)]; } },
    m:     { t: '本月', f: function () { var d = new Date(); return [fmt(new Date(d.getFullYear(), d.getMonth(), 1)), fmt(d)]; } },
    lm:    { t: '上月', f: function () { var d = new Date(); return [fmt(new Date(d.getFullYear(), d.getMonth() - 1, 1)), fmt(new Date(d.getFullYear(), d.getMonth(), 0))]; } },
    q:     { t: '上季度', f: function () { var d = new Date(), y = d.getFullYear(), qi = Math.floor(d.getMonth() / 3); if (qi === 0) { y -= 1; qi = 4; } return [fmt(new Date(y, (qi - 1) * 3, 1)), fmt(new Date(y, (qi - 1) * 3 + 3, 0))]; } },
    h1:    { t: '上半年', f: function () { var y = new Date().getFullYear(); return [fmt(new Date(y, 0, 1)), fmt(new Date(y, 5, 30))]; } },
  };
  var DEFAULT_PRESETS = ['today', 'yday', 'd7', 'd30', 'm', 'lm'];

  function monthCells(year, month) {
    var first = new Date(year, month, 1);
    var startDow = (first.getDay() + 6) % 7; // 周一为首列
    var cur = new Date(year, month, 1 - startDow);
    var days = [];
    for (var i = 0; i < 42; i++) { days.push(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate())); cur.setDate(cur.getDate() + 1); }
    return days;
  }

  function initDateRanges(root) {
    root = root || document;
    if (!root || !root.querySelectorAll) return;
    var inputs = root.querySelectorAll('input[type="date"]');
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (inp.dataset.drp) continue;
      var id = inp.id || '';
      var m = id.match(/(From|from|开始|起始)$/);
      if (!m) continue;
      var tail = m[1];
      var map = { From: 'To', from: 'to', '开始': '结束', '起始': '截止' };
      var endId = id.slice(0, id.length - tail.length) + map[tail];
      var end = document.getElementById(endId);
      if (!end || end.type !== 'date' || end.dataset.drp) continue;
      upgradeRange(inp, end);
    }
  }

  function hideConnector(from, to) {
    var parents = [from.parentElement, to.parentElement];
    parents.forEach(function (p) {
      if (!p) return;
      var cn = p.childNodes;
      for (var i = 0; i < cn.length; i++) {
        var n = cn[i];
        if (n === from || n === to) continue;
        if (n.nodeType === 3) {
          var tx = n.textContent.trim();
          if (tx === '至' || tx === '~') n.textContent = '';
        } else if (n.nodeType === 1) {
          var t = (n.textContent || '').trim();
          if (t === '至' || t === '~') n.style.display = 'none';
        }
      }
    });
  }

  function upgradeRange(from, to) {
    from.dataset.drp = '1'; to.dataset.drp = '1';
    hideConnector(from, to);
    var wrap = document.createElement('span'); wrap.className = 'drp';
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'drp-trigger empty';
    var pop = document.createElement('div'); pop.className = 'drp-pop'; pop.hidden = true;
    wrap.appendChild(btn); wrap.appendChild(pop);
    from.parentElement.insertBefore(wrap, from);
    from.type = 'hidden'; to.type = 'hidden';

    var _vm0 = firstOfMonth(from.value || today());
    // 左月默认本月、右月默认上月（V5.0.8）
    var st = { start: from.value || '', end: to.value || '', vmL: _vm0, vmR: addMonths(_vm0, -1), pickMode: null, pickYear: _vm0.getFullYear() };
    // 快捷预设：默认集；该屏可用 data-drp-presets="键,键" 覆盖（对账单用 m,lm,q,h1）
    var presetKeys = DEFAULT_PRESETS;
    if (from.dataset.drpPresets) {
      var ks = String(from.dataset.drpPresets).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return PRESETS[x]; });
      if (ks.length) presetKeys = ks;
    }

    function syncTrigger() {
      if (st.start && st.end) btn.textContent = st.start + '  ~  ' + st.end;
      else if (st.start) btn.textContent = st.start + '  ~  结束日期';
      else btn.textContent = '开始日期  ~  结束日期';
      btn.classList.toggle('empty', !(st.start && st.end));
    }
    function onDoc(e) { if (!wrap.contains(e.target)) { pop.hidden = true; document.removeEventListener('click', onDoc, true); } }
    function openPop() { pop.hidden = false; renderCal(); setTimeout(function () { document.addEventListener('click', onDoc, true); }, 0); }
    function closePop() { pop.hidden = true; document.removeEventListener('click', onDoc, true); }
    function commit() { from.value = st.start; to.value = st.end; syncTrigger(); closePop(); }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hidden) openPop(); else closePop();
    });

    function renderCal() {
      pop.innerHTML = '';
      var head = document.createElement('div'); head.className = 'drp-head';
      var prev = document.createElement('button'); prev.type = 'button'; prev.className = 'drp-nav'; prev.textContent = '‹';
      var hint = document.createElement('div'); hint.className = 'drp-hint';
      var next = document.createElement('button'); next.type = 'button'; next.className = 'drp-nav'; next.textContent = '›';
      var inYearMode = (st.pickMode === 'L' || st.pickMode === 'R');
      if (inYearMode) {
        hint.textContent = st.pickYear + ' 年 · 点选月份快速跳转';
        prev.onclick = function (e) { e.stopPropagation(); st.pickYear -= 1; renderCal(); };
        next.onclick = function (e) { e.stopPropagation(); st.pickYear += 1; renderCal(); };
      } else {
        hint.textContent = '点选起止日期 · ‹左月 ›右月 · 点年月选年';
        prev.onclick = function (e) { e.stopPropagation(); st.vmL = addMonths(st.vmL, -1); renderCal(); };  // 只动左月
        next.onclick = function (e) { e.stopPropagation(); st.vmR = addMonths(st.vmR, 1); renderCal(); };    // 只动右月
      }
      head.appendChild(prev); head.appendChild(hint); head.appendChild(next);
      pop.appendChild(head);

      if (inYearMode) {
        var ywrap = document.createElement('div'); ywrap.className = 'drp-month';
        var mg = document.createElement('div'); mg.className = 'drp-grid pick';
        for (var mi = 0; mi < 12; mi++) {
          (function (idx) {
            var c = document.createElement('span'); c.className = 'drp-cell';
            c.textContent = (idx + 1) + '月';
            var cur = (st.pickMode === 'L' ? st.vmL : st.vmR);
            if (cur.getFullYear() === st.pickYear && cur.getMonth() === idx) c.className += ' sel';
            c.onclick = function (e) {
              e.stopPropagation();
              var target = new Date(st.pickYear, idx, 1);
              if (st.pickMode === 'L') st.vmL = target; else st.vmR = target;
              st.pickMode = null; renderCal();
            };
            mg.appendChild(c);
          })(mi);
        }
        ywrap.appendChild(mg);
        var yback = document.createElement('button'); yback.type = 'button'; yback.className = 'drp-preset'; yback.textContent = '返回日历';
        yback.style.marginTop = '6px';
        yback.onclick = function (e) { e.stopPropagation(); st.pickMode = null; renderCal(); };
        ywrap.appendChild(yback);
        pop.appendChild(ywrap);
        return;   // 年月视图不显示日历与预设
      }

      var mwrap = document.createElement('div'); mwrap.className = 'drp-months';
      var months = [st.vmL, st.vmR];
      var sD = parse(st.start), eD = parse(st.end);
      months.forEach(function (mv, side) {
        var mc = document.createElement('div'); mc.className = 'drp-month';
        var mt = document.createElement('div'); mt.className = 'drp-mtitle';
        mt.textContent = mv.getFullYear() + '年' + (mv.getMonth() + 1) + '月';
        mt.title = '点击快速选择年份 / 月份';
        mt.onclick = function (e) { e.stopPropagation(); st.pickMode = side === 0 ? 'L' : 'R'; st.pickYear = mv.getFullYear(); renderCal(); };
        mc.appendChild(mt);
        var g = document.createElement('div'); g.className = 'drp-grid';
        WD.forEach(function (w) { var c = document.createElement('span'); c.className = 'drp-wd'; c.textContent = w; g.appendChild(c); });
        monthCells(mv.getFullYear(), mv.getMonth()).forEach(function (d) {
          var c = document.createElement('span'); c.className = 'drp-cell';
          c.textContent = d.getDate();
          var dM = d.getMonth();
          if (dM !== mv.getMonth()) c.className += ' out';
          if (sameDay(d, sD)) c.className += ' sel';
          else if (sameDay(d, eD)) c.className += ' sel';
          else if (sD && eD && d > sD && d < eD) c.className += ' in';
          c.onclick = function (e) { e.stopPropagation(); pick(fmt(d)); };
          g.appendChild(c);
        });
        mc.appendChild(g); mwrap.appendChild(mc);
      });
      pop.appendChild(mwrap);

      var bar = document.createElement('div'); bar.className = 'drp-bar';
      presetKeys.forEach(function (k) {
        var p = PRESETS[k]; if (!p) return;
        var b = document.createElement('button'); b.type = 'button'; b.className = 'drp-preset'; b.textContent = p.t;
        b.onclick = function (e) { e.stopPropagation(); var r = p.f(); st.start = r[0]; st.end = r[1]; commit(); };
        bar.appendChild(b);
      });
      var clear = document.createElement('button'); clear.type = 'button'; clear.className = 'drp-preset'; clear.textContent = '清空';
      clear.onclick = function (e) { e.stopPropagation(); st.start = ''; st.end = ''; commit(); };
      bar.appendChild(clear);
      var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'drp-ok'; ok.textContent = '确定';
      ok.onclick = function (e) { e.stopPropagation(); commit(); };
      bar.appendChild(ok);
      pop.appendChild(bar);

      function pick(dateStr) {
        if (!st.start || (st.start && st.end)) { st.start = dateStr; st.end = ''; }
        else if (dateStr < st.start) st.start = dateStr;
        else st.end = dateStr;
        if (st.start && st.end) commit();
        else renderCal();
      }
    }
    syncTrigger();
  }

  window.initDateRanges = initDateRanges;
  function run(root) { try { initDateRanges(root); } catch (e) { /* 静默 */ } }
  if (document.readyState !== 'loading') run(document);
  else document.addEventListener('DOMContentLoaded', function () { run(document); });

  if (typeof MutationObserver !== 'undefined') {
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          run(n);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
})();
