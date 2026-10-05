package com.pos.cashier;

import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * V5.0.10
 *
 * registerPlugin 必须在 super.onCreate() 之前调用。
 *
 * 为何需要显式注册：Capacitor 只会自动注册 capacitor.plugins.json 里列出的插件，而那个
 * 文件由已安装的 npm 插件包生成。NativeScannerPlugin 是直接写在工程里的自定义插件
 * （不来自 npm），因此不会出现在该清单中，必须在此手动注册，否则
 * window.Capacitor.Plugins.NativeScanner 为 undefined，扫码会退到
 * BarcodeDetector / zxing-wasm 通道。
 *
 * ── V5.0.11k Android 返回键（真机 OPPO A1x 5G / Android 13 实测）──
 * 现象：按返回键或手势返回直接退出应用回桌面，而不是回到上一个页面/上一个标签。
 *
 * 根因：**Capacitor 6 的 BridgeActivity 里根本没有覆写 onBackPressed**（已核查
 * node_modules/@capacitor/android/.../BridgeActivity.java，全文无 onBackPressed）。
 * 在 targetSdk 33（Android 13+）上系统改用 OnBackPressedDispatcher，默认行为是
 * **finish 掉 Activity** —— WebView 的历史后退压根不会被调用。
 * 所以前端用 history.pushState 压的「返回栈」再严密也收不到事件（先前加的返回哨兵
 * 因此完全无效：popstate 永不触发）。
 *
 * 修法：在本 Activity 覆写 onKeyDown(KEYCODE_BACK) 与 onBackPressed，把返回键转成
 * WebView 的历史后退，由前端 app.js 的 popstate 处理器按优先级消费
 * （关弹窗 → 子页出栈 → 回首个标签 → 根页双击退出）；无历史可退时才退出应用。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeScannerPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // 物理返回键：优先走 WebView 历史（触发前端 popstate），无历史才退出
        if (keyCode == KeyEvent.KEYCODE_BACK && event != null && event.getAction() == KeyEvent.ACTION_DOWN) {
            WebView wv = (bridge != null) ? bridge.getWebView() : null;
            if (wv != null && wv.canGoBack()) {
                wv.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        // Android 13+ 的 OnBackPressedDispatcher 最终也会落到这里，逻辑同上
        WebView wv = (bridge != null) ? bridge.getWebView() : null;
        if (wv != null && wv.canGoBack()) {
            wv.goBack();
            return;
        }
        super.onBackPressed();
    }
}
