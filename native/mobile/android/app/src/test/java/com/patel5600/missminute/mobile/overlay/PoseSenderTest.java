package com.patel5600.missminute.mobile.overlay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.patel5600.missminute.mobile.core.Locomotion;
import com.patel5600.missminute.mobile.core.OverlayState;
import com.patel5600.missminute.mobile.core.protocol.Message;
import com.patel5600.missminute.mobile.core.protocol.Protocol;

import java.util.ArrayList;
import java.util.List;
import org.junit.Before;
import org.junit.Test;

public class PoseSenderTest {
    private final List<String> sent = new ArrayList<>();
    private PoseSender sender;

    @Before
    public void setUp() {
        sent.clear();
        sender = new PoseSender(new PoseSender.Sink() {
            @Override
            public void send(String json) {
                sent.add(json);
            }
        });
    }

    private Message last() throws Exception {
        return Protocol.decodeEnvelope(sent.get(sent.size() - 1));
    }

    @Test
    public void aPoseIsSentOnlyWhenLocomotionFacingOrRoundedSpeedChanged() throws Exception {
        assertTrue(sender.pose(Locomotion.WALK, 1, 34.2));
        assertFalse("same pose again", sender.pose(Locomotion.WALK, 1, 34.4));
        assertFalse(sender.pose(Locomotion.WALK, 1, 33.6));
        assertEquals(1, sent.size());
        assertTrue("another whole px/s is a change", sender.pose(Locomotion.WALK, 1, 35.0));
        assertTrue("turning around", sender.pose(Locomotion.WALK, -1, 35.0));
        assertTrue("stopping", sender.pose(Locomotion.STAND, -1, 0));
        assertEquals(4, sent.size());
        Message m = last();
        assertEquals("rig.pose", m.type);
        assertEquals("STAND", m.payload.getString("locomotion"));
        assertEquals(-1, m.payload.getInt("facing"));
        assertEquals(0, m.payload.getInt("speed"));
    }

    @Test
    public void ahundredFramesOfTheSamePoseSendOneMessage() {
        for (int i = 0; i < 100; i++) {
            sender.pose(Locomotion.STAND, 1, 0);
        }
        assertEquals(1, sent.size());
    }

    @Test
    public void everyCommandIsAValidEnvelope() throws Exception {
        sender.pose(Locomotion.WALK, 1, 34);
        sender.gesture("wave");
        sender.hop();
        sender.squash(0.5);
        sender.power(30);
        sender.visible(true);
        sender.state(OverlayState.THINKING);
        assertEquals(7, sent.size());
        for (String json : sent) {
            Message m = Protocol.decodeEnvelope(json);
            assertTrue(m.type.startsWith("rig."));
            assertFalse(m.id.isEmpty());
            assertTrue(m.id.length() <= Protocol.MAX_ID_LENGTH);
        }
    }

    @Test
    public void aGestureAlwaysPlaysEvenTheSameOneTwiceInARow() throws Exception {
        sender.gesture("wave");
        sender.gesture("wave");
        assertEquals(2, sent.size());
        assertEquals("wave", last().payload.getString("gesture"));
        assertEquals("rig.cue", last().type);
    }

    @Test
    public void aStateIsSentOnlyWhenItChanged() throws Exception {
        assertTrue(sender.state(OverlayState.SLEEPING));
        assertFalse(sender.state(OverlayState.SLEEPING));
        assertTrue(sender.state(OverlayState.IDLE));
        assertEquals(2, sent.size());
        assertEquals("IDLE", last().payload.getString("state"));
    }

    @Test
    public void powerAndVisibilityAreSentOnlyWhenTheyChanged() throws Exception {
        assertTrue(sender.power(30));
        assertFalse(sender.power(30));
        assertTrue(sender.power(15));
        assertTrue(sender.visible(false));
        assertFalse(sender.visible(false));
        assertTrue(sender.visible(true));
        assertEquals("power 30, power 15, visible false, visible true", 4, sent.size());
        Message visible = last();
        assertEquals("rig.visible", visible.type);
        assertTrue(visible.payload.getBoolean("visible"));
    }

    @Test
    public void squashIsClampedAndRounded() throws Exception {
        sender.squash(1.7);
        assertEquals(1.0, last().payload.getDouble("amount"), 1e-9);
        sender.squash(-3);
        assertEquals(0.0, last().payload.getDouble("amount"), 1e-9);
        sender.squash(0.3456);
        assertEquals(0.35, last().payload.getDouble("amount"), 1e-9);
        assertEquals("rig.squash", last().type);
    }

    @Test
    public void resendRepeatsTheLastKnownStateForAPageThatReloaded() throws Exception {
        sender.power(15);
        sender.visible(true);
        sender.state(OverlayState.HAPPY);
        sender.pose(Locomotion.WALK, -1, 48);
        sent.clear();
        sender.resend();
        assertEquals(4, sent.size());
        List<String> types = new ArrayList<>();
        for (String json : sent) {
            types.add(Protocol.decodeEnvelope(json).type);
        }
        assertTrue(types.contains("rig.power"));
        assertTrue(types.contains("rig.visible"));
        assertTrue(types.contains("rig.cue"));
        assertTrue(types.contains("rig.pose"));
        assertEquals(48, Protocol.decodeEnvelope(sent.get(3)).payload.getInt("speed"));
    }

    @Test
    public void resendBeforeAnythingWasSentSendsNothing() {
        sender.resend();
        assertTrue(sent.isEmpty());
    }

    @Test
    public void nothingTheSenderBuildsCouldBeSentBackByAPage() throws Exception {
        sender.pose(Locomotion.STAND, 1, 0);
        sender.hop();
        sender.power(30);
        sender.visible(true);
        for (String json : sent) {
            try {
                Protocol.decode(json);
                throw new AssertionError("a page must not be able to send " + json);
            } catch (com.patel5600.missminute.mobile.core.protocol.ProtocolException expected) {
                assertEquals("forbidden", expected.code);
            }
        }
    }
}
