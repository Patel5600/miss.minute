package com.patel5600.missminute.mobile.core;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The behaviour table from the plan. Run, sit-edge, hang, climb, nap, jump and peek exist here and
 * are unit-tested, but stay off until the rig reports the matching capability.
 */
public final class BehaviourCatalog {
    private final List<Behaviour> behaviours;

    public BehaviourCatalog(List<Behaviour> behaviours) {
        this.behaviours = Collections.unmodifiableList(new ArrayList<>(behaviours));
    }

    public List<Behaviour> all() {
        return behaviours;
    }

    public Behaviour find(String id) {
        for (Behaviour b : behaviours) {
            if (b.id.equals(id)) {
                return b;
            }
        }
        return null;
    }

    public static BehaviourCatalog defaults() {
        List<Behaviour> list = new ArrayList<>();
        list.add(new Behaviour("stand", Behaviour.Kind.STAND, "idle", RoamingLevel.DOCKED, 10, 0, 2000, 6000, null));
        for (String g : Vocabulary.GESTURES) {
            list.add(new Behaviour("gesture:" + g, Behaviour.Kind.GESTURE, "gesture:" + g, RoamingLevel.DOCKED, 3,
                    20_000, 1500, 3500, g));
        }
        list.add(new Behaviour("hop", Behaviour.Kind.HOP, "hop", RoamingLevel.CALM, 2, 25_000, 700, 900, null));
        // Walking is her basic way of roaming, so it has no cooldown; the anti-repeat rule still applies.
        list.add(new Behaviour("walk", Behaviour.Kind.WALK, "walk", RoamingLevel.CALM, 8, 0, 1500, 15_000, null));
        list.add(new Behaviour("run", Behaviour.Kind.RUN, "run", RoamingLevel.LIVELY, 2, 40_000, 800, 8000, null));
        list.add(new Behaviour("sit-edge", Behaviour.Kind.SIT_EDGE, "sit-edge", RoamingLevel.LIVELY, 4, 90_000,
                6000, 20_000, null));
        list.add(new Behaviour("hang", Behaviour.Kind.HANG, "hang", RoamingLevel.LIVELY, 3, 60_000, 5000, 15_000, null));
        list.add(new Behaviour("climb", Behaviour.Kind.CLIMB, "climb", RoamingLevel.LIVELY, 3, 60_000, 3000, 10_000,
                null));
        list.add(new Behaviour("nap", Behaviour.Kind.NAP, "nap", RoamingLevel.LIVELY, 2, 90_000, 15_000, 40_000, null));
        list.add(new Behaviour("jump", Behaviour.Kind.JUMP, "jump", RoamingLevel.WILD, 3, 45_000, 800, 1500, null));
        list.add(new Behaviour("peek", Behaviour.Kind.PEEK, "peek", RoamingLevel.WILD, 2, 60_000, 3000, 8000, null));
        list.add(new Behaviour("teleport", Behaviour.Kind.TELEPORT, "teleport", RoamingLevel.WILD, 2, 60_000, 400, 800, null));
        list.add(new Behaviour("think", Behaviour.Kind.THINK, "think", RoamingLevel.CALM, 4, 20_000, 3000, 8000, null));
        return new BehaviourCatalog(list);
    }
}