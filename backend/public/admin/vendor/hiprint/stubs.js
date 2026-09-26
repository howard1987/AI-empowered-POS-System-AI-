/**
 * hiprint 运行时桩（V4.15.9）：
 *   vue-plugin-hiprint UMD 依赖全局 jQuery / JsBarcode / bwip-js / io / jspdf / canvg。
 *   设计器只用到前两个；其余给出无害桩，避免加载报错（导出PDF/客户端打印等未搬入）。
 *   加载顺序：stubs.js → jquery.min.js → JsBarcode.all.min.js → vue-plugin-hiprint.js
 */
(function () {
  'use strict';
  // socket.io-client 桩（electron 客户端打印用，本地部署不存在）。
  // 注意：hiprint 加载时会执行 window.io = 外部模块.io（取桩的 .io 属性），桩必须自引用防覆盖
  function ioStub() {
    return {
      on: function () { }, once: function () { }, off: function () { }, emit: function () { },
      connect: function () { }, disconnect: function () { }, close: function () { }, connected: false,
    };
  }
  ioStub.io = ioStub; ioStub.default = ioStub; ioStub.connect = ioStub;
  if (!window.__hiprintIoStub) window.__hiprintIoStub = ioStub;
  window.io = ioStub;
  // bwip-js 桩（扩展码制，设计器预览走 JsBarcode 已覆盖常用条码）
  if (!window['bwip-js']) window['bwip-js'] = { toSVG: function () { throw new Error('bwip-js 未启用'); } };
  // jspdf / canvg / html2canvas 桩（导出 PDF / 图片快照功能未启用）
  if (!window.jspdf) window.jspdf = { jsPDF: function () { throw new Error('PDF 导出未启用'); } };
  if (!window.canvg) window.canvg = function () { };
  if (!window.html2canvas) window.html2canvas = function () { return Promise.reject(new Error('html2canvas 未启用')); };
})();
