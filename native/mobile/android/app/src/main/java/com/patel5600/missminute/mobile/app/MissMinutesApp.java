package com.patel5600.missminute.mobile.app;

import android.app.Application;
import android.content.Context;
import android.content.Intent;

import com.patel5600.missminute.mobile.BuildConfig;
import com.patel5600.missminute.mobile.MetadataCompanionService;
import com.patel5600.missminute.mobile.core.Clock;
import com.patel5600.missminute.mobile.core.audit.AuditLog;
import com.patel5600.missminute.mobile.core.kill.KillCore;
import com.patel5600.missminute.mobile.core.kill.KillStateStore;
import com.patel5600.missminute.mobile.core.kill.Killable;
import com.patel5600.missminute.mobile.core.policy.PermissionStore;
import com.patel5600.missminute.mobile.kill.KillSwitch;
import com.patel5600.missminute.mobile.overlay.OverlayService;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * The process-wide singletons, built on first use: settings, permission state, kill state, audit log
 * and the kill switch. State files live under {@code getFilesDir()/state/}.
 */
public final class MissMinutesApp extends Application {
    public static final Clock CLOCK = System::currentTimeMillis;

    private Settings settings;
    private PermissionStore permissionStore;
    private KillStateStore killStateStore;
    private AuditLog auditLog;
    private KillSwitch killSwitch;

    public static MissMinutesApp from(Context context) {
        return (MissMinutesApp) context.getApplicationContext();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Notifications.createChannels(this);
        if (BuildConfig.DEBUG) {
            new MainThreadWatchdog().start();
        }
    }

    private File stateFile(String name) {
        File dir = new File(getFilesDir(), "state");
        if (!dir.isDirectory()) {
            dir.mkdirs();
        }
        return new File(dir, name);
    }

    public synchronized Settings settings() {
        if (settings == null) {
            settings = new Settings(this);
        }
        return settings;
    }

    public synchronized PermissionStore permissionStore() {
        if (permissionStore == null) {
            permissionStore = new PermissionStore(stateFile("permissions.json"));
        }
        return permissionStore;
    }

    public synchronized KillStateStore killStateStore() {
        if (killStateStore == null) {
            killStateStore = new KillStateStore(stateFile("kill-state.json"));
        }
        return killStateStore;
    }

    public synchronized AuditLog auditLog() {
        if (auditLog == null) {
            auditLog = new AuditLog(stateFile("audit.jsonl"), CLOCK);
        }
        return auditLog;
    }

    public synchronized KillSwitch killSwitch() {
        if (killSwitch == null) {
            killSwitch = new KillSwitch(killStateStore(), auditLog(), CLOCK, alwaysThereKillables());
        }
        return killSwitch;
    }

    /**
     * What a kill must do even when no component is alive to register itself. Labels go to the audit
     * log, so they are fixed words. Alarms the owner set are not touched.
     */
    private List<Killable> alwaysThereKillables() {
        final Context app = this;
        List<Killable> list = new ArrayList<>();
        list.add(KillSwitch.killable("overlay-service", new KillSwitch.Action() {
            @Override
            public void run() {
                app.stopService(new Intent(app, OverlayService.class));
            }
        }));
        list.add(KillSwitch.killable("metadata-service", new KillSwitch.Action() {
            @Override
            public void run() {
                app.getSharedPreferences("miss_minutes_companion", Context.MODE_PRIVATE).edit()
                        .putBoolean("monitoring_enabled", false).commit();
                app.stopService(new Intent(app, MetadataCompanionService.class));
            }
        }));
        list.add(KillSwitch.killable("notification", new KillSwitch.Action() {
            @Override
            public void run() {
                Notifications.cancelOverlayNotifications(app);
            }
        }));
        list.add(KillSwitch.killable("settings", new KillSwitch.Action() {
            @Override
            public void run() {
                settings().setDesiredRunning(false);
            }
        }));
        list.add(KillSwitch.killable("permissions", new KillSwitch.Action() {
            @Override
            public void run() throws Exception {
                permissionStore().save(KillCore.applyAfterKill(permissionStore().load()));
            }
        }));
        return list;
    }
}
