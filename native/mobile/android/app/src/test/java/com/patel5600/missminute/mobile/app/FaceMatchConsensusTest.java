package com.patel5600.missminute.mobile.app;

import org.junit.Test;
import static org.junit.Assert.*;

public final class FaceMatchConsensusTest {
    @Test public void oneStrongFrameIsOnlyPossibleOwner() {
        FaceMatchConsensus gate = new FaceMatchConsensus();
        assertFalse(gate.observe(0.72, 1000));
        assertTrue(gate.observe(0.70, 1400));
    }

    @Test public void mismatchClearsAccumulatedOwnerEvidence() {
        FaceMatchConsensus gate = new FaceMatchConsensus();
        assertFalse(gate.observe(0.62, 1000));
        assertFalse(gate.observe(0.20, 1400));
        assertFalse(gate.observe(0.61, 1800));
        assertTrue(gate.observe(0.59, 2200));
    }

    @Test public void staleFramesCannotCompleteCandidate() {
        FaceMatchConsensus gate = new FaceMatchConsensus();
        assertFalse(gate.observe(0.63, 1000));
        assertFalse(gate.observe(0.63, 2600));
        assertTrue(gate.observe(0.63, 3000));
    }

    @Test public void candidateEmitsOnceButRemainsConfirmedWhileFreshMatchesContinue() {
        FaceMatchConsensus gate = new FaceMatchConsensus();
        assertFalse(gate.observe(0.60, 1000));
        assertFalse(gate.isConfirmed(1000));
        assertTrue(gate.observe(0.61, 1400));
        assertTrue(gate.isConfirmed(1400));
        assertFalse(gate.observe(0.62, 1800));
        assertTrue(gate.isConfirmed(1800));
        assertFalse(gate.observe(0.20, 1900));
        assertFalse(gate.isConfirmed(1900));
        gate.reset();
        assertFalse(gate.isConfirmed(2200));
        assertFalse(gate.observe(0.60, 2200));
        assertTrue(gate.observe(0.61, 2600));
        assertTrue(gate.isConfirmed(2600));
    }

    @Test public void nonFiniteScoresAreRejected() {
        FaceMatchConsensus gate = new FaceMatchConsensus();
        assertFalse(gate.observe(Double.NaN, 1000));
        assertFalse(gate.observe(0.65, 1400));
        assertTrue(gate.observe(0.65, 1800));
        assertTrue(gate.isConfirmed(1800));
    }

    @Test public void staleCandidateExpiresWithoutRequiringAnotherFrame() {
        FaceMatchConsensus gate = new FaceMatchConsensus();
        assertFalse(gate.observe(0.64, 1000));
        assertTrue(gate.observe(0.64, 1300));
        assertTrue(gate.isConfirmed(2800));
        assertFalse(gate.isConfirmed(2801));
        assertFalse(gate.isConfirmed(1299));
    }
}
