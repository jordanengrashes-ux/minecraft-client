// =============================================================
//  UltraRealism Shaders — composite.fsh
//  Pass 0: Deferred PBR lighting, shadow, SSAO, sky composite
// =============================================================
#version 330 core

#include "/include/settings.glsl"
#include "/include/uniforms.glsl"
#include "/include/utils.glsl"
#include "/include/lighting.glsl"
#include "/include/shadows.glsl"
#include "/include/atmosphere.glsl"
#include "/include/sky.glsl"
#include "/include/water.glsl"
#include "/include/noise.glsl"

in vec2 texCoord;

/* DRAWBUFFERS:6 */
layout(location = 0) out vec4 outLit;    // colortex6

// ---- SSAO kernel (precomputed hemisphere samples) -----------
const vec3 SSAO_KERNEL[64] = vec3[64](
    vec3( 0.0490, 0.0570, 0.0774), vec3(-0.0980, 0.0700, 0.0370),
    vec3( 0.1260, 0.1260, 0.0790), vec3(-0.0280, 0.0280, 0.0199),
    vec3( 0.0330, 0.0990, 0.1100), vec3(-0.1800, 0.0800, 0.0100),
    vec3( 0.0770, 0.1110, 0.0550), vec3( 0.0090, 0.0400, 0.0340),
    vec3( 0.0440, 0.0200, 0.0380), vec3(-0.0900, 0.1500, 0.0310),
    vec3( 0.1700, 0.0700, 0.0460), vec3(-0.0150, 0.0680, 0.0160),
    vec3( 0.1060, 0.1560, 0.1000), vec3(-0.1300, 0.0500, 0.0600),
    vec3( 0.0190, 0.0680, 0.0700), vec3(-0.0620, 0.0380, 0.0620),
    vec3( 0.1400, 0.0600, 0.1100), vec3(-0.1100, 0.0110, 0.1200),
    vec3( 0.0050, 0.1500, 0.0580), vec3(-0.1300, 0.1300, 0.0290),
    vec3( 0.2100, 0.0600, 0.0200), vec3(-0.0550, 0.1900, 0.0840),
    vec3( 0.0240, 0.1400, 0.2100), vec3(-0.1800, 0.0490, 0.1600),
    vec3( 0.1500, 0.2200, 0.0060), vec3(-0.0190, 0.0420, 0.2300),
    vec3( 0.0740, 0.0400, 0.2300), vec3(-0.2100, 0.1700, 0.1100),
    vec3( 0.2400, 0.1600, 0.0850), vec3(-0.0750, 0.2400, 0.1400),
    vec3( 0.1100, 0.2600, 0.1400), vec3(-0.2600, 0.1000, 0.0750),
    vec3( 0.0200, 0.2800, 0.1500), vec3(-0.1500, 0.2100, 0.1700),
    vec3( 0.2700, 0.0800, 0.1700), vec3(-0.0350, 0.0800, 0.2800),
    vec3( 0.1200, 0.1200, 0.2700), vec3(-0.2800, 0.1300, 0.1400),
    vec3( 0.3000, 0.1100, 0.0600), vec3(-0.0880, 0.3000, 0.1100),
    vec3( 0.1300, 0.3000, 0.1100), vec3(-0.2700, 0.2000, 0.0700),
    vec3( 0.0290, 0.3100, 0.1700), vec3(-0.1600, 0.2500, 0.1900),
    vec3( 0.2900, 0.1400, 0.1800), vec3(-0.0410, 0.1100, 0.3100),
    vec3( 0.1400, 0.1500, 0.2900), vec3(-0.2900, 0.1700, 0.1600),
    vec3( 0.3200, 0.1400, 0.0800), vec3(-0.1000, 0.3200, 0.1300),
    vec3( 0.1500, 0.3200, 0.1200), vec3(-0.2800, 0.2300, 0.0800),
    vec3( 0.0360, 0.3300, 0.1900), vec3(-0.1700, 0.2700, 0.2100),
    vec3( 0.3000, 0.1700, 0.1900), vec3(-0.0470, 0.1300, 0.3300),
    vec3( 0.1500, 0.1800, 0.3100), vec3(-0.3000, 0.1900, 0.1800),
    vec3( 0.3400, 0.1600, 0.0950), vec3(-0.1100, 0.3400, 0.1400),
    vec3( 0.1700, 0.3400, 0.1400), vec3(-0.2900, 0.2600, 0.0900),
    vec3( 0.0430, 0.3500, 0.2100), vec3(-0.1900, 0.2900, 0.2200)
);

// ---- SSAO computation ---------------------------------------
float computeSSAO(vec3 viewPos, vec3 viewNorm, float depth) {
#if SSAO_ENABLED == 0
    return 1.0;
#endif
    if (depth >= 1.0) return 1.0;

    vec3  rvec     = normalize(texture(noisetex, gl_FragCoord.xy / 64.0).rgb * 2.0 - 1.0);
    vec3  tangent  = normalize(rvec - viewNorm * dot(rvec, viewNorm));
    vec3  bitangent = cross(viewNorm, tangent);
    mat3  TBN      = mat3(tangent, bitangent, viewNorm);

    float occlusion = 0.0;
    int   counted   = 0;

    for (int i = 0; i < SSAO_SAMPLES; i++) {
        vec3 sampleDir = TBN * SSAO_KERNEL[i];
        vec3 samplePos = viewPos + sampleDir * SSAO_RADIUS;

        vec4 clip = gbufferProjection * vec4(samplePos, 1.0);
        if (clip.w <= 0.0) continue;
        vec2 sUV = clip.xy / clip.w * 0.5 + 0.5;
        if (any(lessThan(sUV, vec2(0.01))) || any(greaterThan(sUV, vec2(0.99)))) continue;

        float sDepth = texture(depthtex1, sUV).r;
        if (sDepth >= 1.0) continue;
        vec3  sPos   = screenToViewPos(sUV, sDepth, gbufferProjectionInverse);

        // Measure how far the scene geometry sits above the surface plane,
        // measured along the surface normal (avoids Z-axis depth bias artifacts).
        float sceneAbove = dot(sPos - viewPos, viewNorm);
        float probeAbove = dot(sampleDir, viewNorm) * SSAO_RADIUS;

        // Scene is between the surface and the probe hemisphere → occlusion.
        // Bias of 0.03 (3 cm) prevents self-shadowing from the same surface.
        float rangeCheck = smoothstep(SSAO_RADIUS * 2.0, 0.0, length(sPos - viewPos));
        occlusion += (sceneAbove > 0.03 && sceneAbove < probeAbove) ? rangeCheck : 0.0;
        counted++;
    }

    if (counted == 0) return 1.0;
    float ao = 1.0 - (occlusion / float(counted)) * SSAO_STRENGTH;
    return clamp(ao, 0.2, 1.0);
}

void main() {
    // ---- Sample GBuffer -------------------------------------
    float depth     = texture(depthtex0, texCoord).r;
    vec4  albedoAO  = texture(colortex0, texCoord);
    vec4  normalRF  = texture(colortex1, texCoord);
    vec4  material  = texture(colortex2, texCoord);
    vec4  lmData    = texture(colortex3, texCoord);

    vec3  albedo    = albedoAO.rgb;
    float ao        = albedoAO.a;

    // Decode normal
    vec3  viewN     = octDecode(normalRF.xy);
    float roughness = normalRF.z;
    float F0val     = normalRF.w;

    float metallic  = material.r;
    float emissive  = material.g;
    float matID     = material.b;
    float sss       = material.a;

    vec2  lightmap  = lmData.xy;

    // ---- Sky pass (depth = 1) --------------------------------
    if (depth >= 1.0) {
        outLit = texture(colortex6, texCoord);  // already written by sky shaders
        return;
    }

    // ---- Reconstruct positions ------------------------------
    vec3  viewPos   = screenToViewPos(texCoord, depth, gbufferProjectionInverse);
    vec3  worldOff  = (gbufferModelViewInverse * vec4(viewPos, 1.0)).xyz;

    // ---- Light directions -----------------------------------
    vec3  sunDir    = normalize(sunPosition);
    vec3  moonDir   = normalize(moonPosition);
    vec3  lightDir  = normalize(shadowLightPosition);  // sun or moon
    vec3  viewDir   = normalize(-viewPos);
    vec3  worldN    = normalize((gbufferModelViewInverse * vec4(viewN, 0.0)).xyz);
    vec3  worldV    = normalize(-(gbufferModelViewInverse * vec4(viewPos, 0.0)).xyz);

    // ---- PBR material setup ---------------------------------
    vec3 F0 = mix(vec3(F0val), albedo, metallic);

    // ---- Shadow ---------------------------------------------
    vec3  shadowTint;
    float shadow    = evaluateShadow(viewPos, max(dot(viewN, lightDir), 0.0), shadowTint);

    // ---- Sunlight / moonlight direction and color -----------
    float sunElev   = sunDir.y;
    float dayNight  = clamp((-sunElev - 0.1) / 0.4, 0.0, 1.0);
    float sunrise   = 1.0 - abs(sunElev / 0.25);   // bright around horizon

    vec3  sunColor  = mix(vec3(1.2, 0.85, 0.6),
                          vec3(1.0, 0.95, 0.85), clamp(sunElev * 4.0, 0.0, 1.0));
    vec3  moonColor = vec3(0.2, 0.3, 0.5);
    vec3  lightColor = mix(sunColor, moonColor, dayNight) * SUNLIGHT_STRENGTH;

    // ---- Sky irradiance (diffuse ambient) -------------------
    vec3  skyIrr    = getSkyIrradiance(worldN, sunDir) * AMBIENT_STRENGTH;
    vec3  envRad    = getSkyColor(reflect(-worldV, worldN), sunDir, moonDir,
                                  dayNight, frameTimeCounter, moonPhase) * 0.5;

    // ---- SSAO -----------------------------------------------
    float ssao      = computeSSAO(viewPos, viewN, depth) * ao;

    // ---- Lightmap contribution ------------------------------
    vec3  blockLight = blocklightColor(lightmap.x, BLOCKLIGHT_TEMP);
    vec3  skyLight   = skylightColor(lightmap.y, skyIrr);
    vec3  ambientLight = (blockLight + skyLight) * ssao;

    // ---- Direct PBR light -----------------------------------
    float NdotL     = max(dot(viewN, lightDir), 0.0);
    vec3  directLight = pbrLight(viewN, viewDir, lightDir,
                                 albedo, roughness, metallic, F0,
                                 lightColor * shadow * shadowTint);

    // ---- Ambient / IBL --------------------------------------
    vec3  ambientPbr = ambientPBR(viewN, viewDir, albedo, roughness, metallic, F0,
                                  skyIrr, envRad) * ssao;

    // ---- Subsurface scattering -------------------------
    float LdotV     = dot(lightDir, viewDir);
    vec3  sssLight  = subsurfaceApprox(albedo, sss * 5.0, LdotV, 0.3)
                      * lightColor * shadow * 0.5;

    // ---- Emissive -------------------------------------------
    vec3  emissiveColor = albedo * emissive * EMISSIVE_BLOOM_STRENGTH;

    // ---- Combine --------------------------------------------
    vec3  litColor  = directLight + ambientPbr + ambientLight + sssLight + emissiveColor;

    // ---- Nether / End overrides ----------------------------
#if NETHER_EFFECTS == 1
    if (dimension == -1) {
        // Nether: red-orange ambient glow
        litColor += albedo * vec3(0.4, 0.1, 0.0) * AMBIENT_STRENGTH;
    }
#endif
#if END_EFFECTS == 1
    if (dimension == 1) {
        // End: purple-tinted ambient
        litColor += albedo * vec3(0.2, 0.0, 0.4) * AMBIENT_STRENGTH * 0.5;
    }
#endif

    // ---- Underwater caustics --------------------------------
#if CAUSTICS == 1
    if (isEyeInWater == 1) {
        vec3 wPos = worldOff + cameraPosition;
        litColor += underwaterCaustics(wPos, sunDir, frameTimeCounter)
                    * lightColor * max(lightmap.y, 0.1);
    }
#endif

    outLit = vec4(max(litColor, vec3(0.0)), 1.0);
}
