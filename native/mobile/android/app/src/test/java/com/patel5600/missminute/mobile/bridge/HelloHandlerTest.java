package com.patel5600.missminute.mobile.bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.patel5600.missminute.mobile.core.Capabilities;
import com.patel5600.missminute.mobile.core.protocol.Role;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class HelloHandlerTest {
    private final List<String> sent = new ArrayList<>();
    private final BridgeRouter.Sink sink = new BridgeRouter.Sink() {
        @Override
        public void send(String json) {
            sent.add(json);
        }
    };

    private static String hello(String payload) {
        return "{\"v\":1,\"id\":\"h1\",\"type\":\"hello\",\"payload\":" + payload + "}";
    }

    @Test
    public void theOverlayPageReportsOnlyKnownCapabilityNames() throws Exception {
        final Capabilities[] got = new Capabilities[1];
        final double[] scale = new double[1];
        BridgeRouter router = new BridgeRouter(Role.OVERLAY).register("hello",
                new HelloHandler(Role.OVERLAY, new HelloHandler.OverlayListener() {
                    @Override
                    public void onOverlayHello(Capabilities reported, double rigScale) {
                        got[0] = reported;
                        scale[0] = rigScale;
                    }
                }, null));
        router.dispatch(hello("{\"role\":\"overlay\",\"rigScale\":0.3256,"
                + "\"capabilities\":[\"idle\",\"walk\",\"hang\",\"teleport\",42,null,\"gesture:wave\"]}"), sink);
        JSONObject reply = new JSONObject(sent.get(0));
        assertTrue(reply.getBoolean("ok"));
        assertEquals("overlay", reply.getJSONObject("payload").getString("role"));
        assertEquals(1, reply.getJSONObject("payload").getInt("protocol"));
        assertTrue(got[0].has("idle"));
        assertTrue(got[0].has("walk"));
        assertTrue(got[0].has("hang"));
        assertTrue(got[0].has("gesture:wave"));
        assertFalse("a name that is not in the vocabulary is dropped", got[0].names().contains("teleport"));
        assertFalse(got[0].has("jump"));
        assertEquals(0.3256, scale[0], 1e-9);
    }

    @Test
    public void aMissingCapabilityListMeansTheRigReportsNothing() throws Exception {
        final Capabilities[] got = new Capabilities[1];
        BridgeRouter router = new BridgeRouter(Role.OVERLAY).register("hello",
                new HelloHandler(Role.OVERLAY, new HelloHandler.OverlayListener() {
                    @Override
                    public void onOverlayHello(Capabilities reported, double rigScale) {
                        got[0] = reported;
                    }
                }, null));
        router.dispatch(hello("{}"), sink);
        assertTrue(got[0].names().isEmpty());
    }

    @Test
    public void onlyTheFirstSixtyFourEntriesAreRead() {
        JSONArray many = new JSONArray();
        for (int i = 0; i < 64; i++) {
            many.put("junk" + i);
        }
        many.put("run"); // the 65th entry
        assertTrue(HelloHandler.parseCapabilities(many).names().isEmpty());
        assertTrue(HelloHandler.parseCapabilities(null).names().isEmpty());
    }

    @Test
    public void aNameLongerThanFortyCharactersIsIgnored() {
        JSONArray names = new JSONArray();
        StringBuilder longName = new StringBuilder("idle");
        for (int i = 0; i < 40; i++) {
            longName.append('x');
        }
        names.put(longName.toString());
        names.put("fall");
        Capabilities caps = HelloHandler.parseCapabilities(names);
        assertEquals(1, caps.names().size());
        assertTrue(caps.has("fall"));
    }

    @Test
    public void theDashboardGetsItsInfoInTheAnswerAndNeverRunsTheOverlayListener() throws Exception {
        final boolean[] overlayCalled = {false};
        BridgeRouter router = new BridgeRouter(Role.DASHBOARD).register("hello",
                new HelloHandler(Role.DASHBOARD, new HelloHandler.OverlayListener() {
                    @Override
                    public void onOverlayHello(Capabilities reported, double rigScale) {
                        overlayCalled[0] = true;
                    }
                }, new HelloHandler.DashboardInfo() {
                    @Override
                    public JSONObject describe() throws org.json.JSONException {
                        return new JSONObject().put("mode", "OBSERVE").put("killNotice", JSONObject.NULL);
                    }
                }));
        router.dispatch(hello("{\"role\":\"dashboard\"}"), sink);
        JSONObject payload = new JSONObject(sent.get(0)).getJSONObject("payload");
        assertEquals("dashboard", payload.getString("role"));
        assertEquals("OBSERVE", payload.getString("mode"));
        assertTrue(payload.isNull("killNotice"));
        assertFalse(overlayCalled[0]);
    }

    @Test
    public void aDashboardCannotSayHelloThroughTheOverlayRouterWithAnotherRole() throws Exception {
        // The role is fixed by the router (the WebView), whatever the payload claims.
        BridgeRouter router = new BridgeRouter(Role.OVERLAY).register("hello",
                new HelloHandler(Role.OVERLAY, null, null));
        router.dispatch(hello("{\"role\":\"dashboard\"}"), sink);
        assertEquals("overlay", new JSONObject(sent.get(0)).getJSONObject("payload").getString("role"));
    }
}
