package com.patel5600.missminute.mobile.app_world.spatial;

import android.content.Context;
import android.util.Log;

import com.patel5600.missminute.mobile.core.AtomicFiles;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Persistent atomic storage for calibrated spatial anchors, layout revisions,
 * and character visit history.
 */
public final class SpatialMemory {
    private static final String TAG = "MMSpatialMemory";
    private static final String FILE_NAME = "spatial_memory.json";
    private static final long RECENCY_HALFLIFE_MS = 45_000L;

    private final File storageFile;
    private final Map<String, SpatialAnchor> anchors = new HashMap<>();
    private final Map<String, Integer> visitCounts = new HashMap<>();
    private final Map<String, Long> lastVisitTimes = new HashMap<>();

    private long currentLayoutRevision = 1L;
    private float lastDensity = 1.0f;
    private double lastWidth = 0;
    private double lastHeight = 0;
    private int activePage = 0;

    public SpatialMemory(Context context) {
        this.storageFile = new File(context.getFilesDir(), FILE_NAME);
        load();
    }

    public synchronized long currentRevision() {
        return currentLayoutRevision;
    }

    public synchronized int getActivePage() {
        return activePage;
    }

    public synchronized void setActivePage(int page) {
        this.activePage = Math.max(0, page);
    }

    /**
     * Checks if display dimensions or density changed, incrementing layout revision
     * and invalidating stale anchors.
     */
    public synchronized boolean onDisplayMetricsChanged(double widthDp, double heightDp, float density) {
        boolean changed = (Math.abs(lastWidth - widthDp) > 1.0 ||
                Math.abs(lastHeight - heightDp) > 1.0 ||
                Math.abs(lastDensity - density) > 0.05f);

        if (changed) {
            Log.i(TAG, "Display geometry changed from (" + lastWidth + "x" + lastHeight + "@" + lastDensity
                    + ") to (" + widthDp + "x" + heightDp + "@" + density + "). Incrementing layout revision.");
            lastWidth = widthDp;
            lastHeight = heightDp;
            lastDensity = density;
            currentLayoutRevision++;
            save();
            return true;
        }
        return false;
    }

    public synchronized void saveAnchor(SpatialAnchor anchor) {
        if (anchor == null) return;
        // Ensure anchor carries the active layout revision
        SpatialAnchor updated = anchor.layoutRevision == currentLayoutRevision
                ? anchor : anchor.withRevision(currentLayoutRevision);
        anchors.put(updated.packageId, updated);
        save();
        Log.i(TAG, "Saved spatial anchor: " + updated);
    }

    public synchronized void saveAnchors(List<SpatialAnchor> list) {
        if (list == null) return;
        for (SpatialAnchor a : list) {
            if (a != null) {
                anchors.put(a.packageId, a.withRevision(currentLayoutRevision));
            }
        }
        save();
    }

    public synchronized SpatialAnchor getAnchor(String packageId) {
        return anchors.get(packageId);
    }

    public synchronized List<SpatialAnchor> getAllAnchors() {
        return Collections.unmodifiableList(new ArrayList<>(anchors.values()));
    }

    /**
     * Returns verified, non-stale anchors belonging to the specified launcher page.
     */
    public synchronized List<SpatialAnchor> getValidAnchorsForPage(int page) {
        List<SpatialAnchor> result = new ArrayList<>();
        for (SpatialAnchor anchor : anchors.values()) {
            if (anchor.pageIdentifier == page && anchor.isValid(currentLayoutRevision, lastDensity)) {
                result.add(anchor);
            }
        }
        return result;
    }

    public synchronized List<SpatialAnchor> getValidAnchors() {
        return getValidAnchorsForPage(activePage);
    }

    public synchronized void recordVisit(String packageId, long nowMs) {
        if (packageId == null) return;
        int count = visitCounts.getOrDefault(packageId, 0) + 1;
        visitCounts.put(packageId, count);
        lastVisitTimes.put(packageId, nowMs);
        save();
    }

    public synchronized int getVisitCount(String packageId) {
        return visitCounts.getOrDefault(packageId, 0);
    }

    public synchronized long getLastVisitTime(String packageId) {
        return lastVisitTimes.getOrDefault(packageId, 0L);
    }

    /**
     * Calculates a recency penalty [0.0, 1.0] for Utility AI to prevent repetitive hops.
     * High penalty if visited very recently, decays to 0 over time.
     */
    public synchronized double getRecencyPenalty(String packageId, long nowMs) {
        Long lastTime = lastVisitTimes.get(packageId);
        if (lastTime == null || lastTime == 0L) {
            return 0.0;
        }
        long delta = Math.max(0L, nowMs - lastTime);
        return Math.exp(-((double) delta) / RECENCY_HALFLIFE_MS);
    }

    public synchronized void clear() {
        anchors.clear();
        visitCounts.clear();
        lastVisitTimes.clear();
        currentLayoutRevision++;
        save();
    }

    private void save() {
        try {
            JSONObject root = new JSONObject();
            root.put("revision", currentLayoutRevision);
            root.put("lastWidth", lastWidth);
            root.put("lastHeight", lastHeight);
            root.put("lastDensity", (double) lastDensity);
            root.put("activePage", activePage);

            JSONArray anchorArray = new JSONArray();
            for (SpatialAnchor a : anchors.values()) {
                anchorArray.put(a.toJson());
            }
            root.put("anchors", anchorArray);

            JSONObject visits = new JSONObject();
            for (Map.Entry<String, Integer> e : visitCounts.entrySet()) {
                visits.put(e.getKey(), e.getValue().intValue());
            }
            root.put("visitCounts", visits);

            JSONObject times = new JSONObject();
            for (Map.Entry<String, Long> e : lastVisitTimes.entrySet()) {
                times.put(e.getKey(), e.getValue().longValue());
            }
            root.put("lastVisitTimes", times);

            AtomicFiles.write(storageFile, root.toString(2), s -> s != null && s.length() > 0);
        } catch (JSONException | IOException e) {
            Log.e(TAG, "Failed to persist spatial memory", e);
        }
    }

    private void load() {
        if (!storageFile.exists()) {
            return;
        }
        try {
            String content = AtomicFiles.read(storageFile);
            if (content == null || content.isEmpty()) return;
            JSONObject root = new JSONObject(content);
            currentLayoutRevision = root.optLong("revision", 1L);
            lastWidth = root.optDouble("lastWidth", 0);
            lastHeight = root.optDouble("lastHeight", 0);
            lastDensity = (float) root.optDouble("lastDensity", 1.0);
            activePage = root.optInt("activePage", 0);

            JSONArray anchorArray = root.optJSONArray("anchors");
            if (anchorArray != null) {
                for (int i = 0; i < anchorArray.length(); i++) {
                    try {
                        SpatialAnchor a = SpatialAnchor.fromJson(anchorArray.getJSONObject(i));
                        anchors.put(a.packageId, a);
                    } catch (JSONException ignored) {
                    }
                }
            }

            JSONObject visits = root.optJSONObject("visitCounts");
            if (visits != null) {
                JSONArray names = visits.names();
                if (names != null) {
                    for (int i = 0; i < names.length(); i++) {
                        String key = names.getString(i);
                        visitCounts.put(key, visits.getInt(key));
                    }
                }
            }

            JSONObject times = root.optJSONObject("lastVisitTimes");
            if (times != null) {
                JSONArray names = times.names();
                if (names != null) {
                    for (int i = 0; i < names.length(); i++) {
                        String key = names.getString(i);
                        lastVisitTimes.put(key, times.getLong(key));
                    }
                }
            }
            Log.i(TAG, "Loaded " + anchors.size() + " spatial anchors from disk (rev " + currentLayoutRevision + ").");
        } catch (JSONException | IOException e) {
            Log.w(TAG, "Could not load spatial memory: " + e.getMessage());
        }
    }
}
