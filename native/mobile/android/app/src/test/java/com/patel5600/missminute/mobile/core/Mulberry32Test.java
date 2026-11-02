package com.patel5600.missminute.mobile.core;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class Mulberry32Test {
    @Test
    public void matchesTheTypeScriptGoldenValuesExactly() throws Exception {
        JSONObject doc = TestVectors.json("rng.json");
        assertEquals("mulberry32", doc.getString("algorithm"));
        JSONArray cases = doc.getJSONArray("cases");
        assertEquals(3, cases.length());
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            Mulberry32 rng = new Mulberry32(c.getLong("seed"));
            JSONArray values = c.getJSONArray("values");
            assertEquals(16, values.length());
            for (int j = 0; j < values.length(); j++) {
                assertEquals("seed " + c.getLong("seed") + " value " + j, values.getDouble(j), rng.nextDouble(), 0.0);
            }
        }
    }

    @Test
    public void sameSeedSameSequenceDifferentSeedDiffers() {
        Mulberry32 a = new Mulberry32(7);
        Mulberry32 b = new Mulberry32(7);
        Mulberry32 c = new Mulberry32(8);
        boolean differs = false;
        for (int i = 0; i < 20; i++) {
            double x = a.nextDouble();
            assertEquals(x, b.nextDouble(), 0.0);
            if (x != c.nextDouble()) {
                differs = true;
            }
        }
        assertTrue(differs);
    }

    @Test
    public void helpersStayInRange() {
        Mulberry32 rng = new Mulberry32(99);
        for (int i = 0; i < 1000; i++) {
            int n = rng.nextInt(5);
            assertTrue(n >= 0 && n < 5);
            double r = rng.range(2, 3);
            assertTrue(r >= 2 && r < 3);
        }
    }
}