package com.patel5600.missminute.mobile.core.protocol;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import com.patel5600.missminute.mobile.core.TestVectors;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ProtocolTest {
    private static final JSONObject DOC = TestVectors.json("protocol.json");

    @Test
    public void limitsMatchTheVectors() throws Exception {
        assertEquals(DOC.getJSONObject("limits").getInt("maxBytes"), Protocol.MAX_BYTES);
        assertEquals(DOC.getJSONObject("limits").getInt("maxIdLength"), Protocol.MAX_ID_LENGTH);
        assertEquals(DOC.getJSONObject("limits").getString("typePattern"), Protocol.TYPE_PATTERN);
    }

    @Test
    public void everyTypeInTheMessageTableCanBeSent() {
        // A type the pattern rejects could never reach its handler (permissions.setMode was one).
        for (String key : MessageTypes.table().keySet()) {
            String sample = key.endsWith(".*") ? key.substring(0, key.length() - 1) + "x" : key;
            assertTrue(sample + " must match " + Protocol.TYPE_PATTERN, sample.matches(Protocol.TYPE_PATTERN));
        }
    }

    @Test
    public void everyValidVectorDecodesWithTheStatedFields() throws Exception {
        JSONArray valid = DOC.getJSONArray("valid");
        assertTrue(valid.length() >= 7);
        for (int i = 0; i < valid.length(); i++) {
            JSONObject v = valid.getJSONObject(i);
            Message m = Protocol.decode(v.getString("text"));
            assertEquals(v.getString("name"), v.getString("type"), m.type);
            assertEquals(v.getString("name"), v.getString("id"), m.id);
            assertEquals(v.getString("name"), Authority.valueOf(v.getString("authority")), m.authority);
            assertEquals(v.getString("name"), v.getBoolean("userOnly"), m.isUserOnly());
        }
    }

    @Test
    public void everyInvalidVectorFailsWithTheStatedCode() throws Exception {
        JSONArray invalid = DOC.getJSONArray("invalid");
        assertTrue(invalid.length() >= 17);
        for (int i = 0; i < invalid.length(); i++) {
            JSONObject v = invalid.getJSONObject(i);
            String text;
            if (v.has("generate")) {
                JSONObject g = v.getJSONObject("generate");
                char[] fill = new char[g.getInt("payloadFillBytes")];
                Arrays.fill(fill, 'x');
                text = new JSONObject().put("v", 1).put("id", g.getString("id")).put("type", g.getString("type"))
                        .put("payload", new JSONObject().put("fill", new String(fill))).toString();
            } else {
                text = v.getString("text");
            }
            try {
                Protocol.decode(text);
                fail("expected " + v.getString("code") + " for: " + v.getString("name"));
            } catch (ProtocolException e) {
                assertEquals(v.getString("name"), v.getString("code"), e.code);
            }
        }
    }

    @Test
    public void aNativeOnlyTypeSentByAPageIsForbidden() {
        for (String type : new String[] {"rig.pose", "rig.power", "reply", "event"}) {
            try {
                Protocol.decode("{\"v\":1,\"id\":\"a\",\"type\":\"" + type + "\",\"ok\":true,\"name\":\"x\",\"payload\":{}}");
                fail("expected forbidden for " + type);
            } catch (ProtocolException e) {
                assertEquals(type, "forbidden", e.code);
            }
        }
    }

    @Test
    public void userOnlyTypesAreFlaggedForANativeConfirmation() throws Exception {
        Message kill = Protocol.decode("{\"v\":1,\"id\":\"k\",\"type\":\"kill.request\",\"payload\":{}}");
        assertTrue(kill.isUserOnly());
        Message status = Protocol.decode("{\"v\":1,\"id\":\"s\",\"type\":\"overlay.status\",\"payload\":{}}");
        assertFalse(status.isUserOnly());
    }

    @Test
    public void theUserOnlyListIsNonEmptyAndStable() {
        assertEquals(Arrays.asList(
                "approval.decide", "kill.ackNotice", "kill.request", "permissions.get", "permissions.grant",
                "permissions.revoke", "permissions.setMode", "provider.pair.complete", "provider.pair.start",
                "provider.promptKey", "provider.remove", "system.consent.set"), MessageTypes.userOnlyTypes());
    }

    @Test
    public void rolesAreEnforcedPerAuthority() throws Exception {
        Message hello = Protocol.decode("{\"v\":1,\"id\":\"a\",\"type\":\"hello\",\"payload\":{}}");
        Protocol.authorize(hello, Role.OVERLAY);
        Protocol.authorize(hello, Role.DASHBOARD);

        Message rigError = Protocol.decode("{\"v\":1,\"id\":\"a\",\"type\":\"rig.error\",\"payload\":{}}");
        Protocol.authorize(rigError, Role.OVERLAY);
        expectForbidden(rigError, Role.DASHBOARD);

        Message kill = Protocol.decode("{\"v\":1,\"id\":\"a\",\"type\":\"kill.request\",\"payload\":{}}");
        Protocol.authorize(kill, Role.DASHBOARD);
        expectForbidden(kill, Role.OVERLAY);

        Message notes = Protocol.decode("{\"v\":1,\"id\":\"a\",\"type\":\"notes.add\",\"payload\":{}}");
        expectForbidden(notes, Role.OVERLAY);
    }

    private static void expectForbidden(Message m, Role role) {
        try {
            Protocol.authorize(m, role);
            fail("expected forbidden for " + m.type + " from " + role);
        } catch (ProtocolException e) {
            assertEquals("forbidden", e.code);
        }
    }

    @Test
    public void builtRepliesErrorsAndEventsRoundTripThroughTheEnvelopeDecoder() throws Exception {
        Message r = Protocol.decodeEnvelope(Protocol.reply("id1", new JSONObject().put("a", 1)));
        assertEquals("reply", r.type);
        assertEquals(Boolean.TRUE, r.ok);
        assertEquals(1, r.payload.getInt("a"));

        Message e = Protocol.decodeEnvelope(Protocol.error("id2", "forbidden", "no"));
        assertEquals(Boolean.FALSE, e.ok);
        assertEquals("forbidden", e.errorCode);
        assertEquals("no", e.errorMessage);

        Message ev = Protocol.decodeEnvelope(Protocol.event("kill.happened", new JSONObject().put("path", "app-button")));
        assertEquals("event", ev.type);
        assertEquals("kill.happened", ev.name);

        Message cmd = Protocol.decodeEnvelope(Protocol.command("rig.pose", new JSONObject().put("speed", 3)));
        assertEquals("rig.pose", cmd.type);
    }

    @Test
    public void unknownTypeAndBadVersionKeepTheirCodes() {
        expectCode("{\"v\":1,\"id\":\"a\",\"type\":\"zzz\",\"payload\":{}}", "unknown_type");
        expectCode("{\"v\":2,\"id\":\"a\",\"type\":\"hello\",\"payload\":{}}", "bad_version");
        expectCode("{\"v\":1,\"id\":\"a\",\"type\":\"hello\",\"payload\":null}", "bad_payload");
    }

    private static void expectCode(String text, String code) {
        try {
            Protocol.decode(text);
            fail("expected " + code);
        } catch (ProtocolException e) {
            assertEquals(code, e.code);
        }
    }
}