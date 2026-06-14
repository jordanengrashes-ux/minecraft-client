package com.voxelclient.cosmetics.mixin;

import com.voxelclient.cosmetics.CapeManager;
import net.minecraft.client.network.AbstractClientPlayerEntity;
import net.minecraft.client.util.SkinTextures;
import net.minecraft.util.Identifier;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(AbstractClientPlayerEntity.class)
public abstract class AbstractClientPlayerEntityMixin {

    @Inject(method = "getSkinTextures", at = @At("RETURN"), cancellable = true)
    private void injectVoxelCape(CallbackInfoReturnable<SkinTextures> cir) {
        AbstractClientPlayerEntity self = (AbstractClientPlayerEntity) (Object) this;
        Identifier cape = CapeManager.getCapeTexture(self.getUuid());
        if (cape == null) return;

        SkinTextures orig = cir.getReturnValue();
        // Replace cape and elytra texture with our custom one
        cir.setReturnValue(new SkinTextures(
            orig.texture(),
            orig.textureUrl(),
            cape,   // capeTexture
            cape,   // elytraTexture (also shows on elytra wings)
            orig.model(),
            orig.secure()
        ));
    }
}
