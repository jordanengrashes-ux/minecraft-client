package com.voxelclient.cosmetics;

import net.fabricmc.api.ClientModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class VoxelCosmeticsMod implements ClientModInitializer {
    public static final Logger LOGGER = LoggerFactory.getLogger("voxelcosmetics");

    @Override
    public void onInitializeClient() {
        LOGGER.info("[Voxel Cosmetics] Loaded — custom capes active");
    }
}
