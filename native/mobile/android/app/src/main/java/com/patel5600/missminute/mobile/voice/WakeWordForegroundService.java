package com.patel5600.missminute.mobile.voice;

import android.Manifest;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;

import androidx.core.content.ContextCompat;

import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.app.Notifications;
import com.patel5600.missminute.mobile.app.OwnerAuthority;
import com.patel5600.missminute.mobile.app.SpeakerIdentityEngine;
import com.patel5600.missminute.mobile.core.kill.KillPath;
import com.patel5600.missminute.mobile.kill.KillSwitch;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * User-started foreground microphone service for on-device wake-word listening.
 *
 * <p>Audio never leaves the device, ring buffers are zeroed immediately on stop or kill,
 * recognized wake phrases + speaker match scores may only transition OwnerAuthority into
 * {@code OwnerCandidate} (never authenticated), and emergency stop phrases trigger an immediate
 * kill-switch lockdown.
 */
public final class WakeWordForegroundService extends Service {
    public static final String ACTION_START = "com.patel5600.missminute.action.WAKE_START";
    public static final String ACTION_STOP = "com.patel5600.missminute.action.WAKE_STOP";

    private static final int SAMPLE_RATE = 16_000;
    private static final int FRAME_SAMPLES = 480; // 30 ms @ 16 kHz
    private static final int RING_SAMPLES = SAMPLE_RATE * 5 / 2; // 2.5 s sliding speaker window
    private static final long SPEAKER_PROBE_INTERVAL_MS = 1_500L;

    public interface StateListener {
        void onWakeEvent(JSONObject payload);
    }

    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static final AtomicBoolean SPEAKER_PROBING = new AtomicBoolean(false);
    private static final Object RING_LOCK = new Object();
    private static final short[] RECENT_PCM = new short[RING_SAMPLES];
    private static int ringCursor = 0;
    private static int ringFilled = 0;
    private static volatile StateListener stateListener;

    private final ExecutorService captureExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "mm-wake-capture");
        t.setDaemon(true);
        return t;
    });
    private final ExecutorService speakerExecutor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "mm-wake-speaker");
        t.setDaemon(true);
        return t;
    });
    private volatile long lastSpeakerProbeAtMs;

    public static void setStateListener(StateListener listener) {
        stateListener = listener;
    }

    public static boolean isRunning() {
        return RUNNING.get();
    }

    public static boolean start(Context context) {
        if (context == null) return false;
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        Intent intent = new Intent(context, WakeWordForegroundService.class).setAction(ACTION_START);
        try {
            context.startForegroundService(intent);
            return true;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    public static void stop(Context context) {
        RUNNING.set(false);
        clearRecentBuffer();
        OwnerAuthority.resetWake();
        if (context != null) {
            context.stopService(new Intent(context, WakeWordForegroundService.class));
            Notifications.cancelWakeNotification(context);
        }
        emitState("stopped", false, null, -1f);
    }

    /** Evaluates one audio/transcript turn through the shared Rust wake-word state machine. */
    public static JSONObject evaluateFrame(
            Context context,
            short[] pcm,
            String transcript,
            float phraseConfidence) {
        long nowMs = System.currentTimeMillis();
        short[] audio = (pcm != null && pcm.length > 0) ? pcm : snapshotRecentPcm();
        String raw = OwnerAuthority.feedWakeFrame(audio, transcript, phraseConfidence, nowMs);
        if (pcm == null && audio != null) {
            Arrays.fill(audio, (short) 0);
        }
        JSONObject out = new JSONObject();
        try {
            if ("\"silent\"".equals(raw)) {
                out.put("status", "silent");
                return out;
            }
            if ("\"below_threshold\"".equals(raw)) {
                out.put("status", "below_threshold");
                return out;
            }
            if ("\"cooldown_active\"".equals(raw)) {
                out.put("status", "cooldown_active");
                return out;
            }
            if (raw != null && raw.startsWith("{")) {
                JSONObject parsed = new JSONObject(raw);
                if (parsed.has("emergency_stop")) {
                    JSONObject stopObj = parsed.getJSONObject("emergency_stop");
                    String phrase = stopObj.optString("phrase", "emergency stop");
                    OwnerAuthority.emergencyKill();
                    if (context != null) {
                        KillSwitch.trigger(context.getApplicationContext(), KillPath.EXTERNAL);
                    }
                    stop(context);
                    emitState("emergency_stop", false, phrase, 1.0f);
                    out.put("status", "emergency_stop").put("phrase", phrase).put("mode", OwnerAuthority.getOperatingMode());
                    return out;
                }
                if (parsed.has("triggered")) {
                    JSONObject trig = parsed.getJSONObject("triggered");
                    String phrase = trig.optString("phrase", "hey miss minutes");
                    float conf = (float) trig.optDouble("confidence", 0.72);
                    float candidateConf = conf;
                    if (context != null && SpeakerIdentityEngine.hasProfile(context)) {
                        short[] speakerWindow = snapshotRecentPcm();
                        float speakerScore = SpeakerIdentityEngine.matchBufferedAudio(context, speakerWindow);
                        if (speakerWindow != null) Arrays.fill(speakerWindow, (short) 0);
                        if (speakerScore >= 0f) {
                            candidateConf = Math.max(conf, speakerScore);
                        }
                    }
                    OwnerAuthority.reportVoiceMatch(candidateConf);
                    emitState("triggered", RUNNING.get(), phrase, candidateConf);
                    out.put("status", "triggered")
                            .put("phrase", phrase)
                            .put("confidence", candidateConf)
                            .put("mode", OwnerAuthority.getOperatingMode());
                    return out;
                }
                if (parsed.has("accumulating")) {
                    JSONObject acc = parsed.getJSONObject("accumulating");
                    out.put("status", "accumulating")
                            .put("hits", acc.optInt("hits", 1))
                            .put("required", acc.optInt("required", 2));
                    return out;
                }
            }
            out.put("status", raw == null ? "error" : raw);
        } catch (Exception ignored) {
            try {
                out.put("status", "error");
            } catch (Exception ignoredInner) {
            }
        }
        return out;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stop(this);
            return START_NOT_STICKY;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            stopSelf();
            return START_NOT_STICKY;
        }
        Notifications.createChannels(this);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(Notifications.ID_WAKE, Notifications.wakeListening(this),
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else {
                startForeground(Notifications.ID_WAKE, Notifications.wakeListening(this));
            }
        } catch (SecurityException ignored) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (RUNNING.compareAndSet(false, true)) {
            emitState("listening", true, null, -1f);
            captureExecutor.execute(this::captureLoop);
        }
        return START_NOT_STICKY;
    }

    private void captureLoop() {
        int minBytes = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBytes <= 0) {
            stop(this);
            return;
        }
        AudioRecord recorder;
        try {
            recorder = new AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    Math.max(minBytes, FRAME_SAMPLES * 8));
        } catch (SecurityException | IllegalArgumentException e) {
            stop(this);
            return;
        }
        if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
            recorder.release();
            stop(this);
            return;
        }
        short[] frame = new short[FRAME_SAMPLES];
        try {
            recorder.startRecording();
            while (RUNNING.get()) {
                int read = recorder.read(frame, 0, frame.length, AudioRecord.READ_BLOCKING);
                if (read <= 0) continue;
                short[] validFrame = read == frame.length ? frame : Arrays.copyOf(frame, read);
                appendToRing(validFrame);
                long nowMs = System.currentTimeMillis();
                OwnerAuthority.feedWakeFrame(validFrame, null, 0f, nowMs);
                if (validFrame != frame) Arrays.fill(validFrame, (short) 0);
                maybeScheduleSpeakerCandidateProbe(nowMs);
            }
        } catch (SecurityException | IllegalStateException ignored) {
        } finally {
            Arrays.fill(frame, (short) 0);
            try { recorder.stop(); } catch (IllegalStateException ignored) {}
            recorder.release();
            clearRecentBuffer();
            if (RUNNING.compareAndSet(true, false)) {
                emitState("stopped", false, null, -1f);
            }
            Notifications.cancelWakeNotification(this);
            stopSelf();
        }
    }

    private void maybeScheduleSpeakerCandidateProbe(long nowMs) {
        if (OwnerAuthority.hasOwnerSession()) return;
        if (!SpeakerIdentityEngine.hasProfile(this)) return;
        if (nowMs - lastSpeakerProbeAtMs < SPEAKER_PROBE_INTERVAL_MS) return;
        if (!SPEAKER_PROBING.compareAndSet(false, true)) return;
        lastSpeakerProbeAtMs = nowMs;
        short[] snapshot = snapshotRecentPcm();
        if (snapshot == null) {
            SPEAKER_PROBING.set(false);
            return;
        }
        speakerExecutor.execute(() -> {
            try {
                if (!RUNNING.get()) return;
                float conf = SpeakerIdentityEngine.matchBufferedAudio(getApplicationContext(), snapshot);
                if (conf >= 0.70f) {
                    OwnerAuthority.reportVoiceMatch(conf);
                    emitState("candidate", RUNNING.get(), null, conf);
                }
            } finally {
                Arrays.fill(snapshot, (short) 0);
                SPEAKER_PROBING.set(false);
            }
        });
    }

    private static void appendToRing(short[] samples) {
        synchronized (RING_LOCK) {
            for (short s : samples) {
                RECENT_PCM[ringCursor] = s;
                ringCursor = (ringCursor + 1) % RING_SAMPLES;
                if (ringFilled < RING_SAMPLES) ringFilled++;
            }
        }
    }

    private static short[] snapshotRecentPcm() {
        synchronized (RING_LOCK) {
            if (ringFilled < SAMPLE_RATE / 2) return null;
            short[] out = new short[ringFilled];
            int start = (ringCursor - ringFilled + RING_SAMPLES) % RING_SAMPLES;
            int firstPart = Math.min(ringFilled, RING_SAMPLES - start);
            System.arraycopy(RECENT_PCM, start, out, 0, firstPart);
            int remaining = ringFilled - firstPart;
            if (remaining > 0) {
                System.arraycopy(RECENT_PCM, 0, out, firstPart, remaining);
            }
            return out;
        }
    }

    private static void clearRecentBuffer() {
        synchronized (RING_LOCK) {
            Arrays.fill(RECENT_PCM, (short) 0);
            ringCursor = 0;
            ringFilled = 0;
        }
    }

    private static void emitState(String event, boolean listening, String phrase, float confidence) {
        StateListener listener = stateListener;
        if (listener == null) return;
        try {
            JSONObject payload = new JSONObject()
                    .put("event", event)
                    .put("listening", listening)
                    .put("mode", OwnerAuthority.getOperatingMode());
            if (phrase != null) payload.put("phrase", phrase);
            if (confidence >= 0f && Float.isFinite(confidence)) payload.put("confidence", confidence);
            listener.onWakeEvent(payload);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        RUNNING.set(false);
        clearRecentBuffer();
        OwnerAuthority.resetWake();
        captureExecutor.shutdownNow();
        speakerExecutor.shutdownNow();
        Notifications.cancelWakeNotification(this);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
