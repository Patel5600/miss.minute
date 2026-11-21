package com.patel5600.missminute.mobile.core.policy;

/**
 * Everything she could be asked to do. Capabilities marked unavailable exist for vocabulary parity
 * with the desktop and are always denied on Android.
 */
public enum Capability {
    TIMER_CREATE("timer.create", Risk.LOW, true),
    REMINDER_CREATE("reminder.create", Risk.LOW, true),
    NOTE_CREATE("note.create", Risk.LOW, true),
    TODO_UPDATE("todo.update", Risk.LOW, true),
    /** Creates a pending candidate only; the owner reviews it. */
    MEMORY_PROPOSE("memory.propose", Risk.LOW, true),
    SYSTEM_READ("system.read", Risk.LOW, true),
    APP_OPEN("app.open", Risk.MEDIUM, true),
    NOTE_DELETE("note.delete", Risk.ALWAYS_ASK, true),
    TODO_DELETE("todo.delete", Risk.ALWAYS_ASK, true),
    MIC_CAPTURE("mic.capture", Risk.OWNER_ONLY, true),
    SEARCH_WEB("search.web", Risk.LOW, false),
    PRESENCE_OBSERVE("presence.observe", Risk.MEDIUM, false),
    FILE_READ("file.read", Risk.MEDIUM, false),
    FILE_WRITE("file.write", Risk.ALWAYS_ASK, false),
    FILE_DELETE("file.delete", Risk.ALWAYS_ASK, false),
    COMMAND_RUN("command.run", Risk.ALWAYS_ASK, false),
    SCREEN_CAPTURE("screen.capture", Risk.ALWAYS_ASK, false),
    MESSAGE_SEND("message.send", Risk.ALWAYS_ASK, false),
    CREDENTIAL_ACCESS("credential.access", Risk.ALWAYS_ASK, false),
    PURCHASE("purchase", Risk.ALWAYS_ASK, false);

    public final String wireName;
    public final Risk risk;
    public final boolean availableOnAndroid;

    Capability(String wireName, Risk risk, boolean availableOnAndroid) {
        this.wireName = wireName;
        this.risk = risk;
        this.availableOnAndroid = availableOnAndroid;
    }

    /** Null for an unknown name. */
    public static Capability fromWire(String name) {
        for (Capability c : values()) {
            if (c.wireName.equals(name)) {
                return c;
            }
        }
        return null;
    }
}