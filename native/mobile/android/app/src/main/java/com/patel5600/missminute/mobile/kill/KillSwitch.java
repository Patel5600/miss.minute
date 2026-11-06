package com.patel5600.missminute.mobile.kill;

import android.content.Context;
import android.util.Log;

import com.patel5600.missminute.mobile.BuildConfig;
import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.core.Clock;
import com.patel5600.missminute.mobile.core.audit.AuditLog;
import com.patel5600.missminute.mobile.core.kill.Killable;
import com.patel5600.missminute.mobile.core.kill.KillCore;
import com.patel5600.missminute.mobile.core.kill.KillPath;
import com.patel5600.missminute.mobile.core.kill.KillState;
import com.patel5600.missminute.mobile.core.kill.KillStateStore;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * The kill switch. Every trigger (the notification action, the Stop button in the app, her long-press
 * menu, the page's own button) ends in {@link #trigger(Context, KillPath)}. The state file is written
 * first, then the running work is stopped, then one audit record is appended ({@link KillCore}).
 * Components that own work register a {@link Killable} while they are alive; the always-present
 * killables (services, notification, settings, permissions) are given at construction, so a kill works
 * with no service running.
 */
public final class KillSwitch {
    /** Told after the kill finished. May be called on any thread; must not throw. */
    public interface Listener {
        void onKilled(KillState state);
    }

    /** One stop action that may throw. */
    public interface Action {
        void run() throws Exception;
    }

    /** Removes a registered killable. */
    public interface Registration {
        void unregister();
    }

    private final KillStateStore store;
    private final AuditLog audit;
    private final Clock clock;
    private final List<Killable> alwaysThere;
    private final List<Killable> registered = new CopyOnWriteArrayList<>();
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();

    public KillSwitch(KillStateStore store, AuditLog audit, Clock clock, List<Killable> alwaysThere) {
        this.store = store;
        this.audit = audit;
        this.clock = clock;
        this.alwaysThere = new ArrayList<>(alwaysThere);
    }

    /** The only entry point from Android code. Safe to call with no service running. */
    public static KillState trigger(Context context, KillPath path) {
        return MissMinutesApp.from(context).killSwitch().trigger(path);
    }

    /** A killable with a fixed label. The label is written to the audit log, so never put user text in it. */
    public static Killable killable(final String label, final Action action) {
        return new Killable() {
            @Override
            public String label() {
                return label;
            }

            @Override
            public void onKill() throws Exception {
                action.run();
            }
        };
    }

    /** Components call this while they own work that a kill must stop, and unregister when they are done. */
    public Registration register(final Killable killable) {
        registered.add(killable);
        return new Registration() {
            @Override
            public void unregister() {
                registered.remove(killable);
            }
        };
    }

    public void addListener(Listener listener) {
        listeners.add(listener);
    }

    public void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    /**
     * Stops everything: first the registered components, then the always-present killables. One
     * failing killable never stops the others. Serialised, so two triggers cannot interleave.
     */
    public synchronized KillState trigger(KillPath path) {
        List<Killable> all = new ArrayList<>(registered);
        all.addAll(alwaysThere);
        KillState state = KillCore.trigger(path, all, store, audit, clock);
        if (BuildConfig.DEBUG) {
            // Metadata only: the audit line holds the path, the labels and the outcome, never user text.
            List<String> tail = audit.tail(1);
            Log.d("MMKill", "path=" + path.wireName + " killed=" + state.killed + " audit=" + (tail.isEmpty() ? "none" : tail.get(0)));
        }
        for (Listener listener : listeners) {
            try {
                listener.onKilled(state);
            } catch (RuntimeException ignored) {
                // A broken listener must not undo a kill.
            }
        }
        return state;
    }

    /** What the last kill left behind (a missing file means never killed; an unreadable one counts as killed). */
    public KillState state() {
        return store.read();
    }

    /**
     * The owner started her again on purpose. Lifts the "killed" flag so a sticky restart is allowed,
     * and keeps the post-kill notice until it is acknowledged.
     *
     * @return false when the new state could not be saved (she then stays blocked from restarting)
     */
    public synchronized boolean clearKillFlag() {
        KillState current = store.read();
        if (!current.killed) {
            return true;
        }
        try {
            store.write(new KillState(false, current.atMs, current.path, current.cancelled, current.noticePending));
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** The owner has seen the post-kill notice. */
    public synchronized void acknowledgeNotice() {
        KillState current = store.read();
        if (!current.noticePending) {
            return;
        }
        try {
            store.write(current.withNoticeAcknowledged());
        } catch (IOException | RuntimeException ignored) {
            // The notice simply shows again on the next launch.
        }
    }
}
