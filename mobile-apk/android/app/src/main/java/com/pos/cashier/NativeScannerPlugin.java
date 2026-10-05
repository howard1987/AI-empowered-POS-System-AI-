package com.pos.cashier;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.NotFoundException;
import com.google.zxing.RGBLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.security.KeyPair;
import java.security.KeyPairGenerator;   // AndroidKeyStore 的 RSA 走 KeyPairGenerator（javax.crypto.KeyGenerator 没有 initialize/generateKeyPair）
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * Native barcode decoding engine (V5.0.10).
 *
 * Why it exists: the APK excludes vendor/zxing-wasm (saves 3.1MB) and the other web
 * channel (BarcodeDetector) does not exist in every Android WebView - it is already
 * undefined on desktop Chrome/Edge. If both are missing, scanning dies entirely.
 * This plugin provides a third channel: ZXing core, which is pure Java.
 *
 * Why not ML Kit: the official Capacitor ML Kit plugin goes through Google Play
 * Services, which most Android devices in this market do not have. ZXing core has
 * no such dependency.
 *
 * Trade-off: this decodes frame-by-frame instead of showing a full-screen native
 * scanner UI. That lets it plug into the existing web scan pipeline (multi-pass,
 * custom ROI and grayscale preprocessing) without rewriting the front end. The cost
 * is one base64/JPEG IPC per frame, so the front end treats it as a fast first
 * attempt and falls back to the other engines on failure.
 */
@CapacitorPlugin(name = "NativeScanner")
public class NativeScannerPlugin extends Plugin {

    private static final Map<DecodeHintType, Object> HINTS = new EnumMap<>(DecodeHintType.class);

    static {
        HINTS.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        HINTS.put(DecodeHintType.CHARACTER_SET, "UTF-8");
    }

    /** Front-end probe: is the native channel usable (decides engine priority). */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", true);
        r.put("engine", "zxing-core");
        call.resolve(r);
    }

    /**
     * Decode one image. "image" is a data URL or raw base64 (PNG/JPEG).
     * "formats" is an optional string array (e.g. ["EAN_13","QR_CODE"]).
     */
    @PluginMethod
    public void analyze(PluginCall call) {
        long t0 = System.currentTimeMillis();
        String raw = call.getString("image", "");
        if (raw == null || raw.isEmpty()) {
            call.reject("image is empty");
            return;
        }
        try {
            int comma = raw.indexOf(",");
            String b64 = (raw.startsWith("data:") && comma > 0) ? raw.substring(comma + 1) : raw;
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bmp == null) { call.reject("cannot decode image"); return; }
            int w = bmp.getWidth(), h = bmp.getHeight();
            if (w <= 0 || h <= 0) { bmp.recycle(); call.reject("empty image"); return; }
            int[] pixels = new int[w * h];
            bmp.getPixels(pixels, 0, w, 0, 0, w, h);
            bmp.recycle();

            MultiFormatReader reader = new MultiFormatReader();
            List<BarcodeFormat> want = parseFormats(call.getArray("formats", null));
            Map<DecodeHintType, Object> effHints = HINTS;
            if (want != null && !want.isEmpty()) {
                effHints = new EnumMap<>(HINTS);
                effHints.put(DecodeHintType.POSSIBLE_FORMATS, want);
            }
            reader.setHints(effHints);

            BinaryBitmap bin = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(w, h, pixels)));
            JSObject codes = new JSObject();
            int n = 0;

            // Decode exactly ONE code per frame.
            //
            // Do NOT loop for "more": the image still contains the first barcode, so every
            // extra pass returns the SAME code (observed count=8 with 8 identical entries,
            // 8x the decode cost for nothing). A POS scan aims at a single barcode anyway,
            // and the next frame picks up anything else. zxing core 3.5.3 also no longer ships
            // decodeMultiple (it lives in the javase package, which we do not depend on).
            try {
                Result r = reader.decodeWithState(bin);
                if (r != null && r.getText() != null && !r.getText().isEmpty()) {
                    JSObject one = new JSObject();
                    one.put("text", r.getText());
                    one.put("format", r.getBarcodeFormat() == null ? "" : r.getBarcodeFormat().name());
                    codes.put("0", one);
                    n = 1;
                }
            } catch (NotFoundException miss) {
                // no barcode in this frame: normal, not an error
            }

            JSObject out = new JSObject();
            out.put("found", n > 0);
            out.put("count", n);
            out.put("codes", codes);
            out.put("ms", System.currentTimeMillis() - t0);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("native scan failed: " + e.getMessage());
        }
    }

    /**
     * P1 硬件级设备身份：用 Android Keystore 生成一对**不可导出**的 RSA 密钥，
     * 返回公钥（base64 SPKI）并提供对任意文本的签名能力。
     *
     * 为什么必须用 Keystore：设备码本身是客户端自报、可伪造的。Keystore 私钥在硬件/TEE 内，
     * extractable=false 时无法导出——即使把设备码抄到另一台手机也拿不到私钥，签名必然失败，
     * 服务端验签不过即拒绝登录。这才是真正防伪造的部分。
     *
     * 载荷格式与服务端 deviceSignPayload() 逐字节一致：{@code empNo|code|ts|nonce}
     */
    @PluginMethod
    public void deviceIdentity(PluginCall call) {
        try {
            final String alias = "pos_device_key_v1";
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            KeyPair kp = null;
            if (ks.containsAlias(alias)) {
                PrivateKey priv = (PrivateKey) ks.getKey(alias, null);
                java.security.cert.Certificate cert = ks.getCertificate(alias);
                if (priv != null && cert != null) {
                    kp = new KeyPair(cert.getPublicKey(), priv);
                } else {
                    ks.deleteEntry(alias);   // 密钥损坏（如 keystore 重置）→ 重建
                }
            }
            if (kp == null) {
                KeyPairGenerator kg = KeyPairGenerator.getInstance("RSA", "AndroidKeyStore");
                // 2048 位与浏览器端 WebCrypto 保持一致，服务端一套验签代码通吃两端
                kg.initialize(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                        .setDigests(KeyProperties.DIGEST_SHA256)
                        .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                        .setKeySize(2048)
                        .build());
                kp = kg.generateKeyPair();
            }
            JSObject r = new JSObject();
            r.put("pubkey", android.util.Base64.encodeToString(kp.getPublic().getEncoded(),
                    android.util.Base64.NO_WRAP));
            r.put("algo", "RSA-SHA256");
            r.put("source", "android-keystore");   // 硬件内不可导出，区别于浏览器 WebCrypto
            call.resolve(r);
        } catch (Exception e) {
            call.reject("keystore device identity failed: " + e.getMessage());
        }
    }

    /** 对 text 用 Keystore 私钥签名（SHA256withRSA），返回 base64 签名 */
    @PluginMethod
    public void deviceSign(PluginCall call) {
        try {
            String text = call.getString("text", "");
            String alias = "pos_device_key_v1";
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            PrivateKey priv = (PrivateKey) ks.getKey(alias, null);
            if (priv == null) { call.reject("keystore key not found"); return; }
            Signature sig = Signature.getInstance("SHA256withRSA");
            sig.initSign(priv);
            sig.update(text.getBytes("UTF-8"));
            JSObject r = new JSObject();
            r.put("sig", android.util.Base64.encodeToString(sig.sign(), android.util.Base64.NO_WRAP));
            r.put("algo", "RSA-SHA256");
            call.resolve(r);
        } catch (Exception e) {
            call.reject("device sign failed: " + e.getMessage());
        }
    }

    /**
     * V5.0.11e 设备显示名：让「授权设备」列表显示真实手机名（如 vivo X100）而不是「Android 设备」。
     *
     * 浏览器拿不到设备友好名称（那是隐私保护 API），但原生可以：
     *   ① Settings.Global.DEVICE_NAME —— 用户在系统设置里自己设的设备名，API 25+ 免权限可读，最贴近「我的手机」；
     *   ② Build.MODEL + Build.MANUFACTURER —— 兜底，如「vivo V2309A」；
     *   ③ Settings.Global.BLUETOOTH_NAME —— 部分机型 DEVICE_NAME 为空时用这个。
     * 三者都拿不到就返回空串，前端会退到 UA 机型识别。
     */
    @PluginMethod
    public void deviceName(PluginCall call) {
        JSObject r = new JSObject();
        String name = "";
        String source = "";
        try {
            android.content.ContentResolver cr = getContext().getContentResolver();
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N_MR1) {
                String dn = android.provider.Settings.Global.getString(cr, android.provider.Settings.Global.DEVICE_NAME);
                if (dn != null && !dn.trim().isEmpty()) { name = dn.trim(); source = "device_name"; }
                if (name.isEmpty()) {
                    // 注意：Settings.Global 没有 BLUETOOTH_NAME 常量（编译不过），
                    // 但底层 key 就是字符串 "bluetooth_name"，部分机型 DEVICE_NAME 为空时它有值。
                    String bn = android.provider.Settings.Global.getString(cr, "bluetooth_name");
                    if (bn != null && !bn.trim().isEmpty()) { name = bn.trim(); source = "bluetooth_name"; }
                }
            }
        } catch (Exception e) {
            // 部分定制 ROM 读 Settings.Global 会抛 SecurityException，忽略即可，后面有兜底
        }
        if (name.isEmpty()) {
            String mf = android.os.Build.MANUFACTURER == null ? "" : android.os.Build.MANUFACTURER;
            String mo = android.os.Build.MODEL == null ? "" : android.os.Build.MODEL;
            if (!mf.isEmpty() || !mo.isEmpty()) {
                // 小米/红米/红魔的 MANUFACTURER 是 Xiaomi/Redmi，型号自带品牌，去重避免「Xiaomi M2102K1AC」
                if (!mf.isEmpty() && mo.toLowerCase().startsWith(mf.toLowerCase())) name = mo;
                else if (mf.equalsIgnoreCase("Xiaomi") && mo.startsWith("MI")) name = mo;
                else name = (mf.isEmpty() ? mo : mf + " " + mo);
                name = name.trim();
                source = "build";
            }
        }
        r.put("name", name);
        r.put("source", source);
        r.put("model", android.os.Build.MODEL == null ? "" : android.os.Build.MODEL);
        r.put("manufacturer", android.os.Build.MANUFACTURER == null ? "" : android.os.Build.MANUFACTURER);
        r.put("sdk", android.os.Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    /** Map the front-end format names to ZXing enums; null/empty means "all formats". */
    private static List<BarcodeFormat> parseFormats(JSArray arr) {
        if (arr == null) return null;
        List<BarcodeFormat> out = new ArrayList<>();
        java.util.List<?> names;
        try {
            names = arr.toList();          // JSArray.toList() throws the checked JSONException
        } catch (Exception e) {
            return null;
        }
        if (names == null) return null;
        for (Object o : names) {
            if (o == null) continue;
            try { out.add(BarcodeFormat.valueOf(String.valueOf(o).trim().toUpperCase())); }
            catch (IllegalArgumentException ignore) { }
        }
        return out;
    }
}
