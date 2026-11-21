package com.patel5600.missminute.mobile.app;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public final class FaceQualityGateTest {
    @Test public void frontalPosePassesAndLargeRotationsAreInsufficientEvidence() {
        assertEquals(FaceQualityGate.Result.USABLE, FaceQualityGate.evaluatePose(-6f, 8f, 4f));
        assertEquals(FaceQualityGate.Result.POSE_UNSUITABLE, FaceQualityGate.evaluatePose(26f, 0f, 0f));
        assertEquals(FaceQualityGate.Result.POSE_UNSUITABLE, FaceQualityGate.evaluatePose(0f, Float.NaN, 0f));
    }
}
