package com.patel5600.missminute.mobile.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;

import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.bridge.handlers.UiBridge;

/**
 * Native confirmations. Anything that gives her more freedom is confirmed here, in a dialog drawn by
 * the app and not by a page, so a page (or a model) can never confirm for the owner.
 */
final class NativeDialogs {
    private NativeDialogs() {
    }

    /** Shows Allow and Cancel. {@code result} is called once; closing the dialog any other way counts as Cancel. */
    static void confirm(Activity activity, int titleRes, int messageRes, final UiBridge.Confirmed result) {
        if (activity.isFinishing() || activity.isDestroyed()) {
            result.onResult(false);
            return;
        }
        final boolean[] answered = {false};
        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle(titleRes)
                .setMessage(messageRes)
                .setPositiveButton(R.string.dialog_allow, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int which) {
                        if (!answered[0]) {
                            answered[0] = true;
                            result.onResult(true);
                        }
                    }
                })
                .setNegativeButton(R.string.dialog_cancel, null)
                .create();
        dialog.setOnDismissListener(new DialogInterface.OnDismissListener() {
            @Override
            public void onDismiss(DialogInterface d) {
                if (!answered[0]) {
                    answered[0] = true;
                    result.onResult(false);
                }
            }
        });
        dialog.show();
    }
}
