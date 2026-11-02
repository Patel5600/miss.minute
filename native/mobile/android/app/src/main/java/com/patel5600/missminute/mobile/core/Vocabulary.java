package com.patel5600.missminute.mobile.core;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * Names shared with the web layer. Each list equals its twin in
 * tests/android/vectors/vocabulary.json (VocabularyTest).
 */
public final class Vocabulary {
    private Vocabulary() {
    }

    public static final List<String> EMOTIONS = list(
            "cheerful", "talking", "winking", "suspicious", "scary", "thinking", "pruning",
            "blushing", "stern", "surprised", "sassy", "worried");

    public static final List<String> GESTURES = list(
            "wave", "shrug", "point", "hips", "present", "think", "knock", "clap");

    /** What the rig can draw today (read from the code). */
    public static final List<String> BASELINE_CAPABILITIES = list(
            "idle", "walk", "drag", "fall", "hop", "squash",
            "run", "hang", "sit-edge", "climb", "jump", "peek", "nap", "teleport", "think",
            "gesture:wave", "gesture:shrug", "gesture:point", "gesture:hips",
            "gesture:present", "gesture:think", "gesture:knock", "gesture:clap");

    public static final List<String> CAPABILITY_NAMES = list(
            "idle", "walk", "drag", "fall", "hop", "squash", "run", "hang", "sit-edge", "climb", "jump", "peek", "nap", "teleport", "think",
            "gesture:wave", "gesture:shrug", "gesture:point", "gesture:hips", "gesture:present", "gesture:think",
            "gesture:knock", "gesture:clap",
            "stand:look-around", "stand:stretch", "stand:foot-tap", "stand:glance-clock", "stand:wave-cursor",
            "stand:yawn");

    public static final List<String> ERROR_CODES = list(
            "bad_json", "bad_version", "bad_type", "too_large", "bad_payload",
            "forbidden", "unknown_type", "unavailable", "cancelled", "internal");

    public static final List<String> EVENT_NAMES = list(
            "state.changed", "kill.happened", "provider.event", "approval.requested", "reminder.fired",
            "voice.state", "voice.partial", "voice.final", "voice.range");

    private static List<String> list(String... names) {
        return Collections.unmodifiableList(Arrays.asList(names));
    }
}