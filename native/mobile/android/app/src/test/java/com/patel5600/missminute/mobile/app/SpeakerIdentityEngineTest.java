package com.patel5600.missminute.mobile.app;

import org.junit.Test;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public final class SpeakerIdentityEngineTest {
    @Test public void cosineIsOneForTheSameDirection() {
        assertEquals(1.0f, SpeakerIdentityEngine.cosine(new float[] {1f, 0f}, new float[] {3f, 0f}), 1e-6f);
    }

    @Test public void cosineIsZeroForOrthogonalEmbeddings() {
        assertEquals(0.0f, SpeakerIdentityEngine.cosine(new float[] {1f, 0f}, new float[] {0f, 1f}), 1e-6f);
    }

    @Test public void invalidDimensionsAndNonFiniteValuesDoNotMatch() {
        assertTrue(SpeakerIdentityEngine.cosine(new float[] {1f}, new float[] {1f, 0f}) < 0f);
        assertTrue(SpeakerIdentityEngine.cosine(new float[] {Float.NaN}, new float[] {1f}) < 0f);
    }

    @Test public void normalizedConfidenceMapsThresholdToPointSeven() {
        assertEquals(0.0f, SpeakerIdentityEngine.normalizedConfidence(Float.NaN), 1e-6f);
        assertEquals(0.0f, SpeakerIdentityEngine.normalizedConfidence(-0.2f), 1e-6f);
        assertTrue(SpeakerIdentityEngine.normalizedConfidence(SpeakerIdentityEngine.INITIAL_CANDIDATE_THRESHOLD - 0.01f) < 0.70f);
        assertEquals(0.70f, SpeakerIdentityEngine.normalizedConfidence(SpeakerIdentityEngine.INITIAL_CANDIDATE_THRESHOLD), 1e-4f);
        assertEquals(1.0f, SpeakerIdentityEngine.normalizedConfidence(1.0f), 1e-4f);
    }
}
