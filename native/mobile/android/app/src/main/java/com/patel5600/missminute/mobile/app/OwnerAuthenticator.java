package com.patel5600.missminute.mobile.app;

import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.fragment.app.FragmentActivity;

import com.patel5600.missminute.mobile.core.security.OwnerAuthProof;

import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.spec.ECGenParameterSpec;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * One-operation owner authentication. The biometric result is not treated as an authorization
 * flag: the requested operation is bound into a fresh challenge and signed by an auth-per-use
 * Android Keystore key through BiometricPrompt.CryptoObject.
 */
public final class OwnerAuthenticator {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "com.patel5600.missminute.owner-auth.ecdsa.v1";
    private static final long CHALLENGE_TTL_MS = 90_000L;
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;
    private static final AtomicBoolean IN_FLIGHT = new AtomicBoolean(false);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    // Keystore IPC and ECDSA work must never run on Android's UI thread.
    private static final ExecutorService CRYPTO = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "mm-owner-keystore");
        thread.setDaemon(true);
        return thread;
    });

    public interface Callback {
        void onAuthenticated(String proofId);
        void onFailure(String reason);
    }

    private OwnerAuthenticator() {}

    public static void authenticate(final FragmentActivity activity, String action, String target,
                                    final Callback callback) {
        if (activity == null || callback == null) {
            throw new IllegalArgumentException("activity and callback are required");
        }
        if (activity.isFinishing() || activity.isDestroyed()) {
            callback.onFailure("The authorization screen is no longer active.");
            return;
        }
        if (!IN_FLIGHT.compareAndSet(false, true)) {
            callback.onFailure("Another owner authorization is already in progress.");
            return;
        }

        final AtomicBoolean completed = new AtomicBoolean(false);
        final Handler main = MAIN;
        final Runnable release = () -> IN_FLIGHT.set(false);
        final java.util.function.Consumer<String> fail = reason -> main.post(() -> {
            if (completed.compareAndSet(false, true)) {
                release.run();
                callback.onFailure(reason);
            }
        });

        try {
            CRYPTO.execute(() -> {
                try {
                    int availability = BiometricManager.from(activity).canAuthenticate(AUTHENTICATORS);
                    if (availability != BiometricManager.BIOMETRIC_SUCCESS) {
                        fail.accept(availabilityMessage(availability));
                        return;
                    }

                    // All potentially blocking Keystore/provider calls are performed off-main.
                    final OwnerAuthProof.Challenge challenge = OwnerAuthProof.create(
                            action, target, SystemClock.elapsedRealtime(), new SecureRandom());
                    final KeyPair keyPair = loadOrCreateKeyPair();
                    final Signature signature = Signature.getInstance("SHA256withECDSA");
                    signature.initSign(keyPair.getPrivate());

                    main.post(() -> {
                        if (completed.get()) return;
                        if (activity.isFinishing() || activity.isDestroyed()) {
                            fail.accept("The authorization screen was closed before authentication.");
                            return;
                        }

                        Executor mainExecutor = command -> main.post(command);
                        BiometricPrompt prompt = new BiometricPrompt(activity, mainExecutor,
                                new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationError(int errorCode, CharSequence errString) {
                                fail.accept(errorCode == BiometricPrompt.ERROR_USER_CANCELED
                                        || errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                                        ? "Owner authentication was canceled."
                                        : "Biometric authentication failed: " + safePromptError(errorCode));
                            }

                            @Override
                            public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                                if (completed.get()) return;
                                if (SystemClock.elapsedRealtime() - challenge.issuedAtElapsedMs > CHALLENGE_TTL_MS) {
                                    fail.accept("The authorization challenge expired. Try again.");
                                    return;
                                }
                                int authenticationType = result.getAuthenticationType();
                                // AndroidX may report UNKNOWN on API 26-29 even though this prompt
                                // accepts BIOMETRIC_STRONG only. The auth-per-use Signature operation
                                // is the proof on those releases. On API 30+ reject unknown methods.
                                if (authenticationType == BiometricPrompt.AUTHENTICATION_RESULT_TYPE_DEVICE_CREDENTIAL
                                        || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                                        && authenticationType != BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC)) {
                                    fail.accept("A strong biometric is required for this operation.");
                                    return;
                                }
                                BiometricPrompt.CryptoObject crypto = result.getCryptoObject();
                                final Signature signer = crypto == null ? null : crypto.getSignature();
                                if (signer == null) {
                                    fail.accept("The authenticated cryptographic operation was not returned.");
                                    return;
                                }
                                try {
                                    CRYPTO.execute(() -> {
                                        try {
                                            signer.update(challenge.encoded());
                                            byte[] signed = signer.sign();
                                            boolean verified = OwnerAuthProof.verify(
                                                    keyPair.getPublic(), challenge.encoded(), signed);
                                            java.util.Arrays.fill(signed, (byte) 0);
                                            if (!verified) {
                                                fail.accept("The owner authentication proof could not be verified.");
                                                return;
                                            }
                                            main.post(() -> {
                                                if (completed.compareAndSet(false, true)) {
                                                    release.run();
                                                    callback.onAuthenticated(challenge.auditId());
                                                }
                                            });
                                        } catch (Exception error) {
                                            fail.accept(safeKeyError(error));
                                        }
                                    });
                                } catch (RuntimeException rejected) {
                                    fail.accept("The owner authentication operation could not be scheduled.");
                                }
                            }

                            @Override
                            public void onAuthenticationFailed() {
                                // A failed biometric attempt is not terminal. Android keeps the prompt open.
                            }
                        });

                        BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
                                .setTitle("Authorize Miss Minutes")
                                .setSubtitle("Verify this permission change")
                                .setDescription("A strong biometric is required. This does not grant Android permissions.")
                                .setAllowedAuthenticators(AUTHENTICATORS)
                                .setNegativeButtonText("Cancel")
                                .build();
                        try {
                            prompt.authenticate(promptInfo, new BiometricPrompt.CryptoObject(signature));
                        } catch (RuntimeException error) {
                            fail.accept("Could not start biometric authentication.");
                        }
                    });
                } catch (Exception error) {
                    fail.accept(safeKeyError(error));
                }
            });
        } catch (RuntimeException rejected) {
            release.run();
            callback.onFailure("The owner authentication worker is unavailable.");
        }
    }

    private static KeyPair loadOrCreateKeyPair() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            PrivateKey privateKey = (PrivateKey) store.getKey(KEY_ALIAS, null);
            Certificate certificate = store.getCertificate(KEY_ALIAS);
            if (privateKey == null || certificate == null || certificate.getPublicKey() == null) {
                throw new IllegalStateException("The owner authentication key is incomplete.");
            }
            return new KeyPair(certificate.getPublicKey(), privateKey);
        }

        KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE);
        KeyGenParameterSpec.Builder specification = new KeyGenParameterSpec.Builder(
                KEY_ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            specification.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        } else {
            // Negative duration means authentication is required for each use on Android 8-10.
            specification.setUserAuthenticationValidityDurationSeconds(-1);
        }
        generator.initialize(specification.build());
        return generator.generateKeyPair();
    }

    private static String availabilityMessage(int status) {
        switch (status) {
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                return "This device has no biometric hardware.";
            case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                return "Biometric hardware is temporarily unavailable.";
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                return "Enroll a strong biometric in Android Settings before authorizing this change.";
            case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                return "Android requires a security update before strong biometrics can be used.";
            default:
                return "Strong biometric authentication is unavailable on this device.";
        }
    }

    private static String safePromptError(int code) {
        switch (code) {
            case BiometricPrompt.ERROR_NO_BIOMETRICS:
                return "no biometrics are enrolled";
            case BiometricPrompt.ERROR_HW_NOT_PRESENT:
                return "biometric hardware is unavailable";
            case BiometricPrompt.ERROR_HW_UNAVAILABLE:
                return "biometric hardware is temporarily unavailable";
            case BiometricPrompt.ERROR_LOCKOUT:
            case BiometricPrompt.ERROR_LOCKOUT_PERMANENT:
                return "the biometric sensor is locked";
            case BiometricPrompt.ERROR_TIMEOUT:
                return "the authentication prompt timed out";
            case BiometricPrompt.ERROR_UNABLE_TO_PROCESS:
                return "the biometric could not be processed";
            default:
                return "the prompt returned error " + code;
        }
    }

    private static String safeKeyError(Exception error) {
        // Never return provider details, key material, or exception messages to a WebView.
        String name = error.getClass().getSimpleName();
        if ("KeyPermanentlyInvalidatedException".equals(name)) {
            return "The owner authentication key was invalidated by a biometric enrollment change. Re-enrol owner security.";
        }
        if ("UserNotAuthenticatedException".equals(name)) {
            return "The Keystore key is not authenticated. Authenticate again.";
        }
        return "The owner authentication key could not complete its cryptographic operation.";
    }
}
