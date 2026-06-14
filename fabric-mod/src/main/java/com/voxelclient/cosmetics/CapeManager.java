package com.voxelclient.cosmetics;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.texture.NativeImage;
import net.minecraft.client.texture.NativeImageBackedTexture;
import net.minecraft.util.Identifier;

import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class CapeManager {
    // Sentinel: looked up this UUID, confirmed no cape
    private static final Identifier NO_CAPE = Identifier.of("voxelcosmetics", "none");

    private static final Map<String, Identifier> cache   = new ConcurrentHashMap<>();
    private static final Set<String>             pending = ConcurrentHashMap.newKeySet();

    /**
     * Returns the Identifier of the cape texture for the given player UUID,
     * or null if not available (not a Voxel Client user, or still loading).
     * Safe to call every frame — all heavy work is off the render thread.
     */
    public static Identifier getCapeTexture(UUID playerUuid) {
        String key = playerUuid.toString().replace("-", "");
        Identifier cached = cache.get(key);
        if (cached == NO_CAPE) return null;
        if (cached != null)    return cached;

        // Kick off async lookup (once per UUID)
        if (pending.add(key)) {
            FirebaseClient.getCapeId(key).thenAccept(capeId -> {
                if (capeId == null) {
                    cache.put(key, NO_CAPE);
                } else {
                    buildAndRegister(key, capeId);
                }
                pending.remove(key);
            });
        }
        return null;
    }

    private static void buildAndRegister(String key, String capeId) {
        try {
            NativeImage img = CapeDesign.forId(capeId).buildTexture();
            // Texture registration must happen on the main (render) thread
            MinecraftClient.getInstance().execute(() -> {
                Identifier id = Identifier.of("voxelcosmetics", "cape_" + key);
                MinecraftClient.getInstance()
                    .getTextureManager()
                    .registerTexture(id, new NativeImageBackedTexture(img));
                cache.put(key, id);
                VoxelCosmeticsMod.LOGGER.info("[Voxel Cosmetics] Cape '{}' loaded for {}", capeId, key.substring(0, 8) + "…");
            });
        } catch (Exception e) {
            cache.put(key, NO_CAPE);
            VoxelCosmeticsMod.LOGGER.warn("[Voxel Cosmetics] Failed to build cape texture: {}", e.getMessage());
        }
    }
}
