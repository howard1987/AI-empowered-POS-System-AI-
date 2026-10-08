package com.pos.cashier;

import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * V5.0.18g 硬件稳定设备标识（卸载重装不失联）。
 *
 * 背景：设备码/签名密钥原本存 WebView 的 IndexedDB/localStorage——APK 一旦卸载重装，
 * App 数据全部清空 → 设备码与密钥双丢 → 服务端视为全新设备，必须重新授权配对。
 *
 * 方案：Settings.Secure.ANDROID_ID——
 *   - Android 8.0+ 按「设备 + 用户 + 应用签名」生成，卸载重装保持不变；
 *   - 无需任何权限；仅恢复出厂设置（或极少数刷机场景）才会变化；
 *   - 由服务端配合「重装自动换绑签名公钥」（auth.module 验签失败 + 30 天活跃窗口 + 审计留痕），
 *     实现「硬件不变、授权不变」。
 */
@CapacitorPlugin(name = "DeviceIdentity")
public class DeviceIdentityPlugin extends Plugin {

    @PluginMethod
    public void getStableId(PluginCall call) {
        try {
            String androidId = Settings.Secure.getString(
                    this.bridge.getContext().getContentResolver(),
                    Settings.Secure.ANDROID_ID);
            JSObject ret = new JSObject();
            ret.put("androidId", androidId == null ? "" : androidId);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("androidId unavailable: " + e.getMessage());
        }
    }
}
