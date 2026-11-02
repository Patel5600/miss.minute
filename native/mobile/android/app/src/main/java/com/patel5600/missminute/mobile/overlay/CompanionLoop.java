package com.patel5600.missminute.mobile.overlay;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Choreographer;

import com.patel5600.missminute.mobile.BuildConfig;
import com.patel5600.missminute.mobile.app.Settings;
import com.patel5600.missminute.mobile.core.Behaviour;
import com.patel5600.missminute.mobile.core.BehaviourCatalog;
import com.patel5600.missminute.mobile.core.BehaviourDirector;
import com.patel5600.missminute.mobile.core.BehaviourPlan;
import com.patel5600.missminute.mobile.core.BodyState;
import com.patel5600.missminute.mobile.core.Capabilities;
import com.patel5600.missminute.mobile.core.Clock;
import com.patel5600.missminute.mobile.core.DirectorContext;
import com.patel5600.missminute.mobile.core.FrameGate;
import com.patel5600.missminute.mobile.core.FrameStats;
import com.patel5600.missminute.mobile.core.JumpSolver;
import com.patel5600.missminute.mobile.core.Locomotion;
import com.patel5600.missminute.mobile.core.OverlayState;
import com.patel5600.missminute.mobile.core.Physics;
import com.patel5600.missminute.mobile.core.PhysicsConfig;
import com.patel5600.missminute.mobile.core.PowerDecision;
import com.patel5600.missminute.mobile.core.PowerInputs;
import com.patel5600.missminute.mobile.core.PowerPolicy;
import com.patel5600.missminute.mobile.core.PowerTier;
import com.patel5600.missminute.mobile.core.RoamingLevel;
import com.patel5600.missminute.mobile.core.SettingsRules;
import com.patel5600.missminute.mobile.core.Visibility;
import com.patel5600.missminute.mobile.core.VisibilityInputs;
import com.patel5600.missminute.mobile.core.VisibilityPolicy;
import com.patel5600.missminute.mobile.core.Vocabulary;
import com.patel5600.missminute.mobile.core.World;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Drives her on the main thread. Native owns position and physics; the page only draws.
 *
 * <p>Each frame (capped at 30 fps, 15 on battery saver or under 20%, 8 when docked, none while the
 * screen is off) it advances the physics in fixed steps, asks the {@link BehaviourDirector} for the
 * next behaviour when the last one ended, moves her window, and tells the page about a pose change only
 * when the pose changed. Every decision comes from the already-tested {@code core} classes; this class
 * only connects them to the Choreographer, the window and the page.
 */
final class CompanionLoop implements Choreographer.FrameCallback, OverlayTouch.Listener {
    interface Host {
        /** The owner held her for 600 ms. The numbers are her window's place on screen, in pixels. */
        void onLongPress(int xPx, int yPx, int widthPx, int heightPx);

        void onVisibilityChanged(Visibility visibility);

        /** Pause or resume the page's own work (WebView). {@code timers} also pauses its JavaScript timers. */
        void pausePage(boolean timers);

        void resumePage();

        /** Android refused to add her window (for example the permission was taken away). */
        void onWindowRefused();
    }

    private static final String TAG = "MMLoop";
    private static final int DOCKED_FPS = 8;
    private static final double MAX_DT = 0.1;
    private static final long TICK_MS = 5000;
    private static final double JUMP_MAX_RISE = 160;
    private static final double JUMP_MAX_REACH = 260;

    /**
     * The capabilities the native choreography below can carry out: the baseline plus run (a faster
     * walk), jump (a ballistic arc over the floor) and nap (standing still, asleep). Hang, sit-edge,
     * climb and peek need movement along the screen edges that is not written yet, so they stay off
     * even when the rig reports a pose for them.
     */
    static final Set<String> NATIVE_CHOREOGRAPHED;

    static {
        Set<String> names = new HashSet<>(Vocabulary.BASELINE_CAPABILITIES);
        names.add("run");
        names.add("jump");
        names.add("nap");
        NATIVE_CHOREOGRAPHED = Collections.unmodifiableSet(names);
    }

    private enum Act { GAP, STAND, GESTURE, HOP, WALK, AIR, DRAG }

    private final Settings settings;
    private final Supplier<PowerInputs> powerSource;
    private final OverlayWindow window;
    private final PoseSender sender;
    private final Clock clock;
    private final Host host;
    private final KeyguardManager keyguard;
    private final Choreographer choreographer = Choreographer.getInstance();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final PhysicsConfig physics = PhysicsConfig.defaults();
    private final FrameGate gate = new FrameGate();
    private final FrameStats stats = new FrameStats();
    private final BodyState body = new BodyState();

    private World world;
    private double density;
    private BehaviourDirector director;
    private Capabilities reported = Capabilities.baseline();
    private Capabilities effective = Capabilities.baseline();
    private PowerDecision power = PowerPolicy.decide(new PowerInputs(100, true, false, true, true, false));
    private Visibility visibility = Visibility.HIDDEN;
    private PowerTier lastTier;

    private Act act = Act.GAP;
    private long actEndMs;
    private double walkTarget;
    private double walkSpeed;
    private BehaviourPlan plan;
    private boolean running;
    private boolean scheduled;
    private boolean holding;
    private boolean napping;
    private boolean userMoved;
    private long prevFrameNanos;
    private long lastInteractionMs;
    private double dragOffsetX;
    private double dragOffsetY;
    private int jumps;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            refresh();
        }
    };

    CompanionLoop(Context context, Settings settings, Supplier<PowerInputs> powerSource, OverlayWindow window,
                  PoseSender sender, World world, Clock clock, Host host) {
        this.settings = settings;
        this.powerSource = powerSource;
        this.window = window;
        this.sender = sender;
        this.world = world;
        this.density = world.density;
        this.clock = clock;
        this.host = host;
        this.keyguard = context.getSystemService(KeyguardManager.class);
    }

    // ---- lifecycle ---------------------------------------------------------------------------

    void start() {
        running = true;
        long now = clock.nowMs();
        long seed = (System.nanoTime() ^ now) & 0xFFFFFFFFL;
        director = new BehaviourDirector(seed, BehaviourCatalog.defaults(), clock);
        lastInteractionMs = now;
        placeAtStart();
        setReportedCapabilities(reported);
        refresh();
    }

    void stop() {
        running = false;
        stopFrames();
        main.removeCallbacks(tick);
    }

    private void placeAtStart() {
        float[] docked = settings.dockedPosition();
        double x = docked != null ? docked[0] : world.minX() + 0.7 * (world.maxX() - world.minX());
        body.x = clamp(x, world.minX(), world.maxX());
        body.y = world.floorTop();
        body.vx = 0;
        body.vy = 0;
        body.facing = -1;
        body.grounded = true;
        body.locomotion = Locomotion.STAND;
        act = Act.GAP;
        actEndMs = clock.nowMs() + 1200;
        syncWindow();
    }

    // ---- inputs from the service -----------------------------------------------------------

    /** The overlay page said hello with the poses its rig can draw. */
    void setReportedCapabilities(Capabilities caps) {
        reported = caps;
        List<String> kept = new ArrayList<>();
        for (String name : caps.names()) {
            if (NATIVE_CHOREOGRAPHED.contains(name)) {
                kept.add(name);
            }
        }
        effective = Capabilities.of(kept);
        if (BuildConfig.DEBUG) {
            Log.d("MMCaps", describeCapabilities());
        }
    }

    /** The page was (re)loaded and said hello: give it the current state again. */
    void resendState() {
        sender.resend();
        sendPose();
    }

    /** The screen changed (rotation, fold, density, insets). */
    void onWorldChanged(World next) {
        world = next;
        density = next.density;
        Physics.clampToWorld(body, world);
        if (body.locomotion.isAirborneKind() && act != Act.DRAG && act != Act.AIR) {
            // The floor moved down under her (for example after a rotation): she falls to it.
            plan = null;
            setAct(Act.AIR);
        }
        window.resize(Math.round((float) (next.boxW * next.density)), Math.round((float) (next.boxH * next.density)));
        window.setTouchListener(this); // the touch slop depends on the density
        syncWindow();
    }

    /** She stands still while her menu is open. */
    void setHolding(boolean hold) {
        holding = hold;
        if (hold) {
            if (act == Act.WALK) {
                body.locomotion = Locomotion.STAND;
                plan = null;
                setAct(Act.STAND);
                actEndMs = clock.nowMs() + 10_000;
            }
        } else if (act != Act.DRAG && act != Act.AIR) {
            actEndMs = Math.min(actEndMs, clock.nowMs() + 500);
        }
    }

    // ---- power and visibility --------------------------------------------------------------

    /** Re-reads the power state and the settings and applies the result. Main thread. */
    void refresh() {
        if (!running) {
            return;
        }
        long now = clock.nowMs();
        PowerInputs inputs = powerSource.get();
        PowerDecision decision = PowerPolicy.decide(inputs);
        boolean locked = keyguard != null && keyguard.isKeyguardLocked();
        VisibilityInputs visibilityInputs = new VisibilityInputs(inputs.screenOn, locked, false,
                !settings.roamingEnabled(), settings.hiddenUntilMs(), now, quietNow(), false, decision.tier);
        Visibility next = VisibilityPolicy.decide(visibilityInputs);

        if (decision.tier != lastTier) {
            lastTier = decision.tier;
            if (BuildConfig.DEBUG) {
                Log.d("MMPower", "tier=" + decision.tier + " maxFps=" + decision.maxFps + " battery="
                        + inputs.batteryPercent + " charging=" + inputs.charging + " powerSave=" + inputs.powerSave
                        + " screenOn=" + inputs.screenOn);
            }
        }
        power = decision;
        applyVisibility(next);
        applyCap();
        // While the screen is off nothing needs to wake up: the screen-on broadcast calls refresh().
        main.removeCallbacks(tick);
        if (inputs.screenOn) {
            main.postDelayed(tick, TICK_MS);
        }
    }

    private void applyVisibility(Visibility next) {
        if (next == visibility) {
            return;
        }
        visibility = next;
        switch (next) {
            case ACTIVE:
            case DOCKED:
                syncWindow();
                if (!window.show()) {
                    host.onWindowRefused();
                }
                host.resumePage();
                sender.visible(true);
                sender.resend();
                startFrames();
                break;
            case PAUSED:
                stopFrames();
                sender.visible(false);
                host.pausePage(true);
                break;
            case HIDDEN:
            default:
                stopFrames();
                sender.visible(false);
                window.hide();
                host.pausePage(false);
                break;
        }
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "visibility=" + next + " " + line(0));
        }
        host.onVisibilityChanged(next);
    }

    private boolean isDrawn() {
        return visibility == Visibility.ACTIVE || visibility == Visibility.DOCKED;
    }

    private RoamingLevel effectiveLevel() {
        RoamingLevel chosen = settings.roamingEnabled() ? settings.roamingLevel() : RoamingLevel.DOCKED;
        return RoamingLevel.min(chosen, power.levelCap);
    }

    /** 30, 15 or 0 from the power policy; 8 when docked, except while she is being moved. */
    private int currentCap() {
        int cap = power.maxFps;
        boolean interacting = act == Act.DRAG || act == Act.AIR;
        if (effectiveLevel() == RoamingLevel.DOCKED && !interacting) {
            cap = Math.min(cap, DOCKED_FPS);
        }
        return cap;
    }

    private void applyCap() {
        int cap = currentCap();
        boolean faster = cap > gate.fps();
        gate.setFps(cap);
        sender.power(cap);
        if (faster) {
            reschedule();
        }
    }

    private boolean quietNow() {
        Calendar calendar = Calendar.getInstance();
        int minute = calendar.get(Calendar.HOUR_OF_DAY) * 60 + calendar.get(Calendar.MINUTE);
        return SettingsRules.quietHoursActive(settings.quietHoursEnabled(), settings.quietHoursStart(),
                settings.quietHoursEnd(), minute);
    }

    // ---- frames ---------------------------------------------------------------------------

    private void startFrames() {
        if (!running || scheduled) {
            return;
        }
        gate.reset();
        gate.setFps(currentCap());
        prevFrameNanos = 0;
        stats.restartWindow();
        scheduled = true;
        choreographer.postFrameCallback(this);
    }

    private void stopFrames() {
        if (scheduled) {
            choreographer.removeFrameCallback(this);
            scheduled = false;
        }
    }

    /** Ask for the next frame now, for example when a drag starts while the cap is low. */
    private void reschedule() {
        if (!running || !isDrawn()) {
            return;
        }
        if (scheduled) {
            choreographer.removeFrameCallback(this);
        }
        scheduled = true;
        choreographer.postFrameCallback(this);
    }

    @Override
    public void doFrame(long frameTimeNanos) {
        scheduled = false;
        if (!running || !isDrawn()) {
            return;
        }
        if (!gate.admit(frameTimeNanos)) {
            postNext(false);
            return;
        }
        double dt = prevFrameNanos == 0
                ? 1.0 / Math.max(1, gate.fps())
                : Math.min(MAX_DT, (frameTimeNanos - prevFrameNanos) / 1e9);
        prevFrameNanos = frameTimeNanos;
        long now = clock.nowMs();

        update(dt, now);
        syncWindow();
        sendPose();

        stats.onFrame(now);
        if (BuildConfig.DEBUG && stats.due(now)) {
            Log.d(TAG, line(stats.takeFps(now)));
        }
        postNext(true);
    }

    private void postNext(boolean processed) {
        if (scheduled) {
            return; // something during this frame already asked for the next one
        }
        scheduled = true;
        long delay = processed ? gate.delayBeforeNextCallbackMs() : 0;
        if (delay > 0) {
            choreographer.postFrameCallbackDelayed(this, delay);
        } else {
            choreographer.postFrameCallback(this);
        }
    }

    // ---- behaviour ------------------------------------------------------------------------

    private void update(double dt, long now) {
        if (holding && act != Act.DRAG && act != Act.AIR) {
            return;
        }
        switch (act) {
            case DRAG:
                break;
            case AIR:
                advancePhysics(dt, now);
                break;
            case WALK:
                walk(dt, now);
                break;
            case STAND:
            case GESTURE:
            case HOP:
                if (now >= actEndMs) {
                    endBehaviour(now);
                }
                break;
            case GAP:
            default:
                if (now >= actEndMs) {
                    chooseNext(now);
                }
                break;
        }
    }

    private void setAct(Act next) {
        act = next;
        applyCap();
    }

    private void wake() {
        if (napping) {
            napping = false;
            sender.state(OverlayState.IDLE);
        }
    }

    private void endBehaviour(long now) {
        wake();
        plan = null;
        body.locomotion = Locomotion.STAND;
        setAct(Act.GAP);
        actEndMs = now + director.nextGapMs(effectiveLevel());
    }

    private void chooseNext(long now) {
        DirectorContext ctx = new DirectorContext(world, body, effectiveLevel(), effective, power,
                Calendar.getInstance().get(Calendar.HOUR_OF_DAY), now - lastInteractionMs);
        BehaviourPlan next = director.choose(ctx);
        if (next == null) {
            actEndMs = now + 1000;
            return;
        }
        begin(next, now);
    }

    private void begin(BehaviourPlan next, long now) {
        plan = next;
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "plan " + next + " from x=" + Math.round(body.x));
        }
        switch (next.kind) {
            case STAND:
                body.locomotion = Locomotion.STAND;
                setAct(Act.STAND);
                actEndMs = now + next.durationMs;
                break;
            case GESTURE:
                body.locomotion = Locomotion.STAND;
                setAct(Act.GESTURE);
                actEndMs = now + next.durationMs;
                sender.gesture(next.gesture);
                break;
            case HOP:
                body.locomotion = Locomotion.STAND;
                setAct(Act.HOP);
                actEndMs = now + next.durationMs;
                sender.hop();
                break;
            case WALK:
            case RUN:
                walkTarget = next.targetX;
                walkSpeed = next.speed;
                body.facing = next.targetX >= body.x ? 1 : -1;
                body.locomotion = next.kind == Behaviour.Kind.RUN ? Locomotion.RUN : Locomotion.WALK;
                setAct(Act.WALK);
                // A walk that has not arrived well after its planned time is cut short.
                actEndMs = now + Math.round(next.durationMs * 1.5) + 500;
                break;
            case JUMP:
                startJump(next, now);
                break;
            case NAP:
                body.locomotion = Locomotion.NAP;
                setAct(Act.STAND);
                actEndMs = now + next.durationMs;
                napping = true;
                sender.state(OverlayState.SLEEPING);
                break;
            default:
                // Hang, sit-edge, climb and peek are not offered to the director (see NATIVE_CHOREOGRAPHED).
                if (BuildConfig.DEBUG) {
                    Log.w(TAG, "behaviour without native choreography: " + next.behaviourId);
                }
                body.locomotion = Locomotion.STAND;
                setAct(Act.STAND);
                actEndMs = now + 1000;
                break;
        }
    }

    private void startJump(BehaviourPlan next, long now) {
        double[] launch = JumpSolver.solve(body.x, body.y, next.targetX, body.y, physics.gravity,
                JUMP_MAX_RISE, JUMP_MAX_REACH);
        if (launch == null) {
            body.locomotion = Locomotion.STAND;
            setAct(Act.STAND);
            actEndMs = now + 800;
            return;
        }
        body.vx = launch[0];
        body.vy = launch[1];
        body.facing = launch[0] < 0 ? -1 : 1;
        body.grounded = false;
        body.locomotion = Locomotion.JUMP;
        jumps++;
        setAct(Act.AIR);
    }

    private void walk(double dt, long now) {
        double distance = walkTarget - body.x;
        double step = walkSpeed * dt;
        if (walkSpeed <= 0 || Math.abs(distance) <= step || now >= actEndMs) {
            if (walkSpeed > 0 && Math.abs(distance) <= step) {
                body.x = walkTarget;
            }
            endBehaviour(now);
            return;
        }
        body.facing = distance > 0 ? 1 : -1;
        body.x = clamp(body.x + Math.signum(distance) * step, world.minX(), world.maxX());
        body.y = world.floorTop();
    }

    private void advancePhysics(double dt, long now) {
        boolean jumping = body.locomotion == Locomotion.JUMP;
        for (Physics.Event event : Physics.advance(body, world, dt, physics)) {
            switch (event.type) {
                case LANDED:
                    if (jumping) {
                        body.vx = 0; // a jump lands where the solver aimed; only a throw slides
                    }
                    double squash = physics.squashFor(event.impact);
                    if (squash > 0) {
                        sender.squash(squash);
                    }
                    break;
                case SETTLED:
                    settle(now);
                    return;
                default:
                    break;
            }
        }
    }

    private void settle(long now) {
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "settled at " + Math.round(body.x) + "," + Math.round(body.y));
        }
        wake();
        plan = null;
        body.locomotion = Locomotion.STAND;
        setAct(Act.GAP);
        actEndMs = now + director.nextGapMs(effectiveLevel());
        if (userMoved) {
            userMoved = false;
            settings.setDockedPosition((float) body.x, (float) body.y);
        }
    }

    private void sendPose() {
        sender.pose(body.locomotion, body.facing, act == Act.WALK ? walkSpeed : 0);
    }

    private void syncWindow() {
        window.moveTo((int) Math.round(body.x * density), (int) Math.round(body.y * density));
    }

    // ---- touch ---------------------------------------------------------------------------

    private void interact() {
        lastInteractionMs = clock.nowMs();
    }

    @Override
    public void onDown() {
        interact();
    }

    @Override
    public void onDragStart(float rawX, float rawY) {
        if (!running || !isDrawn()) {
            return;
        }
        dragOffsetX = rawX / density - body.x;
        dragOffsetY = rawY / density - body.y;
        wake();
        plan = null;
        body.vx = 0;
        body.vy = 0;
        body.grounded = false;
        body.locomotion = Locomotion.DRAGGED;
        userMoved = true;
        interact();
        setAct(Act.DRAG);
        reschedule();
        sendPose();
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "drag start at " + Math.round(body.x) + "," + Math.round(body.y));
        }
    }

    @Override
    public void onDrag(float rawX, float rawY) {
        if (act != Act.DRAG) {
            return;
        }
        Physics.drag(body, world, rawX / density - dragOffsetX, rawY / density - dragOffsetY);
        syncWindow();
    }

    @Override
    public void onRelease(float velocityX, float velocityY) {
        if (act != Act.DRAG) {
            return;
        }
        boolean thrown = Physics.release(body, velocityX / density, velocityY / density, physics);
        interact();
        setAct(Act.AIR);
        sendPose();
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "release finger=" + Math.round(velocityX) + "," + Math.round(velocityY) + "px/s thrown=" + thrown
                    + " v=" + Math.round(body.vx) + "," + Math.round(body.vy) + "dp/s state=" + body.locomotion);
        }
    }

    @Override
    public void onTap() {
        if (!running || !isDrawn()) {
            return;
        }
        interact();
        wake();
        boolean calm = act == Act.GAP || act == Act.STAND || act == Act.GESTURE;
        if (calm && effective.has("hop")) {
            sender.hop();
        }
    }

    @Override
    public void onLongPress() {
        if (!running || !isDrawn()) {
            return;
        }
        interact();
        host.onLongPress(window.x(), window.y(), window.width(), window.height());
    }

    // ---- diagnostics ----------------------------------------------------------------------

    private String line(double fps) {
        return String.format(Locale.US, "fps=%.1f frames=%d state=%s level=%s cap=%d pos=%.1f,%.1f size=%d,%d jumps=%d",
                fps, stats.totalFrames(), body.locomotion, effectiveLevel(), gate.fps(), body.x, body.y,
                Math.round(world.boxW), Math.round(world.boxH), jumps);
    }

    private String describeCapabilities() {
        List<String> on = new ArrayList<>();
        List<String> off = new ArrayList<>();
        List<String> rigOnly = new ArrayList<>();
        for (String name : Vocabulary.CAPABILITY_NAMES) {
            if (effective.has(name)) {
                on.add(name);
            } else {
                off.add(name);
                if (reported.has(name)) {
                    rigOnly.add(name);
                }
            }
        }
        return "on=" + on + " off=" + off + " rigReportedButNotNative=" + rigOnly;
    }

    /** One line for the debug DUMP_STATE command. */
    String snapshot() {
        return "visibility=" + visibility + " act=" + act + " " + line(0) + " " + describeCapabilities();
    }

    Visibility visibility() {
        return visibility;
    }

    private static double clamp(double value, double low, double high) {
        if (high < low) {
            return low;
        }
        return value < low ? low : (value > high ? high : value);
    }
}
