package com.patel5600.missminute.mobile.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.graphics.Bitmap;

import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceContour;
import com.google.mlkit.vision.face.FaceLandmark;

import org.opencv.android.OpenCVLoader;
import org.opencv.android.Utils;
import org.opencv.core.CvType;
import org.opencv.core.Mat;
import org.opencv.core.Core;
import org.opencv.core.Scalar;
import org.opencv.imgproc.Imgproc;
import org.opencv.objdetect.FaceRecognizerSF;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;

/** Local SFace inference with model-provided face alignment. Images are never persisted. */
final class LocalFaceMatcher {
    static final double SAME_FACE_THRESHOLD = 0.363; // OpenCV Zoo SFace cosine operating point.

    /**
     * Maps raw SFace cosine similarity onto the shared Rust candidate confidence scale where
     * {@link #SAME_FACE_THRESHOLD} aligns with {@code MIN_CANDIDATE_CONFIDENCE = 0.70}.
     */
    static float normalizedConfidence(double cosineSimilarity) {
        if (!Double.isFinite(cosineSimilarity) || cosineSimilarity <= 0.0) return 0.0f;
        if (cosineSimilarity < SAME_FACE_THRESHOLD) {
            return (float) ((cosineSimilarity / SAME_FACE_THRESHOLD) * 0.69);
        }
        double span = 1.0 - SAME_FACE_THRESHOLD;
        double bounded = Math.min(cosineSimilarity, 1.0);
        return (float) Math.min(1.0, 0.70 + ((bounded - SAME_FACE_THRESHOLD) / span) * 0.30);
    }
    private static final String ASSET = "face/face_recognition_sface_2021dec_int8.onnx";
    private static final String MODEL_SHA256 = "2b0e941e6f16cc048c20aee0c8e31f569118f65d702914540f7bfdc14048d78a";
    private static final int TEMPLATE_DIMENSIONS = 128;
    private final FaceRecognizerSF recognizer;

    LocalFaceMatcher(Context context) throws Exception {
        if (!OpenCVLoader.initLocal()) throw new IllegalStateException("OpenCV native runtime did not load.");
        Core.setNumThreads(2);
        File model = materializeModel(context.getApplicationContext());
        recognizer = FaceRecognizerSF.create(model.getAbsolutePath(), "");
        if (recognizer == null || recognizer.getNativeObjAddr() == 0)
            throw new IllegalStateException("OpenCV could not initialize the local SFace model.");
        // Pay model initialization cost off the UI thread before the first live owner observation.
        Mat warmupImage = new Mat(112, 112, CvType.CV_8UC3, Scalar.all(0));
        Mat warmupFeatures = new Mat();
        try {
            recognizer.feature(warmupImage, warmupFeatures);
            if (warmupFeatures.total() != TEMPLATE_DIMENSIONS)
                throw new IllegalStateException("SFace model produced an unexpected embedding shape.");
        } finally {
            warmupImage.release();
            warmupFeatures.release();
        }
    }

    float[] embedding(Bitmap cameraFrame, Face face) {
        if (cameraFrame == null || face == null) return null;
        Mat rgba = new Mat();
        Mat bgr = new Mat();
        Mat faceRow = new Mat(1, 15, CvType.CV_32FC1);
        Mat aligned = new Mat();
        Mat features = new Mat();
        try {
            Utils.bitmapToMat(cameraFrame, rgba);
            Imgproc.cvtColor(rgba, bgr, Imgproc.COLOR_RGBA2BGR);
            float[] detection = toFaceRow(face, cameraFrame.getWidth(), cameraFrame.getHeight());
            if (detection == null) return null;
            faceRow.put(0, 0, detection);
            recognizer.alignCrop(bgr, faceRow, aligned);
            if (aligned.empty() || aligned.cols() != 112 || aligned.rows() != 112) return null;
            recognizer.feature(aligned, features);
            if (features.total() != TEMPLATE_DIMENSIONS || features.type() != CvType.CV_32FC1) return null;
            float[] embedding = new float[TEMPLATE_DIMENSIONS];
            features.get(0, 0, embedding);
            normalize(embedding);
            return embedding;
        } catch (RuntimeException inferenceError) {
            return null;
        } finally {
            rgba.release();
            bgr.release();
            faceRow.release();
            aligned.release();
            features.release();
        }
    }

    double similarity(float[] enrolled, float[] observed) {
        if (!valid(enrolled) || !valid(observed)) return Double.NaN;
        Mat expected = new Mat(1, TEMPLATE_DIMENSIONS, CvType.CV_32FC1);
        Mat current = new Mat(1, TEMPLATE_DIMENSIONS, CvType.CV_32FC1);
        try {
            expected.put(0, 0, enrolled);
            current.put(0, 0, observed);
            return recognizer.match(expected, current, FaceRecognizerSF.FR_COSINE);
        } catch (RuntimeException error) {
            return Double.NaN;
        } finally {
            expected.release();
            current.release();
        }
    }

    static float[] averageNormalized(java.util.List<float[]> samples) {
        if (samples == null || samples.size() < 3) return null;
        float[] average = new float[TEMPLATE_DIMENSIONS];
        for (float[] sample : samples) {
            if (!valid(sample)) return null;
            for (int i = 0; i < average.length; i++) average[i] += sample[i];
        }
        for (int i = 0; i < average.length; i++) average[i] /= samples.size();
        normalize(average);
        return valid(average) ? average : null;
    }

    private static float[] toFaceRow(Face face, int imageWidth, int imageHeight) {
        android.graphics.Rect bounds = face.getBoundingBox();
        if (bounds.width() < 100 || bounds.height() < 100) return null;
        FaceLandmark rightEye = face.getLandmark(FaceLandmark.RIGHT_EYE);
        FaceLandmark leftEye = face.getLandmark(FaceLandmark.LEFT_EYE);
        FaceLandmark nose = face.getLandmark(FaceLandmark.NOSE_BASE);
        android.graphics.PointF[] mouthCorners = mouthCorners(face);
        if (rightEye == null || leftEye == null || nose == null || mouthCorners == null)
            return null;
        float x = clamp(bounds.left, 0, imageWidth - 1);
        float y = clamp(bounds.top, 0, imageHeight - 1);
        float right = clamp(bounds.right, x + 1, imageWidth);
        float bottom = clamp(bounds.bottom, y + 1, imageHeight);
        float[] values = {
                x, y, right - x, bottom - y,
                rightEye.getPosition().x, rightEye.getPosition().y,
                leftEye.getPosition().x, leftEye.getPosition().y,
                nose.getPosition().x, nose.getPosition().y,
                mouthCorners[0].x, mouthCorners[0].y,
                mouthCorners[1].x, mouthCorners[1].y,
                1.0f
        };
        for (float value : values) if (!Float.isFinite(value)) return null;
        for (int i = 4; i <= 12; i += 2) {
            if (values[i] < 0 || values[i] >= imageWidth || values[i + 1] < 0 || values[i + 1] >= imageHeight)
                return null;
        }
        return values;
    }

    /** ML Kit exposes lip corners as contour points rather than named mouth landmarks. */
    private static android.graphics.PointF[] mouthCorners(Face face) {
        FaceContour contour = face.getContour(FaceContour.UPPER_LIP_TOP);
        if (contour == null || contour.getPoints().size() < 5) return null;
        android.graphics.PointF left = null;
        android.graphics.PointF right = null;
        for (android.graphics.PointF point : contour.getPoints()) {
            if (left == null || point.x < left.x) left = point;
            if (right == null || point.x > right.x) right = point;
        }
        if (left == null || right == null || right.x - left.x < 4f) return null;
        // FaceRecognizerSF's landmark order uses the subject's right corner before left.
        return new android.graphics.PointF[]{left, right};
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    private static void normalize(float[] values) {
        double norm = 0;
        for (float value : values) norm += value * value;
        if (norm < 1e-12) throw new IllegalArgumentException("Empty face embedding.");
        float inverse = (float) (1.0 / Math.sqrt(norm));
        for (int i = 0; i < values.length; i++) values[i] *= inverse;
    }

    private static boolean valid(float[] values) {
        if (values == null || values.length != TEMPLATE_DIMENSIONS) return false;
        double norm = 0;
        for (float value : values) {
            if (!Float.isFinite(value)) return false;
            norm += value * value;
        }
        return norm >= 0.5 && norm <= 1.5;
    }

    private static File materializeModel(Context context) throws Exception {
        File file = new File(context.getFilesDir(), "face/face_recognition_sface_2021dec_int8.onnx");
        if (file.isFile() && MODEL_SHA256.equals(sha256(file))) return file;
        File parent = file.getParentFile();
        if (parent == null || (!parent.isDirectory() && !parent.mkdirs()))
            throw new IllegalStateException("Cannot create the private model directory.");
        File temporary = new File(parent, file.getName() + ".partial");
        AssetManager assets = context.getAssets();
        try (InputStream input = assets.open(ASSET); FileOutputStream output = new FileOutputStream(temporary)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            long total = 0;
            while ((count = input.read(buffer)) != -1) {
                total += count;
                if (total > 12L * 1024 * 1024) throw new IllegalStateException("SFace model asset exceeds the size limit.");
                output.write(buffer, 0, count);
            }
            output.getFD().sync();
        }
        if (!MODEL_SHA256.equals(sha256(temporary))) {
            temporary.delete();
            throw new SecurityException("SFace model asset failed its SHA-256 integrity check.");
        }
        if (file.exists() && !file.delete()) throw new IllegalStateException("Cannot replace the local model cache.");
        if (!temporary.renameTo(file)) throw new IllegalStateException("Cannot finalize the local model cache.");
        return file;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        StringBuilder encoded = new StringBuilder(64);
        for (byte value : digest.digest()) encoded.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return encoded.toString();
    }
}
