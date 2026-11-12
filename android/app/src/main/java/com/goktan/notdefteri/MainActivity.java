package com.goktan.notdefteri;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NotDefteriPlugin.class);
        super.onCreate(savedInstanceState);

        // Geri tuşu / kenardan kaydırma: uygulamayı kapatmak yerine sayfanın geçmişinde geri gider
        // (defteri kapatır, klasörlerden birer birer çıkar). Kitaplığın en başındayken uygulama kapanır.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web != null && web.canGoBack()) {
                    web.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        });
    }
}
