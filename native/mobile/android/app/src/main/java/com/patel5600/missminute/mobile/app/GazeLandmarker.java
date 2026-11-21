package com.patel5600.missminute.mobile.app;

import android.content.Context;
import android.media.Image;

import com.google.mediapipe.framework.image.MediaImageBuilder;
import com.google.mediapipe.framework.image.MPImage;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions;
import com.google.mediapipe.tasks.vision.core.RunningMode;
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker;
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult;

import java.util.List;

/** Local iris landmarks and normalized eye-relative features for per-device calibration. */
final class GazeLandmarker implements AutoCloseable {
    private final FaceLandmarker landmarker;

    GazeLandmarker(Context context) throws Exception {
        BaseOptions base = BaseOptions.builder()
                .setModelAssetPath("mediapipe/face_landmarker.task")
                .build();
        FaceLandmarker.FaceLandmarkerOptions options = FaceLandmarker.FaceLandmarkerOptions.builder()
                .setBaseOptions(base)
                .setRunningMode(RunningMode.VIDEO)
                .setNumFaces(2)
                .setMinFaceDetectionConfidence(0.6f)
                .setMinFacePresenceConfidence(0.6f)
                .setMinTrackingConfidence(0.6f)
                .build();
        landmarker = FaceLandmarker.createFromOptions(context, options);
    }

    /** Returns iris/eye-corner features only when one face and all ten iris landmarks exist. */
    float[] estimate(Image mediaImage, int rotationDegrees, long timestampMs) {
        MPImage image = new MediaImageBuilder(mediaImage).build();
        try {
            ImageProcessingOptions transform = ImageProcessingOptions.builder()
                    .setRotationDegrees(rotationDegrees)
                    .build();
            FaceLandmarkerResult result = landmarker.detectForVideo(image, transform, timestampMs);
            List<List<NormalizedLandmark>> faces = result.faceLandmarks();
            if (faces.size() != 1 || faces.get(0).size() < 478) return null;
            List<NormalizedLandmark> face = faces.get(0);
            return new float[]{
                    horizontal(face, 468, 33, 133), vertical(face, 468, 159, 145),
                    horizontal(face, 473, 362, 263), vertical(face, 473, 386, 374)
            };
        } finally {
            image.close();
        }
    }

    private static float horizontal(List<NormalizedLandmark> face, int iris, int a, int b) {
        float x1 = face.get(a).x();
        float x2 = face.get(b).x();
        float width = Math.abs(x2 - x1);
        if (width < 0.005f) return Float.NaN;
        return (face.get(iris).x() - Math.min(x1, x2)) / width;
    }

    private static float vertical(List<NormalizedLandmark> face, int iris, int top, int bottom) {
        float y1 = face.get(top).y();
        float y2 = face.get(bottom).y();
        float height = Math.abs(y2 - y1);
        if (height < 0.002f) return Float.NaN;
        return (face.get(iris).y() - (y1 + y2) * 0.5f) / height;
    }

    @Override public void close() { landmarker.close(); }
}
