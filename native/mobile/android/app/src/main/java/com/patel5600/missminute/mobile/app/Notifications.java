package com.patel5600.missminute.mobile.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;

import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.kill.KillReceiver;
import com.patel5600.missminute.mobile.overlay.OverlayService;

/** Notification channels and the notifications this part of the app posts. */
public final class Notifications {
    public static final String CHANNEL_OVERLAY = "mm_overlay";
    public static final String CHANNEL_REMINDERS = "mm_reminders";
    public static final String CHANNEL_CARDS = "mm_cards";

    /** The ongoing notification of the overlay foreground service. 7412 belongs to the metadata service. */
    public static final int ID_OVERLAY = 7413;
    /** Prompts: "Tap to bring her back" and "needs a permission". */
    public static final int ID_PROMPT = 7414;

    private static final int FLAGS = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;

    private Notifications() {
    }

    public static void createChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel overlay = new NotificationChannel(CHANNEL_OVERLAY,
                context.getString(R.string.overlay_channel_name), NotificationManager.IMPORTANCE_LOW);
        overlay.setDescription(context.getString(R.string.overlay_channel_description));
        NotificationChannel reminders = new NotificationChannel(CHANNEL_REMINDERS,
                context.getString(R.string.reminders_channel_name), NotificationManager.IMPORTANCE_HIGH);
        reminders.setDescription(context.getString(R.string.reminders_channel_description));
        NotificationChannel cards = new NotificationChannel(CHANNEL_CARDS,
                context.getString(R.string.cards_channel_name), NotificationManager.IMPORTANCE_DEFAULT);
        cards.setDescription(context.getString(R.string.cards_channel_description));
        manager.createNotificationChannel(overlay);
        manager.createNotificationChannel(reminders);
        manager.createNotificationChannel(cards);
    }

    private static PendingIntent open(Context context) {
        Intent intent = new Intent(context, DashboardActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, 2, intent, FLAGS);
    }

    private static PendingIntent stop(Context context) {
        Intent intent = new Intent(context, KillReceiver.class).setAction(KillReceiver.ACTION_KILL);
        return PendingIntent.getBroadcast(context, 1, intent, FLAGS);
    }

    /** The ongoing notification that keeps the overlay service in the foreground. */
    public static Notification overlay(Context context) {
        Icon icon = Icon.createWithResource(context, R.drawable.ic_stat_mm);
        Notification.Builder builder = new Notification.Builder(context, CHANNEL_OVERLAY)
                .setSmallIcon(R.drawable.ic_stat_mm)
                .setContentTitle(context.getString(R.string.overlay_notification_title))
                .setContentText(context.getString(R.string.overlay_notification_text))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setContentIntent(open(context))
                .addAction(new Notification.Action.Builder(icon, context.getString(R.string.action_open),
                        open(context)).build())
                .addAction(new Notification.Action.Builder(icon, context.getString(R.string.action_stop),
                        stop(context)).build());
        if (Build.VERSION.SDK_INT >= 31) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return builder.build();
    }

    /**
     * Android refused to start her in the foreground (background start rules). A tap on a notification
     * is an allowed user action, so it can start the service again.
     */
    public static void postBringBack(Context context) {
        Intent intent = new Intent(context, OverlayService.class).setAction(OverlayService.ACTION_BRING_BACK);
        post(context, context.getString(R.string.bring_back_title), context.getString(R.string.bring_back_text),
                PendingIntent.getForegroundService(context, 3, intent, FLAGS));
    }

    /** "Display over other apps" is missing: a tap opens the page where it is granted. */
    public static void postNeedsOverlayPermission(Context context) {
        Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + context.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        post(context, context.getString(R.string.overlay_permission_title),
                context.getString(R.string.overlay_permission_text), PendingIntent.getActivity(context, 4, intent, FLAGS));
    }

    private static void post(Context context, String title, String text, PendingIntent tap) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        Notification notification = new Notification.Builder(context, CHANNEL_CARDS)
                .setSmallIcon(R.drawable.ic_stat_mm)
                .setContentTitle(title)
                .setContentText(text)
                .setAutoCancel(true)
                .setContentIntent(tap)
                .build();
        manager.notify(ID_PROMPT, notification);
    }

    /** Removes the overlay notification and any prompt. */
    public static void cancelOverlayNotifications(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.cancel(ID_OVERLAY);
            manager.cancel(ID_PROMPT);
        }
    }
}
