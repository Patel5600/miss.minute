package com.patel5600.missminute.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.patel5600.missminute.mobile.app.MissMinutesApp;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the actual SQLCipher-backed migration status query on an Android runtime. */
@RunWith(AndroidJUnit4.class)
public final class OwnerDataDbInstrumentedTest {
    @Test
    public void migrationStatusCanBeReadFromTheEncryptedOwnerDatabase() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        OwnerDataDb ownerDataDb = MissMinutesApp.from(context).ownerDataDb();

        JSONArray result = ownerDataDb.execute(new JSONObject().put("op", "migrationStatus"));

        assertEquals(1, result.length());
        assertNotNull(result.getJSONObject(0).get("done"));
    }
}
