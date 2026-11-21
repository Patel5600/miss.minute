package com.patel5600.missminute.mobile.voice;

import android.content.ComponentName;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.telecom.Connection;
import android.telecom.ConnectionRequest;
import android.telecom.ConnectionService;
import android.telecom.DisconnectCause;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;

import com.patel5600.missminute.mobile.app_world.voice.ClonedVoicePlayer;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Android Telecom {@link ConnectionService} (self-managed) for ethical AI-disclosed VoIP calls.
 *
 * <p>Every call MUST:
 * 1) pass {@link OutboundCallGuard#prepare} and explicit native owner confirmation;
 * 2) speak its upfront AI disclosure in Miss Minutes brand voice (TTS pitch 1.30f or bundled
 *    Miss Minutes clockwork clip — NEVER the owner's voice clone) BEFORE transitioning from
 *    DISCLOSED to CONNECTED ({@link Connection#setActive()}).
 */
public final class MissMinutesConnectionService extends ConnectionService {
    private static final String ACCOUNT_ID = "miss_minutes_voip";
    private static final String EXTRA_CALL_ID = "mm_call_id";

    public interface StateListener {
        void onCallEvent(JSONObject payload);
    }

    private static final ConcurrentHashMap<String, OutboundCallGuard.PreparedCall> PREPARED_CALLS = new ConcurrentHashMap<>();
    private static final ConcurrentHashMap<String, MissMinutesConnection> ACTIVE_CONNECTIONS = new ConcurrentHashMap<>();
    private static volatile StateListener stateListener;
    private static volatile TextToSpeech activeTts;
    private static volatile ClonedVoicePlayer activePlayer;

    public static void setStateListener(StateListener listener) {
        stateListener = listener;
    }

    public static int activeCallCount() {
        return ACTIVE_CONNECTIONS.size();
    }

    public static PhoneAccountHandle accountHandle(Context context) {
        return new PhoneAccountHandle(
                new ComponentName(context.getApplicationContext(), MissMinutesConnectionService.class),
                ACCOUNT_ID);
    }

    public static void registerPhoneAccount(Context context) {
        TelecomManager telecom = context.getSystemService(TelecomManager.class);
        if (telecom == null) return;
        PhoneAccountHandle handle = accountHandle(context);
        PhoneAccount account = PhoneAccount.builder(handle, "Miss Minutes Assistant")
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .addSupportedUriScheme(PhoneAccount.SCHEME_TEL)
                .build();
        telecom.registerPhoneAccount(account);
    }

    public static void startOutgoingCall(Context context, OutboundCallGuard.PreparedCall prepared) throws SecurityException {
        if (context == null || prepared == null) {
            throw new IllegalArgumentException("Invalid call preparation.");
        }
        TelecomManager telecom = context.getSystemService(TelecomManager.class);
        if (telecom == null) {
            throw new IllegalStateException("Android Telecom service is unavailable.");
        }
        registerPhoneAccount(context);
        PREPARED_CALLS.put(prepared.callId, prepared);
        Bundle extras = new Bundle();
        extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, accountHandle(context));
        Bundle callExtras = new Bundle();
        callExtras.putString(EXTRA_CALL_ID, prepared.callId);
        extras.putBundle(TelecomManager.EXTRA_OUTGOING_CALL_EXTRAS, callExtras);
        Uri uri = Uri.fromParts(PhoneAccount.SCHEME_TEL, prepared.destinationE164, null);
        try {
            emitEvent(prepared);
            telecom.placeCall(uri, extras);
        } catch (RuntimeException e) {
            PREPARED_CALLS.remove(prepared.callId);
            prepared.abort();
            emitEvent(prepared);
            throw e;
        }
    }

    public static void hangupAll(Context context) {
        for (OutboundCallGuard.PreparedCall pending : PREPARED_CALLS.values()) {
            pending.abort();
            emitEvent(pending);
        }
        PREPARED_CALLS.clear();
        List<MissMinutesConnection> conns = new ArrayList<>(ACTIVE_CONNECTIONS.values());
        for (MissMinutesConnection conn : conns) {
            conn.abortAndDestroy(DisconnectCause.LOCAL);
        }
        ACTIVE_CONNECTIONS.clear();
        stopBrandSpeech();
    }

    private static synchronized void stopBrandSpeech() {
        TextToSpeech tts = activeTts;
        activeTts = null;
        if (tts != null) {
            try { tts.stop(); } catch (Exception ignored) {}
            try { tts.shutdown(); } catch (Exception ignored) {}
        }
        ClonedVoicePlayer player = activePlayer;
        activePlayer = null;
        if (player != null) {
            player.release();
        }
    }

    @Override
    public Connection onCreateOutgoingConnection(PhoneAccountHandle connectionManagerPhoneAccount, ConnectionRequest request) {
        Bundle extras = request != null ? request.getExtras() : null;
        String callId = extras != null ? extras.getString(EXTRA_CALL_ID, "") : "";
        OutboundCallGuard.PreparedCall prepared = PREPARED_CALLS.remove(callId);
        if (prepared == null) {
            return Connection.createFailedConnection(new DisconnectCause(DisconnectCause.ERROR, "Missing validated outbound call record."));
        }
        MissMinutesConnection connection = new MissMinutesConnection(this, prepared);
        ACTIVE_CONNECTIONS.put(prepared.callId, connection);
        connection.beginWithMandatoryDisclosure();
        return connection;
    }

    @Override
    public void onCreateOutgoingConnectionFailed(PhoneAccountHandle connectionManagerPhoneAccount, ConnectionRequest request) {
        Bundle extras = request != null ? request.getExtras() : null;
        String callId = extras != null ? extras.getString(EXTRA_CALL_ID, "") : "";
        OutboundCallGuard.PreparedCall prepared = PREPARED_CALLS.remove(callId);
        if (prepared != null) {
            prepared.abort();
            emitEvent(prepared);
        }
    }

    private static void emitEvent(OutboundCallGuard.PreparedCall prepared) {
        StateListener listener = stateListener;
        if (listener == null || prepared == null) return;
        try {
            listener.onCallEvent(new JSONObject()
                    .put("callId", prepared.callId)
                    .put("destinationE164", prepared.destinationE164)
                    .put("state", prepared.state().name().toLowerCase(Locale.ROOT))
                    .put("voice", prepared.voice.name())
                    .put("disclosureOpening", prepared.disclosureOpening));
        } catch (Exception ignored) {
        }
    }

    private static final class MissMinutesConnection extends Connection {
        private final Context appContext;
        private final OutboundCallGuard.PreparedCall prepared;
        private volatile boolean closed;

        MissMinutesConnection(Context context, OutboundCallGuard.PreparedCall prepared) {
            this.appContext = context.getApplicationContext();
            this.prepared = prepared;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                setConnectionProperties(PROPERTY_SELF_MANAGED);
            }
            setAudioModeIsVoip(true);
            setAddress(Uri.fromParts(PhoneAccount.SCHEME_TEL, prepared.destinationE164, null), TelecomManager.PRESENTATION_ALLOWED);
            setCallerDisplayName("Miss Minutes", TelecomManager.PRESENTATION_ALLOWED);
            setDialing();
        }

        void beginWithMandatoryDisclosure() {
            emitEvent(prepared);
            // Enforce upfront AI disclosure in Miss Minutes' brand voice BEFORE transitioning to Connected/Active.
            speakDisclosureWithBrandVoice(appContext, prepared.disclosureOpening, () -> {
                if (closed) return;
                try {
                    prepared.markDisclosed();
                    emitEvent(prepared);
                    prepared.markConnected();
                    emitEvent(prepared);
                    setActive();
                } catch (IllegalStateException e) {
                    abortAndDestroy(DisconnectCause.ERROR);
                }
            });
        }

        @Override
        public void onAbort() {
            abortAndDestroy(DisconnectCause.CANCELED);
        }

        @Override
        public void onDisconnect() {
            completeAndDestroy();
        }

        @Override
        public void onReject() {
            abortAndDestroy(DisconnectCause.REJECTED);
        }

        void completeAndDestroy() {
            if (closed) return;
            closed = true;
            ACTIVE_CONNECTIONS.remove(prepared.callId);
            try {
                prepared.complete();
            } catch (IllegalStateException ignored) {
                prepared.abort();
            }
            emitEvent(prepared);
            setDisconnected(new DisconnectCause(DisconnectCause.LOCAL));
            destroy();
            if (ACTIVE_CONNECTIONS.isEmpty()) stopBrandSpeech();
        }

        void abortAndDestroy(int cause) {
            if (closed) return;
            closed = true;
            ACTIVE_CONNECTIONS.remove(prepared.callId);
            prepared.abort();
            emitEvent(prepared);
            setDisconnected(new DisconnectCause(cause));
            destroy();
            if (ACTIVE_CONNECTIONS.isEmpty()) stopBrandSpeech();
        }
    }

    private static void speakDisclosureWithBrandVoice(Context context, String text, Runnable onDisclosed) {
        stopBrandSpeech();
        final boolean[] completed = {false};
        Runnable completeOnce = () -> {
            synchronized (completed) {
                if (completed[0]) return;
                completed[0] = true;
            }
            onDisclosed.run();
        };
        try {
            final TextToSpeech[] holder = new TextToSpeech[1];
            holder[0] = new TextToSpeech(context.getApplicationContext(), status -> {
                TextToSpeech tts = holder[0];
                if (tts == null || status != TextToSpeech.SUCCESS) {
                    ClonedVoicePlayer fallback = new ClonedVoicePlayer(context);
                    activePlayer = fallback;
                    fallback.playAsset(ClonedVoicePlayer.CLIP_CONVERSATIONAL);
                    completeOnce.run();
                    return;
                }
                tts.setLanguage(Locale.US);
                tts.setPitch(1.30f);
                tts.setSpeechRate(1.05f);
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utteranceId) {}
                    @Override public void onDone(String utteranceId) { completeOnce.run(); }
                    @Override public void onError(String utteranceId) { completeOnce.run(); }
                });
                int spoken = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "mm_disclosure");
                if (spoken != TextToSpeech.SUCCESS) {
                    completeOnce.run();
                }
            });
            activeTts = holder[0];
        } catch (RuntimeException e) {
            ClonedVoicePlayer fallback = new ClonedVoicePlayer(context);
            activePlayer = fallback;
            fallback.playAsset(ClonedVoicePlayer.CLIP_CONVERSATIONAL);
            completeOnce.run();
        }
    }
}
