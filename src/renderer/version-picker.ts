// Version picker — a scrolling strip of Minecraft versions, each tile
// showing that update's artwork, plus the big "stage" preview above it.
//
// The hidden #mc-version <select> stays the source of truth: game.ts reads
// mcVersion.value everywhere, so picking a tile just sets the select's value
// and fires its normal 'change' event.
//
// Artwork comes from the same patch-notes feed the official launcher uses;
// the stage shows a wide screenshot from that version's patch notes.
// It covers every release since 1.13 and every snapshot since early 2020;
// anything older gets a procedurally drawn block texture instead.

export interface PickerVersion { id: string; type: string; releaseTime?: string }

const CONTENT_HOST   = 'https://launchercontent.mojang.com';
const JAVA_FEED      = `${CONTENT_HOST}/v2/javaPatchNotes.json`;
const BEDROCK_FEED   = `${CONTENT_HOST}/v2/bedrockPatchNotes.json`;
const FEED_CACHE_KEY = 'voxel_java_patchnotes_v3';
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
const art = new Map<string, string>();      // version → square thumbnail (240 or 540px)
const articles = new Map<string, string>(); // version → patch-notes article path
let releaseOrder: string[] = [];            // releases in the feed, newest first

type FeedEntry = { version: string; type?: string; image?: { url: string }; contentPath?: string };
function ingestFeed(entries: FeedEntry[]) {
  art.clear();
  articles.clear();
  for (const e of entries) {
    if (e.image?.url) art.set(e.version, CONTENT_HOST + e.image.url);
    if (e.contentPath) articles.set(e.version, e.contentPath);
  }
  releaseOrder = entries.filter(e => e.type === 'release').map(e => e.version);
}

// The stage wants a wide screenshot: the thumbnails are small squares (only
// 240px before 1.20.5) and go soft when stretched across it. The patch-notes
// articles carry 1280×720 screenshots, but mostly only an update's main
// release has them; its hotfixes' notes are text. So the screenshots of a
// whole update are pooled and each release in it takes a different one:
// 1.21.9 gets The Copper Age's first screenshot, 1.21.10 its second.
const groupKey = (id: string) => { const p = parseVer(id); return p ? `${p.a}.${p.b}|${updateName(id) ?? ''}` : null; };
function cmpVer(a: string, b: string): number {
  const pa = parseVer(a)!, pb = parseVer(b)!;
  return pa.a - pb.a || pa.b - pb.b || pa.c - pb.c;
}

// The update's releases, oldest first, and this version's place among them.
function updateMembers(v: PickerVersion): { members: string[]; rank: number } {
  if (v.type !== 'release') return { members: [v.id], rank: 0 };
  const g = groupKey(v.id);
  if (!g) return { members: [v.id], rank: 0 };
  const members = [...new Set([...releaseOrder.filter(id => groupKey(id) === g), v.id])].sort(cmpVer);
  return { members, rank: members.indexOf(v.id) };
}

function articleCandidates(v: PickerVersion): string[] {
  return updateMembers(v).members.map(id => articles.get(id)).filter((p): p is string => !!p);
}

const articleImageCache = new Map<string, Promise<string[]>>();
function articleImages(path: string): Promise<string[]> {
  let p = articleImageCache.get(path);
  if (!p) {
    p = fetch(`${CONTENT_HOST}/v2/${path}`)
      .then(r => r.json())
      .then(j => [...String(j.body || '').matchAll(/<img[^>]*?src=["']?([^"'\s>]+)/g)]
        .map(m => m[1].startsWith('/') ? CONTENT_HOST + m[1] : m[1]))
      .catch(() => []);
    articleImageCache.set(path, p);
  }
  return p;
}

// Filenames don't reliably say the size, so measure. A decoded image is
// cached by the browser, so the winner shows instantly afterwards.
const wideCache = new Map<string, Promise<boolean>>();
function isWide(src: string): Promise<boolean> {
  let p = wideCache.get(src);
  if (!p) {
    const img = new Image();
    img.src = src;
    p = img.decode().then(() => img.naturalWidth >= 720 && img.naturalWidth > img.naturalHeight * 1.3, () => false);
    wideCache.set(src, p);
  }
  return p;
}

// The n-th wide screenshot across these articles (0 = the first).
async function nthWide(paths: string[], n: number): Promise<string | null> {
  let found = 0, probes = 0;
  for (const path of paths) {
    for (const src of await articleImages(path)) {
      if (/thumb|_tn\./i.test(src)) continue;
      if (probes++ >= 14) return null;
      if (await isWide(src)) { if (found === n) return src; found++; }
    }
  }
  return null;
}
const findWide = (paths: string[]) => nthWide(paths, 0);

// No two releases share a screenshot: when the update has run out of them,
// the version falls back to its own thumbnail instead.
const heroCache = new Map<string, Promise<string | null>>();
function heroFor(v: PickerVersion): Promise<string | null> {
  let p = heroCache.get(v.id);
  if (!p) {
    p = nthWide(articleCandidates(v), updateMembers(v).rank);
    heroCache.set(v.id, p);
  }
  return p;
}

// Only a version's own thumbnail. Versions Mojang made none for (1.13.1,
// 1.14.4, everything before 1.13 …) get drawn art in their update's colours
// rather than a copy of a neighbour's picture.
function artFor(v: PickerVersion): string | null {
  return art.get(v.id) ?? null;
}

// Fallback art: a 16×16 block face drawn in colours from that update.
const PIXEL_PALETTES: Record<string, string[]> = {
  '14': ['#8a6a3c', '#a6824a', '#6b4f2a', '#7d5e34'],
  '13': ['#2a7f86', '#36a3a6', '#1d5f69', '#4fc3c4'],
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
    const entries: FeedEntry[] = (data.entries as any[]).map(e => ({ version: e.version, type: e.type, image: e.image ? { url: e.image.url } : undefined, contentPath: e.contentPath }));
    ingestFeed(entries);
    try { localStorage.setItem(FEED_CACHE_KEY, JSON.stringify({ at: Date.now(), entries })); } catch { /* storage full */ }
    onFresh();
  } catch { /* offline — tiles keep their drawn fallback */ }
}

// ── Picker ────────────────────────────────────────────────────────────────────
export function initVersionPicker(select: HTMLSelectElement) {
  const strip   = document.getElementById('ver-strip')!;
  const wrap    = strip.parentElement!;
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
  let selectedIdx = -1;
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
    strip.scrollLeft = 0;
    reveal(idx, false);
    showStage(list[idx], false);
    updateEdges();
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
      chip.addEventListener('click', () => { commit(i); reveal(i, true, true); });
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

  // ── Scrolling ──
  // The strip starts at the left edge like any list; scrolling only browses,
  // and the selected tile is wherever it happens to sit.
  let scrollTarget: number | null = null;
  function scrollStripTo(left: number, smooth: boolean) {
    const max = strip.scrollWidth - strip.clientWidth;
    scrollTarget = Math.max(0, Math.min(max, left));
    strip.scrollTo({ left: scrollTarget, behavior: smooth && !reduceMotion ? 'smooth' : 'instant' });
  }

  // Scrolls just far enough to show a tile in full; `toStart` puts it at the
  // left edge instead (used by the jump chips).
  function reveal(idx: number, smooth: boolean, toStart = false) {
    const tile = tiles[idx];
    if (!tile) return;
    const pad = 44; // clear of the arrow buttons
    const left = tile.offsetLeft;
    const right = left + tile.offsetWidth;
    if (toStart || left - pad < strip.scrollLeft) scrollStripTo(left - pad, smooth);
    else if (right + pad > strip.scrollLeft + strip.clientWidth) scrollStripTo(right + pad - strip.clientWidth, smooth);
  }

  function updateEdges() {
    const max = strip.scrollWidth - strip.clientWidth;
    wrap.classList.toggle('can-left', strip.scrollLeft > 2);
    wrap.classList.toggle('can-right', strip.scrollLeft < max - 2);
  }
  let edgeRaf = 0;
  strip.addEventListener('scroll', () => {
    if (!edgeRaf) edgeRaf = requestAnimationFrame(() => { edgeRaf = 0; updateEdges(); });
  }, { passive: true });
  strip.addEventListener('scrollend', () => { scrollTarget = null; });

  // A vertical mouse wheel scrolls the strip sideways, about two tiles a notch.
  strip.addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal trackpad swipe: native
    e.preventDefault();
    const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 33 : e.deltaY;
    scrollStripTo((scrollTarget ?? strip.scrollLeft) + delta * 1.8, true);
  }, { passive: false });

  // Arrow keys move the selection itself, like any list box.
  strip.addEventListener('keydown', e => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -5, PageDown: 5 };
    let to: number;
    if (e.key in steps) to = selectedIdx + steps[e.key];
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = tiles.length - 1;
    else return;
    e.preventDefault();
    to = Math.max(0, Math.min(tiles.length - 1, to));
    commit(to);
    reveal(to, true);
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
    strip.classList.remove('is-dragging');
  });

  strip.addEventListener('click', e => {
    if (dragMoved) { dragMoved = false; return; }
    const tile = (e.target as HTMLElement).closest<HTMLButtonElement>('.ver-tile');
    if (!tile) return;
    const i = +tile.dataset.i!;
    commit(i);
    reveal(i, true);
  });

  const page = () => Math.max(120, strip.clientWidth - 160);
  document.getElementById('ver-prev')?.addEventListener('click', () => scrollStripTo(strip.scrollLeft - page(), true));
  document.getElementById('ver-next')?.addEventListener('click', () => scrollStripTo(strip.scrollLeft + page(), true));

  // Follow version changes made elsewhere (e.g. quick-join picking a server's version).
  select.addEventListener('change', () => {
    const i = list.findIndex(v => v.id === select.value);
    // A version the strip doesn't list (e.g. a snapshot while snapshots are hidden): still show it.
    if (i < 0) { showStage({ id: select.value, type: /^\d+\.\d+(\.\d+)?$/.test(select.value) ? 'release' : 'snapshot' }, true); return; }
    if (i === selectedIdx) return;
    mark(i);
    reveal(i, true);
    showStage(list[i], true);
  });

  new ResizeObserver(updateEdges).observe(strip);

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

    // Prefer a wide screenshot, full-bleed. Give it a moment to arrive so the
    // stage changes once; if it's slow, show the fallback first and swap when
    // it lands. The fallback never gets stretched: a thumbnail shows at its
    // own size as a card, and drawn block art scales up pixel-sharp.
    const token = ++stageToken;
    const thumb = artFor(v);
    const fallback = (): void => swapArt(thumb ?? pixelArt(v), thumb ? 'card' : 'pixel', token, animate);
    let shown = false;
    const showFallback = () => {
      if (shown || token !== stageToken) return;
      shown = true;
      fallback();
    };
    if (!articleCandidates(v).length) { showFallback(); return; }
    const timer = setTimeout(showFallback, 400);
    heroFor(v).then(hero => {
      if (token !== stageToken) return;
      clearTimeout(timer);
      if (!hero) { showFallback(); return; }
      swapArt(hero, 'full', token, animate && !shown);
      shown = true;
    });
  }

  function swapArt(src: string, mode: 'full' | 'card' | 'pixel', token: number, animate: boolean) {
    const back = layers[frontLayer ^ 1];
    const img = back.querySelector('img')!;
    const swap = () => {
      if (token !== stageToken) return;
      img.src = src;
      img.classList.toggle('is-pixel', mode === 'pixel');
      back.classList.toggle('is-card', mode === 'card');
      back.classList.add('is-front');
      layers[frontLayer].classList.remove('is-front');
      frontLayer ^= 1;
      if (animate && !reduceMotion) {
        img.animate(
          [{ transform: 'scale(1.05)' }, { transform: 'scale(1)' }],
          { duration: 900, easing: 'cubic-bezier(.16,1,.3,1)' },
        );
      }
    };
    const pre = new Image();
    pre.src = src;
    pre.decode().then(swap, swap);
  }

  loadFeed(() => {
    tiles.forEach(t => { if (t.dataset.painted) paintTile(t); });
    const v = list[selectedIdx];
    stageId = '';
    showStage(v, true);
  });

  return { render };
}

// Bedrock page header art: the latest retail release from the Bedrock feed,
// using a wide screenshot from its patch notes when there is one.
export async function loadBedrockArt(stageEl: HTMLElement, caption: HTMLElement) {
  try {
    const data = await (await fetch(BEDROCK_FEED)).json();
    const entry = (data.entries as any[])
      .filter(e => e.patchNoteType === 'retail' && e.image?.url)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    if (!entry) return;
    const hero = entry.contentPath ? await findWide([entry.contentPath]) : null;
    const img = stageEl.querySelector('img')!;
    img.src = hero ?? CONTENT_HOST + entry.image.url;
    await img.decode().catch(() => {});
    stageEl.classList.add('has-art');
    // Titles are either "26.50 - Wilderness Bound" or "Minecraft: Bedrock Edition 26.60 Changelog"
    const dropName = String(entry.title).split(' - ')[1];
    caption.textContent = `Latest release: ${entry.version}${dropName ? ` · ${dropName}` : ''}`;
  } catch { /* offline — header keeps its plain background */ }
}
