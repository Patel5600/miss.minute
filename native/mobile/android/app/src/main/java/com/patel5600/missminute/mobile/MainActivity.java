package com.patel5600.missminute.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final int REQUEST_TREE = 4101;
    private static final int REQUEST_NOTIFICATIONS = 4102;
    private SharedPreferences preferences;
    private TextView folderStatus;
    private TextView agentStatus;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        preferences = getSharedPreferences("miss_minutes_companion", MODE_PRIVATE);
        buildUi();
        refreshStatus();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        }
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(32, 48, 32, 32);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        TextView title = new TextView(this);
        title.setText("Miss Minutes Companion");
        title.setTextSize(24);
        root.addView(title);

        TextView disclosure = new TextView(this);
        disclosure.setText("Choose one folder explicitly. The agent records file names, sizes and modification times only. It never reads file contents, captures the screen, clipboard, microphone or keystrokes.");
        disclosure.setTextSize(14);
        root.addView(disclosure);

        folderStatus = new TextView(this);
        agentStatus = new TextView(this);
        root.addView(folderStatus);
        root.addView(agentStatus);

        Button choose = new Button(this);
        choose.setText("Choose monitored folder");
        choose.setOnClickListener(view -> chooseFolder());
        root.addView(choose);

        Button start = new Button(this);
        start.setText("Start foreground companion");
        start.setOnClickListener(view -> startAgent());
        root.addView(start);

        Button stop = new Button(this);
        stop.setText("Stop companion");
        stop.setOnClickListener(view -> stopAgent());
        root.addView(stop);

        setContentView(root);
    }

    private void chooseFolder() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(intent, REQUEST_TREE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_TREE || resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri tree = data.getData();
        final int takeFlags = data.getFlags()
                & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        getContentResolver().takePersistableUriPermission(tree, takeFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if (!DocumentsContract.isTreeUri(tree)) {
            folderStatus.setText("The selected URI is not a document tree.");
            return;
        }
        preferences.edit().putString("tree_uri", tree.toString()).apply();
        refreshStatus();
    }

    private void startAgent() {
        if (preferences.getString("tree_uri", null) == null) {
            folderStatus.setText("Choose a folder before starting the agent.");
            return;
        }
        preferences.edit().putBoolean("monitoring_enabled", true).apply();
        Intent service = new Intent(this, MetadataCompanionService.class);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service);
        else startService(service);
        refreshStatus();
    }

    private void stopAgent() {
        preferences.edit().putBoolean("monitoring_enabled", false).apply();
        stopService(new Intent(this, MetadataCompanionService.class));
        refreshStatus();
    }

    private void refreshStatus() {
        String tree = preferences.getString("tree_uri", null);
        folderStatus.setText(tree == null ? "No folder selected." : "Owner-selected folder is saved on this device.");
        agentStatus.setText(Boolean.TRUE.equals(preferences.getBoolean("monitoring_enabled", false))
                ? "Foreground session requested. The system may still stop services under resource or policy pressure."
                : "Companion session stopped.");
    }
}
