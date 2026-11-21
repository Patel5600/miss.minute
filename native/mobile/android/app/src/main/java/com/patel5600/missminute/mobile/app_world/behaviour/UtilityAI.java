package com.patel5600.missminute.mobile.app_world.behaviour;

import android.util.Log;

import com.patel5600.missminute.mobile.app_world.physics.BallisticSolver;
import com.patel5600.missminute.mobile.app_world.spatial.AppRegistry;
import com.patel5600.missminute.mobile.app_world.spatial.LandingSurface;
import com.patel5600.missminute.mobile.app_world.spatial.SpatialAnchor;
import com.patel5600.missminute.mobile.app_world.spatial.SpatialMemory;
import com.patel5600.missminute.mobile.core.BodyState;
import com.patel5600.missminute.mobile.core.Mulberry32;
import com.patel5600.missminute.mobile.core.PowerDecision;
import com.patel5600.missminute.mobile.core.PowerTier;
import com.patel5600.missminute.mobile.core.RoamingLevel;
import com.patel5600.missminute.mobile.core.World;

import java.util.ArrayList;
import java.util.List;

/**
 * Utility-Based AI Engine for autonomous companion decisions.
 * Scores candidates deterministically via:
 *   Score = (Weight_base * Relevance_context * Feasibility_dest) - Cost_energy - Penalty_recent
 *
 * Fully event-driven: allows NO_ACTION as a valid high-utility choice.
 */
public final class UtilityAI {
    private static final String TAG = "MMUtilityAI";

    private final Mulberry32 tieBreakerRng;

    public UtilityAI(long seed) {
        this.tieBreakerRng = new Mulberry32(seed);
    }

    /**
     * Evaluates the environment and selects the highest-scoring ActionCandidate.
     */
    public ActionLibrary.ActionCandidate selectBestAction(
            World world,
            BodyState body,
            SpatialAnchor currentAnchor,
            LandingSurface currentSurface,
            List<SpatialAnchor> validAnchors,
            SpatialMemory memory,
            AppRegistry registry,
            PowerDecision power,
            RoamingLevel roaming,
            EventRouter.DeviceEvent event,
            boolean isLauncherInForeground,
            long nowMs) {

        // 1. If an app just opened in the foreground, retreat to screen edge so UI is not blocked
        if (event != null && event.type == EventRouter.EventType.FOREGROUND_APP_CHANGED) {
            String fgPkg = event.stringData;
            boolean isLauncher = fgPkg != null && (fgPkg.contains("launcher") || fgPkg.contains("home"));
            if (!isLauncher && fgPkg != null && !fgPkg.isEmpty()) {
                AppRegistry.AppEntry entry = registry != null ? registry.find(fgPkg) : null;
                String quote = entry != null ? entry.contextualQuote : null;
                Log.i(TAG, "Foreground app switched to " + fgPkg + ". Retreating to safe screen-edge perch.");
                return new ActionLibrary.ActionCandidate(
                        ActionLibrary.ActionKind.RETREAT_TO_EDGE,
                        null,
                        LandingSurface.TOP,
                        3000L,
                        quote,
                        "point",
                        com.patel5600.missminute.mobile.core.Locomotion.HANG,
                        100.0 // maximum priority
                );
            }
        }

        // 2. If launcher is NOT in foreground and user didn't tap, remain at screen edge
        if (!isLauncherInForeground) {
            return ActionLibrary.ActionCandidate.noAction(5000L, 50.0);
        }

        // 3. User touch event: high responsiveness
        if (event != null && event.type == EventRouter.EventType.USER_TOUCH) {
            if (currentAnchor != null) {
                AppRegistry.AppEntry entry = registry != null ? registry.find(currentAnchor.packageId) : null;
                String quote = entry != null ? entry.contextualQuote : null;
                return ActionLibrary.ActionCandidate.wave(currentAnchor, currentSurface, 90.0);
            }
        }

        // 4. Generate candidate actions
        List<ActionLibrary.ActionCandidate> candidates = new ArrayList<>();

        // Candidate: NO_ACTION (staying resting on current icon or floor)
        double restScore = 30.0;
        if (currentAnchor != null) {
            restScore += 15.0; // comfy on an icon
        }
        if (power.tier == PowerTier.REDUCED || power.tier == PowerTier.MINIMAL) {
            restScore += 40.0; // resting saves battery
        }
        candidates.add(ActionLibrary.ActionCandidate.noAction(8000L, restScore));

        // Candidates on Current Anchor (if attached)
        if (currentAnchor != null) {
            // Wave from icon
            candidates.add(ActionLibrary.ActionCandidate.wave(currentAnchor, currentSurface, 35.0));

            // Speak contextual lore for this app
            AppRegistry.AppEntry entry = registry != null ? registry.find(currentAnchor.packageId) : null;
            if (entry != null && entry.contextualQuote != null) {
                double quoteScore = 40.0;
                double recency = memory.getRecencyPenalty(currentAnchor.packageId, nowMs);
                quoteScore -= (recency * 25.0);
                candidates.add(ActionLibrary.ActionCandidate.speak(currentAnchor, entry.contextualQuote, quoteScore));
            }

            // Reposition to another surface of the same icon (e.g. sit on TOP, climb LEFT, hang BOTTOM)
            for (LandingSurface s : currentAnchor.availableSurfaces) {
                if (s != currentSurface) {
                    if (s == LandingSurface.TOP) {
                        candidates.add(ActionLibrary.ActionCandidate.sit(currentAnchor, s, 6000L, 38.0));
                    } else if (s == LandingSurface.LEFT || s == LandingSurface.RIGHT) {
                        candidates.add(ActionLibrary.ActionCandidate.climb(currentAnchor, s, 4000L, 32.0));
                    } else if (s == LandingSurface.BOTTOM) {
                        candidates.add(ActionLibrary.ActionCandidate.hang(currentAnchor, s, 5000L, 34.0));
                    } else if (s == LandingSurface.CENTER) {
                        candidates.add(ActionLibrary.ActionCandidate.peek(currentAnchor, 3000L, 28.0));
                    }
                }
            }
        }

        // Candidate: JUMP_TO_APP (ballistic jump to another valid anchor)
        if (roaming.atLeast(RoamingLevel.LIVELY) && power.tier != PowerTier.REDUCED && power.tier != PowerTier.MINIMAL) {
            if (validAnchors != null) {
                for (SpatialAnchor target : validAnchors) {
                    // Do not jump to same anchor
                    if (currentAnchor != null && target.packageId.equals(currentAnchor.packageId)) {
                        continue;
                    }

                    // Check ballistic reachability
                    float[] targetTop = target.getAttachment(LandingSurface.TOP, world.boxW, world.boxH, world.footInset);
                    BallisticSolver.TrajectoryPlan plan = BallisticSolver.solve(
                            body.x, body.y, targetTop[0], targetTop[1], BallisticSolver.DEFAULT_GRAVITY, world.ceilTop());

                    if (plan == null) {
                        continue; // out of reach or obstructed
                    }

                    double baseWeight = 50.0;
                    double distance = Math.hypot(targetTop[0] - body.x, targetTop[1] - body.y);
                    double feasibility = Math.max(0.2, 1.0 - (distance / BallisticSolver.MAX_REACH_DISTANCE) * 0.5);
                    double energyCost = (distance / 500.0) * 10.0;
                    double recencyPenalty = memory.getRecencyPenalty(target.packageId, nowMs) * 35.0;

                    double finalScore = (baseWeight * feasibility) - energyCost - recencyPenalty;
                    candidates.add(ActionLibrary.ActionCandidate.jump(target, LandingSurface.TOP, finalScore));
                }
            }
        }

        // 5. Select candidate with highest utility score
        ActionLibrary.ActionCandidate best = null;
        double bestScore = Double.NEGATIVE_INFINITY;

        for (ActionLibrary.ActionCandidate c : candidates) {
            // Apply tiny bounded seeded tie-breaking jitter
            double jitter = tieBreakerRng.range(0.0, 0.05);
            double totalScore = c.score + jitter;
            if (totalScore > bestScore) {
                bestScore = totalScore;
                best = c;
            }
        }

        if (best == null) {
            best = ActionLibrary.ActionCandidate.noAction(5000L, 1.0);
        }

        Log.i(TAG, "Selected action: " + best + " [score=" + String.format("%.2f", bestScore) + "]");
        return best;
    }
}
