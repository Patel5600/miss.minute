package com.patel5600.missminute.mobile.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import org.json.JSONException;
import org.json.JSONObject;

/** Reads the shared golden vectors (tests/android/vectors) that Gradle adds as test resources. */
public final class TestVectors {
    private TestVectors() {
    }

    public static String text(String name) {
        try (InputStream in = TestVectors.class.getResourceAsStream("/" + name)) {
            if (in == null) {
                throw new IllegalStateException("missing test resource " + name);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    public static JSONObject json(String name) {
        try {
            return new JSONObject(text(name));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }
}