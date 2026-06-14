package com.voxelclient.cosmetics;

import com.google.gson.JsonElement;
import com.google.gson.JsonParser;

import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URI;
import java.util.concurrent.CompletableFuture;

public class FirebaseClient {
    // Firebase RTDB base URL — reads voxel_capes/{uuid} without auth (public read)
    private static final String RTDB = "https://tank-d367c-default-rtdb.firebaseio.com";

    /**
     * Returns the cape_id string for the given Minecraft UUID (no dashes),
     * or null if the player has no cape or lookup failed.
     */
    public static CompletableFuture<String> getCapeId(String uuidNoDashes) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                URI uri = URI.create(RTDB + "/voxel_capes/" + uuidNoDashes + ".json");
                HttpURLConnection conn = (HttpURLConnection) uri.toURL().openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(4000);
                conn.setReadTimeout(4000);
                conn.setRequestProperty("Accept", "application/json");
                if (conn.getResponseCode() != 200) return null;
                JsonElement el = JsonParser.parseReader(new InputStreamReader(conn.getInputStream()));
                if (el.isJsonNull() || !el.isJsonObject()) return null;
                var obj = el.getAsJsonObject();
                if (!obj.has("enabled") || !obj.get("enabled").getAsBoolean()) return null;
                if (!obj.has("cape_id")) return null;
                return obj.get("cape_id").getAsString();
            } catch (Exception e) {
                VoxelCosmeticsMod.LOGGER.debug("[Voxel Cosmetics] Cape lookup failed for {}: {}", uuidNoDashes, e.getMessage());
                return null;
            }
        });
    }
}
