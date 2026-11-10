package com.patel5600.missminute.mobile.overlay;

import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;

import com.patel5600.missminute.mobile.core.FlingTracker;

/**
 * Turns the raw touches on her window into five events: drag (after 8 dp of movement), release with
 * the finger's velocity, tap (up within 250 ms, moved less than 8 dp), and long press (600 ms, moved
 * less than 8 dp). The WebView never sees a touch. Positions are raw screen pixels, so moving the
 * window while dragging does not disturb them. The release velocity comes from {@link FlingTracker}
 * fed with those raw positions: Android's VelocityTracker works in view coordinates, and her window
 * moves with the finger, so it would report almost no movement.
 */
final class OverlayTouch {
    static final long TAP_MS = 250;
    static final long LONG_PRESS_MS = 600;
    static final float SLOP_DP = 8;

    interface Listener {
        void onDown();

        /** The finger moved past the slop. The position is where it first touched her, in screen pixels. */
        void onDragStart(float rawX, float rawY);

        void onDrag(float rawX, float rawY);

        /** The finger lifted after a drag; velocity in pixels per second. */
        void onRelease(float velocityX, float velocityY);

        void onTap();

        void onLongPress();
    }

    private final View owner;
    private final Listener listener;
    private final float slopPx;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final FlingTracker tracker = new FlingTracker();
    private float downX;
    private float downY;
    private long downTime;
    private boolean active;
    private boolean dragging;
    private boolean longPressed;

    private final Runnable longPress = new Runnable() {
        @Override
        public void run() {
            if (active && !dragging && !longPressed) {
                longPressed = true;
                listener.onLongPress();
            }
        }
    };

    OverlayTouch(View owner, float density, Listener listener) {
        this.owner = owner;
        this.listener = listener;
        this.slopPx = SLOP_DP * density;
    }

    boolean onTouch(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                begin(event);
                return true;
            case MotionEvent.ACTION_MOVE:
                if (!active) {
                    return true;
                }
                addSamples(event);
                if (longPressed) {
                    return true; // the menu has taken over this touch
                }
                if (!dragging && distance(event) > slopPx) {
                    dragging = true;
                    handler.removeCallbacks(longPress);
                    // She is held where the finger first touched her, however far the finger has gone
                    // by the time this (possibly batched) event is handled.
                    listener.onDragStart(downX, downY);
                }
                if (dragging) {
                    listener.onDrag(event.getRawX(), event.getRawY());
                }
                return true;
            case MotionEvent.ACTION_UP:
                finish(event, true);
                return true;
            case MotionEvent.ACTION_CANCEL:
                finish(event, false);
                return true;
            default:
                return true;
        }
    }

    /**
     * Adds the samples Android batched into this MOVE (oldest first) and then the newest, all in screen
     * pixels. Without them a janky frame would leave the tracker with one sample and no velocity. The
     * batched samples carry view coordinates; the offset to the screen is the same for the whole batch.
     */
    private void addSamples(MotionEvent event) {
        float offsetX = event.getRawX() - event.getX();
        float offsetY = event.getRawY() - event.getY();
        int history = event.getHistorySize();
        for (int h = 0; h < history; h++) {
            tracker.add(event.getHistoricalEventTime(h), event.getHistoricalX(h) + offsetX,
                    event.getHistoricalY(h) + offsetY);
        }
        tracker.add(event.getEventTime(), event.getRawX(), event.getRawY());
    }

    private void begin(MotionEvent event) {
        end();
        active = true;
        dragging = false;
        longPressed = false;
        downX = event.getRawX();
        downY = event.getRawY();
        downTime = event.getEventTime();
        tracker.clear();
        tracker.add(downTime, downX, downY);
        handler.postDelayed(longPress, LONG_PRESS_MS);
        listener.onDown();
    }

    private void finish(MotionEvent event, boolean up) {
        if (!active) {
            return;
        }
        handler.removeCallbacks(longPress);
        tracker.add(event.getEventTime(), event.getRawX(), event.getRawY());
        if (dragging) {
            float vx = 0;
            float vy = 0;
            if (up) {
                double[] velocity = tracker.velocity(event.getEventTime());
                vx = (float) velocity[0];
                vy = (float) velocity[1];
            }
            listener.onRelease(vx, vy);
        } else if (up && !longPressed && event.getEventTime() - downTime <= TAP_MS
                && distance(event) <= slopPx) {
            owner.performClick();
            listener.onTap();
        }
        end();
    }

    /** Drops any gesture in progress (the window is going away or hidden). */
    void cancel() {
        handler.removeCallbacks(longPress);
        end();
    }

    private void end() {
        active = false;
        dragging = false;
        tracker.clear();
    }

    private float distance(MotionEvent event) {
        return (float) Math.hypot(event.getRawX() - downX, event.getRawY() - downY);
    }
}
