package com.goktan.notdefteri;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Uygulamanın Android tarafı:
 *  - Başka uygulamalardan "Şununla aç" / "Paylaş" ile gelen PDF'leri alır, web tarafına verir.
 *  - Web tarafının hazırladığı dosyaları (yedek, PDF) İndirilenler'e kaydeder ya da paylaşır.
 *    (Uygulamanın içindeki tarayıcı dosya indirmeyi ve paylaşmayı kendisi yapamıyor.)
 */
@CapacitorPlugin(name = "NotDefteri")
public class NotDefteriPlugin extends Plugin {
    private static final String HANDLED = "nd_handled";
    private final List<JSObject> pending = new ArrayList<>();

    @Override
    public void load() {
        Intent intent = getActivity().getIntent();
        // Son uygulamalar ekranından açılınca Android eski isteği yeniden verir; aynı PDF iki kez eklenmesin.
        if (intent != null && (intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) {
            handleIntent(intent);
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent.getBooleanExtra(HANDLED, false)) return;
        List<Uri> uris = new ArrayList<>();
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return;
        intent.putExtra(HANDLED, true);
        // Dosyayı uygulamanın kendi alanına kopyala: gönderen uygulamanın verdiği izin kısa ömürlü.
        new Thread(() -> {
            for (Uri uri : uris) {
                try {
                    File dir = new File(getContext().getCacheDir(), "incoming");
                    dir.mkdirs();
                    File out = new File(dir, UUID.randomUUID() + ".pdf");
                    try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                         OutputStream os = new FileOutputStream(out)) {
                        copy(in, os);
                    }
                    JSObject f = new JSObject();
                    f.put("path", out.getAbsolutePath());
                    f.put("name", displayName(uri));
                    synchronized (pending) {
                        pending.add(f);
                    }
                } catch (Exception e) {
                    android.util.Log.e("NotDefteri", "PDF alınamadı", e);
                }
            }
            bridge.triggerWindowJSEvent("ndIncoming");
        }).start();
    }

    private String displayName(Uri uri) {
        String name = null;
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
            }
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "Belge.pdf";
        return name;
    }

    /** Bekleyen gelen PDF'leri verir ve listeyi boşaltır. */
    @PluginMethod
    public void take(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (pending) {
            for (JSObject f : pending) arr.put(f);
            pending.clear();
        }
        JSObject r = new JSObject();
        r.put("files", arr);
        call.resolve(r);
    }

    /** Kitaplığa eklenen gelen PDF'in geçici kopyasını siler. */
    @PluginMethod
    public void done(PluginCall call) {
        File f = new File(call.getString("path", ""));
        File dir = new File(getContext().getCacheDir(), "incoming");
        if (dir.equals(f.getParentFile())) f.delete();
        call.resolve();
    }

    /* ---- Dışarı dosya verme: parça parça yazılır, sonra kaydedilir ya da paylaşılır ---- */

    private File outDir() {
        File dir = new File(getContext().getCacheDir(), "out");
        dir.mkdirs();
        return dir;
    }

    private File outFile(PluginCall call) {
        File f = new File(call.getString("path", ""));
        return outDir().equals(f.getParentFile()) ? f : null;
    }

    @PluginMethod
    public void fileStart(PluginCall call) {
        File dir = outDir();
        File[] old = dir.listFiles();
        if (old != null) for (File o : old) o.delete();
        String name = call.getString("name", "dosya").replaceAll("[\\\\/:*?\"<>|]+", " ").trim();
        if (name.isEmpty()) name = "dosya";
        File f = new File(dir, name);
        JSObject r = new JSObject();
        r.put("path", f.getAbsolutePath());
        call.resolve(r);
    }

    @PluginMethod
    public void fileAppend(PluginCall call) {
        File f = outFile(call);
        if (f == null) {
            call.reject("Geçersiz dosya");
            return;
        }
        try (FileOutputStream os = new FileOutputStream(f, true)) {
            os.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception e) {
            call.reject("Dosya yazılamadı: " + e.getMessage());
        }
    }

    @PluginMethod
    public void fileFinish(PluginCall call) {
        File f = outFile(call);
        if (f == null || !f.exists()) {
            call.reject("Dosya bulunamadı");
            return;
        }
        String mime = call.getString("mime", "application/octet-stream");
        try {
            if ("share".equals(call.getString("mode"))) {
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                Intent chooser = Intent.createChooser(send, f.getName());
                chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(chooser);
                call.resolve();
            } else {
                saveToDownloads(f, mime);
                f.delete();
                call.resolve();
            }
        } catch (Exception e) {
            call.reject("Kaydedilemedi: " + e.getMessage());
        }
    }

    private void saveToDownloads(File f, String mime) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw new Exception("Bu Android sürümünde desteklenmiyor");
        ContentResolver cr = getContext().getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, f.getName());
        v.put(MediaStore.Downloads.MIME_TYPE, mime);
        v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        v.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new Exception("İndirilenler klasörüne yazılamadı");
        try (InputStream in = new FileInputStream(f); OutputStream os = cr.openOutputStream(uri)) {
            copy(in, os);
        } catch (Exception e) {
            cr.delete(uri, null, null);
            throw e;
        }
        v.clear();
        v.put(MediaStore.Downloads.IS_PENDING, 0);
        cr.update(uri, v, null, null);
    }

    private static void copy(InputStream in, OutputStream os) throws Exception {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
    }
}
