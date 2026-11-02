package com.patel5600.missminute.mobile.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.patel5600.missminute.mobile.core.protocol.Message;
import com.patel5600.missminute.mobile.core.protocol.ProtocolException;
import com.patel5600.missminute.mobile.core.protocol.Role;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Test;

public class BridgeRouterTest {
    private static final String CANARY = "CANARY-exception-text-8841";

    private final List<String> sent = new ArrayList<>();
    private final BridgeRouter.Sink sink = new BridgeRouter.Sink() {
        @Override
        public void send(String json) {
            sent.add(json);
        }
    };

    private static String request(String id, String type, String payload) {
        return "{\"v\":1,\"id\":\"" + id + "\",\"type\":\"" + type + "\",\"payload\":" + payload + "}";
    }

    private JSONObject only() throws Exception {
        assertEquals("exactly one reply was expected", 1, sent.size());
        return new JSONObject(sent.get(0));
    }

    private static Handler echo(final List<String> seen) {
        return new Handler() {
            @Override
            public void handle(Message message, Reply reply) throws Exception {
                seen.add(message.type);
                reply.ok(new JSONObject().put("got", message.type));
            }
        };
    }

    @Test
    public void aKnownTypeReachesItsHandlerAndTheReplyCarriesTheRequestId() throws Exception {
        List<String> seen = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.get", echo(seen));
        router.dispatch(request("abc-1", "settings.get", "{}"), sink);
        JSONObject reply = only();
        assertEquals("abc-1", reply.getString("id"));
        assertEquals("reply", reply.getString("type"));
        assertTrue(reply.getBoolean("ok"));
        assertEquals("settings.get", reply.getJSONObject("payload").getString("got"));
        assertEquals(1, seen.size());
    }

    @Test
    public void anUnknownTypeIsRejectedAndNoHandlerRuns() throws Exception {
        List<String> seen = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.get", echo(seen));
        router.dispatch(request("u1", "nothing.here", "{}"), sink);
        JSONObject reply = only();
        assertFalse(reply.getBoolean("ok"));
        assertEquals("unknown_type", reply.getJSONObject("error").getString("code"));
        assertEquals("u1", reply.getString("id"));
        assertTrue(seen.isEmpty());
    }

    @Test
    public void aTypeReservedForNativeCodeIsForbiddenFromAPage() throws Exception {
        List<String> seen = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(Role.OVERLAY).register("hello", echo(seen));
        router.dispatch(request("f1", "rig.pose", "{\"locomotion\":\"WALK\"}"), sink);
        JSONObject reply = only();
        assertEquals("forbidden", reply.getJSONObject("error").getString("code"));
        assertEquals("f1", reply.getString("id"));
        assertTrue(seen.isEmpty());
    }

    @Test
    public void aPageCannotForgeAnEventOrAReply() {
        List<String> seen = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.get", echo(seen));
        router.dispatch("{\"v\":1,\"type\":\"event\",\"name\":\"kill.happened\",\"payload\":{}}", sink);
        router.dispatch("{\"v\":1,\"id\":\"r\",\"type\":\"reply\",\"ok\":true,\"payload\":{}}", sink);
        assertTrue(seen.isEmpty());
        // The event has no id to answer; the forged reply is answered with forbidden.
        assertEquals(1, sent.size());
        assertTrue(sent.get(0).contains("forbidden"));
    }

    @Test
    public void aTypeForTheOtherPageIsForbidden() throws Exception {
        List<String> seen = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(Role.OVERLAY).register("settings.get", echo(seen));
        router.dispatch(request("o1", "settings.get", "{}"), sink);
        assertEquals("forbidden", only().getJSONObject("error").getString("code"));
        assertTrue(seen.isEmpty());
    }

    @Test
    public void theOverlayCannotReachUserOnlyTypes() throws Exception {
        List<String> seen = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(Role.OVERLAY)
                .register("kill.request", echo(seen))
                .register("permissions.setMode", echo(seen));
        router.dispatch(request("k1", "kill.request", "{}"), sink);
        router.dispatch(request("k2", "permissions.setMode", "{\"mode\":\"AUTHORIZED\"}"), sink);
        assertEquals(2, sent.size());
        for (String json : sent) {
            assertEquals("forbidden", new JSONObject(json).getJSONObject("error").getString("code"));
        }
        assertTrue(seen.isEmpty());
    }

    @Test
    public void anOversizeMessageIsRejectedWithItsIdAndNeverReachesAHandler() throws Exception {
        List<String> seen = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.set", echo(seen));
        StringBuilder big = new StringBuilder("{\"v\":1,\"id\":\"big1\",\"type\":\"settings.set\",\"payload\":{\"x\":\"");
        for (int i = 0; i < 300 * 1024; i++) {
            big.append('a');
        }
        big.append("\"}}");
        router.dispatch(big.toString(), sink);
        JSONObject reply = only();
        assertEquals("too_large", reply.getJSONObject("error").getString("code"));
        assertEquals("big1", reply.getString("id"));
        assertTrue(seen.isEmpty());
    }

    @Test
    public void aWrongVersionIsRejected() throws Exception {
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.get", echo(new ArrayList<String>()));
        router.dispatch("{\"v\":2,\"id\":\"v2\",\"type\":\"settings.get\",\"payload\":{}}", sink);
        JSONObject reply = only();
        assertEquals("bad_version", reply.getJSONObject("error").getString("code"));
        assertEquals("v2", reply.getString("id"));
    }

    @Test
    public void textThatIsNotJsonGetsNoReplyWhenThereIsNoIdToAnswer() {
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD);
        router.dispatch("not json at all", sink);
        router.dispatch(null, sink);
        router.dispatch("", sink);
        assertTrue(sent.isEmpty());
    }

    @Test
    public void brokenJsonWithAnIdInItsFirstCharactersStillGetsAnAnswer() throws Exception {
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD);
        router.dispatch("{\"v\":1,\"id\":\"half\",\"type\":\"settings.get\",\"payload\":{", sink);
        JSONObject reply = only();
        assertEquals("bad_json", reply.getJSONObject("error").getString("code"));
        assertEquals("half", reply.getString("id"));
    }

    @Test
    public void aHandlerExceptionBecomesInternalWithoutLeakingItsText() throws Exception {
        final List<String> failures = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.get", new Handler() {
            @Override
            public void handle(Message message, Reply reply) {
                throw new IllegalStateException("db path /data/user/0/x " + CANARY);
            }
        });
        router.setFailureListener(new BridgeRouter.FailureListener() {
            @Override
            public void onHandlerFailure(String type, Throwable error) {
                failures.add(type + ":" + error.getClass().getSimpleName());
            }
        });
        router.dispatch(request("e1", "settings.get", "{}"), sink);
        JSONObject reply = only();
        assertFalse(reply.getBoolean("ok"));
        assertEquals("internal", reply.getJSONObject("error").getString("code"));
        assertFalse(sent.get(0).contains(CANARY));
        assertFalse(sent.get(0).contains("/data/user"));
        assertEquals("e1", reply.getString("id"));
        assertEquals(1, failures.size());
        assertEquals("settings.get:IllegalStateException", failures.get(0));
        assertFalse(failures.get(0).contains(CANARY));
    }

    @Test
    public void aProtocolExceptionFromAHandlerKeepsItsCodeAndItsOwnMessage() throws Exception {
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.set", new Handler() {
            @Override
            public void handle(Message message, Reply reply) throws Exception {
                throw new ProtocolException("bad_payload", "value must be true or false");
            }
        });
        router.dispatch(request("p1", "settings.set", "{}"), sink);
        JSONObject error = only().getJSONObject("error");
        assertEquals("bad_payload", error.getString("code"));
        assertEquals("value must be true or false", error.getString("message"));
    }

    @Test
    public void aKnownTypeWithoutAHandlerIsUnavailableNotUnknown() throws Exception {
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD);
        router.dispatch(request("n1", "voice.status", "{}"), sink);
        assertEquals("unavailable", only().getJSONObject("error").getString("code"));
    }

    @Test
    public void onlyTheFirstReplyCounts() throws Exception {
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.get", new Handler() {
            @Override
            public void handle(Message message, Reply reply) throws Exception {
                reply.ok(new JSONObject().put("first", true));
                reply.fail("internal", "second");
                reply.ok(new JSONObject().put("third", true));
            }
        });
        router.dispatch(request("d1", "settings.get", "{}"), sink);
        JSONObject reply = only();
        assertTrue(reply.getBoolean("ok"));
        assertTrue(reply.getJSONObject("payload").getBoolean("first"));
    }

    @Test
    public void aHandlerThatRepliesAndThenThrowsDoesNotSendASecondReply() throws Exception {
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.get", new Handler() {
            @Override
            public void handle(Message message, Reply reply) throws Exception {
                reply.ok(new JSONObject());
                throw new IllegalStateException(CANARY);
            }
        });
        router.dispatch(request("t1", "settings.get", "{}"), sink);
        assertTrue(only().getBoolean("ok"));
    }

    @Test
    public void aHandlerCanAnswerLaterFromAnotherThread() throws Exception {
        final Handler.Reply[] saved = new Handler.Reply[1];
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.set", new Handler() {
            @Override
            public void handle(Message message, Reply reply) {
                saved[0] = reply; // a confirmation dialog would answer when the owner taps
            }
        });
        router.dispatch(request("l1", "settings.set", "{}"), sink);
        assertTrue("nothing is sent while the handler waits", sent.isEmpty());
        saved[0].fail("cancelled", "Not changed.");
        JSONObject error = only().getJSONObject("error");
        assertEquals("cancelled", error.getString("code"));
    }

    @Test
    public void anErrorCodeOutsideTheVocabularyIsSentAsInternal() throws Exception {
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("settings.get", new Handler() {
            @Override
            public void handle(Message message, Reply reply) {
                reply.fail("totally_made_up", "x");
            }
        });
        router.dispatch(request("c1", "settings.get", "{}"), sink);
        assertEquals("internal", only().getJSONObject("error").getString("code"));
    }

    @Test
    public void aFamilyHandlerAnswersEveryTypeWithThatPrefix() throws Exception {
        List<String> seen = new ArrayList<>();
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("reminders.*", echo(seen));
        router.dispatch(request("m1", "reminders.list", "{}"), sink);
        router.dispatch(request("m2", "reminders.create", "{}"), sink);
        assertEquals(2, seen.size());
        assertEquals("reminders.create", seen.get(1));
    }

    @Test
    public void registeringATypeThatIsNotInTheProtocolTableFails() {
        try {
            new BridgeRouter(Role.DASHBOARD).register("made.up", echo(new ArrayList<String>()));
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("made.up"));
        }
    }

    @Test
    public void bestEffortIdIgnoresOversizedOrMissingIds() {
        assertNull(BridgeRouter.bestEffortId(null));
        assertNull(BridgeRouter.bestEffortId("{\"v\":1}"));
        StringBuilder longId = new StringBuilder();
        for (int i = 0; i < 65; i++) {
            longId.append('x');
        }
        assertNull(BridgeRouter.bestEffortId("{\"id\":\"" + longId + "\"}"));
        assertEquals("ok-1", BridgeRouter.bestEffortId("{\"id\":\"ok-1\"}"));
    }
}
