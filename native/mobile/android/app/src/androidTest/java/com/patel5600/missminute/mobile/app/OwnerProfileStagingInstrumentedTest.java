package com.patel5600.missminute.mobile.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises pending-template encryption and activation with the real Android Keystore. */
@RunWith(AndroidJUnit4.class)
public final class OwnerProfileStagingInstrumentedTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    @After public void cleanProfiles() throws Exception {
        FaceProfileStore.delete(context);
        SpeakerProfileStore.delete(context);
    }

    @Test public void stagedFaceTemplateCannotBeLoadedUntilOwnerActivation() throws Exception {
        float[] expected = normalizedVector(128);
        FaceProfileStore.savePending(context, expected);

        assertTrue(FaceProfileStore.existsPending(context));
        assertFalse(FaceProfileStore.exists(context));
        assertNull(FaceProfileStore.load(context));

        FaceProfileStore.activatePending(context);
        assertFalse(FaceProfileStore.existsPending(context));
        assertTrue(FaceProfileStore.exists(context));
        assertArrayEquals(expected, FaceProfileStore.load(context), 0.00001f);
    }

    @Test public void stagedSpeakerTemplateCannotBeLoadedUntilOwnerActivation() throws Exception {
        float[] expected = normalizedVector(192);
        SpeakerProfileStore.savePending(context, expected);

        assertTrue(SpeakerProfileStore.existsPending(context));
        assertFalse(SpeakerProfileStore.exists(context));
        assertNull(SpeakerProfileStore.load(context, expected.length));

        SpeakerProfileStore.activatePending(context);
        assertFalse(SpeakerProfileStore.existsPending(context));
        assertTrue(SpeakerProfileStore.exists(context));
        assertArrayEquals(expected, SpeakerProfileStore.load(context, expected.length), 0.00001f);
    }

    private static float[] normalizedVector(int dimensions) {
        float[] values = new float[dimensions];
        values[0] = 1f;
        return values;
    }
}
