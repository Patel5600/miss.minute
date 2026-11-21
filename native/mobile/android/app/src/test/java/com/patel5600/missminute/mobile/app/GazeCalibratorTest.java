package com.patel5600.missminute.mobile.app;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public final class GazeCalibratorTest {
    @Test public void requiresEnoughCalibrationSamplesAndMapsKnownAffineTargets() {
        GazeCalibrator gaze = new GazeCalibrator();
        float[][] inputs = {
                {0.10f, 0.12f, 0.08f, 0.10f}, {0.85f, 0.14f, 0.87f, 0.12f},
                {0.12f, 0.82f, 0.11f, 0.84f}, {0.86f, 0.83f, 0.84f, 0.81f},
                {0.48f, 0.48f, 0.50f, 0.50f}, {0.52f, 0.18f, 0.48f, 0.16f}
        };
        assertFalse(gaze.calibrate());
        for (float[] input : inputs) {
            float x = (input[0] + input[2]) * 0.5f;
            float y = (input[1] + input[3]) * 0.5f;
            assertTrue(gaze.add(input, x, y));
        }
        assertTrue(gaze.calibrate());
        GazeCalibrator.Point point = gaze.project(new float[]{0.30f, 0.35f, 0.34f, 0.33f});
        assertNotNull(point);
        assertEquals(0.32f, point.x, 0.02f);
        assertEquals(0.34f, point.y, 0.02f);
    }

    @Test public void rejectsNonFiniteFeaturesAndUnsafeExtrapolation() {
        GazeCalibrator gaze = new GazeCalibrator();
        assertFalse(gaze.add(new float[]{Float.NaN, 0, 0, 0}, 0.5f, 0.5f));
        assertFalse(gaze.add(new float[]{0, 0, 0, 0}, Float.NaN, 0.5f));
        assertNull(gaze.project(new float[]{Float.NaN, 0, 0, 0}));
    }

    @Test public void serializesAndRestoresCalibratedAffineWeights() {
        GazeCalibrator source = new GazeCalibrator();
        assertNull(source.serializeWeights());
        float[][] inputs = {
                {0.10f, 0.12f, 0.08f, 0.10f}, {0.85f, 0.14f, 0.87f, 0.12f},
                {0.12f, 0.82f, 0.11f, 0.84f}, {0.86f, 0.83f, 0.84f, 0.81f},
                {0.48f, 0.48f, 0.50f, 0.50f}, {0.52f, 0.18f, 0.48f, 0.16f}
        };
        for (float[] input : inputs) {
            assertTrue(source.add(input, (input[0] + input[2]) * 0.5f, (input[1] + input[3]) * 0.5f));
        }
        assertTrue(source.calibrate());
        String serialized = source.serializeWeights();
        assertNotNull(serialized);

        GazeCalibrator restored = new GazeCalibrator();
        assertTrue(restored.restoreWeights(serialized));
        assertTrue(restored.isCalibrated());
        float[] probe = new float[]{0.30f, 0.35f, 0.34f, 0.33f};
        GazeCalibrator.Point expected = source.project(probe);
        GazeCalibrator.Point actual = restored.project(probe);
        assertNotNull(expected);
        assertNotNull(actual);
        assertEquals(expected.x, actual.x, 1e-6f);
        assertEquals(expected.y, actual.y, 1e-6f);

        assertFalse(restored.restoreWeights(""));
        assertFalse(restored.restoreWeights("v2|0,0,0,0,0|0,0,0,0,0"));
        assertFalse(restored.restoreWeights("v1|NaN,0,0,0,0|0,0,0,0,0"));
        assertFalse(restored.restoreWeights("v1|1,2,3|1,2,3"));
        assertTrue(restored.isCalibrated());
    }
}
