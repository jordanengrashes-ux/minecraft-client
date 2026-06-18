// =============================================================
//  UltraRealism Shaders — include/atmosphere.glsl
//  Analytic Rayleigh + Mie single-scattering sky model
// =============================================================
#ifndef ATMOSPHERE_GLSL
#define ATMOSPHERE_GLSL

#include "/include/settings.glsl"
#include "/include/utils.glsl"

// ---- Physical constants -------------------------------------
const float EARTH_RADIUS     = 6371000.0;
const float ATMOS_RADIUS      = 6471000.0;  // 100 km above surface
const float RAYLEIGH_HEIGHT   = 8500.0;
const float MIE_HEIGHT        = 1200.0;
const vec3  RAYLEIGH_BETA     = vec3(5.5e-6, 13.0e-6, 22.4e-6);  // sea-level
const float MIE_BETA          = 2.0e-5;
const float MIE_G             = 0.758;       // asymmetry factor
const float SUN_INTENSITY     = 5.0;

// ---- Phase functions ----------------------------------------
float rayleighPhase(float cosTheta) {
    return (3.0 / (16.0 * PI)) * (1.0 + cosTheta * cosTheta);
}

float miePhase(float cosTheta, float g) {
    float g2 = g * g;
    return (3.0 / (8.0 * PI)) * ((1.0 - g2) * (1.0 + cosTheta * cosTheta))
           / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
}

// ---- Ray–sphere intersection --------------------------------
bool raySphere(vec3 ro, vec3 rd, float radius, out float t0, out float t1) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - radius * radius;
    float d = b * b - c;
    if (d < 0.0) return false;
    float sqrtD = sqrt(d);
    t0 = -b - sqrtD;
    t1 = -b + sqrtD;
    return true;
}

// ---- Density at height --------------------------------------
vec2 atmosphereDensity(vec3 p) {
    float h = max(0.0, length(p) - EARTH_RADIUS);
    return vec2(exp(-h / RAYLEIGH_HEIGHT), exp(-h / MIE_HEIGHT));
}

// ---- Optical depth along ray --------------------------------
vec2 opticalDepth(vec3 ro, vec3 rd, float tMax, int steps) {
    float dt = tMax / float(steps);
    vec2  acc = vec2(0.0);
    for (int i = 0; i < steps; i++) {
        vec3 p = ro + rd * (float(i) + 0.5) * dt;
        acc   += atmosphereDensity(p) * dt;
    }
    return acc;
}

// ---- Full single-scatter atmosphere -------------------------
// viewDir: normalized direction from camera to sky
// sunDir:  normalized direction towards sun
// altitude: viewer altitude above sea level (metres, use ~64 for Minecraft)
vec3 atmosphereScattering(vec3 viewDir, vec3 sunDir, float altitude, int steps) {
    vec3 origin = vec3(0.0, EARTH_RADIUS + altitude, 0.0);

    // Ray through atmosphere
    float t0, t1;
    if (!raySphere(origin, viewDir, ATMOS_RADIUS, t0, t1)) return vec3(0.0);
    t0 = max(t0, 0.0);
    float tMax = t1;

    float cosTheta = dot(viewDir, sunDir);
    float phaseR   = rayleighPhase(cosTheta) * RAYLEIGH_STRENGTH;
    float phaseM   = miePhase(cosTheta, MIE_G) * MIE_STRENGTH;

    float dt = tMax / float(steps);
    vec3  accR = vec3(0.0), accM = vec3(0.0);

    for (int i = 0; i < steps; i++) {
        vec3 p = origin + viewDir * (float(i) + 0.5) * dt;

        // Check if segment reaches sun
        float st0, st1;
        if (!raySphere(p, sunDir, ATMOS_RADIUS, st0, st1)) continue;
        st0 = max(st0, 0.0);

        vec2  density    = atmosphereDensity(p) * dt;
        vec2  sunDepth   = opticalDepth(p, sunDir, st1, max(steps / 2, 4));
        vec2  viewDepth  = opticalDepth(origin, viewDir,
                                        (float(i) + 0.5) * dt, max(steps / 2, 4));

        vec3 extinction  = exp(-(RAYLEIGH_BETA * (sunDepth.x + viewDepth.x)
                             + MIE_BETA   * 1.1 * (sunDepth.y + viewDepth.y)));

        accR += density.x * extinction;
        accM += density.y * extinction;
    }

    vec3 scatter = SUN_INTENSITY * (RAYLEIGH_BETA * phaseR * accR
                                  + MIE_BETA * phaseM * accM);
    return max(scatter, vec3(0.0));
}

// ---- Fast sky (cheaper, no loop) ----------------------------
// Good enough for ambient sky color without full ray march
vec3 skyColorFast(vec3 viewDir, vec3 sunDir) {
    float cosTheta = dot(viewDir, sunDir);
    float altitude = max(viewDir.y, 0.0);

    // Zenith color (deep blue) to horizon (white/orange at sunset)
    vec3 zenith  = vec3(0.05, 0.15, 0.45) * RAYLEIGH_STRENGTH;
    vec3 horizon = vec3(0.7, 0.8, 1.0);

    // Sunset tint near horizon when sun is low
    float sunElev  = sunDir.y;                          // -1 .. 1
    float sunset   = pow(max(0.0, 1.0 - sunElev * 3.0), 2.0);
    vec3  sunTint  = mix(vec3(1.0), vec3(1.2, 0.5, 0.1), sunset) * SUNSET_STRENGTH;

    vec3 sky = mix(horizon * sunTint, zenith, smoothstep(0.0, 0.3, altitude));

    // Mie glow around sun
    float mie = pow(max(cosTheta, 0.0), 8.0) * MIE_STRENGTH;
    sky += vec3(0.9, 0.5, 0.2) * mie * max(0.0, sunDir.y + 0.2) * 0.3;

    return max(sky, vec3(0.0));
}

// ---- Night sky color ----------------------------------------
vec3 nightSkyColor(vec3 viewDir, vec3 moonDir) {
    float moonGlow = pow(max(dot(viewDir, moonDir), 0.0), 32.0);
    vec3 night     = vec3(0.005, 0.01, 0.03);
    night += vec3(0.1, 0.12, 0.15) * moonGlow * 0.5;
    return night;
}

// ---- Get ambient sky irradiance (for PBR lighting) ----------
vec3 getSkyIrradiance(vec3 N, vec3 sunDir) {
    // Approximation: integrate over hemisphere
    float upDot = dot(N, vec3(0.0, 1.0, 0.0));
    vec3 dayAmb  = skyColorFast(N * 0.5 + 0.5, sunDir) * 0.7;
    return dayAmb * (0.5 + 0.5 * upDot);
}

#endif // ATMOSPHERE_GLSL
