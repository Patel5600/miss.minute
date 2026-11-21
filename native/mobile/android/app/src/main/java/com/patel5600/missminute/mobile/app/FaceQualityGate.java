package com.patel5600.missminute.mobile.app;

import android.graphics.Rect;

import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceLandmark;

/**
 * Rejects observations that are too small or too far from a frontal view for a useful embedding.
 * This is an image-quality gate, not liveness detection or identity evidence.
 */
final class FaceQualityGate {
    static final int MIN_FACE_EDGE = 100;
    static final float MAX_YAW_DEGREES = 25f;
    static final float MAX_PITCH_DEGREES = 25f;
    static final float MAX_ROLL_DEGREES = 22f;
    static final float MIN_EYE_SEPARATION_RATIO = 0.22f;

    enum Result { USABLE, TOO_SMALL, POSE_UNSUITABLE, LANDMARKS_UNAVAILABLE }

    private FaceQualityGate() {}

    static Result evaluate(Face face, Rect bounds) {
        if (face == null || bounds == null) return Result.LANDMARKS_UNAVAILABLE;
        if (bounds.width() < MIN_FACE_EDGE || bounds.height() < MIN_FACE_EDGE) return Result.TOO_SMALL;
        Result pose = evaluatePose(face.getHeadEulerAngleY(), face.getHeadEulerAngleX(), face.getHeadEulerAngleZ());
        if (pose != Result.USABLE) return pose;
        FaceLandmark right = face.getLandmark(FaceLandmark.RIGHT_EYE);
        FaceLandmark left = face.getLandmark(FaceLandmark.LEFT_EYE);
        if (right == null || left == null) return Result.LANDMARKS_UNAVAILABLE;
        float dx = right.getPosition().x - left.getPosition().x;
        float dy = right.getPosition().y - left.getPosition().y;
        float separation = (float) Math.sqrt(dx * dx + dy * dy);
        return separation >= bounds.width() * MIN_EYE_SEPARATION_RATIO
                ? Result.USABLE : Result.LANDMARKS_UNAVAILABLE;
    }

    static Result evaluatePose(float yaw, float pitch, float roll) {
        return within(yaw, MAX_YAW_DEGREES) && within(pitch, MAX_PITCH_DEGREES)
                && within(roll, MAX_ROLL_DEGREES) ? Result.USABLE : Result.POSE_UNSUITABLE;
    }

    private static boolean within(float angle, float limit) {
        return Float.isFinite(angle) && Math.abs(angle) <= limit;
    }
}
