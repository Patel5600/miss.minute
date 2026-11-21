package com.patel5600.missminute.mobile.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.tasks.Task;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.face.Face;
import com.google.mlkit.vision.face.FaceDetection;
import com.google.mlkit.vision.face.FaceDetector;
import com.google.mlkit.vision.face.FaceDetectorOptions;
import com.patel5600.missminute.mobile.R;
import com.patel5600.missminute.mobile.overlay.OverlayService;

import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import java.io.IOException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Explicit, foreground-only face presence. ML Kit detects and tracks faces; it does not identify
 * the owner. A stable, single-face observation can only open Android's biometric challenge.
 */
public final class FacePresenceActivity extends Activity {
    static final String EXTRA_PENDING_OWNER_ENROLLMENT = "com.patel5600.missminute.pending-owner-enrollment";
    private static final int REQUEST_CAMERA = 7214;
    private static final int IMAGE_WIDTH = 640;
    private static final int IMAGE_HEIGHT = 480;
    private static final long MIN_FRAME_INTERVAL_MS = 250;
    // Camera frames are already throttled to 250 ms; matching at that cadence keeps the
    // two-observation candidate decision responsive without treating one frame as identity.
    private static final long MIN_MATCH_INTERVAL_MS = 250;
    private static final Object FACE_MATCHER_LOCK = new Object();
    private static volatile LocalFaceMatcher processFaceMatcher;

    @Override
    protected void onStart() {
        super.onStart();
        OverlayService.setDashboardForeground(this, true);
    }

    @Override
    protected void onStop() {
        OverlayService.setDashboardForeground(this, false);
        super.onStop();
    }

    private final AtomicBoolean processing = new AtomicBoolean(false);
    private final AttentionDwellGate attentionDwell = new AttentionDwellGate();
    private final GazeCalibrator gazeCalibrator = new GazeCalibrator();
    private static final float[][] CALIBRATION_TARGETS = {
            {0.12f, 0.12f}, {0.50f, 0.12f}, {0.88f, 0.12f},
            {0.88f, 0.50f}, {0.88f, 0.88f}, {0.50f, 0.88f},
            {0.12f, 0.88f}, {0.12f, 0.50f}, {0.50f, 0.50f}
    };
    private TextureView preview;
    private GazeOverlayView gazeOverlay;
    private TextView status;
    private Button scanButton;
    private Button gazeButton;
    private Button calibrateButton;
    private Button faceProfileButton;
    private Button verifyButton;
    private FaceDetector detector;
    private volatile GazeLandmarker gazeLandmarker;
    private volatile LocalFaceMatcher faceMatcher;
    private volatile float[] enrolledFaceTemplate;
    private volatile float[] latestGazeFeatures;
    private volatile int calibrationIndex = -1;
    private volatile boolean gazeEnabled;
    private volatile long gazeDwellStartedAt;
    private volatile long lastGazeDwellAt;
    private final float[] calibrationFeatureSum = new float[4];
    private int calibrationFeatureCount;
    private HandlerThread cameraThread;
    private Handler cameraHandler;
    private CameraDevice camera;
    private CameraCaptureSession captureSession;
    private ImageReader imageReader;
    private volatile boolean scanRequested;
    private volatile boolean verificationPending;
    private volatile boolean faceEnrollmentRequested;
    private boolean pendingOwnerEnrollment;
    private volatile long lastFrameAt;
    // Reject asynchronous ML Kit results originating before a pause, stop, or camera failure.
    private volatile long scanGeneration;
    private long lastMatchAt;
    private final FaceMatchConsensus faceMatchConsensus = new FaceMatchConsensus();
    private final List<float[]> enrollmentSamples = new ArrayList<>();
    private int stableFrames;
    private Integer lastTrackingId;
    private android.graphics.Rect lastFaceBounds;
    private String cameraId;
    private int imageRotation;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        pendingOwnerEnrollment = getIntent().getBooleanExtra(EXTRA_PENDING_OWNER_ENROLLMENT, false)
                && !OwnerAuthority.isEnrolled(this);
        FaceDetectorOptions options = new FaceDetectorOptions.Builder()
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
                .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
                .setContourMode(FaceDetectorOptions.CONTOUR_MODE_ALL)
                .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
                .setMinFaceSize(0.05f)
                .enableTracking()
                .build();
        detector = FaceDetection.getClient(options);
        buildView();
        requestScan();
    }

    private void buildView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(getColor(R.color.mm_base));
        root.setPadding(dp(16), dp(16), dp(16), dp(16));

        TextView explanation = new TextView(this);
        explanation.setText("Face presence is only a candidate signal. Miss Minutes will ask Android to verify you before unlocking owner access.");
        explanation.setTextColor(getColor(R.color.mm_cream));
        explanation.setTextSize(16);
        explanation.setPadding(0, 0, 0, dp(12));
        root.addView(explanation, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        FrameLayout previewFrame = new FrameLayout(this);
        preview = new TextureView(this);
        preview.setSurfaceTextureListener(surfaceListener);
        previewFrame.addView(preview, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        gazeOverlay = new GazeOverlayView(this);
        gazeOverlay.setOnTouchListener((view, event) -> onGazeOverlayTouch(event));
        previewFrame.addView(gazeOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(previewFrame, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        status = new TextView(this);
        status.setText("Camera is off.");
        status.setTextColor(getColor(R.color.mm_cream));
        status.setTextSize(15);
        status.setGravity(Gravity.CENTER_VERTICAL);
        status.setPadding(0, dp(12), 0, dp(8));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        root.addView(status, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.VERTICAL);
        LinearLayout cameraActions = new LinearLayout(this);
        cameraActions.setOrientation(LinearLayout.HORIZONTAL);
        cameraActions.setGravity(Gravity.CENTER_VERTICAL);
        scanButton = new Button(this);
        scanButton.setAllCaps(false);
        scanButton.setText("Start scan");
        scanButton.setOnClickListener(view -> {
            if (scanRequested) stopScan();
            else requestScan();
        });
        cameraActions.addView(scanButton, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        gazeButton = new Button(this);
        gazeButton.setAllCaps(false);
        gazeButton.setText("Enable gaze");
        gazeButton.setOnClickListener(view -> toggleGaze());
        cameraActions.addView(gazeButton, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        calibrateButton = new Button(this);
        calibrateButton.setAllCaps(false);
        calibrateButton.setText("Calibrate");
        calibrateButton.setEnabled(false);
        calibrateButton.setOnClickListener(view -> beginGazeCalibration());
        cameraActions.addView(calibrateButton, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        actions.addView(cameraActions);
        LinearLayout ownerActions = new LinearLayout(this);
        ownerActions.setOrientation(LinearLayout.HORIZONTAL);
        ownerActions.setGravity(Gravity.CENTER_VERTICAL);
        faceProfileButton = new Button(this);
        faceProfileButton.setAllCaps(false);
        faceProfileButton.setText(FaceProfileStore.exists(this) ? "Manage face"
                : pendingOwnerEnrollment && FaceProfileStore.existsPending(this) ? "Replace staged face" : "Enroll face");
        faceProfileButton.setEnabled(false);
        faceProfileButton.setOnClickListener(view -> manageFaceProfile());
        ownerActions.addView(faceProfileButton, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        verifyButton = new Button(this);
        verifyButton.setAllCaps(false);
        verifyButton.setText("Verify with device");
        verifyButton.setOnClickListener(view -> beginManualVerification());
        ownerActions.addView(verifyButton, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button close = new Button(this);
        close.setAllCaps(false);
        close.setText("Close");
        close.setOnClickListener(view -> finish());
        ownerActions.addView(close, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        actions.addView(ownerActions);
        Button voiceIdentity = new Button(this);
        voiceIdentity.setAllCaps(false);
        voiceIdentity.setText("Owner voice profile and match");
        voiceIdentity.setContentDescription("Open local owner voice enrollment and speaker match settings");
        voiceIdentity.setOnClickListener(view -> startActivity(new android.content.Intent(this, SpeakerIdentityActivity.class)
                .putExtra(SpeakerIdentityActivity.EXTRA_PENDING_OWNER_ENROLLMENT, pendingOwnerEnrollment)));
        actions.addView(voiceIdentity, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(actions, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        setContentView(root);
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void toggleGaze() {
        if (!scanRequested) {
            status.setText("Start the visible camera scan before enabling gaze interaction.");
            return;
        }
        if (gazeEnabled) {
            gazeEnabled = false;
            calibrationIndex = -1;
            latestGazeFeatures = null;
            gazeDwellStartedAt = 0;
            lastGazeDwellAt = 0;
            gazeOverlay.clear();
            gazeButton.setText("Enable gaze");
            calibrateButton.setEnabled(false);
            status.setText("Gaze processing paused. Camera presence scan remains active.");
            return;
        }
        if (cameraHandler == null) {
            status.setText("Camera processing is not ready. Start the scan again.");
            return;
        }
        gazeButton.setEnabled(false);
        status.setText("Loading the on-device iris landmark model. Camera frames stay on this device.");
        cameraHandler.post(() -> {
            try {
                if (gazeLandmarker == null) gazeLandmarker = new GazeLandmarker(getApplicationContext());
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    gazeEnabled = true;
                    gazeButton.setEnabled(true);
                    gazeButton.setText("Pause gaze");
                    calibrateButton.setEnabled(true);
                    if (gazeCalibrator.isCalibrated() || gazeCalibrator.load(getApplicationContext())) {
                        gazeOverlay.setOwnerActionTarget(0.50f, 0.50f);
                        status.setText("Saved gaze calibration restored. Hold gaze on the center target to request verification, or tap Calibrate to re-tune.");
                    } else {
                        status.setText("Local iris landmarks are active. Calibrate this camera and display before using gaze selection.");
                    }
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    gazeButton.setEnabled(true);
                    status.setText("The local gaze model could not start: " + error.getClass().getSimpleName());
                });
            }
        });
    }

    private void beginGazeCalibration() {
        if (!gazeEnabled || latestGazeFeatures == null) {
            status.setText("Wait until one face is visible and iris landmarks are available.");
            return;
        }
        gazeCalibrator.clear();
        calibrationIndex = 0;
        resetCalibrationFeatureWindow();
        gazeOverlay.setCalibrationTarget(CALIBRATION_TARGETS[0][0], CALIBRATION_TARGETS[0][1]);
        gazeOverlay.invalidate();
        status.setText("Look at the highlighted dot, hold your head still, then tap the dot. Nine points calibrate gaze locally.");
    }

    private boolean onGazeOverlayTouch(MotionEvent event) {
        int index = calibrationIndex;
        if (index < 0 || event.getAction() != MotionEvent.ACTION_UP) return index >= 0;
        float targetX = CALIBRATION_TARGETS[index][0];
        float targetY = CALIBRATION_TARGETS[index][1];
        float radius = dp(48);
        if (Math.hypot(event.getX() - targetX * gazeOverlay.getWidth(),
                event.getY() - targetY * gazeOverlay.getHeight()) > radius) {
            status.setText("Tap the highlighted calibration dot after looking at it.");
            return true;
        }
        float[] features = calibrationFeatureAverage();
        if (features == null) {
            status.setText("Hold your gaze on the dot until several stable iris frames are collected, then tap it.");
            return true;
        }
        float[] target = CALIBRATION_TARGETS[index];
        if (!gazeCalibrator.add(features, target[0], target[1])) {
            status.setText("This gaze sample was invalid. Look at the dot and tap it again.");
            return true;
        }
        int next = index + 1;
        if (next < CALIBRATION_TARGETS.length) {
            calibrationIndex = next;
            resetCalibrationFeatureWindow();
            gazeOverlay.setCalibrationTarget(CALIBRATION_TARGETS[next][0], CALIBRATION_TARGETS[next][1]);
            status.setText("Calibration point " + (next + 1) + " of " + CALIBRATION_TARGETS.length + ". Look at the dot and tap it.");
        } else if (gazeCalibrator.calibrate()) {
            calibrationIndex = -1;
            gazeCalibrator.save(getApplicationContext());
            gazeOverlay.setCalibrationTarget(-1f, -1f);
            gazeOverlay.setOwnerActionTarget(0.50f, 0.50f);
            status.setText("Gaze calibrated and saved for this device. Hold the center target to request Android verification.");
        } else {
            calibrationIndex = -1;
            gazeOverlay.clear();
            status.setText("Calibration points were too similar. Repeat while looking at each highlighted target.");
        }
        gazeOverlay.invalidate();
        return true;
    }

    private void requestScan() {
        if (verificationPending) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA);
            return;
        }
        scanRequested = true;
        stableFrames = 0;
        faceMatchConsensus.reset();
        lastTrackingId = null;
        lastFaceBounds = null;
        status.setText(enrolledFaceTemplate == null
                ? "Camera active. Face detection is local; enroll a face profile to distinguish the owner from unknown people."
                : "Camera active. Comparing one face against the encrypted on-device owner template.");
        scanButton.setText("Stop scan");
        scanButton.setEnabled(true);
        if (preview.isAvailable()) openCamera();
    }

    private final TextureView.SurfaceTextureListener surfaceListener = new TextureView.SurfaceTextureListener() {
        @Override public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) {
            if (scanRequested) openCamera();
        }
        @Override public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {}
        @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) { closeCamera(); return true; }
        @Override public void onSurfaceTextureUpdated(SurfaceTexture texture) {}
    };

    @Override
    protected void onResume() {
        super.onResume();
        gazeCalibrator.load(getApplicationContext());
        cameraThread = new HandlerThread("mm-face-presence");
        cameraThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());
        cameraHandler.post(() -> {
            try {
                synchronized (FACE_MATCHER_LOCK) {
                    if (processFaceMatcher == null) processFaceMatcher = new LocalFaceMatcher(getApplicationContext());
                    faceMatcher = processFaceMatcher;
                }
                enrolledFaceTemplate = FaceProfileStore.load(getApplicationContext());
                runOnUiThread(() -> {
                    if (isFinishing()) return;
                    faceProfileButton.setEnabled(true);
                    if (enrolledFaceTemplate == null) {
                        status.setText(pendingOwnerEnrollment
                                ? "Local face model is ready. Start the guided enrollment; the encrypted profile stays inactive until device verification."
                                : "Local face matching is ready. Enroll your face after device verification, or verify manually.");
                    } else if (scanRequested) {
                        status.setText("Local face matching is ready. Looking for the enrolled owner face.");
                    }
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (!isFinishing()) {
                        faceProfileButton.setEnabled(true);
                        status.setText("Local face matching could not start: " + error.getClass().getSimpleName()
                                + ". Device biometric verification remains available.");
                    }
                });
            }
        });
        if (scanRequested && !verificationPending && preview != null && preview.isAvailable()) openCamera();
    }

    private void beginManualVerification() {
        if (!OwnerAuthority.isEnrolled(this)) {
            status.setText("Set up owner access from the dashboard first. Face matching cannot create an owner identity.");
            return;
        }
        if (OwnerAuthority.hasOwnerSession()) {
            status.setText("Owner session is already active on this device.");
            return;
        }
        beginBiometricVerification();
    }

    private void manageFaceProfile() {
        if (!FaceProfileStore.exists(this)) {
            startFaceEnrollment();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("Local owner face profile")
                .setItems(new String[]{"Replace profile", "Delete profile"}, (dialog, which) -> {
                    if (which == 0) startFaceEnrollment();
                    else deleteOwnerFaceProfile();
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void deleteOwnerFaceProfile() {
        if (OwnerAuthority.hasOwnerSession() && !OwnerAuthority.requireFreshAuthentication()) {
            status.setText("Could not request fresh authentication. The local face profile was not deleted.");
            return;
        }
        OwnerAuthority.authenticate(this, (sessionId, error) -> runOnUiThread(() -> {
            if (isFinishing()) return;
            if (error != null || sessionId == null
                    || !OwnerAuthority.authorizeOwnerCapability("owner.profile.modify")) {
                status.setText("Owner verification failed. The local face profile was not deleted.");
                return;
            }
            try {
                FaceProfileStore.delete(getApplicationContext());
                GazeCalibrator.clearPersisted(getApplicationContext());
                gazeCalibrator.clear();
                enrolledFaceTemplate = null;
                faceMatchConsensus.reset();
                faceProfileButton.setText("Enroll face");
                status.setText("Encrypted face profile deleted from this device. Camera recognition is now disabled.");
            } catch (Exception failure) {
                status.setText("Could not delete the local face profile: " + failure.getClass().getSimpleName());
            }
        }));
    }

    private void startFaceEnrollment() {
        if (pendingOwnerEnrollment && !OwnerAuthority.isEnrolled(this)) {
            faceProfileButton.setEnabled(false);
            faceEnrollmentRequested = true;
            enrollmentSamples.clear();
            status.setText("Staging five local face samples. The encrypted profile cannot be matched until device verification activates setup.");
            if (!scanRequested) requestScan();
            return;
        }
        if (!OwnerAuthority.isEnrolled(this)) {
            status.setText("Enroll this device as the owner first. A face profile cannot create the owner identity.");
            return;
        }
        faceProfileButton.setEnabled(false);
        status.setText("Confirm owner access with this device before changing the local face profile.");
        if (OwnerAuthority.hasOwnerSession() && !OwnerAuthority.requireFreshAuthentication()) {
            faceProfileButton.setEnabled(true);
            status.setText("Could not request fresh authentication. No face profile was changed.");
            return;
        }
        OwnerAuthority.authenticate(this, (sessionId, error) -> runOnUiThread(() -> {
            if (isFinishing()) return;
            if (error != null || sessionId == null) {
                faceProfileButton.setEnabled(true);
                status.setText("Owner verification failed. The saved face profile was not changed.");
                return;
            }
            if (!OwnerAuthority.authorizeOwnerCapability("owner.profile.modify")) {
                faceProfileButton.setEnabled(true);
                status.setText("Owner policy denied face-profile changes. No profile was changed.");
                return;
            }
            faceEnrollmentRequested = true;
            enrollmentSamples.clear();
            faceMatchConsensus.reset();
            status.setText("Owner verified. Hold still in good light while five local face samples are collected. Images are discarded.");
            if (!scanRequested) requestScan();
        }));
    }

    private void openCamera() {
        if (!scanRequested || verificationPending || camera != null || cameraHandler == null) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) return;
        try {
            CameraManager manager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            CameraCharacteristics characteristics = null;
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics candidate = manager.getCameraCharacteristics(id);
                Integer facing = candidate.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT) {
                    cameraId = id;
                    characteristics = candidate;
                    break;
                }
            }
            if (cameraId == null || characteristics == null) {
                failCamera("This device has no front camera.");
                return;
            }
            Integer sensor = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
            int displayDegrees = displayDegrees();
            imageRotation = ((sensor == null ? 0 : sensor) + displayDegrees) % 360;
            android.hardware.camera2.params.StreamConfigurationMap map =
                    characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null || map.getOutputSizes(SurfaceTexture.class) == null
                    || map.getOutputSizes(android.graphics.ImageFormat.YUV_420_888) == null) {
                failCamera("The front camera does not expose a preview stream.");
                return;
            }
            android.util.Size previewSize = chooseSize(map.getOutputSizes(SurfaceTexture.class));
            android.util.Size frameSize = chooseSize(map.getOutputSizes(android.graphics.ImageFormat.YUV_420_888));
            SurfaceTexture texture = preview.getSurfaceTexture();
            if (texture == null) return;
            texture.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            Surface previewSurface = new Surface(texture);
            imageReader = ImageReader.newInstance(frameSize.getWidth(), frameSize.getHeight(),
                    android.graphics.ImageFormat.YUV_420_888, 2);
            imageReader.setOnImageAvailableListener(this::processLatestImage, cameraHandler);
            Surface imageSurface = imageReader.getSurface();
            manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice opened) {
                    camera = opened;
                    configurePreview(opened, previewSurface, imageSurface);
                }
                @Override public void onDisconnected(CameraDevice disconnected) {
                    disconnected.close();
                    if (camera == disconnected) camera = null;
                    failCamera("Camera disconnected. Face processing has stopped.");
                }
                @Override public void onError(CameraDevice failed, int error) {
                    failed.close();
                    if (camera == failed) camera = null;
                    failCamera("The camera reported an error. Face processing has stopped.");
                }
            }, cameraHandler);
        } catch (SecurityException denied) {
            failCamera("Camera access was revoked. Enable it to use face presence.");
        } catch (Exception error) {
            failCamera("Could not start the front camera: " + error.getClass().getSimpleName());
        }
    }

    private int displayDegrees() {
        switch (getWindowManager().getDefaultDisplay().getRotation()) {
            case Surface.ROTATION_90: return 90;
            case Surface.ROTATION_180: return 180;
            case Surface.ROTATION_270: return 270;
            default: return 0;
        }
    }

    private android.util.Size chooseSize(android.util.Size[] sizes) {
        return Arrays.stream(sizes)
                .min((left, right) -> Long.compare(sizeCost(left), sizeCost(right)))
                .orElse(new android.util.Size(640, 480));
    }

    private long sizeCost(android.util.Size size) {
        long area = Math.abs((long) size.getWidth() * size.getHeight() - (long) IMAGE_WIDTH * IMAGE_HEIGHT);
        double targetRatio = (double) IMAGE_WIDTH / IMAGE_HEIGHT;
        long ratioCost = Math.round(Math.abs((double) size.getWidth() / size.getHeight() - targetRatio) * 1_000_000);
        return area + ratioCost;
    }

    private void configurePreview(CameraDevice opened, Surface previewSurface, Surface imageSurface) {
        try {
            CaptureRequest.Builder request = opened.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
            request.addTarget(previewSurface);
            request.addTarget(imageSurface);
            opened.createCaptureSession(Arrays.asList(previewSurface, imageSurface),
                    new CameraCaptureSession.StateCallback() {
                        @Override public void onConfigured(CameraCaptureSession session) {
                            if (!scanRequested || camera != opened) { session.close(); return; }
                            captureSession = session;
                            try {
                                request.set(CaptureRequest.CONTROL_AF_MODE,
                                        CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                                session.setRepeatingRequest(request.build(), null, cameraHandler);
                            } catch (Exception error) {
                                failCamera("Could not start camera frames.");
                            }
                        }
                        @Override public void onConfigureFailed(CameraCaptureSession session) {
                            session.close();
                            failCamera("The camera could not configure a preview.");
                        }
                    }, cameraHandler);
        } catch (Exception error) {
            failCamera("Could not configure the camera preview.");
        }
    }

    private void processLatestImage(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null || !scanRequested || verificationPending || !processing.compareAndSet(false, true)) {
                if (image != null) image.close();
                return;
            }
            long now = android.os.SystemClock.elapsedRealtime();
            if (now - lastFrameAt < MIN_FRAME_INTERVAL_MS) {
                image.close();
                processing.set(false);
                return;
            }
            lastFrameAt = now;
            Image processingImage = image;
            long frameGeneration = scanGeneration;
            if (gazeEnabled && gazeLandmarker != null) {
                try {
                    float[] features = gazeLandmarker.estimate(processingImage, imageRotation, now);
                    latestGazeFeatures = features;
                    collectCalibrationFeatures(features);
                    GazeCalibrator.Point point = gazeCalibrator.project(features);
                    runOnUiThread(() -> {
                        if (gazeOverlay != null) gazeOverlay.setGazePoint(point);
                    });
                } catch (RuntimeException gazeError) {
                    latestGazeFeatures = null;
                    runOnUiThread(() -> status.setText("Iris tracking paused after an inference error. Face presence remains separate."));
                }
            }
            Bitmap frame = imageToBitmap(processingImage, imageRotation);
            InputImage input = InputImage.fromMediaImage(processingImage, imageRotation);
            Task<List<Face>> task = detector.process(input);
            task.addOnSuccessListener(faces -> {
                Handler handler = cameraHandler;
                if (handler != null) handler.post(() -> {
                    if (frameGeneration == scanGeneration && scanRequested) onFaces(faces, frame);
                    else frame.recycle();
                });
                else frame.recycle();
            });
            task.addOnFailureListener(error -> {
                frame.recycle();
                if (frameGeneration != scanGeneration || !scanRequested) return;
                runOnUiThread(() -> {
                    stableFrames = 0;
                    faceMatchConsensus.reset();
                    status.setText("Local face detection failed. Camera remains visible and can be stopped.");
                });
            });
            task.addOnCompleteListener(done -> {
                processingImage.close();
                processing.set(false);
            });
            image = null; // closed by the detector task completion listener
        } catch (Exception error) {
            if (image != null) image.close();
            processing.set(false);
            runOnUiThread(() -> failCamera("Could not process a camera frame."));
        }
    }

    /** Converts one bounded Camera2 YUV frame to a short-lived bitmap for local SFace inference. */
    private static Bitmap imageToBitmap(Image image, int rotationDegrees) throws IOException {
        int width = image.getWidth();
        int height = image.getHeight();
        Image.Plane[] planes = image.getPlanes();
        if (planes.length != 3 || width <= 0 || height <= 0 || (width & 1) != 0 || (height & 1) != 0)
            throw new IOException("Unsupported Camera2 YUV frame.");
        int[] pixels = new int[width * height];
        java.nio.ByteBuffer yBuffer = planes[0].getBuffer().duplicate();
        java.nio.ByteBuffer uBuffer = planes[1].getBuffer().duplicate();
        java.nio.ByteBuffer vBuffer = planes[2].getBuffer().duplicate();
        int yRowStride = planes[0].getRowStride();
        int yPixelStride = planes[0].getPixelStride();
        int uRowStride = planes[1].getRowStride();
        int uPixelStride = planes[1].getPixelStride();
        int vRowStride = planes[2].getRowStride();
        int vPixelStride = planes[2].getPixelStride();
        for (int row = 0; row < height; row++) {
            int yStart = row * yRowStride;
            int uvRow = row >> 1;
            for (int col = 0; col < width; col++) {
                int y = (yBuffer.get(yStart + col * yPixelStride) & 0xff) - 16;
                int uvCol = col >> 1;
                int u = (uBuffer.get(uvRow * uRowStride + uvCol * uPixelStride) & 0xff) - 128;
                int v = (vBuffer.get(uvRow * vRowStride + uvCol * vPixelStride) & 0xff) - 128;
                int luminance = Math.max(0, y) * 1192;
                int red = clampColor(luminance + 1634 * v);
                int green = clampColor(luminance - 833 * v - 400 * u);
                int blue = clampColor(luminance + 2066 * u);
                pixels[row * width + col] = 0xff000000 | (red << 16) | (green << 8) | blue;
            }
        }
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        bitmap.setPixels(pixels, 0, width, 0, 0, width, height);
        int rotation = ((rotationDegrees % 360) + 360) % 360;
        if (rotation == 0) return bitmap;
        Matrix transform = new Matrix();
        transform.setRotate(rotation);
        Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), transform, true);
        bitmap.recycle();
        return rotated;
    }

    private static int clampColor(int value) {
        int channel = Math.max(0, Math.min(262143, value));
        return channel >> 10;
    }

    private void onFaces(List<Face> faces, Bitmap frame) {
        if (faces == null || faces.size() != 1 || !scanRequested || verificationPending) {
            stableFrames = 0;
            attentionDwell.reset();
            faceMatchConsensus.reset();
            if (faceEnrollmentRequested) enrollmentSamples.clear();
            lastTrackingId = null;
            lastFaceBounds = null;
            runOnUiThread(() -> status.setText(faces != null && faces.size() > 1
                    ? "Unknown: more than one face is visible. Enrollment and owner matching pause until only one face is present."
                    : "No face is visible. Camera is active; tap Stop to pause it."));
            frame.recycle();
            return;
        }
        Face face = faces.get(0);
        android.graphics.Rect bounds = face.getBoundingBox();
        FaceQualityGate.Result quality = FaceQualityGate.evaluate(face, bounds);
        if (quality != FaceQualityGate.Result.USABLE) {
            stableFrames = 0;
            attentionDwell.reset();
            faceMatchConsensus.reset();
            if (faceEnrollmentRequested) enrollmentSamples.clear();
            lastTrackingId = face.getTrackingId();
            lastFaceBounds = new android.graphics.Rect(bounds);
            String reason = quality == FaceQualityGate.Result.TOO_SMALL
                    ? "Face detail is too small for a useful match. Move closer to the camera."
                    : quality == FaceQualityGate.Result.POSE_UNSUITABLE
                    ? "Face angle is outside the matching range. Face the camera briefly."
                    : "Face landmarks are not clear enough for a useful match. Improve lighting and face the camera.";
            runOnUiThread(() -> status.setText(reason));
            frame.recycle();
            return;
        }
        Integer track = face.getTrackingId();
        boolean sameTrack = lastTrackingId != null && track != null && lastTrackingId.equals(track);
        boolean spatiallyStable = lastFaceBounds != null
                && Math.abs(bounds.centerX() - lastFaceBounds.centerX()) < Math.max(40, lastFaceBounds.width() / 3)
                && Math.abs(bounds.centerY() - lastFaceBounds.centerY()) < Math.max(40, lastFaceBounds.height() / 3);
        stableFrames = (sameTrack || spatiallyStable) ? stableFrames + 1 : 1;
        lastTrackingId = track;
        lastFaceBounds = new android.graphics.Rect(bounds);
        long now = android.os.SystemClock.elapsedRealtime();
        if (stableFrames < 3 || now - lastMatchAt < MIN_MATCH_INTERVAL_MS) {
            if (stableFrames < 3) runOnUiThread(() -> status.setText("Checking face quality and track stability locally…"));
            frame.recycle();
            return;
        }
        lastMatchAt = now;
        LocalFaceMatcher matcher = faceMatcher;
        if (matcher == null) {
            runOnUiThread(() -> status.setText("Local face model is still loading. Device verification is available below."));
            frame.recycle();
            return;
        }
        float[] embedding = matcher.embedding(frame, face);
        frame.recycle();
        if (embedding == null) {
            faceMatchConsensus.reset();
            if (faceEnrollmentRequested) enrollmentSamples.clear();
            runOnUiThread(() -> status.setText("Insufficient face detail or landmarks. Improve lighting and face the camera; no identity decision was made."));
            return;
        }
        if (faceEnrollmentRequested) {
            collectOwnerFaceEnrollment(embedding);
            return;
        }
        float[] template = enrolledFaceTemplate;
        if (template == null) {
            faceMatchConsensus.reset();
            runOnUiThread(() -> status.setText("Face detected, but no owner face profile is enrolled. Face detection alone cannot identify you."));
            return;
        }
        double score = matcher.similarity(template, embedding);
        boolean candidate = faceMatchConsensus.observe(score, now);
        if (!Double.isFinite(score) || score < LocalFaceMatcher.SAME_FACE_THRESHOLD) {
            attentionDwell.reset();
            runOnUiThread(() -> status.setText("Unknown face. No owner data or device capability was opened."));
            return;
        }
        if (!OwnerRecognitionPolicy.shouldRequestPlatformVerification(OwnerAuthority.hasOwnerSession())) {
            runOnUiThread(() -> status.setText("Enrolled owner recognized. The active owner session is still valid; no second device prompt was needed."));
            return;
        }
        Float leftEyeOpen = face.getLeftEyeOpenProbability();
        Float rightEyeOpen = face.getRightEyeOpenProbability();
        boolean livenessPassed = stableFrames >= 3
                && quality == FaceQualityGate.Result.USABLE
                && leftEyeOpen != null && leftEyeOpen >= 0.35f
                && rightEyeOpen != null && rightEyeOpen >= 0.35f;
        float faceConfidence = LocalFaceMatcher.normalizedConfidence(score);
        if (candidate && !OwnerAuthority.reportFaceMatch(faceConfidence, livenessPassed)) {
            // Do not let later frames reuse local evidence if the shared authority core rejected it.
            faceMatchConsensus.reset();
            attentionDwell.reset();
            runOnUiThread(() -> status.setText(livenessPassed
                    ? "Face matched locally, but the authority engine rejected the candidate state."
                    : "Eyes must be clearly visible and open to prepare verification."));
            return;
        }
        if (!candidate && !faceMatchConsensus.isConfirmed(now)) {
            runOnUiThread(() -> status.setText("Possible owner match; confirming with another local frame. This is not authorization."));
            return;
        }
        if (gazeEnabled && gazeCalibrator.isCalibrated()) {
            boolean intent = observeGazeDwell(true, now);
            if (intent) {
                OwnerAuthority.reportPresence(true);
                runOnUiThread(this::beginBiometricVerification);
            } else {
                runOnUiThread(() -> status.setText("Likely owner detected. Hold gaze on the verification target, or use Verify with device."));
            }
        } else {
            runOnUiThread(() -> status.setText("Likely owner detected. Confirm with Android biometrics to activate owner permissions."));
            runOnUiThread(this::beginBiometricVerification);
        }
    }

    private void collectOwnerFaceEnrollment(float[] embedding) {
        if (!pendingOwnerEnrollment && !OwnerAuthority.hasOwnerSession()) {
            faceEnrollmentRequested = false;
            enrollmentSamples.clear();
            runOnUiThread(() -> {
                faceProfileButton.setEnabled(true);
                status.setText("Owner authorization expired during enrollment. No face profile was saved.");
            });
            return;
        }
        enrollmentSamples.add(embedding);
        runOnUiThread(() -> status.setText("Collecting local face samples: " + enrollmentSamples.size() + " of 5. Images are discarded."));
        if (enrollmentSamples.size() < 5) return;
        float[] average = LocalFaceMatcher.averageNormalized(enrollmentSamples);
        try {
            if (average == null) throw new IllegalStateException("Face samples were inconsistent.");
            if (pendingOwnerEnrollment) FaceProfileStore.savePending(getApplicationContext(), average);
            else FaceProfileStore.save(getApplicationContext(), average);
            if (!pendingOwnerEnrollment) enrolledFaceTemplate = average;
            faceEnrollmentRequested = false;
            enrollmentSamples.clear();
            runOnUiThread(() -> {
                faceProfileButton.setText(pendingOwnerEnrollment ? "Replace staged face" : "Manage face");
                faceProfileButton.setEnabled(true);
                stopScan();
                status.setText(pendingOwnerEnrollment
                        ? "Encrypted face profile staged on this device. It remains inactive until you verify the initial owner claim."
                        : "Encrypted owner face profile saved on this device. Matching can prepare verification; it cannot unlock permissions by itself.");
            });
        } catch (Exception error) {
            faceEnrollmentRequested = false;
            enrollmentSamples.clear();
            runOnUiThread(() -> {
                faceProfileButton.setEnabled(true);
                status.setText("Face enrollment failed; the previous profile remains unchanged: " + error.getClass().getSimpleName());
            });
        }
    }

    private boolean observeGazeDwell(boolean stableFace, long now) {
        GazeCalibrator.Point point = gazeCalibrator.project(latestGazeFeatures);
        boolean onTarget = stableFace && point != null && gazeOverlay.isOnOwnerActionTarget(point, 0.14f);
        long last = lastGazeDwellAt;
        if (!onTarget || (last != 0 && (now <= last || now - last > 600))) {
            gazeDwellStartedAt = onTarget ? now : 0;
            lastGazeDwellAt = onTarget ? now : 0;
            return false;
        }
        if (gazeDwellStartedAt == 0) gazeDwellStartedAt = now;
        lastGazeDwellAt = now;
        return now - gazeDwellStartedAt >= 1_200;
    }

    private synchronized void collectCalibrationFeatures(float[] features) {
        if (calibrationIndex < 0 || features == null || features.length != 4) return;
        for (float value : features) if (!Float.isFinite(value)) return;
        for (int i = 0; i < features.length; i++) calibrationFeatureSum[i] += features[i];
        calibrationFeatureCount = Math.min(calibrationFeatureCount + 1, 30);
    }

    private synchronized float[] calibrationFeatureAverage() {
        if (calibrationFeatureCount < 5) return null;
        float[] average = new float[4];
        for (int i = 0; i < average.length; i++) average[i] = calibrationFeatureSum[i] / calibrationFeatureCount;
        return average;
    }

    private synchronized void resetCalibrationFeatureWindow() {
        Arrays.fill(calibrationFeatureSum, 0f);
        calibrationFeatureCount = 0;
    }

    private void beginBiometricVerification() {
        if (verificationPending || !OwnerAuthority.isEnrolled(this)) return;
        if (OwnerAuthority.hasOwnerSession()) {
            setResult(Activity.RESULT_OK);
            finish();
            return;
        }
        verificationPending = true;
        scanRequested = false;
        closeCamera();
        runOnUiThread(() -> status.setText("Stable face presence detected. Verify with Android to activate owner access."));
        OwnerAuthority.authenticate(this, (sessionId, error) -> runOnUiThread(() -> {
            if (error == null) {
                Toast.makeText(this, "Device verification succeeded.", Toast.LENGTH_SHORT).show();
                setResult(Activity.RESULT_OK);
                finish();
            } else {
                verificationPending = false;
                stableFrames = 0;
                status.setText("Not authenticated. No owner access was granted. You can try again.");
                scanButton.setText("Start scan");
                scanButton.setEnabled(true);
            }
        }));
    }

    private void stopScan() {
        scanGeneration++;
        scanRequested = false;
        stableFrames = 0;
        faceEnrollmentRequested = false;
        enrollmentSamples.clear();
        faceMatchConsensus.reset();
        attentionDwell.reset();
        gazeDwellStartedAt = 0;
        lastGazeDwellAt = 0;
        resetCalibrationFeatureWindow();
        lastTrackingId = null;
        lastFaceBounds = null;
        closeCamera();
        status.setText("Camera paused. No more frames are being processed.");
        scanButton.setText("Start scan");
        scanButton.setEnabled(true);
    }

    private void failCamera(String message) {
        scanGeneration++;
        scanRequested = false;
        faceEnrollmentRequested = false;
        enrollmentSamples.clear();
        faceMatchConsensus.reset();
        gazeDwellStartedAt = 0;
        lastGazeDwellAt = 0;
        resetCalibrationFeatureWindow();
        closeCamera();
        runOnUiThread(() -> {
            status.setText(message);
            scanButton.setText("Start scan");
            scanButton.setEnabled(true);
        });
    }

    private void closeCamera() {
        CameraCaptureSession session = captureSession;
        captureSession = null;
        if (session != null) session.close();
        CameraDevice active = camera;
        camera = null;
        if (active != null) active.close();
        ImageReader reader = imageReader;
        imageReader = null;
        if (reader != null) {
            reader.setOnImageAvailableListener(null, null);
            reader.close();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_CAMERA) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            requestScan();
        } else {
            scanRequested = false;
            status.setText("Camera permission denied. No camera frames were captured.");
            scanButton.setText("Start scan");
            scanButton.setEnabled(true);
        }
    }

    @Override
    protected void onPause() {
        scanGeneration++;
        scanRequested = false;
        faceEnrollmentRequested = false;
        enrollmentSamples.clear();
        faceMatchConsensus.reset();
        closeCamera();
        if (cameraThread != null) {
            if (cameraHandler != null) {
                cameraHandler.post(() -> {
                    GazeLandmarker old = gazeLandmarker;
                    gazeLandmarker = null;
                    if (old != null) old.close();
                });
            }
            cameraThread.quitSafely();
            try { cameraThread.join(500); } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            cameraThread = null;
            cameraHandler = null;
        }
        gazeEnabled = false;
        latestGazeFeatures = null;
        calibrationIndex = -1;
        gazeDwellStartedAt = 0;
        lastGazeDwellAt = 0;
        attentionDwell.reset();
        if (scanButton != null) {
            scanButton.setText("Start scan");
            scanButton.setEnabled(true);
        }
        if (gazeButton != null) gazeButton.setText("Enable gaze");
        if (calibrateButton != null) calibrateButton.setEnabled(false);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        scanRequested = false;
        closeCamera();
        if (detector != null) detector.close();
        super.onDestroy();
    }

    private final class GazeOverlayView extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private float targetX = -1f;
        private float targetY = -1f;
        private float actionX = -1f;
        private float actionY = -1f;
        private GazeCalibrator.Point cursor;

        GazeOverlayView(Context context) { super(context); setWillNotDraw(false); }

        void setCalibrationTarget(float x, float y) { targetX = x; targetY = y; invalidate(); }
        void setOwnerActionTarget(float x, float y) { actionX = x; actionY = y; invalidate(); }
        void setGazePoint(GazeCalibrator.Point point) { cursor = point; invalidate(); }
        void clear() {
            targetX = targetY = actionX = actionY = -1f;
            cursor = null;
            invalidate();
        }
        boolean isOnOwnerActionTarget(GazeCalibrator.Point point, float tolerance) {
            return point != null && actionX >= 0 && actionY >= 0
                    && Math.abs(point.x - actionX) <= tolerance
                    && Math.abs(point.y - actionY) <= tolerance;
        }

        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            if (actionX >= 0 && calibrationIndex < 0) {
                float x = actionX * getWidth(), y = actionY * getHeight();
                paint.setColor(Color.argb(210, 255, 204, 90));
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(dp(2));
                canvas.drawCircle(x, y, dp(24), paint);
                paint.setStyle(Paint.Style.FILL);
            }
            if (targetX >= 0 && targetY >= 0) {
                float x = targetX * getWidth(), y = targetY * getHeight();
                paint.setColor(Color.YELLOW);
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(dp(3));
                canvas.drawCircle(x, y, dp(18), paint);
                canvas.drawLine(x - dp(28), y, x + dp(28), y, paint);
                canvas.drawLine(x, y - dp(28), x, y + dp(28), paint);
                paint.setStyle(Paint.Style.FILL);
            }
            if (cursor != null) {
                paint.setColor(Color.CYAN);
                paint.setStyle(Paint.Style.FILL);
                canvas.drawCircle(cursor.x * getWidth(), cursor.y * getHeight(), dp(9), paint);
                paint.setColor(Color.BLACK);
                paint.setTextSize(dp(12));
                canvas.drawText("gaze", cursor.x * getWidth() + dp(10), cursor.y * getHeight() - dp(10), paint);
            }
        }
    }
}
