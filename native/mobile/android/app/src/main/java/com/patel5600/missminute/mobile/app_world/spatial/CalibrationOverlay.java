package com.patel5600.missminute.mobile.app_world.spatial;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.patel5600.missminute.mobile.app_world.behaviour.EventRouter;
import com.patel5600.missminute.mobile.core.World;

import java.util.List;

/**
 * Strategy B: Calibration system allowing interactive or programmatic calibration
 * of real application icons on the home screen.
 */
public final class CalibrationOverlay {
    private static final String TAG = "MMCalibration";

    public interface CalibrationCallback {
        void onAnchorCalibrated(SpatialAnchor anchor);
        void onCalibrationCancelled();
    }

    private final Context context;
    private final WindowManager windowManager;
    private final SpatialMemory spatialMemory;
    private final AppRegistry appRegistry;
    private final EventRouter eventRouter;

    private FrameLayout rootFrame;
    private boolean isShowing = false;

    public CalibrationOverlay(Context context, SpatialMemory spatialMemory,
                              AppRegistry appRegistry, EventRouter eventRouter) {
        this.context = context;
        this.windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        this.spatialMemory = spatialMemory;
        this.appRegistry = appRegistry;
        this.eventRouter = eventRouter;
    }

    public boolean isShowing() {
        return isShowing;
    }

    /**
     * Programmatically registers a calibrated spatial anchor for an app.
     * Useful for automated setup, test scripts, and acceptance tests.
     */
    public SpatialAnchor calibrateApp(String packageId, RectF boundsDp, World world, int pageIndex) {
        AppRegistry.AppEntry entry = appRegistry.find(packageId);
        String name = entry != null ? entry.appName : packageId;
        float density = world != null ? (float) world.density : 1.0f;
        long revision = spatialMemory.currentRevision();

        SpatialAnchor anchor = new SpatialAnchor(
                packageId,
                name,
                "com.android.launcher",
                pageIndex,
                0,
                boundsDp,
                density,
                System.currentTimeMillis(),
                1.0f, // 100% calibrated confidence
                revision,
                null
        );

        spatialMemory.saveAnchor(anchor);
        Log.i(TAG, "Calibrated app anchor: " + anchor);
        if (eventRouter != null) {
            eventRouter.dispatch(EventRouter.DeviceEvent.anchorsUpdated(System.currentTimeMillis()));
        }
        return anchor;
    }

    /**
     * Calibrates from raw screen pixel coordinates.
     */
    public SpatialAnchor calibrateAppPx(String packageId, float leftPx, float topPx,
                                        float rightPx, float bottomPx, World world, int pageIndex) {
        float density = world != null ? (float) world.density : 1.0f;
        RectF boundsDp = new RectF(
                leftPx / density,
                topPx / density,
                rightPx / density,
                bottomPx / density
        );
        return calibrateApp(packageId, boundsDp, world, pageIndex);
    }

    /**
     * Shows the interactive on-screen calibration HUD.
     */
    public void showCalibrationHud(World world, final double currentCharX, final double currentCharY,
                                   final CalibrationCallback callback) {
        if (isShowing) {
            return;
        }

        final float density = (float) world.density;
        rootFrame = new FrameLayout(context);

        // Semi-transparent HUD card at top of screen
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(32, 24, 32, 24);

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#E6231F20")); // Miss Minutes dark TVA background
        bg.setCornerRadius(24f * density);
        bg.setStroke((int) (2 * density), Color.parseColor("#F57C00"));
        card.setBackground(bg);

        TextView title = new TextView(context);
        title.setText("Miss Minutes Icon Calibration");
        title.setTextColor(Color.parseColor("#FF9800"));
        title.setTextSize(16f);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        card.addView(title);

        TextView desc = new TextView(context);
        desc.setText("Move Miss Minutes over any app icon, then tap Confirm to record the spatial anchor.");
        desc.setTextColor(Color.WHITE);
        desc.setTextSize(13f);
        desc.setPadding(0, 8, 0, 16);
        card.addView(desc);

        LinearLayout btnRow = new LinearLayout(context);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setGravity(Gravity.CENTER);

        Button cancelBtn = new Button(context);
        cancelBtn.setText("Cancel");
        cancelBtn.setTextColor(Color.WHITE);
        cancelBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                dismiss();
                if (callback != null) callback.onCalibrationCancelled();
            }
        });
        btnRow.addView(cancelBtn);

        Button confirmBtn = new Button(context);
        confirmBtn.setText("Lock Location");
        confirmBtn.setTextColor(Color.parseColor("#FF9800"));
        confirmBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                // Calibrate icon around current character position
                float iconSize = 64f;
                RectF bounds = new RectF(
                        (float) currentCharX,
                        (float) (currentCharY + world.boxH - world.footInset),
                        (float) (currentCharX + iconSize),
                        (float) (currentCharY + world.boxH - world.footInset + iconSize)
                );
                SpatialAnchor anchor = calibrateApp("custom.app.anchor", bounds, world, spatialMemory.getActivePage());
                dismiss();
                Toast.makeText(context, "Spatial anchor locked!", Toast.LENGTH_SHORT).show();
                if (callback != null) callback.onAnchorCalibrated(anchor);
            }
        });
        btnRow.addView(confirmBtn);

        card.addView(btnRow);

        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
        );
        cardParams.setMargins(32, 64, 32, 0);
        rootFrame.addView(card, cardParams);

        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
        );
        lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;

        try {
            windowManager.addView(rootFrame, lp);
            isShowing = true;
        } catch (RuntimeException e) {
            Log.e(TAG, "Failed to display calibration HUD", e);
        }
    }

    public void dismiss() {
        if (!isShowing || rootFrame == null) {
            return;
        }
        try {
            windowManager.removeViewImmediate(rootFrame);
        } catch (RuntimeException ignored) {
        }
        rootFrame = null;
        isShowing = false;
    }
}
