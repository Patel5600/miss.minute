package com.patel5600.missminute.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.provider.DocumentsContract;
import android.util.Log;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;

public final class MetadataCompanionService extends Service {
    private static final String TAG = "MissMinutesAgent";
    private static final String CHANNEL_ID = "miss_minutes_companion";
    private static final int NOTIFICATION_ID = 7412;
    private static final String ACTION_STOP = "com.patel5600.missminute.STOP";

    private HandlerThread workerThread;
    private Handler worker;
    private final Runnable scanTask = new Runnable() {
        @Override public void run() {
            if (!isEnabled()) {
                stopSelf();
                return;
            }
            try {
                scanAuthorizedTree();
            } catch (Exception error) {
                Log.e(TAG, "Metadata scan failed; the service remains visible and will retry.", error);
            }
            if (worker != null && isEnabled()) worker.postDelayed(this, 60_000L);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        workerThread = new HandlerThread("miss-minutes-document-metadata");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            getPreferences().edit().putBoolean("monitoring_enabled", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!isEnabled() || getPreferences().getString("tree_uri", null) == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startVisibleForeground();
        worker.removeCallbacks(scanTask);
        worker.post(scanTask);
        return START_STICKY;
    }

    private void startVisibleForeground() {
        Notification notification = buildNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildNotification() {
        Intent stopIntent = new Intent(this, MetadataCompanionService.class).setAction(ACTION_STOP);
        PendingIntent stop = PendingIntent.getService(
                this, 1, stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle("Miss Minutes is active")
                .setContentText("Metadata-only monitoring of your selected folder")
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_media_pause, "Stop", stop).build());
        return builder.build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, "Miss Minutes companion", NotificationManager.IMPORTANCE_LOW));
        }
    }

    private boolean isEnabled() {
        return getPreferences().getBoolean("monitoring_enabled", false);
    }

    private SharedPreferences getPreferences() {
        return getSharedPreferences("miss_minutes_companion", MODE_PRIVATE);
    }

    private void scanAuthorizedTree() throws Exception {
        String saved = getPreferences().getString("tree_uri", null);
        if (saved == null) return;
        Uri tree = Uri.parse(saved);
        String rootId = DocumentsContract.getTreeDocumentId(tree);
        ContentResolver resolver = getContentResolver();
        MetadataDb db = new MetadataDb(this);
        ArrayDeque<Node> pending = new ArrayDeque<>();
        Set<String> visited = new HashSet<>();
        pending.add(new Node(rootId, 0));
        int inspected = 0;

        while (!pending.isEmpty() && inspected < 5000 && isEnabled()) {
            Node node = pending.removeFirst();
            if (node.depth > 16 || !visited.add(node.documentId)) continue;
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, node.documentId);
            String[] columns = {
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED
            };
            try (Cursor cursor = resolver.query(children, columns, null, null, null)) {
                if (cursor == null) continue;
                int idCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
                int nameCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
                int mimeCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE);
                int sizeCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE);
                int modifiedCol = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
                while (cursor.moveToNext() && inspected++ < 5000 && isEnabled()) {
                    String id = cursor.getString(idCol);
                    String name = cursor.getString(nameCol);
                    String mime = cursor.getString(mimeCol);
                    long size = cursor.isNull(sizeCol) ? -1 : cursor.getLong(sizeCol);
                    long modified = cursor.isNull(modifiedCol) ? -1 : cursor.getLong(modifiedCol);
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        pending.addLast(new Node(id, node.depth + 1));
                    } else {
                        db.observe(id, name, mime, size, modified);
                    }
                }
            }
        }
        db.trimEvents();
        db.close();
    }

    @Override
    public void onDestroy() {
        if (worker != null) worker.removeCallbacksAndMessages(null);
        if (workerThread != null) {
            workerThread.quitSafely();
            try { workerThread.join(2000L); } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private static final class Node {
        final String documentId;
        final int depth;
        Node(String id, int depth) { this.documentId = id; this.depth = depth; }
    }

}
