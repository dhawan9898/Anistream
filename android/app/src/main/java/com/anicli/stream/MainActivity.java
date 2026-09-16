package com.anicli.stream;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void load() {
        super.load();
        if (bridge != null) {
            bridge.setWebViewClient(new AnimeStreamWebViewClient(bridge));
        }
    }
}
