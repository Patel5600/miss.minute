package com.patel5600.missminute.mobile.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import com.k2fsa.sherpa.onnx.OnlineStream;
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor;
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Local speaker embedding and candidate matching. Audio stays in memory and is discarded after
 * inference. This deliberately cannot authenticate or grant a capability.
 */
public final class SpeakerIdentityEngine {
    static final int SAMPLE_RATE = 16_000;
    static final int ENROLLMENT_CLIPS = 3;
    static final int CLIP_MILLIS = 2_500;
    static final float INITIAL_CANDIDATE_THRESHOLD = 0.60f;
    private static final String MODEL = "speaker/wespeaker_en_voxceleb_resnet34.onnx";
    private static final AtomicBoolean BUSY = new AtomicBoolean(false);
    private static volatile SpeakerEmbeddingExtractor extractor;

    interface Progress { void update(String message); }

    private SpeakerIdentityEngine() {}

    static boolean isBusy() { return BUSY.get(); }

    static void enroll(Context context, Progress progress) throws Exception {
        enroll(context, progress, false);
    }

    static void enrollPending(Context context, Progress progress) throws Exception {
        enroll(context, progress, true);
    }

    private static void enroll(Context context, Progress progress, boolean pending) throws Exception {
        if (!BUSY.compareAndSet(false, true)) throw new IllegalStateException("A voice operation is already running.");
        float[][] clips = new float[ENROLLMENT_CLIPS][];
        float[] template = null;
        try {
            SpeakerEmbeddingExtractor model = extractor(context);
            for (int i = 0; i < ENROLLMENT_CLIPS; i++) {
                progress.update("Enrollment sample " + (i + 1) + " of " + ENROLLMENT_CLIPS + ": speak naturally for 2.5 seconds.");
                clips[i] = embedding(model, capture(context));
            }
            template = averageAndNormalize(clips);
            if (pending) SpeakerProfileStore.savePending(context, template);
            else SpeakerProfileStore.save(context, template);
        } finally {
            for (float[] clip : clips) if (clip != null) java.util.Arrays.fill(clip, 0f);
            if (template != null) java.util.Arrays.fill(template, 0f);
            BUSY.set(false);
        }
    }

    /**
     * Maps speaker cosine similarity onto the shared Rust candidate confidence scale where
     * {@link #INITIAL_CANDIDATE_THRESHOLD} aligns with {@code MIN_CANDIDATE_CONFIDENCE = 0.70}.
     */
    static float normalizedConfidence(float cosineSimilarity) {
        if (!Float.isFinite(cosineSimilarity) || cosineSimilarity <= 0f) return 0.0f;
        if (cosineSimilarity < INITIAL_CANDIDATE_THRESHOLD) {
            return (cosineSimilarity / INITIAL_CANDIDATE_THRESHOLD) * 0.69f;
        }
        float span = 1.0f - INITIAL_CANDIDATE_THRESHOLD;
        float bounded = Math.min(cosineSimilarity, 1.0f);
        return Math.min(1.0f, 0.70f + ((bounded - INITIAL_CANDIDATE_THRESHOLD) / span) * 0.30f);
    }

    static boolean match(Context context, Progress progress) throws Exception {
        return matchScore(context, progress) >= INITIAL_CANDIDATE_THRESHOLD;
    }

    static float matchScore(Context context, Progress progress) throws Exception {
        if (!BUSY.compareAndSet(false, true)) throw new IllegalStateException("A voice operation is already running.");
        float[] candidate = null;
        float[] enrolled = null;
        try {
            SpeakerEmbeddingExtractor model = extractor(context);
            enrolled = SpeakerProfileStore.load(context, model.dim());
            if (enrolled == null) throw new IllegalStateException("Enroll an owner voice profile first.");
            progress.update("Speak naturally for 2.5 seconds. Audio is processed locally and discarded.");
            candidate = embedding(model, capture(context));
            return cosine(enrolled, candidate);
        } finally {
            if (candidate != null) java.util.Arrays.fill(candidate, 0f);
            if (enrolled != null) java.util.Arrays.fill(enrolled, 0f);
            BUSY.set(false);
        }
    }

    static void deleteProfile(Context context) throws Exception {
        SpeakerProfileStore.delete(context);
    }

    public static boolean hasProfile(Context context) { return SpeakerProfileStore.exists(context); }

    /**
     * Scores a pre-captured 16 kHz mono PCM buffer against the enrolled owner voice profile without
     * opening a duplicate {@link AudioRecord}. Returns normalized candidate confidence ({@code >= 0.70}
     * on match), or {@code -1f} if no profile is enrolled, another voice operation is active, or the
     * frame lacks speech energy. Audio and intermediate embeddings are zeroed in {@code finally}.
     */
    public static float matchBufferedAudio(Context context, short[] pcm) {
        if (context == null || pcm == null || pcm.length < SAMPLE_RATE / 2 || !hasProfile(context)) {
            return -1f;
        }
        if (!BUSY.compareAndSet(false, true)) return -1f;
        float[] samples = null;
        float[] candidate = null;
        float[] enrolled = null;
        try {
            double square = 0;
            for (short sample : pcm) {
                double value = sample / 32768.0;
                square += value * value;
            }
            if (Math.sqrt(square / pcm.length) < 0.008) return -1f;
            SpeakerEmbeddingExtractor model = extractor(context);
            enrolled = SpeakerProfileStore.load(context, model.dim());
            if (enrolled == null) return -1f;
            samples = new float[pcm.length];
            for (int i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768f;
            candidate = embedding(model, samples);
            return normalizedConfidence(cosine(enrolled, candidate));
        } catch (Exception ignored) {
            return -1f;
        } finally {
            if (samples != null) java.util.Arrays.fill(samples, 0f);
            if (candidate != null) java.util.Arrays.fill(candidate, 0f);
            if (enrolled != null) java.util.Arrays.fill(enrolled, 0f);
            BUSY.set(false);
        }
    }

    static void release() {
        SpeakerEmbeddingExtractor current = extractor;
        extractor = null;
        if (current != null) current.release();
    }

    static float cosine(float[] left, float[] right) {
        if (left == null || right == null || left.length == 0 || left.length != right.length) return -1f;
        double dot = 0, leftNorm = 0, rightNorm = 0;
        for (int i = 0; i < left.length; i++) {
            if (!Float.isFinite(left[i]) || !Float.isFinite(right[i])) return -1f;
            dot += (double) left[i] * right[i];
            leftNorm += (double) left[i] * left[i];
            rightNorm += (double) right[i] * right[i];
        }
        if (leftNorm <= 0 || rightNorm <= 0) return -1f;
        return (float) (dot / Math.sqrt(leftNorm * rightNorm));
    }

    private static SpeakerEmbeddingExtractor extractor(Context context) {
        SpeakerEmbeddingExtractor current = extractor;
        if (current != null) return current;
        synchronized (SpeakerIdentityEngine.class) {
            current = extractor;
            if (current == null) {
                SpeakerEmbeddingExtractorConfig config = new SpeakerEmbeddingExtractorConfig(MODEL, 2, false, "cpu");
                current = new SpeakerEmbeddingExtractor(context.getAssets(), config);
                extractor = current;
            }
        }
        return current;
    }

    private static float[] embedding(SpeakerEmbeddingExtractor model, float[] samples) {
        OnlineStream stream = model.createStream();
        try {
            stream.acceptWaveform(samples, SAMPLE_RATE);
            stream.inputFinished();
            float[] result = model.compute(stream);
            if (result == null || result.length != model.dim()) throw new IllegalStateException("Speaker model returned an invalid embedding.");
            return normalize(result);
        } finally {
            stream.release();
            java.util.Arrays.fill(samples, 0f);
        }
    }

    private static float[] capture(Context context) throws Exception {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            throw new SecurityException("Microphone permission is not granted.");
        int minBytes = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBytes <= 0) throw new IllegalStateException("The microphone does not support 16 kHz mono capture.");
        int frames = SAMPLE_RATE * CLIP_MILLIS / 1000;
        short[] pcm = new short[frames];
        AudioRecord recorder = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBytes, frames * 2));
        if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
            recorder.release();
            throw new IllegalStateException("The microphone could not be opened.");
        }
        int offset = 0;
        try {
            recorder.startRecording();
            while (offset < pcm.length) {
                int read = recorder.read(pcm, offset, pcm.length - offset, AudioRecord.READ_BLOCKING);
                if (read < 0) throw new IllegalStateException("Microphone capture failed with code " + read + ".");
                if (read == 0) continue;
                offset += read;
            }
        } finally {
            try { recorder.stop(); } catch (IllegalStateException ignored) { }
            recorder.release();
        }
        if (offset < SAMPLE_RATE) throw new IllegalStateException("Too little audio was captured.");
        double square = 0;
        int clipped = 0;
        for (short sample : pcm) {
            double value = sample / 32768.0;
            square += value * value;
            if (Math.abs((int) sample) > 32_000) clipped++;
        }
        double rms = Math.sqrt(square / pcm.length);
        if (rms < 0.008) {
            java.util.Arrays.fill(pcm, (short) 0);
            throw new IllegalArgumentException("The recording was too quiet. Move closer to the microphone and retry.");
        }
        if (clipped > pcm.length / 20) {
            java.util.Arrays.fill(pcm, (short) 0);
            throw new IllegalArgumentException("The recording clipped. Reduce microphone volume and retry.");
        }
        float[] samples = new float[pcm.length];
        for (int i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768f;
        java.util.Arrays.fill(pcm, (short) 0);
        return samples;
    }

    private static float[] averageAndNormalize(float[][] vectors) {
        if (vectors == null || vectors.length != ENROLLMENT_CLIPS || vectors[0] == null)
            throw new IllegalArgumentException("All voice enrollment samples are required.");
        float[] average = new float[vectors[0].length];
        for (float[] vector : vectors) {
            if (vector == null || vector.length != average.length) throw new IllegalArgumentException("Enrollment samples do not match.");
            for (int i = 0; i < average.length; i++) average[i] += vector[i] / vectors.length;
        }
        return normalize(average);
    }

    private static float[] normalize(float[] vector) {
        double norm = 0;
        for (float value : vector) {
            if (!Float.isFinite(value)) throw new IllegalArgumentException("Speaker model returned a non-finite value.");
            norm += (double) value * value;
        }
        if (norm < 1e-12) throw new IllegalArgumentException("Speaker model returned an empty embedding.");
        double scale = 1.0 / Math.sqrt(norm);
        for (int i = 0; i < vector.length; i++) vector[i] *= (float) scale;
        return vector;
    }
}
