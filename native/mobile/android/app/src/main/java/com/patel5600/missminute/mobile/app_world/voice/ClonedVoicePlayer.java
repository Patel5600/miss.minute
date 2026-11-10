package com.patel5600.missminute.mobile.app_world.voice;

import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.util.Log;

import java.io.IOException;
import java.util.Random;

/**
 * High-fidelity cloned voice audio player for Miss Minutes.
 * Plays authentic Kyutai Pocket TTS cloned voice clips and TVA reference audio
 * directly from app assets, guaranteeing 100% authentic character timbre,
 * southern inflection, and cheerful TVA persona without robotic Android system TTS.
 */
public class ClonedVoicePlayer {
    private static final String TAG = "MMVoice";

    private final Context context;
    private final Random random = new Random();
    private MediaPlayer mediaPlayer;
    private boolean isPlaying = false;

    // Authentic cloned voice asset paths
    public static final String CLIP_JUMP = "audio/mm_jump.wav";
    public static final String CLIP_LAND = "audio/mm_land.wav";
    public static final String CLIP_SIT = "audio/mm_sit.wav";
    public static final String CLIP_HANG = "audio/mm_hang.wav";
    public static final String CLIP_CALIBRATE = "audio/mm_calibrate.wav";
    public static final String CLIP_APP_SWITCH = "audio/mm_app_switch.wav";
    public static final String CLIP_CONVERSATIONAL = "audio/mm_cloned_conversational.wav";
    public static final String CLIP_INFORMATIONAL = "audio/mm_cloned_informational.wav";
    public static final String CLIP_NARRATION = "audio/mm_cloned_narration.wav";
    public static final String CLIP_PERSUASIVE = "audio/mm_cloned_persuasive.wav";
    public static final String CLIP_REFERENCE = "audio/mm_cloned_reference.wav";

    private static final String[] TAP_CLIPS = {
        "audio/mm_tap1.wav",
        "audio/mm_tap2.wav",
        "audio/mm_tap3.wav"
    };

    public ClonedVoicePlayer(Context context) {
        this.context = context.getApplicationContext();
    }

    /**
     * Plays a specific cloned voice audio file from assets.
     */
    public synchronized void playAsset(String assetPath) {
        if (assetPath == null || assetPath.isEmpty()) {
            return;
        }

        try {
            stopAndReset();

            AssetFileDescriptor afd = context.getAssets().openFd(assetPath);
            mediaPlayer = new MediaPlayer();
            mediaPlayer.setAudioAttributes(new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
                    .build());

            mediaPlayer.setDataSource(
                    afd.getFileDescriptor(),
                    afd.getStartOffset(),
                    afd.getLength()
            );
            afd.close();

            mediaPlayer.setOnPreparedListener(mp -> {
                isPlaying = true;
                mp.start();
                Log.i(TAG, "Playing authentic cloned voice: " + assetPath);
            });

            mediaPlayer.setOnCompletionListener(mp -> {
                isPlaying = false;
                mp.reset();
                mp.release();
                mediaPlayer = null;
                Log.d(TAG, "Completed playing cloned voice: " + assetPath);
            });

            mediaPlayer.setOnErrorListener((mp, what, extra) -> {
                Log.e(TAG, "MediaPlayer error playing " + assetPath + " (" + what + ", " + extra + ")");
                isPlaying = false;
                mp.reset();
                mp.release();
                mediaPlayer = null;
                return true;
            });

            mediaPlayer.prepareAsync();
        } catch (IOException e) {
            Log.e(TAG, "Failed to load cloned voice asset: " + assetPath, e);
        }
    }

    /**
     * Plays a random authentic 4th-wall tap reaction.
     */
    public void playTapQuote() {
        int index = random.nextInt(TAP_CLIPS.length);
        playAsset(TAP_CLIPS[index]);
    }

    public void playJump() {
        playAsset(CLIP_JUMP);
    }

    public void playLand() {
        playAsset(CLIP_LAND);
    }

    public void playSit() {
        playAsset(CLIP_SIT);
    }

    public void playHang() {
        playAsset(CLIP_HANG);
    }

    public void playCalibrate() {
        playAsset(CLIP_CALIBRATE);
    }

    public void playAppSwitch() {
        playAsset(CLIP_APP_SWITCH);
    }

    public void playConversational() {
        playAsset(CLIP_CONVERSATIONAL);
    }

    public void playInformational() {
        playAsset(CLIP_INFORMATIONAL);
    }

    public void playNarration() {
        playAsset(CLIP_NARRATION);
    }

    public void playPersuasive() {
        playAsset(CLIP_PERSUASIVE);
    }

    public void playReference() {
        playAsset(CLIP_REFERENCE);
    }

    /**
     * Contextual speech router: Maps any requested speech text or intent strictly
     * to the appropriate authentic cloned Miss Minutes voice clip.
     */
    public void speak(String text) {
        if (text == null || text.trim().isEmpty()) {
            return;
        }

        String lower = text.toLowerCase();
        if (lower.contains("glass") || lower.contains("poke") || lower.contains("smudge")
                || lower.contains("tickle") || lower.contains("tap") || lower.contains("pixel")) {
            playTapQuote();
        } else if (lower.contains("jump") || lower.contains("leap")) {
            playJump();
        } else if (lower.contains("land")) {
            playLand();
        } else if (lower.contains("rest") || lower.contains("sit") || lower.contains("comfy")) {
            playSit();
        } else if (lower.contains("hang") || lower.contains("grip")) {
            playHang();
        } else if (lower.contains("calibrat") || lower.contains("anchor")) {
            playCalibrate();
        } else if (lower.contains("switch") || lower.contains("perch") || lower.contains("border")) {
            playAppSwitch();
        } else if (lower.contains("timeline") || lower.contains("war") || lower.contains("time-keeper")
                || lower.contains("sacred") || lower.contains("variant")) {
            if (random.nextBoolean()) {
                playNarration();
            } else {
                playReference();
            }
        } else if (lower.contains("briefing") || lower.contains("schedule") || lower.contains("meeting")) {
            playInformational();
        } else if (lower.contains("plan") || lower.contains("prun") || lower.contains("tidy")) {
            playPersuasive();
        } else {
            // Default conversational greeting
            playConversational();
        }
    }

    public synchronized void stopAndReset() {
        if (mediaPlayer != null) {
            try {
                if (mediaPlayer.isPlaying()) {
                    mediaPlayer.stop();
                }
                mediaPlayer.reset();
                mediaPlayer.release();
            } catch (Exception ignored) {
            }
            mediaPlayer = null;
        }
        isPlaying = false;
    }

    public synchronized void release() {
        stopAndReset();
    }

    public boolean isSpeaking() {
        return isPlaying;
    }
}
