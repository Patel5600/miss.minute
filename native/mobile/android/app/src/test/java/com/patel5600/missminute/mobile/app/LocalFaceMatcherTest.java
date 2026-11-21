package com.patel5600.missminute.mobile.app;

import org.junit.Test;
import java.util.Arrays;
import static org.junit.Assert.*;

public final class LocalFaceMatcherTest {
    @Test public void averagingRequiresAtLeastThreeValidSamplesAndNormalizes() {
        float[] first = vector(0, 1f);
        float[] second = vector(1, 1f);
        float[] third = vector(2, 1f);
        assertNull(LocalFaceMatcher.averageNormalized(Arrays.asList(first, second)));
        float[] averaged = LocalFaceMatcher.averageNormalized(Arrays.asList(first, second, third));
        assertNotNull(averaged);
        assertEquals(1.0, norm(averaged), 1e-5);
        assertTrue(averaged[0] > 0f);
        assertTrue(averaged[1] > 0f);
        assertTrue(averaged[2] > 0f);
    }

    @Test public void invalidOrNonFiniteSamplesAreRejected() {
        assertNull(LocalFaceMatcher.averageNormalized(Arrays.asList(vector(0, 1f), vector(1, 1f), new float[128])));
        float[] nonFinite = vector(0, 1f);
        nonFinite[4] = Float.NaN;
        assertNull(LocalFaceMatcher.averageNormalized(Arrays.asList(vector(0, 1f), vector(1, 1f), nonFinite)));
    }

    @Test public void thresholdIsCandidateOnlyOperatingPoint() {
        FaceMatchConsensus gate = new FaceMatchConsensus();
        assertFalse(gate.observe(LocalFaceMatcher.SAME_FACE_THRESHOLD - 0.001, 1000));
        assertFalse(gate.observe(LocalFaceMatcher.SAME_FACE_THRESHOLD + 0.05, 1400));
        assertTrue(gate.observe(LocalFaceMatcher.SAME_FACE_THRESHOLD + 0.05, 1800));
    }

    @Test public void normalizedConfidenceMapsThresholdToPointSeven() {
        assertEquals(0.0f, LocalFaceMatcher.normalizedConfidence(Double.NaN), 1e-6f);
        assertEquals(0.0f, LocalFaceMatcher.normalizedConfidence(-0.1), 1e-6f);
        assertTrue(LocalFaceMatcher.normalizedConfidence(LocalFaceMatcher.SAME_FACE_THRESHOLD - 0.01) < 0.70f);
        assertEquals(0.70f, LocalFaceMatcher.normalizedConfidence(LocalFaceMatcher.SAME_FACE_THRESHOLD), 1e-4f);
        assertEquals(1.0f, LocalFaceMatcher.normalizedConfidence(1.0), 1e-4f);
    }

    private static float[] vector(int index, float value) {
        float[] result = new float[128];
        result[index] = value;
        return result;
    }

    private static double norm(float[] values) {
        double sum = 0;
        for (float value : values) sum += value * value;
        return Math.sqrt(sum);
    }
}
