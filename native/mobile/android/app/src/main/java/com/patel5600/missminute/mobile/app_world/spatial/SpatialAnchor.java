package com.patel5600.missminute.mobile.app_world.spatial;

import android.graphics.RectF;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.EnumSet;
import java.util.Objects;
import java.util.Set;

/**
 * Immutable verifiable spatial anchor representing an application icon on the Android launcher screen.
 * Follows the Spatial Truth Contract: coordinates are documented in display-independent pixels (dp)
 * and tied to a specific layout revision and screen density.
 */
public final class SpatialAnchor {
    public static final String COORDINATE_SYSTEM_DP = "dp";
    public static final float CONFIDENCE_MIN_VALID = 0.5f;

    public final String packageId;
    public final String appName;
    public final String launcherIdentity;
    public final int pageIdentifier;
    public final int displayIdentifier;
    public final RectF bounds;
    public final String coordinateSystem;
    public final float density;
    public final long calibrationTimestamp;
    public final float confidence;
    public final long layoutRevision;
    public final Set<LandingSurface> availableSurfaces;

    public SpatialAnchor(String packageId, String appName, String launcherIdentity,
                         int pageIdentifier, int displayIdentifier, RectF bounds,
                         float density, long calibrationTimestamp, float confidence,
                         long layoutRevision, Set<LandingSurface> availableSurfaces) {
        this.packageId = Objects.requireNonNull(packageId, "packageId");
        this.appName = appName != null ? appName : packageId;
        this.launcherIdentity = launcherIdentity != null ? launcherIdentity : "";
        this.pageIdentifier = Math.max(0, pageIdentifier);
        this.displayIdentifier = displayIdentifier;
        this.bounds = new RectF(bounds);
        this.coordinateSystem = COORDINATE_SYSTEM_DP;
        this.density = density > 0 ? density : 1.0f;
        this.calibrationTimestamp = calibrationTimestamp;
        this.confidence = Math.max(0.0f, Math.min(1.0f, confidence));
        this.layoutRevision = layoutRevision;
        if (availableSurfaces == null || availableSurfaces.isEmpty()) {
            this.availableSurfaces = Collections.unmodifiableSet(EnumSet.allOf(LandingSurface.class));
        } else {
            this.availableSurfaces = Collections.unmodifiableSet(EnumSet.copyOf(availableSurfaces));
        }
    }

    /**
     * Checks if this anchor is currently valid (non-stale and sufficiently confident)
     * against the active layout revision and screen density.
     */
    public boolean isValid(long currentLayoutRevision, float currentDensity) {
        if (confidence < CONFIDENCE_MIN_VALID) {
            return false;
        }
        if (layoutRevision != currentLayoutRevision) {
            return false;
        }
        return Math.abs(density - currentDensity) <= 0.05f;
    }

    /**
     * True if the anchor has been invalidated by a layout, orientation, or density change.
     */
    public boolean isStale(long currentLayoutRevision, float currentDensity) {
        return !isValid(currentLayoutRevision, currentDensity);
    }

    /**
     * Computes the character window position for a target landing surface.
     */
    public float[] getAttachment(LandingSurface surface, double charBoxW, double charBoxH, double footInset) {
        LandingSurface target = (surface != null && availableSurfaces.contains(surface))
                ? surface : LandingSurface.TOP;
        return target.calculateAttachment(bounds, charBoxW, charBoxH, footInset);
    }

    /**
     * Returns an updated anchor with modified confidence score.
     */
    public SpatialAnchor withConfidence(float newConfidence) {
        return new SpatialAnchor(packageId, appName, launcherIdentity, pageIdentifier,
                displayIdentifier, bounds, density, calibrationTimestamp,
                newConfidence, layoutRevision, availableSurfaces);
    }

    /**
     * Returns an updated anchor marked with a new layout revision.
     */
    public SpatialAnchor withRevision(long newRevision) {
        return new SpatialAnchor(packageId, appName, launcherIdentity, pageIdentifier,
                displayIdentifier, bounds, density, calibrationTimestamp,
                confidence, newRevision, availableSurfaces);
    }

    public JSONObject toJson() {
        try {
            JSONObject obj = new JSONObject();
            obj.put("packageId", packageId);
            obj.put("appName", appName);
            obj.put("launcherIdentity", launcherIdentity);
            obj.put("pageIdentifier", pageIdentifier);
            obj.put("displayIdentifier", displayIdentifier);
            obj.put("coordinateSystem", coordinateSystem);
            obj.put("density", (double) density);
            obj.put("calibrationTimestamp", calibrationTimestamp);
            obj.put("confidence", (double) confidence);
            obj.put("layoutRevision", layoutRevision);

            JSONObject rect = new JSONObject();
            rect.put("left", (double) bounds.left);
            rect.put("top", (double) bounds.top);
            rect.put("right", (double) bounds.right);
            rect.put("bottom", (double) bounds.bottom);
            obj.put("bounds", rect);

            JSONArray surfaces = new JSONArray();
            for (LandingSurface s : availableSurfaces) {
                surfaces.put(s.name());
            }
            obj.put("availableSurfaces", surfaces);
            return obj;
        } catch (JSONException e) {
            throw new RuntimeException("SpatialAnchor serialization failed", e);
        }
    }

    public static SpatialAnchor fromJson(JSONObject obj) throws JSONException {
        String packageId = obj.getString("packageId");
        String appName = obj.optString("appName", packageId);
        String launcherIdentity = obj.optString("launcherIdentity", "");
        int pageIdentifier = obj.optInt("pageIdentifier", 0);
        int displayIdentifier = obj.optInt("displayIdentifier", 0);
        float density = (float) obj.optDouble("density", 1.0);
        long calibrationTimestamp = obj.optLong("calibrationTimestamp", System.currentTimeMillis());
        float confidence = (float) obj.optDouble("confidence", 1.0);
        long layoutRevision = obj.optLong("layoutRevision", 0L);

        JSONObject rect = obj.getJSONObject("bounds");
        RectF bounds = new RectF(
                (float) rect.getDouble("left"),
                (float) rect.getDouble("top"),
                (float) rect.getDouble("right"),
                (float) rect.getDouble("bottom")
        );

        Set<LandingSurface> surfaces = EnumSet.noneOf(LandingSurface.class);
        JSONArray arr = obj.optJSONArray("availableSurfaces");
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                try {
                    surfaces.add(LandingSurface.valueOf(arr.getString(i)));
                } catch (IllegalArgumentException ignored) {
                }
            }
        }
        if (surfaces.isEmpty()) {
            surfaces = EnumSet.allOf(LandingSurface.class);
        }

        return new SpatialAnchor(packageId, appName, launcherIdentity, pageIdentifier,
                displayIdentifier, bounds, density, calibrationTimestamp,
                confidence, layoutRevision, surfaces);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (o == null || getClass() != o.getClass()) return false;
        SpatialAnchor that = (SpatialAnchor) o;
        return pageIdentifier == that.pageIdentifier &&
                displayIdentifier == that.displayIdentifier &&
                Float.compare(that.density, density) == 0 &&
                calibrationTimestamp == that.calibrationTimestamp &&
                Float.compare(that.confidence, confidence) == 0 &&
                layoutRevision == that.layoutRevision &&
                packageId.equals(that.packageId) &&
                bounds.equals(that.bounds);
    }

    @Override
    public int hashCode() {
        return Objects.hash(packageId, pageIdentifier, bounds, layoutRevision);
    }

    @Override
    public String toString() {
        return "SpatialAnchor{" + packageId + " " + appName +
                " bounds=[" + bounds.left + "," + bounds.top + "," + bounds.right + "," + bounds.bottom + "]" +
                " page=" + pageIdentifier + " conf=" + confidence + " rev=" + layoutRevision + "}";
    }
}
