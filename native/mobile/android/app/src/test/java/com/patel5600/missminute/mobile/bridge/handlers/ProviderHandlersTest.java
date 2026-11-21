package com.patel5600.missminute.mobile.bridge.handlers;

import static org.junit.Assert.fail;
import static org.junit.Assert.assertTrue;

import java.net.URL;
import org.junit.Test;

public final class ProviderHandlersTest {
    @Test
    public void allowsOnlyKnownOpenAiApiPaths() throws Exception {
        ProviderHandlers.validateTarget("openai", new URL("https://api.openai.com/v1/responses"));
        ProviderHandlers.validateTarget("openai", new URL("https://api.openai.com/v1/audio/speech"));
        expectRejected("openai", "https://api.openai.com/v1/files");
    }

    @Test
    public void providerCredentialCannotBeSentToAnotherHost() throws Exception {
        expectRejected("openai", "https://attacker.example/v1/responses");
        expectRejected("openrouter", "https://api.openai.com/api/v1/chat/completions");
    }

    @Test
    public void cloudProviderRequiresHttpsAndDefaultPort() throws Exception {
        expectRejected("openai", "http://api.openai.com/v1/responses");
        expectRejected("openai", "https://api.openai.com:8443/v1/responses");
    }

    @Test
    public void ollamaIsRestrictedToLoopbackAndKnownApiPaths() throws Exception {
        ProviderHandlers.validateTarget("ollama", new URL("http://127.0.0.1:11434/api/tags"));
        expectRejected("ollama", "http://192.168.1.10:11434/api/tags");
        expectRejected("ollama", "http://127.0.0.1:11434/api/delete");
    }

    @Test
    public void streamRequestIdsMustBeBoundedAndSafe() {
        org.junit.Assert.assertEquals("req_1.stream-ok", ProviderHandlers.validateStreamRequestId("req_1.stream-ok"));
        String[] invalid = {"", "bad id", "../escape", new String(new char[65]).replace('\0', 'a')};
        for (String id : invalid) {
            try {
                ProviderHandlers.validateStreamRequestId(id);
                fail("Expected invalid stream id to be rejected: " + id);
            } catch (IllegalArgumentException expected) {
                assertTrue(expected.getMessage() != null && !expected.getMessage().isEmpty());
            }
        }
    }

    private static void expectRejected(String provider, String target) throws Exception {
        try {
            ProviderHandlers.validateTarget(provider, new URL(target));
            fail("Expected provider request to be rejected: " + target);
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage() != null && !expected.getMessage().isEmpty());
        }
    }
}
