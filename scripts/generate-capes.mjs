// Generates the Voxel Client cape textures.
//
//   node scripts/generate-capes.mjs
//
// Writes one PNG per cape to src/renderer/assets/capes/, plus capes.json with
// each cape's frame count and frame time. The launcher's 3D preview reads
// these, and the Fabric mod can bundle the same files so a cape looks the same
// in the launcher and in-game.
//
// Layout: Minecraft's standard 64×32 cape texture at 2× (128×64 per frame).
// Animated capes stack their frames vertically (128 × 64·frames), the same way
// Minecraft's own animated textures do. Regions, in 2× pixels:
//   outside (seen from behind the player)  x 2..22,  y 2..34
//   lining  (faces the player's back)      x 24..44, y 2..34
//   edges   top 2..22 / bottom 22..42 at y 0..2, sides x 0..2 and 22..24
//   elytra  x 44..92, y 0..44 (the mod also uses this texture for elytra)
//
// Each frame is painted as a stack of layers: cloth (gradient + weave),
// pattern, fold shading, trim, emblem, and an optional animated effect.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const W = 128, H = 64;
const FRONT = { x: 2, y: 2, w: 20, h: 32 };
const LINING = { x: 24, y: 2, w: 20, h: 32 };
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'assets', 'capes');

// ── Colour + noise helpers ─────────────────────────────────────────────────
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const scale = (c, f) => c.map(v => Math.max(0, Math.min(255, Math.round(v * f))));
// Integer hash (murmur3 finaliser) — no diagonal streaks in scattered detail.
function hash(x, y, s) {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y + 0x9e37, 0x165667b1) ^ Math.imul(s + 7, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class Frame {
  constructor() { this.px = new Uint8Array(W * H * 4); }
  set(x, y, c, a = 255) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    if (a >= 255) { this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2]; this.px[i + 3] = 255; return; }
    const t = a / 255;
    for (let k = 0; k < 3; k++) this.px[i + k] = Math.round(this.px[i + k] * (1 - t) + c[k] * t);
    this.px[i + 3] = 255;
  }
  get(x, y) { const i = (y * W + x) * 4; return [this.px[i], this.px[i + 1], this.px[i + 2]]; }
  tint(x, y, f) { this.set(x, y, scale(this.get(x, y), f)); }
}

// Runs fn(u, v) over the outside face, u/v being face-local pixel coords.
function eachFront(fn) {
  for (let v = 0; v < FRONT.h; v++) for (let u = 0; u < FRONT.w; u++) fn(u, v, FRONT.x + u, FRONT.y + v);
}

// ── Layers ─────────────────────────────────────────────────────────────────
// Cloth: top→bottom gradient with a 2px weave so it reads as fabric, painted
// over the whole texture (edges and elytra included), the lining darker.
function cloth(f, d) {
  const top = hex(d.top), bot = hex(d.bottom), seed = d.seed;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = Math.min(1, Math.max(0, (y - 2) / 32));
      let c = mix(top, bot, v);
      const weave = ((x >> 0) + (y >> 0)) % 2 === 0 ? 1.03 : 0.97;
      c = scale(c, weave * (0.95 + hash(x, y, seed) * 0.1));
      f.set(x, y, c);
    }
  }
  const lining = hex(d.lining);
  for (let v = 0; v < LINING.h; v++) for (let u = 0; u < LINING.w; u++) {
    f.set(LINING.x + u, LINING.y + v, scale(lining, 0.92 + hash(u, v, seed + 9) * 0.12));
  }
}

// Folds: soft vertical light/dark bands, darker toward the hem.
function folds(f) {
  eachFront((u, v, x, y) => {
    const band = Math.sin((u + 0.5) / FRONT.w * Math.PI * 3) * 0.06;
    const hem = v > 26 ? -0.05 * (v - 26) / 6 : 0;
    f.tint(x, y, 1 + band + hem);
  });
}

// Trim: a border around the outside face with stitch marks, and coloured edges.
function trim(f, d) {
  const t = hex(d.trim), stitch = scale(t, 1.35);
  eachFront((u, v, x, y) => {
    const edge = u === 0 || u === FRONT.w - 1 || v === FRONT.h - 1 || v === 0;
    if (edge) f.set(x, y, scale(t, 0.9 + hash(x, y, d.seed + 3) * 0.15));
    else if ((u === 1 || u === FRONT.w - 2) && v % 3 === 1) f.set(x, y, stitch, 150);
  });
  for (let x = 0; x < W; x++) for (let y = 0; y < 2; y++) if (x < 44) f.set(x, y, scale(t, 0.85));
  for (let y = 2; y < 34; y++) for (const x of [0, 1, 22, 23]) f.set(x, y, scale(t, 0.8));
}

// Emblems are small pixel drawings: rows of characters mapped to colours.
function emblem(f, d, rows, palette, top = 8) {
  const w = rows[0].length, left = FRONT.x + Math.floor((FRONT.w - w) / 2);
  rows.forEach((row, j) => [...row].forEach((ch, i) => {
    if (ch !== '.' && palette[ch]) f.set(left + i, FRONT.y + top + j, hex(palette[ch]));
  }));
}

// ── Designs ────────────────────────────────────────────────────────────────
const designs = {
  voxel_green: {
    top: '#24704a', bottom: '#103a24', lining: '#0c2a1a', trim: '#d98f17', seed: 11,
    paint(f) {
      // faint diagonal pinstripes
      eachFront((u, v, x, y) => { if ((u + v) % 6 === 0) f.tint(x, y, 1.1); });
      // the Voxel cube mark
      emblem(f, this, [
        '....aa....',
        '..aaaaaa..',
        'aaaaaaaaaa',
        'bbaaaaaacc',
        'bbbbaacccc',
        'bbbbbccccc',
        'bbbbbccccc',
        'bbbbbccccc',
        '..bbbccc..',
        '....bc....',
      ], { a: '#ffc35a', b: '#f5a623', c: '#a8680b' }, 8);
    },
  },
  midnight: {
    top: '#22376b', bottom: '#0c1430', lining: '#0a1024', trim: '#9fb4d9', seed: 23,
    paint(f) {
      eachFront((u, v, x, y) => {
        const r = hash(u, v, 23);
        if (r > 0.965) f.set(x, y, hex('#dbe7ff'));
        else if (r > 0.93) f.set(x, y, hex('#7f97c9'));
      });
      emblem(f, this, [
        '...aaa..',
        '..aa....',
        '.aa.....',
        '.aa.....',
        '.aa.....',
        '..aa....',
        '...aaa..',
      ], { a: '#f3e7b6' }, 7);
    },
  },
  crimson: {
    top: '#9a1f1f', bottom: '#470909', lining: '#2f0606', trim: '#e2b33f', seed: 37,
    paint(f) {
      // diamond lattice
      eachFront((u, v, x, y) => { if ((u + v) % 8 === 0 || (u - v + 64) % 8 === 0) f.tint(x, y, 0.78); });
      emblem(f, this, [
        'a..a..a',
        'aa.a.aa',
        'aaaaaaa',
        'abbbbba',
        'aaaaaaa',
      ], { a: '#e2b33f', b: '#ff6b4a' }, 8);
    },
  },
  amethyst: {
    top: '#6a35b8', bottom: '#2c1158', lining: '#1f0b40', trim: '#c9a6ff', seed: 41, frames: 8, frametime: 3,
    paint(f) {
      // crystal facets
      eachFront((u, v, x, y) => {
        const k = (Math.floor(u / 5) * 7 + Math.floor((v + (u % 5)) / 6) * 3) % 4;
        f.tint(x, y, [1.12, 0.94, 1.03, 0.86][k]);
      });
      emblem(f, this, [
        '..a..',
        '.aba.',
        'abcba',
        '.aba.',
        '..a..',
      ], { a: '#b48cff', b: '#e1ccff', c: '#ffffff' }, 10);
    },
    animate(f, i) {
      // sparkles that blink in and out
      for (let n = 0; n < 7; n++) {
        const u = Math.floor(hash(n, 1, 41) * (FRONT.w - 4)) + 2;
        const v = Math.floor(hash(n, 2, 41) * (FRONT.h - 4)) + 2;
        const phase = (i + n * 3) % 8;
        const x = FRONT.x + u, y = FRONT.y + v;
        if (phase === 0 || phase === 2) f.set(x, y, hex('#e9dbff'));
        if (phase === 1) { f.set(x, y, hex('#ffffff')); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) f.set(x + dx, y + dy, hex('#d4bcff'), 200); }
      }
    },
  },
  golden: {
    top: '#e9b431', bottom: '#8a5a08', lining: '#5a3a04', trim: '#fff0b0', seed: 53, frames: 12, frametime: 2,
    paint(f) {
      // engraved chevrons
      eachFront((u, v, x, y) => { if ((v + Math.abs(u - 9.5) | 0) % 7 === 0) f.tint(x, y, 0.82); });
      emblem(f, this, [
        '..a.a.a..',
        '...aaa...',
        'a.abbba.a',
        '.abbbbba.',
        'a.abbba.a',
        '...aaa...',
        '..a.a.a..',
      ], { a: '#fff3c4', b: '#ffd25a' }, 8);
    },
    animate(f, i) {
      // a diagonal shine sweeping across, then a pause
      const pos = i * 5 - 12;
      eachFront((u, v, x, y) => {
        const dist = Math.abs(u + v * 0.5 - pos);
        if (dist < 1.5) f.set(x, y, hex('#fffbe6'), 210);
        else if (dist < 3) f.tint(x, y, 1.18);
      });
    },
  },
  nether: {
    top: '#4a0f08', bottom: '#2a0703', lining: '#1c0402', trim: '#2a1838', seed: 67, frames: 8, frametime: 3,
    paint(f) {
      // netherrack speckle
      eachFront((u, v, x, y) => { const r = hash(u, v, 67); if (r > 0.8) f.tint(x, y, 1.25); else if (r < 0.15) f.tint(x, y, 0.75); });
      // obsidian trim gets crying-obsidian purple flecks
      eachFront((u, v, x, y) => {
        const edge = u === 0 || u === FRONT.w - 1 || v === FRONT.h - 1 || v === 0;
        if (edge && hash(u, v, 5) > 0.7) f.set(x, y, hex('#8a3cff'));
      });
    },
    animate(f, i) {
      // two lava rivers flowing down the cape
      const lava = [hex('#ff4a00'), hex('#ff7a00'), hex('#ffb000'), hex('#ffd65a')];
      eachFront((u, v, x, y) => {
        if (u === 0 || u === FRONT.w - 1 || v === 0 || v === FRONT.h - 1) return;
        for (const base of [5, 14]) {
          const centre = base + Math.sin((v + i * 4) / 32 * Math.PI * 2) * 2;
          const d = Math.abs(u - centre);
          if (d < 1.6) {
            const k = Math.floor(((v - i * 4) % 16 + 16) % 16 / 4);
            f.set(x, y, d < 0.6 ? lava[3 - (k % 2)] : lava[k % 3]);
          } else if (d < 2.4) f.set(x, y, hex('#c42a00'), 140);
        }
      });
    },
  },
  ocean: {
    top: '#1f7f9c', bottom: '#0a3144', lining: '#07222f', trim: '#bfeaf5', seed: 79, frames: 8, frametime: 3,
    paint(f) {
      emblem(f, this, [
        '..a.a.a..',
        '..a.a.a..',
        '..aaaaa..',
        '....a....',
        '....a....',
        '....a....',
      ], { a: '#e6fbff' }, 6);
    },
    animate(f, i) {
      // rolling wave crests moving down toward the hem
      eachFront((u, v, x, y) => {
        if (u === 0 || u === FRONT.w - 1 || v === FRONT.h - 1 || v < 14) return;
        const crest = (v - 14 - i) % 8;
        const wave = Math.round(Math.sin((u + i * 2) / FRONT.w * Math.PI * 4) * 1.2);
        if ((crest + 8 + wave) % 8 === 0) f.set(x, y, hex('#9fe6f5'));
        else if ((crest + 8 + wave) % 8 === 1) f.set(x, y, hex('#4fb3cf'), 170);
      });
    },
  },
  void: {
    top: '#0b0920', bottom: '#030208', lining: '#040310', trim: '#7c4dff', seed: 97, frames: 8, frametime: 3,
    paint(f) {
      // a purple nebula drifting through the dark
      eachFront((u, v, x, y) => {
        const n = Math.sin(u * 0.45 + v * 0.22) + Math.sin(v * 0.31 - u * 0.17) + hash(u, v, 97) * 0.6;
        if (n > 1.25) f.set(x, y, hex('#3b1f86'), 170);
        else if (n > 0.9) f.set(x, y, hex('#231354'), 150);
      });
      emblem(f, this, [
        '..aaaa..',
        '.abbbba.',
        'abbccbba',
        'abbccbba',
        '.abbbba.',
        '..aaaa..',
      ], { a: '#1a8f6e', b: '#2fd1a0', c: '#062018' }, 10);
    },
    animate(f, i) {
      for (let n = 0; n < 16; n++) {
        const u = Math.floor(hash(n, 3, 97) * (FRONT.w - 2)) + 1;
        const v = Math.floor(hash(n, 4, 97) * (FRONT.h - 2)) + 1;
        const b = (i + n * 5) % 8;
        const x = FRONT.x + u, y = FRONT.y + v;
        if (b < 2) f.set(x, y, hex('#ffffff'));
        else if (b < 4) f.set(x, y, hex('#b9a3ff'), 200);
      }
    },
  },
};

// ── PNG encoding (8-bit RGBA, no dependencies) ─────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Build ──────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true });
const meta = {};
for (const [id, d] of Object.entries(designs)) {
  const frames = d.frames ?? 1;
  const sheet = Buffer.alloc(W * H * 4 * frames);
  for (let i = 0; i < frames; i++) {
    const f = new Frame();
    cloth(f, d);
    d.paint.call(d, f); // pattern, then emblem
    folds(f);
    trim(f, d);
    d.animate?.(f, i);
    Buffer.from(f.px).copy(sheet, i * W * H * 4);
  }
  fs.writeFileSync(path.join(OUT_DIR, `${id}.png`), encodePng(W, H * frames, sheet));
  meta[id] = { frames, frametime: d.frametime ?? 1, width: W, height: H };
  console.log(`${id.padEnd(12)} ${frames} frame${frames > 1 ? 's' : ''}`);
}
fs.writeFileSync(path.join(OUT_DIR, 'capes.json'), JSON.stringify(meta, null, 2) + '\n');
