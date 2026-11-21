package com.patel5600.missminute.mobile.app;

import static org.junit.Assert.assertEquals;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class ChatGptModelCatalogTest {
    @Test
    public void parsesSignInWithChatGptCatalogAndSkipsHiddenEntries() throws Exception {
        JSONObject response = new JSONObject()
                .put("models", new JSONArray()
                        .put(new JSONObject().put("slug", "gpt-visible").put("display_name", "Visible GPT").put("visibility", "list"))
                        .put(new JSONObject().put("slug", "gpt-hidden").put("display_name", "Hidden GPT").put("visibility", "private")));

        JSONArray models = ChatGptOAuth.parseModelCatalog(response);

        assertEquals(1, models.length());
        assertEquals("gpt-visible", models.getJSONObject(0).getString("slug"));
        assertEquals("Visible GPT", models.getJSONObject(0).getString("displayName"));
    }

    @Test
    public void acceptsStandardApiModelCatalogFallback() throws Exception {
        JSONObject response = new JSONObject()
                .put("data", new JSONArray().put(new JSONObject().put("id", "gpt-standard")));

        JSONArray models = ChatGptOAuth.parseModelCatalog(response);

        assertEquals(1, models.length());
        assertEquals("gpt-standard", models.getJSONObject(0).getString("slug"));
        assertEquals("gpt-standard", models.getJSONObject(0).getString("displayName"));
    }
}
