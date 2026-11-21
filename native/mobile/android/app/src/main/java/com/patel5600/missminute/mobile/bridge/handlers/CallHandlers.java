package com.patel5600.missminute.mobile.bridge.handlers;

import android.content.Context;
import android.content.SharedPreferences;

import com.patel5600.missminute.mobile.app.OwnerAuthority;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.Handler;
import com.patel5600.missminute.mobile.voice.MissMinutesConnectionService;
import com.patel5600.missminute.mobile.voice.OutboundCallGuard;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Bridge handlers for ethical AI-disclosed VoIP calling:
 * - {@code calls.prepare}: validates E.164, quiet hours, DNC, daily cap, typed facts, returns preview.
 * - {@code calls.start}: requires fresh confirmation in a native dialog with disclosure preview before dialing.
 * - {@code calls.hangup}: immediately disconnects all active self-managed VoIP calls.
 */
public final class CallHandlers {
    private static final String PREFS = "mm_call_ledger";
    private static final String KEY_DAY = "day";
    private static final String KEY_COUNT = "count";
    private static final String KEY_DNC = "dnc";

    private CallHandlers() {}

    public static void register(BridgeRouter router, Context context, UiBridge ui) {
        if (ui != null) {
            MissMinutesConnectionService.setStateListener(payload -> ui.push("calls.state", payload));
        }

        router.register("calls.prepare", (message, reply) -> {
            if (!OwnerAuthority.authorizeOwnerCapability("device.control")) {
                reply.fail("owner_auth_required", "Unlock Miss Minutes before preparing an outbound call.");
                return;
            }
            try {
                OutboundCallGuard.Ledger ledger = loadLedger(context, message.payload.optJSONArray("dncNumbers"));
                OutboundCallGuard.PreparedCall preview = buildCall(message.payload, ledger, true);
                reply.ok(toJson(preview, ledger, OutboundCallGuard.Policy.defaults(), true));
            } catch (IllegalArgumentException e) {
                reply.fail("bad_payload", e.getMessage());
            } catch (IllegalStateException | SecurityException e) {
                reply.fail("forbidden", e.getMessage());
            }
        });

        router.register("calls.start", (message, reply) -> {
            String sessionId = OwnerAuthority.ownerSessionForCapability("device.control");
            if (sessionId == null) {
                reply.fail("owner_auth_required", "Unlock Miss Minutes before placing an outbound call.");
                return;
            }
            if (ui == null) {
                reply.fail("unavailable", "Outbound calls require native dashboard confirmation.");
                return;
            }
            final OutboundCallGuard.PreparedCall preview;
            try {
                OutboundCallGuard.Ledger ledger = loadLedger(context, message.payload.optJSONArray("dncNumbers"));
                preview = buildCall(message.payload, ledger, true);
            } catch (IllegalArgumentException e) {
                reply.fail("bad_payload", e.getMessage());
                return;
            } catch (IllegalStateException | SecurityException e) {
                reply.fail("forbidden", e.getMessage());
                return;
            }

            String confirmBody = "Miss Minutes (automated AI brand voice) will place an outbound VoIP call to "
                    + preview.destinationE164 + " and open immediately with:\n\n\""
                    + preview.disclosureOpening + "\"\n\nFacts to share: " + preview.allowedFacts.size();

            ui.confirmAction(
                    "Confirm outbound Miss Minutes call",
                    confirmBody,
                    "Place Call",
                    "Cancel",
                    allowed -> {
                        if (!allowed) {
                            reply.fail("cancelled", "Outbound call was cancelled by the owner.");
                            return;
                        }
                        if (!OwnerAuthority.authorizeOwnerCapability(sessionId, "device.control")) {
                            reply.fail("owner_auth_required", "Owner access expired before the outbound call started.");
                            return;
                        }
                        try {
                            OutboundCallGuard.Ledger liveLedger = loadLedger(context, message.payload.optJSONArray("dncNumbers"));
                            OutboundCallGuard.PreparedCall liveCall = buildCall(message.payload, liveLedger, true);
                            MissMinutesConnectionService.startOutgoingCall(context, liveCall);
                            incrementDailyCalls(context);
                            reply.ok(toJson(liveCall, loadLedger(context, null), OutboundCallGuard.Policy.defaults(), false));
                        } catch (SecurityException se) {
                            reply.fail("forbidden", se.getMessage() == null ? "Call permission denied by Android Telecom." : se.getMessage());
                        } catch (Exception e) {
                            reply.fail("unavailable", e.getMessage() == null ? "Could not start outbound call." : e.getMessage());
                        }
                    });
        });

        router.register("calls.hangup", (message, reply) -> {
            MissMinutesConnectionService.hangupAll(context);
            reply.ok(new JSONObject().put("hungUp", true).put("activeCalls", MissMinutesConnectionService.activeCallCount()));
        });
    }

    private static OutboundCallGuard.PreparedCall buildCall(
            JSONObject payload,
            OutboundCallGuard.Ledger ledger,
            boolean confirmed) {
        String destination = payload.optString("destinationE164", "").trim();
        String ownerFirstName = payload.optString("ownerFirstName", "");
        JSONArray factsArr = payload.optJSONArray("facts");
        List<OutboundCallGuard.Fact> facts = new ArrayList<>();
        if (factsArr != null) {
            for (int i = 0; i < factsArr.length(); i++) {
                JSONObject obj = factsArr.optJSONObject(i);
                if (obj == null) continue;
                OutboundCallGuard.FactKind kind = OutboundCallGuard.FactKind.fromWire(obj.optString("kind", ""));
                String val = obj.optString("value", "");
                facts.add(new OutboundCallGuard.Fact(kind, val));
            }
        }
        Calendar now = Calendar.getInstance();
        int minuteOfDay = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);
        return OutboundCallGuard.prepare(
                destination,
                ownerFirstName,
                facts,
                OutboundCallGuard.BrandVoice.MISS_MINUTES_TVA,
                minuteOfDay,
                OutboundCallGuard.Policy.defaults(),
                ledger,
                confirmed);
    }

    private static JSONObject toJson(
            OutboundCallGuard.PreparedCall call,
            OutboundCallGuard.Ledger ledger,
            OutboundCallGuard.Policy policy,
            boolean dryRun) throws Exception {
        JSONArray factsOut = new JSONArray();
        for (OutboundCallGuard.Fact fact : call.allowedFacts) {
            factsOut.put(new JSONObject().put("kind", fact.kind.wireName).put("value", fact.value.trim()));
        }
        return new JSONObject()
                .put("callId", call.callId)
                .put("destinationE164", call.destinationE164)
                .put("callerLabel", call.callerLabel)
                .put("voice", call.voice.name())
                .put("disclosureOpening", call.disclosureOpening)
                .put("allowedFacts", factsOut)
                .put("state", call.state().name().toLowerCase(Locale.ROOT))
                .put("dryRun", dryRun)
                .put("dailyRemaining", Math.max(0, policy.maxCallsPerDay - ledger.callsPlacedToday));
    }

    private static OutboundCallGuard.Ledger loadLedger(Context context, JSONArray extraDnc) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String today = OutboundCallGuard.todayKey();
        int count = today.equals(prefs.getString(KEY_DAY, "")) ? prefs.getInt(KEY_COUNT, 0) : 0;
        Set<String> dnc = new HashSet<>(prefs.getStringSet(KEY_DNC, new HashSet<>()));
        if (extraDnc != null) {
            for (int i = 0; i < extraDnc.length(); i++) {
                String num = extraDnc.optString(i, "").trim();
                if (!num.isEmpty()) dnc.add(num);
            }
        }
        return new OutboundCallGuard.Ledger(dnc, count);
    }

    private static void incrementDailyCalls(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String today = OutboundCallGuard.todayKey();
        int prev = today.equals(prefs.getString(KEY_DAY, "")) ? prefs.getInt(KEY_COUNT, 0) : 0;
        prefs.edit().putString(KEY_DAY, today).putInt(KEY_COUNT, prev + 1).commit();
    }
}
