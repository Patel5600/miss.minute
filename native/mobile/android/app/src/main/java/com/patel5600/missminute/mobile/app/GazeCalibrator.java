package com.patel5600.missminute.mobile.app;

import android.content.Context;

import java.util.ArrayList;
import java.util.List;

/** Fits a local affine mapping from both eyes' iris features to normalized screen coordinates. */
final class GazeCalibrator {
    private static final String PREFS = "miss_minutes_gaze";
    private static final String KEY_WEIGHTS = "affine_weights_v1";
    private static final int FEATURES = 5; // left x/y, right x/y, intercept
    private final List<Sample> samples = new ArrayList<>();
    private double[] horizontal;
    private double[] vertical;

    static final class Point {
        final float x;
        final float y;
        Point(float x, float y) { this.x = x; this.y = y; }
    }

    private static final class Sample {
        final double[] features;
        final double x;
        final double y;
        Sample(float[] input, float x, float y) {
            features = new double[]{input[0], input[1], input[2], input[3], 1.0};
            this.x = x;
            this.y = y;
        }
    }

    synchronized boolean add(float[] features, float screenX, float screenY) {
        if (features == null || features.length != 4 || !Float.isFinite(screenX)
                || !Float.isFinite(screenY) || screenX < 0 || screenX > 1
                || screenY < 0 || screenY > 1) return false;
        for (float value : features) if (!Float.isFinite(value)) return false;
        samples.add(new Sample(features.clone(), screenX, screenY));
        horizontal = null;
        vertical = null;
        return true;
    }

    synchronized int sampleCount() { return samples.size(); }
    synchronized boolean isCalibrated() { return horizontal != null && vertical != null; }

    synchronized void clear() {
        samples.clear();
        horizontal = null;
        vertical = null;
    }

    synchronized boolean calibrate() {
        if (samples.size() < FEATURES) return false;
        double[][] normal = new double[FEATURES][FEATURES];
        double[] x = new double[FEATURES];
        double[] y = new double[FEATURES];
        for (Sample sample : samples) {
            for (int row = 0; row < FEATURES; row++) {
                x[row] += sample.features[row] * sample.x;
                y[row] += sample.features[row] * sample.y;
                for (int col = 0; col < FEATURES; col++) {
                    normal[row][col] += sample.features[row] * sample.features[col];
                }
            }
        }
        for (int i = 0; i < FEATURES - 1; i++) normal[i][i] += 1e-4;
        horizontal = solve(normal, x);
        vertical = solve(normal, y);
        if (horizontal == null || vertical == null) {
            horizontal = null;
            vertical = null;
            return false;
        }
        return true;
    }

    synchronized Point project(float[] features) {
        if (horizontal == null || vertical == null || features == null || features.length != 4) return null;
        for (float value : features) if (!Float.isFinite(value)) return null;
        double[] input = {features[0], features[1], features[2], features[3], 1.0};
        double x = dot(horizontal, input);
        double y = dot(vertical, input);
        if (!Double.isFinite(x) || !Double.isFinite(y) || x < -0.25 || x > 1.25 || y < -0.25 || y > 1.25) return null;
        return new Point((float) Math.max(0, Math.min(1, x)), (float) Math.max(0, Math.min(1, y)));
    }

    synchronized String serializeWeights() {
        if (horizontal == null || vertical == null
                || horizontal.length != FEATURES || vertical.length != FEATURES) {
            return null;
        }
        StringBuilder out = new StringBuilder("v1|");
        for (int i = 0; i < FEATURES; i++) {
            if (!Double.isFinite(horizontal[i])) return null;
            if (i > 0) out.append(',');
            out.append(Double.toString(horizontal[i]));
        }
        out.append('|');
        for (int i = 0; i < FEATURES; i++) {
            if (!Double.isFinite(vertical[i])) return null;
            if (i > 0) out.append(',');
            out.append(Double.toString(vertical[i]));
        }
        return out.toString();
    }

    synchronized boolean restoreWeights(String raw) {
        if (raw == null || raw.isEmpty() || raw.length() > 2048) return false;
        String[] parts = raw.split("\\|", -1);
        if (parts.length != 3 || !"v1".equals(parts[0])) return false;
        double[] nextH = parseVector(parts[1]);
        double[] nextV = parseVector(parts[2]);
        if (nextH == null || nextV == null) return false;
        horizontal = nextH;
        vertical = nextV;
        return true;
    }

    boolean save(Context context) {
        if (context == null) return false;
        String serialized = serializeWeights();
        if (serialized == null) return false;
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_WEIGHTS, serialized)
                .commit();
    }

    boolean load(Context context) {
        if (context == null) return false;
        String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_WEIGHTS, null);
        return restoreWeights(raw);
    }

    static void clearPersisted(Context context) {
        if (context == null) return;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_WEIGHTS).commit();
    }

    private static double[] parseVector(String csv) {
        if (csv == null || csv.isEmpty()) return null;
        String[] tokens = csv.split(",", -1);
        if (tokens.length != FEATURES) return null;
        double[] values = new double[FEATURES];
        for (int i = 0; i < FEATURES; i++) {
            try {
                double parsed = Double.parseDouble(tokens[i]);
                if (!Double.isFinite(parsed) || Math.abs(parsed) > 1e6) return null;
                values[i] = parsed;
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return values;
    }

    private static double dot(double[] a, double[] b) {
        double value = 0;
        for (int i = 0; i < a.length; i++) value += a[i] * b[i];
        return value;
    }

    private static double[] solve(double[][] matrix, double[] vector) {
        int n = vector.length;
        double[][] a = new double[n][n + 1];
        for (int row = 0; row < n; row++) {
            System.arraycopy(matrix[row], 0, a[row], 0, n);
            a[row][n] = vector[row];
        }
        for (int col = 0; col < n; col++) {
            int pivot = col;
            for (int row = col + 1; row < n; row++)
                if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
            if (Math.abs(a[pivot][col]) < 1e-9) return null;
            double[] swap = a[col]; a[col] = a[pivot]; a[pivot] = swap;
            double divisor = a[col][col];
            for (int j = col; j <= n; j++) a[col][j] /= divisor;
            for (int row = 0; row < n; row++) {
                if (row == col) continue;
                double factor = a[row][col];
                for (int j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
            }
        }
        double[] result = new double[n];
        for (int row = 0; row < n; row++) result[row] = a[row][n];
        return result;
    }
}
