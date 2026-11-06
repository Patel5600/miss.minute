package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import com.patel5600.missminute.mobile.core.kill.KillPath;
import com.patel5600.missminute.mobile.core.policy.Capability;
import com.patel5600.missminute.mobile.core.policy.Mode;
import com.patel5600.missminute.mobile.core.protocol.Authority;
import com.patel5600.missminute.mobile.core.protocol.MessageTypes;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class VocabularyTest {
    private static final JSONObject DOC = TestVectors.json("vocabulary.json");

    private static List<String> strings(String key) throws Exception {
        JSONArray a = DOC.getJSONArray(key);
        List<String> out = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) {
            out.add(a.getString(i));
        }
        return out;
    }

    private static List<String> names(Enum<?>[] values) {
        List<String> out = new ArrayList<>();
        for (Enum<?> e : values) {
            out.add(e.name());
        }
        return out;
    }

    @Test
    public void statesEqualTheJsonList() throws Exception {
        assertEquals(strings("states"), names(OverlayState.values()));
        assertEquals(14, OverlayState.values().length);
    }

    @Test
    public void locomotionEqualsTheJsonList() throws Exception {
        assertEquals(strings("locomotion"), names(Locomotion.values()));
    }

    @Test
    public void roamingLevelsEqualTheJsonList() throws Exception {
        assertEquals(strings("roamingLevels"), names(RoamingLevel.values()));
    }

    @Test
    public void vocabularyConstantsEqualTheJsonLists() throws Exception {
        assertEquals(strings("emotions"), Vocabulary.EMOTIONS);
        assertEquals(strings("gestures"), Vocabulary.GESTURES);
        assertEquals(strings("baselineCapabilities"), Vocabulary.BASELINE_CAPABILITIES);
        assertEquals(strings("capabilityNames"), Vocabulary.CAPABILITY_NAMES);
        assertEquals(strings("errorCodes"), Vocabulary.ERROR_CODES);
        assertEquals(strings("events"), Vocabulary.EVENT_NAMES);
    }

    @Test
    public void everyGestureHasACapabilityName() {
        for (String g : Vocabulary.GESTURES) {
            assertTrue(Vocabulary.CAPABILITY_NAMES.contains("gesture:" + g));
        }
    }

    @Test
    public void baselineCapabilitiesAreAllKnownNames() {
        assertTrue(Vocabulary.CAPABILITY_NAMES.containsAll(Vocabulary.BASELINE_CAPABILITIES));
        Capabilities base = Capabilities.baseline();
        assertTrue(base.has("walk"));
        assertTrue(!base.has("hang"));
        assertTrue(base.with("hang").has("hang"));
        assertTrue(!base.with("not-a-capability").has("not-a-capability"));
    }

    @Test
    public void modesKillPathsCapabilitiesAndAuthoritiesEqualTheJsonLists() throws Exception {
        assertEquals(strings("modes"), names(Mode.values()));
        List<String> paths = new ArrayList<>();
        for (KillPath p : KillPath.values()) {
            paths.add(p.wireName);
        }
        assertEquals(strings("killPaths"), paths);
        List<String> caps = new ArrayList<>();
        for (Capability c : Capability.values()) {
            caps.add(c.wireName);
        }
        assertEquals(strings("permissionCapabilities"), caps);
        assertEquals(strings("authorities"), names(Authority.values()));
    }

    @Test
    public void theMessageTypeTableEqualsTheJsonTable() throws Exception {
        JSONObject table = DOC.getJSONObject("messageTypes");
        Map<String, Authority> mine = MessageTypes.table();
        assertEquals(table.length(), mine.size());
        for (Map.Entry<String, Authority> e : mine.entrySet()) {
            assertEquals(e.getKey(), table.getString(e.getKey()), e.getValue().name());
        }
    }
}