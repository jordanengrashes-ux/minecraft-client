package com.voxelclient.cosmetics;

import net.minecraft.client.texture.NativeImage;

public enum CapeDesign {
    // id, top ARGB color, bottom ARGB color
    VOXEL_GREEN ("voxel_green",  0xFF3FB950, 0xFF1A4A2E),
    MIDNIGHT    ("midnight",     0xFF58A6FF, 0xFF1A2E4A),
    CRIMSON     ("crimson",      0xFFDA3633, 0xFF5A0A0A),
    AMETHYST    ("amethyst",     0xFFA371F7, 0xFF4A1A9E),
    GOLDEN      ("golden",       0xFFD29922, 0xFF6B4C00),
    NETHER      ("nether",       0xFFF97316, 0xFF7A1A00),
    OCEAN       ("ocean",        0xFF7CC4DB, 0xFF1A4A5A),
    VOID        ("void",         0xFF8B5CF6, 0xFF0A0A2E);

    public final String id;
    private final int topArgb;
    private final int botArgb;

    CapeDesign(String id, int top, int bot) {
        this.id = id;
        this.topArgb = top;
        this.botArgb = bot;
    }

    public static CapeDesign forId(String id) {
        for (CapeDesign d : values()) if (d.id.equals(id)) return d;
        return VOXEL_GREEN;
    }

    // Convert 0xAARRGGBB → 0xAABBGGRR (ABGR) for NativeImage.fillRect
    private static int toAbgr(int argb) {
        return (argb & 0xFF00FF00)
             | ((argb & 0x00FF0000) >>> 16)
             | ((argb & 0x000000FF) <<  16);
    }

    public NativeImage buildTexture() {
        // Standard Minecraft cape texture: 64x32, RGBA format
        // Cape visible UV area: x=0-63, y=0-15 (top half used by cape model)
        // Two-tone design: top 8 rows = topColor, next 8 rows = botColor
        NativeImage img = new NativeImage(NativeImage.Format.RGBA, 64, 32, true);
        int top = toAbgr(topArgb);
        int bot = toAbgr(botArgb);
        img.fillRect(0, 0, 64, 8,  top);
        img.fillRect(0, 8, 64, 8,  bot);
        // Bright trim strip at very top (1px) using top color lightened
        img.fillRect(0, 0, 64, 1, toAbgr(lighten(topArgb, 0.3f)));
        return img;
    }

    private static int lighten(int argb, float f) {
        int a = (argb >> 24) & 0xFF;
        int r = Math.min(255, (int)(((argb >> 16) & 0xFF) * (1 + f)));
        int g = Math.min(255, (int)(((argb >> 8)  & 0xFF) * (1 + f)));
        int b = Math.min(255, (int)( (argb        & 0xFF) * (1 + f)));
        return (a << 24) | (r << 16) | (g << 8) | b;
    }
}
