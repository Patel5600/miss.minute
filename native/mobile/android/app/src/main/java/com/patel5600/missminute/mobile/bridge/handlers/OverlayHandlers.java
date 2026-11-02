package com.patel5600.missminute.mobile.bridge.handlers;

import android.content.Context;

import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.Handler;
import com.patel5600.missminute.mobile.core.protocol.Message;
import com.patel5600.missminute.mobile.overlay.OverlayService;

import org.json.JSONException;
import org.json.JSONObject;

/** overlay.status, overlay.start, overlay.stop and overlay.requestPermission. */
public final class OverlayHandlers {
    private OverlayHandlers() {
    }

    public static void register(BridgeRouter router, final Context context, final UiBridge ui) {
        router.register("overlay.status", new Handler() {
            @Override
            public void handle(Message message, Reply reply) throws Exception {
                reply.ok(status(context, ui));
            }
        });
        router.register("overlay.start", new Handler() {
            @Override
            public void handle(Message message, final Reply reply) {
                ui.runOnUi(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            if (!ui.notificationsGranted()) {
                                ui.requestNotificationPermission();
                            }
                            OverlayService.StartResult result = OverlayService.start(context);
                            JSONObject out = status(context, ui);
                            out.put("started", result == OverlayService.StartResult.STARTED);
                            if (result == OverlayService.StartResult.NEEDS_OVERLAY_PERMISSION) {
                                out.put("needs", "overlay_permission");
                            }
                            reply.ok(out);
                        } catch (JSONException | RuntimeException e) {
                            reply.fail("internal", "Could not start her.");
                        }
                    }
                });
            }
        });
        router.register("overlay.stop", new Handler() {
            @Override
            public void handle(Message message, final Reply reply) {
                ui.runOnUi(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            OverlayService.stop(context);
                            reply.ok(status(context, ui));
                        } catch (JSONException | RuntimeException e) {
                            reply.fail("internal", "Could not stop her.");
                        }
                    }
                });
            }
        });
        router.register("overlay.requestPermission", new Handler() {
            @Override
            public void handle(Message message, final Reply reply) {
                ui.runOnUi(new Runnable() {
                    @Override
                    public void run() {
                        ui.openOverlayPermissionScreen();
                        reply.ok(new JSONObject());
                    }
                });
            }
        });
    }

    /** Everything the page may know about her overlay. */
    public static JSONObject status(Context context, UiBridge ui) throws JSONException {
        MissMinutesApp app = MissMinutesApp.from(context);
        return new JSONObject()
                .put("running", OverlayService.isRunning())
                .put("windowShown", OverlayService.isWindowShown())
                .put("pageReady", OverlayService.isPageReady())
                .put("visibility", OverlayService.visibilityName())
                .put("overlayPermission", android.provider.Settings.canDrawOverlays(context))
                .put("notificationPermission", ui.notificationsGranted())
                .put("desiredRunning", app.settings().desiredRunning())
                .put("hiddenUntilMs", app.settings().hiddenUntilMs())
                .put("killed", app.killSwitch().state().killed);
    }
}
