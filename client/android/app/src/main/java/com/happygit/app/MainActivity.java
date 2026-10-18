package com.happygit.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.happygit.app.nativebridge.HappyGitPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HappyGitPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
