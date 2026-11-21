package com.patel5600.missminute.mobile.voice;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/**
 * Pure ethical outbound call policy, E.164 & Do-Not-Call guard, quiet hours, daily rate cap,
 * typed fact allowlist, mandatory upfront AI disclosure, and call state machine.
 *
 * <p>Architectural isolation: this class intentionally has zero references to owner speaker profiles
 * or biometric stores. Outbound calls can only bind {@link BrandVoice#MISS_MINUTES_TVA}.
 */
public final class OutboundCallGuard {
    public static final int DEFAULT_QUIET_START_MIN = 21 * 60;
    public static final int DEFAULT_QUIET_END_MIN = 8 * 60;
    public static final int DEFAULT_MAX_CALLS_PER_DAY = 5;
    public static final int MAX_FACTS = 8;
    public static final int MAX_FACT_LENGTH = 140;

    public enum BrandVoice {
        MISS_MINUTES_TVA
    }

    public enum CallState {
        DRAFT, VALIDATED, DISCLOSED, CONNECTED, COMPLETED, ABORTED
    }

    public enum FactKind {
        SCHEDULED_WINDOW("scheduled_window"),
        BOOKING_NAME("booking_name"),
        CALLBACK_NUMBER("callback_number"),
        REFERENCE_CODE("reference_code"),
        BRIEF_TOPIC("brief_topic");

        public final String wireName;

        FactKind(String wireName) {
            this.wireName = wireName;
        }

        public static FactKind fromWire(String name) {
            if (name == null) return null;
            for (FactKind k : values()) {
                if (k.wireName.equals(name)) return k;
            }
            return null;
        }
    }

    public static final class Fact {
        public final FactKind kind;
        public final String value;

        public Fact(FactKind kind, String value) {
            this.kind = kind;
            this.value = value;
        }

        public void validate() {
            if (kind == null || value == null) {
                throw new IllegalArgumentException("Disclosed fact must specify kind and value.");
            }
            String trimmed = value.trim();
            if (trimmed.isEmpty() || trimmed.length() > MAX_FACT_LENGTH) {
                throw new IllegalArgumentException("Disclosed fact value must be 1..140 characters.");
            }
            if (trimmed.indexOf('\n') >= 0 || trimmed.indexOf('\r') >= 0
                    || trimmed.contains("sk-") || trimmed.contains("Bearer ")) {
                throw new IllegalArgumentException("Disclosed fact contains disallowed control text or secret prefix.");
            }
            if (kind == FactKind.CALLBACK_NUMBER && !isValidE164(trimmed)) {
                throw new IllegalArgumentException("Callback number must be strict E.164 format.");
            }
        }
    }

    public static final class Policy {
        public final int quietStartMin;
        public final int quietEndMin;
        public final int maxCallsPerDay;

        public Policy(int quietStartMin, int quietEndMin, int maxCallsPerDay) {
            this.quietStartMin = quietStartMin;
            this.quietEndMin = quietEndMin;
            this.maxCallsPerDay = maxCallsPerDay;
        }

        public static Policy defaults() {
            return new Policy(DEFAULT_QUIET_START_MIN, DEFAULT_QUIET_END_MIN, DEFAULT_MAX_CALLS_PER_DAY);
        }

        public boolean isQuietHour(int localMinuteOfDay) {
            int m = ((localMinuteOfDay % 1440) + 1440) % 1440;
            if (quietStartMin > quietEndMin) {
                return m >= quietStartMin || m < quietEndMin;
            }
            return m >= quietStartMin && m < quietEndMin;
        }
    }

    public static final class Ledger {
        public final Set<String> dncNumbers;
        public final int callsPlacedToday;

        public Ledger(Set<String> dncNumbers, int callsPlacedToday) {
            this.dncNumbers = dncNumbers == null ? Collections.emptySet() : new HashSet<>(dncNumbers);
            this.callsPlacedToday = Math.max(0, callsPlacedToday);
        }
    }

    public static final class PreparedCall {
        public final String callId;
        public final String destinationE164;
        public final String callerLabel;
        public final BrandVoice voice;
        public final String disclosureOpening;
        public final List<Fact> allowedFacts;
        private CallState state;

        PreparedCall(
                String callId,
                String destinationE164,
                String callerLabel,
                BrandVoice voice,
                String disclosureOpening,
                List<Fact> allowedFacts) {
            this.callId = callId;
            this.destinationE164 = destinationE164;
            this.callerLabel = callerLabel;
            this.voice = voice;
            this.disclosureOpening = disclosureOpening;
            this.allowedFacts = Collections.unmodifiableList(new ArrayList<>(allowedFacts));
            this.state = CallState.VALIDATED;
        }

        public synchronized CallState state() {
            return state;
        }

        public synchronized void markDisclosed() {
            if (state != CallState.VALIDATED || disclosureOpening == null || disclosureOpening.trim().isEmpty()) {
                throw new IllegalStateException("Call must be validated with a non-empty AI disclosure before marking disclosed.");
            }
            state = CallState.DISCLOSED;
        }

        public synchronized void markConnected() {
            if (state != CallState.DISCLOSED) {
                throw new IllegalStateException("AI identity disclosure must be delivered before the call enters CONNECTED state.");
            }
            state = CallState.CONNECTED;
        }

        public synchronized void complete() {
            if (state != CallState.DISCLOSED && state != CallState.CONNECTED) {
                throw new IllegalStateException("Call cannot complete from state " + state + ".");
            }
            state = CallState.COMPLETED;
        }

        public synchronized void abort() {
            state = CallState.ABORTED;
        }
    }

    private OutboundCallGuard() {}

    /** Strict E.164 check: '+' followed by 7 to 15 digits, country code starting with 1..9. */
    public static boolean isValidE164(String number) {
        if (number == null || !number.startsWith("+")) return false;
        String rest = number.substring(1);
        if (rest.length() < 7 || rest.length() > 15) return false;
        char first = rest.charAt(0);
        if (first < '1' || first > '9') return false;
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    public static PreparedCall prepare(
            String destinationE164,
            String ownerFirstName,
            List<Fact> facts,
            BrandVoice voice,
            int localMinuteOfDay,
            Policy policy,
            Ledger ledger,
            boolean ownerConfirmed) {
        if (voice != BrandVoice.MISS_MINUTES_TVA) {
            throw new IllegalArgumentException("Outbound calls may only use Miss Minutes brand voice.");
        }
        if (!isValidE164(destinationE164)) {
            throw new IllegalArgumentException("Destination phone number must use strict E.164 format (+[country][number]).");
        }
        if (ledger.dncNumbers.contains(destinationE164)) {
            throw new IllegalStateException("Destination number is on the Do-Not-Call registry.");
        }
        if (policy.isQuietHour(localMinuteOfDay)) {
            throw new IllegalStateException("Quiet hours are active (21:00-08:00 local time); outbound calling is deferred.");
        }
        if (ledger.callsPlacedToday >= policy.maxCallsPerDay) {
            throw new IllegalStateException("Daily outbound call cap (" + policy.maxCallsPerDay + ") reached.");
        }
        if (facts == null || facts.isEmpty() || facts.size() > MAX_FACTS) {
            throw new IllegalArgumentException("Outbound calls require between 1 and " + MAX_FACTS + " allowed facts.");
        }
        for (Fact f : facts) {
            if (f == null) throw new IllegalArgumentException("Disclosed fact entry cannot be null.");
            f.validate();
        }
        if (!ownerConfirmed) {
            throw new SecurityException("Explicit owner confirmation is required before placing an outbound call.");
        }
        String cleanName = ownerFirstName == null || ownerFirstName.trim().isEmpty()
                ? "the account owner"
                : ownerFirstName.trim().replace('\n', ' ').replace('\r', ' ');
        String disclosure = "Hello, this is Miss Minutes, an automated AI assistant calling on behalf of "
                + cleanName + ". I will only share authorized scheduling details.";
        return new PreparedCall(
                UUID.randomUUID().toString(),
                destinationE164,
                cleanName,
                voice,
                disclosure,
                facts);
    }

    public static String todayKey() {
        return LocalDate.now().toString();
    }
}
