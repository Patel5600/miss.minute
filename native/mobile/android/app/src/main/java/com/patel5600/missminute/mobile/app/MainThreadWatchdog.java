package com.patel5600.missminute.mobile.app;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

/**
 * Debug builds only. Pings the main thread twice a second and, when it does not answer for 1.5 s,
 * logs the main thread's Java stack (tag MMStall) every 3 s until it recovers. It exists to show
 * where a stall is when the system would only say "not responding". It writes no payloads.
 */
final class MainThreadWatchdog extends Thread {
    private static final long PING_MS = 500;
    private static final long STALL_MS = 1500;
    private static final long REPEAT_MS = 3000;
    private static final int MAX_FRAMES = 16;

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile long lastAnswerMs = SystemClock.uptimeMillis();
    private volatile boolean pending;
    private final Runnable answer = new Runnable() {
        @Override
        public void run() {
            lastAnswerMs = SystemClock.uptimeMillis();
            pending = false;
        }
    };

    MainThreadWatchdog() {
        super("mm-watchdog");
        setDaemon(true);
    }

    @Override
    public void run() {
        long lastReport = 0;
        while (!isInterrupted()) {
            if (!pending) {
                pending = true;
                main.post(answer);
            }
            try {
                Thread.sleep(PING_MS);
            } catch (InterruptedException e) {
                return;
            }
            long now = SystemClock.uptimeMillis();
            long stalled = now - lastAnswerMs;
            if (stalled >= STALL_MS && now - lastReport >= REPEAT_MS) {
                lastReport = now;
                StackTraceElement[] stack = Looper.getMainLooper().getThread().getStackTrace();
                StringBuilder text = new StringBuilder("main thread has not answered for ").append(stalled).append(" ms");
                for (int i = 0; i < Math.min(stack.length, MAX_FRAMES); i++) {
                    text.append("\n    at ").append(stack[i]);
                }
                Log.w("MMStall", text.toString());
            }
        }
    }
}
