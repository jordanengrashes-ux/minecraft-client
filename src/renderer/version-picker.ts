// Version picker — a snap-scrolling strip of Minecraft versions, each tile
// showing that update's artwork, plus the big "stage" preview above it.
//
// The hidden #mc-version <select> stays the source of truth: game.ts reads
// mcVersion.value everywhere, so picking a tile just sets the select's value
// and fires its normal 'change' event.
//
// Artwork comes from the same patch-notes feed the official launcher uses.
// It covers every release since 1.13 and every snapshot since early 2020;
// anything older gets a procedurally drawn block texture instead.

export interface PickerVersion { id: string; type: string; releaseTime?: string }

const CONTENT_HOST   = 'https://launchercontent.mojang.com';
const JAVA_FEED      = `${CONTENT_HOST}/v2/javaPatchNotes.json`;
const BEDROCK_FEED   = `${CONTENT_HOST}/v2/bedrockPatchNotes.json`;
const FEED_CACHE_KEY = 'voxel_java_patchnotes';
const FEED_MAX_AGE   = 6 * 60 * 60 * 1000;

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── Update names ──────────────────────────────────────────────────────────────
// The names Mojang gave each update / game drop, checked against the opening
// line of each release's patch notes.
const YEAR_DROPS: Record<string, string> = {
  '26.1': 'Tiny Takeover', '26.2': 'Chaos Cubed', '26.3': 'Wilderness Bound',
};
// 1.21.x was split into several drops; [first patch, name], newest first.
const DROPS_1_21: Array<[number, string]> = [
  [11, 'Mounts of Mayhem'], [9, 'The Copper Age'], [6, 'Chase the Skies'], [5, 'Spring to Life'],
  [4, 'The Garden Awakens'], [2, 'Bundles of Bravery'], [0, 'Tricky Trials'],
];
const MAJOR_UPDATES: Record<number, string> = {
  20: 'Trails & Tales', 19: 'The Wild Update', 18: 'Caves & Cliffs: Part II', 17: 'Caves & Cliffs: Part I',
  16: 'Nether Update', 15: 'Buzzy Bees', 14: 'Village & Pillage', 13: 'Update Aquatic',
  12: 'World of Color', 11: 'Exploration Update', 10: 'Frostburn Update', 9: 'Combat Update',
  8: 'Bountiful Update', 7: 'The Update that Changed the World', 6: 'Horse Update',
  5: 'Redstone Update', 4: 'Pretty Scary Update',
};

function parseVer(id: string): { a: number; b: number; c: number } | null {
  const m = id.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? { a: +m[1], b: +m[2], c: +(m[3] ?? 0) } : null;
}

function updateName(id: string): string | null {
  const v = parseVer(id);
  if (!v) return null;
  if (v.a > 1) return YEAR_DROPS[`${v.a}.${v.b}`] ?? null;
  if (v.b === 21) return DROPS_1_21.find(([from]) => v.c >= from)?.[1] ?? null;
  return MAJOR_UPDATES[v.b] ?? null;
}

// Groups for the jump chips: "26" for year-based versions, "1.21" etc. for
// classic ones, with everything before 1.8 folded into one group.
function lineKey(id: string): string | null {
  const v = parseVer(id);
  if (!v) return null;
  if (v.a > 1) return String(v.a);
  return v.b >= 8 ? `1.${v.b}` : 'classic';
}
function lineLabel(key: string): string {
  if (key === 'classic') return '1.7 & older';
  return key.includes('.') ? key : `${key}.x`;
}

// Splits "26.4-snapshot-5" into a headline ("26.4") and a tag ("Snapshot 5").
function splitId(v: PickerVersion): { main: string; tag: string | null; short: string } {
  const m = v.id.match(/^(.+?)-(snapshot-|pre|rc)(\d+)$/);
  if (m) {
    const [, base, kind, n] = m;
    const tag   = kind === 'pre' ? `Pre-release ${n}` : kind === 'rc' ? `Release Candidate ${n}` : `Snapshot ${n}`;
    const short = kind === 'pre' ? `pre ${n}` : kind === 'rc' ? `rc ${n}` : `snap ${n}`;
    return { main: base, tag, short: `${base} ${short}` };
  }
  if (/^\d+w\d+[a-z]$/.test(v.id)) return { main: v.id, tag: 'Weekly snapshot', short: v.id };
  return { main: v.id, tag: null, short: v.id };
}

function typeLabel(v: PickerVersion): string {
  if (v.type === 'release') return 'Release';
  if (/-pre\d+$/.test(v.id)) return 'Pre-release';
  if (/-rc\d+$/.test(v.id)) return 'Release candidate';
  return 'Snapshot';
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(+d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Artwork ───────────────────────────────────────────────────────────────────
const art = new Map<string, string>();

function ingestFeed(entries: Array<{ version: string; image?: { url: string } }>) {
  art.clear();
  for (const e of entries) if (e.image?.url) art.set(e.version, CONTENT_HOST + e.image.url);
}

// Exact match first; a release the feed skips (e.g. 1.14.4) borrows the art
// of the closest earlier release in its line.
function artFor(v: PickerVersion): string | null {
  const exact = art.get(v.id);
  if (exact) return exact;
  const p = parseVer(v.id);
  if (!p) return null;
  for (let c = p.c; c >= 0; c--) {
    const hit = art.get(c === 0 ? `${p.a}.${p.b}` : `${p.a}.${p.b}.${c}`);
    if (hit) return hit;
  }
  return null;
}

// Fallback art: a 16×16 block face drawn in colours from that update.
const PIXEL_PALETTES: Record<string, string[]> = {
  '12': ['#e9ecec', '#f07613', '#bd44b3', '#3aafd9', '#f8c627', '#70b919', '#ed8dac', '#3e4447',
         '#8e8e86', '#158991', '#792aac', '#35399d', '#724728', '#546d1b', '#a12722', '#141519'],
  '11': ['#3e2912', '#4f3218', '#5c3d1e', '#2a1b0b'],
  '10': ['#8f3a08', '#c75a10', '#ef8f1c', '#541a04', '#ffbb33'],
  '9':  ['#a77ba7', '#b58bb5', '#8e5f8e', '#c9a3c9'],
  '8':  ['#63a597', '#4f8f84', '#7ab8a9', '#3d7466'],
  '7':  ['#7a5a2f', '#5c3f1d', '#a96e3c', '#6b4a22'],
  '6':  ['#c9a227', '#a9851c', '#e0bd3a', '#8a6b12'],
  '5':  ['#a10f0f', '#d22b2b', '#5c0606', '#7a0a0a'],
  '4':  ['#e3901d', '#c46f11', '#f2a93b', '#7a4a0c'],
  stone: ['#7f7f7f', '#6d6d6d', '#8f8f8f', '#5f5f5f'],
};
const GRASS = ['#5b8a32', '#6fa53d', '#4b7428'];
const DIRT  = ['#79553a', '#966c4a', '#5d4128', '#6a4b30'];

function seededRandom(seedText: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seedText.length; i++) h = Math.imul(h ^ seedText.charCodeAt(i), 16777619);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

const pixelCache = new Map<string, string>();
function pixelArt(v: PickerVersion): string {
  const cached = pixelCache.get(v.id);
  if (cached) return cached;
  const p = parseVer(v.id);
  const key = v.type !== 'release' ? 'stone' : p && p.a === 1 && PIXEL_PALETTES[p.b] ? String(p.b) : 'grass';
  const rand = seededRandom(v.id);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let pal: string[];
      if (key === 'grass') pal = y < 3 || (y < 5 && rand() < 0.45) ? GRASS : DIRT;
      else if (key === '12') pal = [PIXEL_PALETTES['12'][(Math.floor(x / 8) + Math.floor(y / 8) * 2 + v.id.length * 3) % 16]];
      else pal = PIXEL_PALETTES[key];
      ctx.fillStyle = shade(pal[Math.floor(rand() * pal.length)], 0.9 + rand() * 0.2);
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const url = canvas.toDataURL();
  pixelCache.set(v.id, url);
  return url;
}

async function loadFeed(onFresh: () => void) {
  try {
    const cached = JSON.parse(localStorage.getItem(FEED_CACHE_KEY) || 'null');
    if (cached?.entries) {
      ingestFeed(cached.entries);
      if (Date.now() - cached.at < FEED_MAX_AGE) return;
    }
  } catch { /* cache unreadable — fetch below */ }
  try {
    const data = await (await fetch(JAVA_FEED)).json();
    const entries = (data.entries as any[]).map(e => ({ version: e.version, image: e.image ? { url: e.image.url } : undefined }));
    ingestFeed(entries);
    try { localStorage.setItem(FEED_CACHE_KEY, JSON.stringify({ at: Date.now(), entries })); } catch { /* storage full */ }
    onFresh();
  } catch { /* offline — tiles keep their drawn fallback */ }
}

// ── Picker ────────────────────────────────────────────────────────────────────
export function initVersionPicker(select: HTMLSelectElement) {
  const strip   = document.getElementById('ver-strip')!;
  const chips   = document.getElementById('ver-lines')!;
  const stage   = document.getElementById('stage')!;
  const layers  = Array.from(stage.querySelectorAll<HTMLElement>('.stage-layer'));
  const verEl   = document.getElementById('stage-ver')!;
  const nameEl  = document.getElementById('stage-name')!;
  const metaEl  = document.getElementById('stage-meta')!;
  const copyEl  = document.getElementById('stage-copy')!;

  let list: PickerVersion[] = [];
  let tiles: HTMLButtonElement[] = [];
  let latestId = '';
  let selectedIdx = -1;   // committed to the <select>
  let targetIdx = 0;      // where wheel/keys are heading
  let centeredIdx = -1;   // nearest the middle right now
  let stageId = '';
  let frontLayer = 0;
  let stageToken = 0;

  // Tiles load their art only when scrolled near, since a strip with
  // snapshots on holds hundreds of versions.
  const lazy = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      paintTile(e.target as HTMLButtonElement);
      lazy.unobserve(e.target);
    }
  }, { root: strip, rootMargin: '0px 900px' });

  function paintTile(tile: HTMLButtonElement) {
    const v = list[+tile.dataset.i!];
    const img = tile.querySelector('img')!;
    const src = artFor(v);
    img.src = src ?? pixelArt(v);
    img.classList.toggle('is-pixel', !src);
    tile.dataset.painted = '1';
  }

  function render(versions: PickerVersion[], latest: string) {
    list = versions;
    latestId = latest;
    lazy.disconnect();
    strip.textContent = '';
    const frag = document.createDocumentFragment();
    tiles = versions.map((v, i) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'ver-tile' + (v.type === 'release' ? '' : ' is-snapshot');
      tile.dataset.i = String(i);
      tile.tabIndex = -1;
      tile.setAttribute('role', 'option');
      tile.innerHTML = '<span class="ver-art"><img alt="" draggable="false"></span><span class="ver-id"></span>';
      tile.querySelector('.ver-id')!.textContent = splitId(v).short;
      tile.title = v.id;
      frag.appendChild(tile);
      return tile;
    });
    strip.appendChild(frag);
    tiles.forEach(t => lazy.observe(t));
    renderChips();

    const idx = Math.max(0, list.findIndex(v => v.id === select.value));
    selectedIdx = -1;
    mark(idx);
    targetIdx = idx;
    centerOn(idx, false);
    showStage(list[idx], false);
  }

  function renderChips() {
    chips.textContent = '';
    const firstOfLine = new Map<string, number>();
    list.forEach((v, i) => {
      if (v.type !== 'release') return;
      const k = lineKey(v.id);
      if (k && !firstOfLine.has(k)) firstOfLine.set(k, i);
    });
    for (const [key, i] of firstOfLine) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.line = key;
      chip.textContent = lineLabel(key);
      chip.addEventListener('click', () => { targetIdx = i; centerOn(i, true); });
      chips.appendChild(chip);
    }
  }

  function mark(idx: number) {
    if (idx === selectedIdx || !list[idx]) return;
    tiles[selectedIdx]?.classList.remove('is-selected');
    tiles[selectedIdx]?.setAttribute('aria-selected', 'false');
    selectedIdx = idx;
    tiles[idx].classList.add('is-selected');
    tiles[idx].setAttribute('aria-selected', 'true');
    const key = lineKey(list[idx].id);
    chips.querySelectorAll<HTMLElement>('.chip').forEach(c => {
      const on = c.dataset.line === key;
      c.classList.toggle('on', on);
      if (on) c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    document.querySelectorAll('[data-current-version]').forEach(el => { el.textContent = list[idx].id; });
  }

  function commit(idx: number) {
    if (!list[idx]) return;
    mark(idx);
    showStage(list[idx], true);
    if (select.value !== list[idx].id) {
      select.value = list[idx].id;
      select.dispatchEvent(new Event('change'));
    }
  }

  // Tiles are evenly spaced, so the one nearest the middle is plain arithmetic.
  function nearestIndex(): number {
    const first = tiles[0];
    if (!first) return -1;
    const pitch = tiles.length > 1 ? tiles[1].offsetLeft - first.offsetLeft : first.offsetWidth;
    const mid = strip.scrollLeft + strip.clientWidth / 2;
    const i = Math.round((mid - first.offsetLeft - first.offsetWidth / 2) / pitch);
    return Math.max(0, Math.min(tiles.length - 1, i));
  }

  function centerOn(idx: number, smooth: boolean) {
    const tile = tiles[idx];
    if (!tile) return;
    strip.scrollTo({
      left: tile.offsetLeft + tile.offsetWidth / 2 - strip.clientWidth / 2,
      behavior: smooth && !reduceMotion ? 'smooth' : 'instant',
    });
  }

  function move(delta: number) {
    targetIdx = Math.max(0, Math.min(tiles.length - 1, targetIdx + delta));
    centerOn(targetIdx, true);
  }

  // ── Stage ──
  function showStage(v: PickerVersion | undefined, animate: boolean) {
    if (!v || v.id === stageId) return;
    stageId = v.id;

    const { main, tag } = splitId(v);
    verEl.textContent = main;
    nameEl.textContent = tag ?? updateName(v.id) ?? 'Java Edition';
    metaEl.textContent = '';
    for (const part of [typeLabel(v), formatDate(v.releaseTime)]) {
      if (!part) continue;
      const s = document.createElement('span');
      s.textContent = part;
      metaEl.appendChild(s);
    }
    if (v.id === latestId) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = 'Latest';
      metaEl.appendChild(pill);
    }
    if (animate && !reduceMotion) {
      copyEl.animate(
        [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
        { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
    }

    const real = artFor(v);
    const src = real ?? pixelArt(v);
    const token = ++stageToken;
    const back = layers[frontLayer ^ 1];
    const swap = () => {
      if (token !== stageToken) return;
      back.querySelectorAll('img').forEach(img => {
        img.src = src;
        img.classList.toggle('is-pixel', !real);
      });
      back.classList.add('is-front');
      layers[frontLayer].classList.remove('is-front');
      frontLayer ^= 1;
      if (animate && !reduceMotion) {
        back.querySelector('.stage-art')?.animate(
          [{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
          { duration: 900, easing: 'cubic-bezier(.16,1,.3,1)' },
        );
      }
    };
    const pre = new Image();
    pre.src = src;
    pre.decode().then(swap, swap);
  }

  // ── Input ──
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollRaf = 0;
  strip.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const i = nearestIndex();
      if (i === centeredIdx) return;
      centeredIdx = i;
      // Preview while gliding past; the select only changes once scrolling settles.
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(() => showStage(list[i], true), 90);
    });
  }, { passive: true });

  strip.addEventListener('scrollend', () => {
    if (dragging) return;
    const i = nearestIndex();
    targetIdx = i;
    commit(i);
  });

  // A mouse wheel notch (100px in Chromium) moves exactly one version;
  // smaller trackpad deltas add up until they make a whole step.
  let wheelAcc = 0;
  let wheelReset: ReturnType<typeof setTimeout> | null = null;
  strip.addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal trackpad swipe: native
    e.preventDefault();
    wheelAcc += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 33 : e.deltaY;
    const step = 100;
    while (Math.abs(wheelAcc) >= step) {
      const dir = Math.sign(wheelAcc);
      move(dir);
      wheelAcc -= dir * step;
    }
    if (wheelReset) clearTimeout(wheelReset);
    wheelReset = setTimeout(() => { wheelAcc = 0; }, 180);
  }, { passive: false });

  strip.addEventListener('keydown', e => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -5, PageDown: 5 };
    if (e.key in steps) move(steps[e.key]);
    else if (e.key === 'Home') move(-tiles.length);
    else if (e.key === 'End') move(tiles.length);
    else return;
    e.preventDefault();
  });

  // Click-and-drag with a mouse, like flicking through a record crate.
  let dragging = false;
  let dragMoved = false;
  let dragStartX = 0;
  let dragStartScroll = 0;
  strip.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    dragging = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartScroll = strip.scrollLeft;
  });
  window.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    if (!dragMoved && Math.abs(dx) > 4) {
      dragMoved = true;
      strip.classList.add('is-dragging');
    }
    if (dragMoved) strip.scrollLeft = dragStartScroll - dx;
  });
  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    if (!dragMoved) return;
    strip.classList.remove('is-dragging');
    targetIdx = nearestIndex();
    centerOn(targetIdx, true);
  });

  strip.addEventListener('click', e => {
    if (dragMoved) { dragMoved = false; return; }
    const tile = (e.target as HTMLElement).closest<HTMLButtonElement>('.ver-tile');
    if (!tile) return;
    const i = +tile.dataset.i!;
    targetIdx = i;
    if (i === nearestIndex()) commit(i);
    else centerOn(i, true);
  });

  // Follow version changes made elsewhere (e.g. quick-join picking a server's version).
  select.addEventListener('change', () => {
    const i = list.findIndex(v => v.id === select.value);
    // A version the strip doesn't list (e.g. a snapshot while snapshots are hidden): still show it.
    if (i < 0) { showStage({ id: select.value, type: /^\d+\.\d+(\.\d+)?$/.test(select.value) ? 'release' : 'snapshot' }, true); return; }
    if (i === selectedIdx) return;
    mark(i);
    targetIdx = i;
    centerOn(i, true);
    showStage(list[i], true);
  });

  document.getElementById('ver-prev')?.addEventListener('click', () => move(-1));
  document.getElementById('ver-next')?.addEventListener('click', () => move(1));

  // Keep the chosen tile centred when the window (or the strip) resizes.
  new ResizeObserver(() => { if (!dragging && selectedIdx >= 0) centerOn(selectedIdx, false); }).observe(strip);

  loadFeed(() => {
    tiles.forEach(t => { if (t.dataset.painted) paintTile(t); });
    const v = list[selectedIdx];
    stageId = '';
    showStage(v, true);
  });

  return { render };
}

// Bedrock page header art: the latest retail release from the Bedrock feed.
export async function loadBedrockArt(stageEl: HTMLElement, caption: HTMLElement) {
  try {
    const data = await (await fetch(BEDROCK_FEED)).json();
    const entry = (data.entries as any[])
      .filter(e => e.patchNoteType === 'retail' && e.image?.url)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    if (!entry) return;
    stageEl.querySelectorAll('img').forEach(img => { img.src = CONTENT_HOST + entry.image.url; });
    stageEl.classList.add('has-art');
    // Titles are either "26.50 - Wilderness Bound" or "Minecraft: Bedrock Edition 26.60 Changelog"
    const dropName = String(entry.title).split(' - ')[1];
    caption.textContent = `Latest release: ${entry.version}${dropName ? ` · ${dropName}` : ''}`;
  } catch { /* offline — header keeps its plain background */ }
}
