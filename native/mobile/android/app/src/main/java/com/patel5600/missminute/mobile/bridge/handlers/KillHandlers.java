package com.patel5600.missminute.mobile.bridge.handlers;

import android.content.Context;

import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.Handler;
import com.patel5600.missminute.mobile.core.kill.KillPath;
import com.patel5600.missminute.mobile.core.kill.KillState;
import com.patel5600.missminute.mobile.core.protocol.Message;
import com.patel5600.missminute.mobile.kill.KillSwitch;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * kill.request and kill.ackNotice. Both are user-only message types. The page's own stop button is
 * the in-app kill path ({@code app-button}); it runs on the main thread like every other trigger.
 */
public final class KillHandlers {
    private KillHandlers() {
    }

    public static void register(BridgeRouter router, final Context context, final UiBridge ui) {
        router.register("kill.request", new Handler() {
            @Override
            public void handle(Message message, final Reply reply) {
                ui.runOnUi(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            KillState state = KillSwitch.trigger(context, KillPath.APP_BUTTON);
                            reply.ok(new JSONObject().put("killed", state.killed).put("atMs", state.atMs));
                        } catch (JSONException | RuntimeException e) {
                            reply.fail("internal", "The stop request did not finish.");
                        }
                    }
                });
            }
        });
        router.register("kill.ackNotice", new Handler() {
            @Override
            public void handle(Message message, Reply reply) throws Exception {
                MissMinutesApp.from(context).killSwitch().acknowledgeNotice();
                reply.ok(new JSONObject());
            }
        });
    }

    /** The notice the dashboard shows after a kill, or null when there is none. */
    public static JSONObject notice(Context context) throws JSONException {
        KillState state = MissMinutesApp.from(context).killSwitch().state();
        if (!state.noticePending) {
            return null;
        }
        return new JSONObject().put("atMs", state.atMs).put("path", state.path.wireName);
    }
}
