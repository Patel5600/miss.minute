package com.patel5600.missminute.mobile.app_world.physics;

import android.graphics.RectF;
import com.patel5600.missminute.mobile.app_world.spatial.LandingSurface;
import com.patel5600.missminute.mobile.app_world.spatial.SpatialAnchor;
import com.patel5600.missminute.mobile.core.BodyState;
import com.patel5600.missminute.mobile.core.Locomotion;
import com.patel5600.missminute.mobile.core.World;

/**
 * Spatial physics coordinator handling multi-phase ballistic flight,
 * anticipation crouch, impact momentum dissipation, recovery spring,
 * and icon platform attachment.
 */
public final class SpatialPhysics {
    public enum Phase {
        ATTACHED,
        ANTICIPATION,
        BALLISTIC_FLIGHT,
        IMPACT_SQUASH,
        RECOVERY,
        CONTROLLED_FALL
    }

    public interface Listener {
        void onSquash(double amount);
        void onFlightProgress(double progress);
        void onLanded(SpatialAnchor targetAnchor, LandingSurface targetSurface);
        void onFallSettled();
    }

    private static final long ANTICIPATION_DURATION_MS = 160L;
    private static final long RECOVERY_DURATION_MS = 200L;

    private Phase phase = Phase.ATTACHED;
    private BallisticSolver.TrajectoryPlan currentPlan;
    private SpatialAnchor targetAnchor;
    private LandingSurface targetSurface;
    private SpatialAnchor attachedAnchor;
    private LandingSurface attachedSurface;

    private long phaseStartMs;
    private double flightTime;
    private Listener listener;

    public SpatialPhysics() {
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public Phase getPhase() {
        return phase;
    }

    public SpatialAnchor getAttachedAnchor() {
        return attachedAnchor;
    }

    public LandingSurface getAttachedSurface() {
        return attachedSurface;
    }

    public void setAttached(SpatialAnchor anchor, LandingSurface surface) {
        this.attachedAnchor = anchor;
        this.attachedSurface = surface;
        this.phase = Phase.ATTACHED;
        this.currentPlan = null;
    }

    public void clearAttachment() {
        this.attachedAnchor = null;
        this.attachedSurface = null;
        this.phase = Phase.ATTACHED;
    }

    /**
     * Initiates a ballistic jump to a target spatial anchor and landing surface.
     *
     * @return true if trajectory was successfully computed and jump started, false otherwise.
     */
    public boolean launchJump(BodyState body, World world, SpatialAnchor target,
                              LandingSurface surface, long nowMs) {
        if (target == null || surface == null) {
            return false;
        }

        float[] targetPos = target.getAttachment(surface, world.boxW, world.boxH, world.footInset);
        // Clamp target position to world bounds
        double xd = Math.max(world.minX(), Math.min(world.maxX(), targetPos[0]));
        double yd = Math.max(world.ceilTop(), Math.min(world.floorTop(), targetPos[1]));

        BallisticSolver.TrajectoryPlan plan = BallisticSolver.solve(
                body.x, body.y, xd, yd, BallisticSolver.DEFAULT_GRAVITY, world.ceilTop());

        if (plan == null) {
            return false;
        }

        this.currentPlan = plan;
        this.targetAnchor = target;
        this.targetSurface = surface;
        this.phase = Phase.ANTICIPATION;
        this.phaseStartMs = nowMs;
        this.flightTime = 0.0;

        // Crouch in anticipation
        if (listener != null) {
            listener.onSquash(0.35); // anticipation crouch
        }
        return true;
    }

    /**
     * Steps the physical integration by delta time dt (in seconds).
     */
    public void step(BodyState body, World world, double dt, long nowMs) {
        switch (phase) {
            case ATTACHED:
                // Keep body anchored to current anchor if still valid
                if (attachedAnchor != null && attachedSurface != null) {
                    float[] pos = attachedAnchor.getAttachment(attachedSurface, world.boxW, world.boxH, world.footInset);
                    body.x = pos[0];
                    body.y = pos[1];
                    body.vx = 0;
                    body.vy = 0;
                    body.grounded = true;
                }
                break;

            case ANTICIPATION:
                // Character pauses and squashes down before takeoff
                body.vx = 0;
                body.vy = 0;
                if (nowMs - phaseStartMs >= ANTICIPATION_DURATION_MS) {
                    // Launch impulse!
                    phase = Phase.BALLISTIC_FLIGHT;
                    flightTime = 0.0;
                    body.grounded = false;
                    body.locomotion = Locomotion.JUMP;
                    body.facing = (currentPlan.xd >= body.x) ? 1 : -1;
                    attachedAnchor = null;
                    attachedSurface = null;
                }
                break;

            case BALLISTIC_FLIGHT:
                if (currentPlan == null) {
                    phase = Phase.CONTROLLED_FALL;
                    return;
                }
                flightTime += dt;
                float[] pos = currentPlan.samplePosition(flightTime);
                float[] vel = currentPlan.sampleVelocity(flightTime);

                body.x = pos[0];
                body.y = pos[1];
                body.vx = vel[0];
                body.vy = vel[1];

                if (listener != null) {
                    listener.onFlightProgress(flightTime / currentPlan.duration);
                }

                // Contact detection: check if flight duration reached or target arrived
                if (flightTime >= currentPlan.duration) {
                    // Direct landing contact on target anchor!
                    body.x = currentPlan.xd;
                    body.y = currentPlan.yd;
                    body.vx = 0;
                    body.vy = 0;
                    body.grounded = true;

                    // Impact momentum dissipation into squash
                    phase = Phase.IMPACT_SQUASH;
                    phaseStartMs = nowMs;
                    if (listener != null) {
                        listener.onSquash(currentPlan.estimatedSquash);
                        listener.onLanded(targetAnchor, targetSurface);
                    }
                }
                break;

            case IMPACT_SQUASH:
                body.vx = 0;
                body.vy = 0;
                // Transition into recovery bounce
                phase = Phase.RECOVERY;
                phaseStartMs = nowMs;
                break;

            case RECOVERY:
                body.vx = 0;
                body.vy = 0;
                long elapsedRecovery = nowMs - phaseStartMs;
                if (elapsedRecovery >= RECOVERY_DURATION_MS) {
                    // Lock attachment
                    phase = Phase.ATTACHED;
                    attachedAnchor = targetAnchor;
                    attachedSurface = targetSurface;
                    targetAnchor = null;
                    targetSurface = null;
                    currentPlan = null;
                    if (listener != null) {
                        listener.onSquash(0.0);
                    }
                }
                break;

            case CONTROLLED_FALL:
                // Integrate gravity downward until landing on floor or safe boundary
                body.vy += BallisticSolver.DEFAULT_GRAVITY * dt;
                body.y += body.vy * dt;
                if (body.y >= world.floorTop()) {
                    body.y = world.floorTop();
                    body.vy = 0;
                    body.vx = 0;
                    body.grounded = true;
                    body.locomotion = Locomotion.STAND;
                    phase = Phase.ATTACHED;
                    attachedAnchor = null;
                    attachedSurface = null;
                    if (listener != null) {
                        listener.onSquash(0.4);
                        listener.onFallSettled();
                    }
                }
                break;
        }
    }
}
