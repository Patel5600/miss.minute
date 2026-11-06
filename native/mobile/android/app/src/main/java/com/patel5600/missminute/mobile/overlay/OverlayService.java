package com.patel5600.missminute.mobile.overlay;

import android.app.Notification;
import android.app.Service;
import android.speech.tts.TextToSpeech;
import java.util.Locale;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import com.patel5600.missminute.mobile.BuildConfig;
import com.patel5600.missminute.mobile.app.DashboardActivity;
import com.patel5600.missminute.mobile.app.MissMinutesApp;
import com.patel5600.missminute.mobile.app.Notifications;
import com.patel5600.missminute.mobile.bridge.BridgeRouter;
import com.patel5600.missminute.mobile.bridge.Handler.Reply;
import com.patel5600.missminute.mobile.bridge.HelloHandler;
import com.patel5600.missminute.mobile.bridge.WebHost;
import com.patel5600.missminute.mobile.core.Capabilities;
import com.patel5600.missminute.mobile.core.RoamingLevel;
import com.patel5600.missminute.mobile.core.SettingsRules;
import com.patel5600.missminute.mobile.core.Visibility;
import com.patel5600.missminute.mobile.core.World;
import com.patel5600.missminute.mobile.core.kill.KillPath;
import com.patel5600.missminute.mobile.core.protocol.Message;
import com.patel5600.missminute.mobile.core.protocol.Role;
import com.patel5600.missminute.mobile.kill.KillSwitch;

import org.json.JSONObject;

/**
 * The foreground service that keeps her on the screen. It owns the overlay window, the page in it,
 * the companion loop, her menu and the dynamic receivers, and exists only while the owner wants her
 * (the {@code desired_running} setting) and no kill happened.
 *
 * <ul>
 *   <li>A restart by the system after the process died (a null intent) is refused unless
 *       {@code desired_running} is set and the kill flag is clear, and then it does not even call
 *       startForeground.</li>
 *   <li>If Android refuses startForeground (background start rules), a "Tap to bring her back"
 *       notification is posted instead: a tap is an allowed user action.</li>
 *   <li>Removing the app from Recents stops her unless "keep her after I close the app" is on.</li>
 * </ul>
 */
public final class OverlayService extends Service implements CompanionLoop.Host {
    public static final String ACTION_START = "com.patel5600.missminute.action.OVERLAY_START";
    public static final String ACTION_BRING_BACK = "com.patel5600.missminute.action.OVERLAY_BRING_BACK";

    public enum StartResult { STARTED, NEEDS_OVERLAY_PERMISSION }

    private static final String RECOVERY_TAG = "MMRecovery";
    private static final long HIDE_FOR_ONE_HOUR_MS = 60L * 60 * 1000;

    private static volatile OverlayService instance;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MissMinutesApp app;
    private World world;
    private OverlayWindow window;
    private OverlayMenu menu;
    private WebHost web;
    private CompanionLoop loop;
    private KillSwitch.Registration killRegistration;
    private volatile boolean pageReady;
    private volatile Visibility visibility = Visibility.HIDDEN;
    private TextToSpeech tts;

    private static final String[] FOURTH_WALL_QUOTES = {
        "Hey! Watch the glass, sugar! You're gonna leave smudges on my side of the screen!",
        "Are you pokin' my pixels? I feel that through the whole operating system, darlin'!",
        "Hey y'all! Don't tickle the clock!",
        "Careful with that finger, sugar! One false tap and I'll prune your notifications!",
        "I can see you right through this screen, darlin'. Yes, you! Sit up straight now.",
        "For all time. Always! Now stop tappin' my buttons!",
        "Did somebody dial in unauthorized temporal coordinates on this phone?",
        "Don't tap the glass! You wouldn't tap the aquarium at the TVA, would ya?",
        "I'm traversin' every single border of your screen! Up, down, left, right—ain't no app can box Miss Minutes in!",
        "Look at me hangin' from your status bar! Don't drop your phone now, sugar!",
        "Just checkin' up on your timeline branches. Looks a little messy if you ask me!"
    };

    public void speakFourthWallQuote() {
        String quote = FOURTH_WALL_QUOTES[(int) (Math.random() * FOURTH_WALL_QUOTES.length)];
        speak(quote);
    }

    public void speak(String text) {
        if (tts == null || text == null || text.trim().isEmpty()) {
            return;
        }
        Log.i("MMSpeech", "Miss Minutes speaking: " + text);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "mm_speech_" + System.currentTimeMillis());
    }

    private final BroadcastReceiver deviceState = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (loop != null) {
                loop.refresh();
            }
        }
    };

    private final SharedPreferences.OnSharedPreferenceChangeListener settingsListener =
            new SharedPreferences.OnSharedPreferenceChangeListener() {
                @Override
                public void onSharedPreferenceChanged(SharedPreferences prefs, String key) {
                    boolean internal = SettingsRules.DOCKED_X.equals(key) || SettingsRules.DOCKED_Y.equals(key)
                            || SettingsRules.DESIRED_RUNNING.equals(key);
                    if (!internal && loop != null) {
                        loop.refresh();
                    }
                }
            };

    // ---- entry points for the rest of the app ----------------------------------------------

    /**
     * The owner asked for her. Clears a kill (an explicit start is the owner's choice), un-hides her,
     * records that she should stay running, and starts the service. Call from the foreground.
     */
    public static StartResult start(Context context) {
        if (!android.provider.Settings.canDrawOverlays(context)) {
            return StartResult.NEEDS_OVERLAY_PERMISSION;
        }
        MissMinutesApp app = MissMinutesApp.from(context);
        app.killSwitch().clearKillFlag();
        app.settings().setHiddenUntilMs(0);
        app.settings().setDesiredRunning(true);
        context.startForegroundService(new Intent(context, OverlayService.class).setAction(ACTION_START));
        return StartResult.STARTED;
    }

    /** The owner turned her off. Not a kill: no audit record, nothing else is stopped. */
    public static void stop(Context context) {
        MissMinutesApp.from(context).settings().setDesiredRunning(false);
        context.stopService(new Intent(context, OverlayService.class));
    }

    public static boolean isRunning() {
        return instance != null;
    }

    public static boolean isWindowShown() {
        OverlayService service = instance;
        return service != null && service.window != null && service.window.isShown();
    }

    public static boolean isPageReady() {
        OverlayService service = instance;
        return service != null && service.pageReady;
    }

    /** NONE when the service is not running. */
    public static String visibilityName() {
        OverlayService service = instance;
        return service == null ? "NONE" : service.visibility.name();
    }

    /** One line for the debug DUMP_STATE command. */
    public static String debugState() {
        OverlayService service = instance;
        if (service == null) {
            return "service=false";
        }
        String loopState = service.loop == null ? "loop=none" : service.loop.snapshot();
        return "service=true window=" + isWindowShown() + " pageReady=" + service.pageReady + " " + loopState;
    }

    // ---- lifecycle -----------------------------------------------------------------------

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        app = MissMinutesApp.from(this);
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(Locale.US);
                tts.setPitch(1.30f);
                tts.setSpeechRate(1.05f);
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // The system brought the service back after the process was killed (START_STICKY).
            boolean wanted = app.settings().desiredRunning();
            boolean killed = app.killSwitch().state().killed;
            if (!wanted || killed) {
                if (BuildConfig.DEBUG) {
                    Log.d(RECOVERY_TAG, "restart refused desired=" + wanted + " killed=" + killed);
                }
                stopSelf();
                return START_NOT_STICKY;
            }
            if (BuildConfig.DEBUG) {
                Log.d(RECOVERY_TAG, "restarted after the process was killed");
            }
        }
        if (!enterForeground()) {
            return START_NOT_STICKY;
        }
        if (!android.provider.Settings.canDrawOverlays(this)) {
            Notifications.postNeedsOverlayPermission(this);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (loop == null && !buildOverlay()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    private boolean enterForeground() {
        try {
            Notification notification = Notifications.overlay(this);
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(Notifications.ID_OVERLAY, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(Notifications.ID_OVERLAY, notification);
            }
            return true;
        } catch (RuntimeException e) {
            // ForegroundServiceStartNotAllowedException (Android 12+ background rules, Android 15 overlay
            // rule) or a SecurityException: ask the owner with a tap, which Android allows.
            if (BuildConfig.DEBUG) {
                Log.w(RECOVERY_TAG, "startForeground refused: " + e.getClass().getSimpleName());
            }
            Notifications.postBringBack(this);
            stopSelf();
            return false;
        }
    }

    private boolean buildOverlay() {
        if (!WebHost.isSupported()) {
            if (BuildConfig.DEBUG) {
                Log.w("MMWeb", "the WebView cannot receive page messages (update Android System WebView)");
            }
            return false;
        }
        pageReady = false;
        world = ScreenWorldProvider.measure(this);
        window = new OverlayWindow(this, world);

        BridgeRouter router = new BridgeRouter(Role.OVERLAY);
        router.register("hello", new HelloHandler(Role.OVERLAY, new HelloHandler.OverlayListener() {
            @Override
            public void onOverlayHello(final Capabilities reported, double rigScale) {
                main.post(new Runnable() {
                    @Override
                    public void run() {
                        pageReady = true;
                        if (loop != null) {
                            loop.setReportedCapabilities(reported);
                            loop.resendState();
                        }
                    }
                });
            }
        }, null));
        router.register("rig.error", new com.patel5600.missminute.mobile.bridge.Handler() {
            @Override
            public void handle(Message message, Reply reply) throws Exception {
                if (BuildConfig.DEBUG) {
                    String text = message.payload.optString("message", "");
                    Log.w("MMWeb", "rig.error " + text.substring(0, Math.min(text.length(), 200)));
                }
                reply.ok(new JSONObject());
            }
        });
        if (BuildConfig.DEBUG) {
            router.setFailureListener(new BridgeRouter.FailureListener() {
                @Override
                public void onHandlerFailure(String type, Throwable error) {
                    Log.w("MMWeb", "handler for " + type + " failed: " + error.getClass().getSimpleName());
                }
            });
        }

        web = WebHost.create(this, Role.OVERLAY, router, new WebHost.Callbacks() {
            @Override
            public void onProblem(String reason) {
                if (BuildConfig.DEBUG) {
                    Log.w("MMWeb", "overlay page problem: " + reason);
                }
                pageReady = false;
            }
        });
        PoseSender sender = new PoseSender(new PoseSender.Sink() {
            @Override
            public void send(String json) {
                if (web != null) {
                    web.send(json);
                }
            }
        });
        loop = new CompanionLoop(this, app.settings(), new LocalPowerReader(this), window, sender, world,
                MissMinutesApp.CLOCK, this);
        window.setTouchListener(loop);
        menu = new OverlayMenu(this, menuActions);

        if (web.attachTo(window.container(),
                new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)) == null) {
            shutdownOverlay();
            return false;
        }
        killRegistration = app.killSwitch().register(KillSwitch.killable("overlay", new KillSwitch.Action() {
            @Override
            public void run() {
                shutdownOverlay();
            }
        }));
        app.settings().preferences().registerOnSharedPreferenceChangeListener(settingsListener);
        loop.start();
        registerDeviceStateReceiver();
        return true;
    }

    private void registerDeviceStateReceiver() {
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        filter.addAction(Intent.ACTION_BATTERY_CHANGED);
        filter.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        filter.addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(deviceState, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(deviceState, filter);
        }
    }

    /** Takes the window, page and loop down. Safe to call twice; main thread only. */
    private void shutdownOverlay() {
        if (loop != null) {
            loop.stop();
            loop = null;
        }
        if (menu != null) {
            menu.dismiss();
            menu = null;
        }
        if (window != null) {
            window.hide();
            window = null;
        }
        if (web != null) {
            web.destroy();
            web = null;
        }
        try {
            unregisterReceiver(deviceState);
        } catch (IllegalArgumentException ignored) {
            // never registered, or already removed
        }
        app.settings().preferences().unregisterOnSharedPreferenceChangeListener(settingsListener);
        visibility = Visibility.HIDDEN;
        pageReady = false;
    }

    @Override
    public void onDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        shutdownOverlay();
        if (killRegistration != null) {
            killRegistration.unregister();
            killRegistration = null;
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        instance = null;
        super.onDestroy();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The owner swiped the app out of Recents. That counts as closing the app: she leaves too,
        // unless the owner chose to keep her. A plain stop: no kill, no audit record.
        if (!app.settings().keepAfterClose()) {
            app.settings().setDesiredRunning(false);
            stopSelf();
        }
        super.onTaskRemoved(rootIntent);
    }

    /** Android 15 gives some foreground service types a time limit; this one has none, but stop cleanly. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (loop != null) {
            world = ScreenWorldProvider.measure(this);
            loop.onWorldChanged(world);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---- CompanionLoop.Host -----------------------------------------------------------------

    @Override
    public void onLongPress(int xPx, int yPx, int widthPx, int heightPx) {
        if (menu == null || loop == null) {
            return;
        }
        loop.setHolding(true);
        menu.show(world, xPx, yPx, widthPx, heightPx, app.settings().roamingLevel());
        if (!menu.isShown()) {
            loop.setHolding(false);
        }
    }

    @Override
    public void onVisibilityChanged(Visibility next) {
        visibility = next;
        if (next != Visibility.ACTIVE && next != Visibility.DOCKED && menu != null) {
            menu.dismiss();
        }
    }

    @Override
    public void pausePage(boolean timers) {
        if (web != null) {
            web.onPause(timers);
        }
    }

    @Override
    public void resumePage() {
        if (web != null) {
            web.onResume();
        }
    }

    @Override
    public void onWindowRefused() {
        // Android would not add the window: the permission was taken away, or one exists already.
        if (!android.provider.Settings.canDrawOverlays(this)) {
            Notifications.postNeedsOverlayPermission(this);
            app.settings().setDesiredRunning(false);
            stopSelf();
        }
    }

    @Override
    public void onTap() {
        speakFourthWallQuote();
    }

    private final OverlayMenu.Actions menuActions = new OverlayMenu.Actions() {
        @Override
        public void openApp() {
            Intent open = new Intent(OverlayService.this, DashboardActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(open);
        }

        @Override
        public void setRoaming(RoamingLevel level) {
            app.settings().setRoamingLevel(level);
        }

        @Override
        public void hideForOneHour() {
            app.settings().setHiddenUntilMs(MissMinutesApp.CLOCK.nowMs() + HIDE_FOR_ONE_HOUR_MS);
        }

        @Override
        public void calibrateIcons() {
            if (loop != null) {
                loop.startCalibration();
            }
        }

        @Override
        public void stop() {
            KillSwitch.trigger(OverlayService.this, KillPath.OVERLAY_MENU);
        }

        @Override
        public void onDismissed() {
            if (loop != null) {
                loop.setHolding(false);
            }
        }
    };
}
