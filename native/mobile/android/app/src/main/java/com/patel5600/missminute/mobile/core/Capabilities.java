package com.patel5600.missminute.mobile.core;

import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/** The poses the rig can draw, as reported by the overlay page's {@code hello}. Immutable. */
public final class Capabilities {
    private final Set<String> names;

    private Capabilities(Set<String> names) {
        this.names = Collections.unmodifiableSet(names);
    }

    /** What the rig is known to draw today; everything else stays off until the page reports it. */
    public static Capabilities baseline() {
        return new Capabilities(new LinkedHashSet<>(Vocabulary.BASELINE_CAPABILITIES));
    }

    /** Only the names that exist in the vocabulary are kept. */
    public static Capabilities of(Collection<String> reported) {
        Set<String> kept = new LinkedHashSet<>();
        for (String name : Vocabulary.CAPABILITY_NAMES) {
            if (reported.contains(name)) {
                kept.add(name);
            }
        }
        return new Capabilities(kept);
    }

    /** Every capability in the vocabulary. For tests and for a rig that has all the poses. */
    public static Capabilities all() {
        return new Capabilities(new LinkedHashSet<>(Vocabulary.CAPABILITY_NAMES));
    }

    public boolean has(String name) {
        return names.contains(name);
    }

    public Capabilities with(String... extra) {
        Set<String> next = new LinkedHashSet<>(names);
        for (String name : extra) {
            if (Vocabulary.CAPABILITY_NAMES.contains(name)) {
                next.add(name);
            }
        }
        return new Capabilities(next);
    }

    public Set<String> names() {
        return names;
    }
}