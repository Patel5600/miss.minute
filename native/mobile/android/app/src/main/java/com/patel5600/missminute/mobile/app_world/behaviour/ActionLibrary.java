package com.patel5600.missminute.mobile.app_world.behaviour;

import com.patel5600.missminute.mobile.app_world.spatial.LandingSurface;
import com.patel5600.missminute.mobile.app_world.spatial.SpatialAnchor;
import com.patel5600.missminute.mobile.core.Locomotion;

/**
 * Catalog of executable semantic action primitives for the autonomous companion.
 */
public final class ActionLibrary {

    public enum ActionKind {
        /** Explicit valid state: staying resting/perched on current icon or edge. Zero timers! */
        NO_ACTION,

        /** Ballistic jump from current position to a target spatial icon. */
        JUMP_TO_APP,

        /** Sits comfortably on top of an icon with legs visibly dangling over the upper edge. */
        SIT_ON_APP,

        /** Climbs vertically along the side of an app icon. */
        CLIMB_ICON,

        /** Hangs beneath the bottom of an app icon or from the top status bar. */
        HANG_FROM_ICON,

        /** Peeks playfully from behind the icon body. */
        PEEK_BEHIND_ICON,

        /** Waves to the user from the current perch. */
        WAVE_FROM_ICON,

        /** Speaks contextual TVA dialogue about the current application. */
        SPEAK_CONTEXTUAL,

        /** Safely perches on screen edge (status bar or side bezel) when an app opens. */
        RETREAT_TO_EDGE
    }

    public static final class ActionCandidate {
        public final ActionKind kind;
        public final SpatialAnchor targetAnchor;
        public final LandingSurface targetSurface;
        public final long durationMs;
        public final String speechText;
        public final String gestureName;
        public final Locomotion locomotion;
        public double score;

        public ActionCandidate(ActionKind kind, SpatialAnchor targetAnchor,
                               LandingSurface targetSurface, long durationMs,
                               String speechText, String gestureName,
                               Locomotion locomotion, double score) {
            this.kind = kind;
            this.targetAnchor = targetAnchor;
            this.targetSurface = targetSurface;
            this.durationMs = durationMs;
            this.speechText = speechText;
            this.gestureName = gestureName;
            this.locomotion = locomotion;
            this.score = score;
        }

        public static ActionCandidate noAction(long durationMs, double score) {
            return new ActionCandidate(ActionKind.NO_ACTION, null, null,
                    durationMs, null, null, Locomotion.STAND, score);
        }

        public static ActionCandidate jump(SpatialAnchor anchor, LandingSurface surface, double score) {
            return new ActionCandidate(ActionKind.JUMP_TO_APP, anchor, surface,
                    1500L, null, null, Locomotion.JUMP, score);
        }

        public static ActionCandidate sit(SpatialAnchor anchor, LandingSurface surface, long durationMs, double score) {
            return new ActionCandidate(ActionKind.SIT_ON_APP, anchor, surface,
                    durationMs, null, null, Locomotion.SIT_EDGE, score);
        }

        public static ActionCandidate climb(SpatialAnchor anchor, LandingSurface surface, long durationMs, double score) {
            return new ActionCandidate(ActionKind.CLIMB_ICON, anchor, surface,
                    durationMs, null, null, Locomotion.CLIMB, score);
        }

        public static ActionCandidate hang(SpatialAnchor anchor, LandingSurface surface, long durationMs, double score) {
            return new ActionCandidate(ActionKind.HANG_FROM_ICON, anchor, surface,
                    durationMs, null, null, Locomotion.HANG, score);
        }

        public static ActionCandidate peek(SpatialAnchor anchor, long durationMs, double score) {
            return new ActionCandidate(ActionKind.PEEK_BEHIND_ICON, anchor, LandingSurface.CENTER,
                    durationMs, null, null, Locomotion.PEEK, score);
        }

        public static ActionCandidate wave(SpatialAnchor anchor, LandingSurface surface, double score) {
            return new ActionCandidate(ActionKind.WAVE_FROM_ICON, anchor, surface,
                    2000L, null, "wave", Locomotion.STAND, score);
        }

        public static ActionCandidate speak(SpatialAnchor anchor, String quote, double score) {
            return new ActionCandidate(ActionKind.SPEAK_CONTEXTUAL, anchor, null,
                    3000L, quote, "present", Locomotion.STAND, score);
        }

        public static ActionCandidate retreatToEdge(long durationMs, double score) {
            return new ActionCandidate(ActionKind.RETREAT_TO_EDGE, null, LandingSurface.TOP,
                    durationMs, null, null, Locomotion.HANG, score);
        }

        @Override
        public String toString() {
            return "ActionCandidate{" + kind +
                    (targetAnchor != null ? " on " + targetAnchor.packageId : "") +
                    (targetSurface != null ? " surface=" + targetSurface : "") +
                    " score=" + String.format("%.2f", score) + "}";
        }
    }

    private ActionLibrary() {
    }
}
