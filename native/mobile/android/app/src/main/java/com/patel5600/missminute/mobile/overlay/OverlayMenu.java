package com.patel5600.missminute.mobile.overlay;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.patel5600.missminute.mobile.BuildConfig;
import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.core.RoamingLevel;
import com.patel5600.missminute.mobile.core.World;

import java.util.ArrayList;
import java.util.List;

/**
 * Her long-press menu: a second small overlay window next to her with Open Miss Minutes, the four
 * roaming levels, Hide for 1 hour, and a red Stop Miss Minutes that works in one tap. It hides itself
 * after 8 seconds or on a touch outside it. Every control has a content description. Debug builds log
 * the button rectangles (tag MMMenu) so a device script can tap them.
 */
final class OverlayMenu {
    interface Actions {
        void openApp();

        void setRoaming(RoamingLevel level);

        void hideForOneHour();

        /** The red button: the same kill switch as the notification and the in-app button. */
        void stop();

        /** The menu left the screen, whatever the reason. */
        void onDismissed();
    }

    private static final long AUTO_HIDE_MS = 8000;
    private static final int CARD_WIDTH_DP = 240;
    private static final int MARGIN_DP = 12;

    private final Context context;
    private final WindowManager windowManager;
    private final Actions actions;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable autoHide = new Runnable() {
        @Override
        public void run() {
            dismiss();
        }
    };
    private MenuFrame root;
    private boolean shown;

    OverlayMenu(Context context, Actions actions) {
        this.context = context;
        this.windowManager = context.getSystemService(WindowManager.class);
        this.actions = actions;
    }

    boolean isShown() {
        return shown;
    }

    /** Shows the menu beside her; the anchor is her window in screen pixels. */
    void show(World world, int anchorX, int anchorY, int anchorWidth, int anchorHeight, RoamingLevel current) {
        if (shown) {
            return;
        }
        float density = (float) world.density;
        int margin = Math.round(MARGIN_DP * density);
        int screenWidth = Math.round((float) (world.screenW * density));
        int screenHeight = Math.round((float) (world.screenH * density));
        int cardWidth = Math.min(Math.round(CARD_WIDTH_DP * density), screenWidth - 2 * margin);

        final List<View> buttons = new ArrayList<>();
        root = new MenuFrame(context);
        root.addView(buildCard(density, current, buttons),
                new FrameLayout.LayoutParams(cardWidth, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.measure(View.MeasureSpec.makeMeasureSpec(cardWidth, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(screenHeight, View.MeasureSpec.AT_MOST));
        int cardHeight = root.getMeasuredHeight();

        int x = anchorX + anchorWidth / 2 - cardWidth / 2;
        x = Math.max(margin, Math.min(x, screenWidth - cardWidth - margin));
        boolean herInLowerHalf = anchorY + anchorHeight / 2 > screenHeight / 2;
        int y = herInLowerHalf ? anchorY - cardHeight - margin : anchorY + anchorHeight + margin;
        int top = Math.round((float) (world.insetTop * density));
        int bottom = screenHeight - Math.round((float) (world.insetBottom * density)) - cardHeight;
        y = Math.max(top, Math.min(y, Math.max(top, bottom)));

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                cardWidth, ViewGroup.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = x;
        params.y = y;
        params.setTitle("MissMinutesMenu");
        if (Build.VERSION.SDK_INT >= 28) {
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        try {
            windowManager.addView(root, params);
        } catch (RuntimeException e) {
            root = null;
            return;
        }
        shown = true;
        handler.postDelayed(autoHide, AUTO_HIDE_MS);
        if (BuildConfig.DEBUG) {
            logRectangles(buttons);
        }
    }

    void dismiss() {
        handler.removeCallbacks(autoHide);
        if (!shown) {
            return;
        }
        shown = false;
        try {
            windowManager.removeViewImmediate(root);
        } catch (RuntimeException ignored) {
            // already gone
        }
        root = null;
        actions.onDismissed();
    }

    private LinearLayout buildCard(float density, RoamingLevel current, List<View> buttons) {
        int pad = Math.round(12 * density);
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(pad, pad, pad, pad);
        card.setBackground(rounded(context.getColor(R.color.mm_raised), context.getColor(R.color.mm_line),
                Math.round(16 * density), density));

        card.addView(row(context.getString(R.string.menu_open), context.getColor(R.color.mm_cream), 0,
                density, buttons, new Runnable() {
                    @Override
                    public void run() {
                        dismiss();
                        actions.openApp();
                    }
                }));

        TextView label = new TextView(context);
        label.setText(R.string.menu_roaming);
        label.setTextSize(12);
        label.setTextColor(context.getColor(R.color.mm_muted));
        label.setPadding(Math.round(4 * density), Math.round(10 * density), 0, Math.round(4 * density));
        card.addView(label);

        LinearLayout levels = new LinearLayout(context);
        levels.setOrientation(LinearLayout.HORIZONTAL);
        for (final RoamingLevel level : RoamingLevel.values()) {
            TextView chip = chip(levelName(level), level == current, density);
            chip.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    dismiss();
                    actions.setRoaming(level);
                }
            });
            buttons.add(chip);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, Math.round(40 * density), 1f);
            lp.setMarginEnd(Math.round(4 * density));
            levels.addView(chip, lp);
        }
        card.addView(levels);

        card.addView(row(context.getString(R.string.menu_hide_hour), context.getColor(R.color.mm_cream), 0,
                density, buttons, new Runnable() {
                    @Override
                    public void run() {
                        dismiss();
                        actions.hideForOneHour();
                    }
                }));
        card.addView(row(context.getString(R.string.menu_stop), 0xFFFFFFFF, context.getColor(R.color.mm_stop),
                density, buttons, new Runnable() {
                    @Override
                    public void run() {
                        dismiss();
                        actions.stop();
                    }
                }));
        return card;
    }

    private String levelName(RoamingLevel level) {
        switch (level) {
            case DOCKED:
                return context.getString(R.string.level_docked);
            case CALM:
                return context.getString(R.string.level_calm);
            case LIVELY:
                return context.getString(R.string.level_lively);
            default:
                return context.getString(R.string.level_wild);
        }
    }

    private TextView row(String text, int textColor, int fill, float density, List<View> buttons,
                         final Runnable action) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextSize(15);
        view.setTextColor(textColor);
        view.setTypeface(Typeface.DEFAULT_BOLD);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setMinHeight(Math.round(48 * density));
        view.setPadding(Math.round(12 * density), 0, Math.round(12 * density), 0);
        view.setContentDescription(text);
        view.setClickable(true);
        // A transparent fill still gives the ripple its bounds, so it stays inside the row.
        Drawable base = rounded(fill != 0 ? fill : 0x00000000, 0, Math.round(10 * density), density);
        view.setBackground(new RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), base, null));
        view.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                action.run();
            }
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Math.round(6 * density);
        view.setLayoutParams(lp);
        buttons.add(view);
        return view;
    }

    private TextView chip(String text, boolean selected, float density) {
        TextView chip = new TextView(context);
        chip.setText(text);
        chip.setTextSize(12);
        chip.setGravity(Gravity.CENTER);
        chip.setTextColor(selected ? context.getColor(R.color.mm_base) : context.getColor(R.color.mm_cream));
        chip.setContentDescription(context.getString(R.string.menu_roaming) + " " + text
                + (selected ? ", selected" : ""));
        chip.setClickable(true);
        int fill = selected ? context.getColor(R.color.mm_face) : context.getColor(R.color.mm_base);
        chip.setBackground(new RippleDrawable(ColorStateList.valueOf(0x33FFFFFF),
                rounded(fill, context.getColor(R.color.mm_line), Math.round(10 * density), density), null));
        return chip;
    }

    private static Drawable rounded(int fill, int stroke, int radiusPx, float density) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(radiusPx);
        if (stroke != 0) {
            drawable.setStroke(Math.max(1, Math.round(density)), stroke);
        }
        return drawable;
    }

    private void logRectangles(final List<View> buttons) {
        final ViewTreeObserver observer = root.getViewTreeObserver();
        observer.addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
            @Override
            public void onGlobalLayout() {
                if (observer.isAlive()) {
                    observer.removeOnGlobalLayoutListener(this);
                }
                for (View button : buttons) {
                    int[] at = new int[2];
                    button.getLocationOnScreen(at);
                    Log.d("MMMenu", "button=\"" + button.getContentDescription() + "\" rect=" + at[0] + ","
                            + at[1] + "," + (at[0] + button.getWidth()) + "," + (at[1] + button.getHeight()));
                }
            }
        });
    }

    /** Dismisses the menu on a touch outside it. */
    private final class MenuFrame extends FrameLayout {
        MenuFrame(Context context) {
            super(context);
        }

        @Override
        public boolean onTouchEvent(MotionEvent event) {
            if (event.getAction() == MotionEvent.ACTION_OUTSIDE) {
                dismiss();
                return true;
            }
            return super.onTouchEvent(event);
        }
    }
}
