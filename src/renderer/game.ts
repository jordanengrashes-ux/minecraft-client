// Launcher logic — no Three.js, just UI wiring for Minecraft launch

const mc = (window as any).mc;

// ── DOM ────────────────────────────────────────────────────────────────────────
const userName      = document.getElementById('user-name')!;
const mcIgnBadge    = document.getElementById('mc-username-badge')!;
const mcIgnSpan     = document.getElementById('mc-ign')!;
const mcAuthBtn     = document.getElementById('mc-auth-btn') as HTMLButtonElement;
const mcPlayBtn     = document.getElementById('mc-play-btn') as HTMLButtonElement;
const mcVersion     = document.getElementById('mc-version') as HTMLSelectElement;
const mcMemory      = document.getElementById('mc-memory') as HTMLInputElement;
const mcMemoryVal   = document.getElementById('mc-memory-val')!;
const statusDot     = document.getElementById('status-dot')!;
const statusText    = document.getElementById('status-text')!;
const progressWrap  = document.getElementById('progress-bar-wrap')!;
const progressBar   = document.getElementById('progress-bar')!;
const logToggle     = document.getElementById('log-toggle') as HTMLButtonElement;
const logPanel      = document.getElementById('log-panel')!;

let authed = false;
let running = false;
let logVisible = false;

// ── User data from Electron ────────────────────────────────────────────────────
if ((window as any).electron) {
  (window as any).electron.onUserData((d: any) => {
    userName.textContent = d.name || 'Player';
  });
} else {
  const stored = sessionStorage.getItem('userData');
  if (stored) userName.textContent = JSON.parse(stored).name || 'Player';
}

// ── Cached MC auth (no login needed) ──────────────────────────────────────────
if (mc) {
  mc.onAlreadyAuthed((name: string) => {
    authed = true;
    mcAuthBtn.textContent = `✅  Logged in as ${name}`;
    mcAuthBtn.classList.add('authed');
    mcIgnSpan.textContent = name;
    mcIgnBadge.style.display = 'inline-block';
    mcPlayBtn.disabled = false;
    setStatus(`Authenticated as ${name}`, 'green');
  });
}

// ── Version list from Mojang ───────────────────────────────────────────────────
const snapshotsToggle = document.getElementById('snapshots-toggle') as HTMLInputElement;

type MCVersion = { id: string; type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha' };
let allVersions: MCVersion[] = [];
let latestRelease = '';

function populateVersions() {
  const showSnapshots = snapshotsToggle.checked;
  const filtered = allVersions.filter(v =>
    v.type === 'release' || (showSnapshots && v.type === 'snapshot')
  );
  const prev = mcVersion.value;
  mcVersion.innerHTML = '';
  for (const v of filtered) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.id === latestRelease
      ? `${v.id} — Latest Release`
      : v.type === 'snapshot'
        ? `${v.id} ✦ Snapshot`
        : v.id;
    mcVersion.appendChild(opt);
  }
  if (filtered.find(v => v.id === prev)) mcVersion.value = prev;
}

fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')
  .then(r => r.json())
  .then((data: { latest: { release: string }; versions: MCVersion[] }) => {
    latestRelease = data.latest.release;
    allVersions = data.versions;
    populateVersions();
  })
  .catch(() => {
    // Fallback static list if fetch fails
    allVersions = [
      { id: '1.21.5', type: 'release' }, { id: '1.21.4', type: 'release' },
      { id: '1.20.4', type: 'release' }, { id: '1.19.4', type: 'release' },
      { id: '1.18.2', type: 'release' }, { id: '1.16.5', type: 'release' },
      { id: '1.12.2', type: 'release' }, { id: '1.8.9',  type: 'release' },
    ];
    latestRelease = '1.21.5';
    populateVersions();
  });

snapshotsToggle.addEventListener('change', populateVersions);

// ── Memory slider ──────────────────────────────────────────────────────────────
mcMemory.addEventListener('input', () => {
  mcMemoryVal.textContent = mcMemory.value;
});

// ── Log panel toggle ──────────────────────────────────────────────────────────
logToggle.addEventListener('click', () => {
  logVisible = !logVisible;
  logPanel.style.display = logVisible ? 'block' : 'none';
  logToggle.textContent = logVisible ? 'Hide log ▼' : 'Show log ▲';
});

function addLog(text: string, cls = '') {
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ` ${cls}` : '');
  line.textContent = text;
  logPanel.appendChild(line);
  if (logPanel.children.length > 200) logPanel.removeChild(logPanel.firstChild!);
  logPanel.scrollTop = logPanel.scrollHeight;
}

// ── Status helpers ─────────────────────────────────────────────────────────────
function setStatus(msg: string, color: 'green' | 'yellow' | 'red' | '' = '') {
  statusDot.className = color ? `${color}` : '';
  statusText.textContent = msg;
}

function setProgress(pct: number | null) {
  if (pct === null) {
    progressWrap.style.display = 'none';
  } else {
    progressWrap.style.display = 'block';
    progressBar.style.width = `${Math.min(100, pct)}%`;
  }
}

// ── Microsoft auth ─────────────────────────────────────────────────────────────
mcAuthBtn.addEventListener('click', async () => {
  if (!mc) { setStatus('Not running in Electron', 'red'); return; }
  mcAuthBtn.disabled = true;
  setStatus('Opening Microsoft login…', 'yellow');
  const res = await mc.auth();
  mcAuthBtn.disabled = false;
  if (res.ok) {
    authed = true;
    mcAuthBtn.textContent = `✅  Logged in as ${res.username}`;
    mcAuthBtn.classList.add('authed');
    mcIgnSpan.textContent = res.username;
    mcIgnBadge.style.display = 'inline-block';
    mcPlayBtn.disabled = false;
    setStatus(`Authenticated as ${res.username}`, 'green');
  } else {
    setStatus(`Auth failed: ${res.error}`, 'red');
    addLog(`Auth error: ${res.error}`, 'error');
  }
});

// ── Launch ─────────────────────────────────────────────────────────────────────
mcPlayBtn.addEventListener('click', async () => {
  if (!mc) return;
  if (running) return;

  const version = mcVersion.value;
  const maxMem  = parseInt(mcMemory.value, 10);

  running = true;
  mcPlayBtn.disabled = true;
  mcPlayBtn.classList.add('running');
  mcPlayBtn.textContent = '⏳  Launching…';
  setStatus(`Launching Minecraft ${version}…`, 'yellow');
  setProgress(0);
  logToggle.style.display = 'inline';

  // Auto-open log so user can see output
  logVisible = true;
  logPanel.style.display = 'block';
  logToggle.textContent = 'Hide log ▼';

  addLog(`Launching Minecraft ${version} with ${maxMem}GB RAM…`);

  const res = await mc.launch({ version, maxMem });
  if (!res.ok) {
    setStatus(`Launch failed: ${res.error}`, 'red');
    addLog(`Error: ${res.error}`, 'error');
    resetPlay();
  }
});

function resetPlay() {
  running = false;
  mcPlayBtn.disabled = !authed;
  mcPlayBtn.classList.remove('running');
  mcPlayBtn.textContent = '▶  PLAY';
  setProgress(null);
}

// ── Progress events ────────────────────────────────────────────────────────────
if (mc) {
  mc.onProgress((e: any) => {
    const type  = e.type  || '';
    const task  = e.task  || 0;
    const total = e.total || 0;
    const pct   = total > 0 ? Math.round((task / total) * 100) : 0;
    const label = type === 'assets'    ? 'Downloading assets'
                : type === 'natives'   ? 'Extracting natives'
                : type === 'libraries' ? 'Downloading libraries'
                : type === 'version'   ? 'Downloading version files'
                : 'Preparing';
    setStatus(`${label}… ${pct}%`, 'yellow');
    setProgress(pct);
    if (task === total && total > 0) addLog(`✓ ${label} complete`);
  });

  const recentLines: string[] = [];

  mc.onLog((line: string) => {
    const t = line.trim();
    if (!t) return;
    recentLines.push(t);
    if (recentLines.length > 500) recentLines.shift();

    // Show all lines in log
    const isErr = t.includes('ERROR') || t.includes('Exception') || t.includes('FATAL');
    const isWarn = t.includes('WARN');
    addLog(t, isErr ? 'error' : isWarn ? 'warn' : '');

    if (t.includes('Backend library') || t.includes('Game engine started')) {
      setStatus('Minecraft is running', 'green');
      setProgress(null);
      mcPlayBtn.textContent = '🟢  Running';
    }
  });

  mc.onClosed((code: number) => {
    if (code !== 0) {
      // Auto-open log and show crash diagnosis
      logVisible = true;
      logPanel.style.display = 'block';
      logToggle.textContent = 'Hide log ▼';

      const crashLines = recentLines.slice(-80);
      const reason =
        crashLines.some(l => l.includes('OutOfMemoryError'))     ? 'Out of memory — increase RAM allocation' :
        crashLines.some(l => l.includes('Failed to verify username') || l.includes('Invalid session')) ? 'Session expired — click Microsoft Login to re-authenticate' :
        crashLines.some(l => l.includes('OpenGL') || l.includes('GLFW'))   ? 'Graphics error — update your GPU drivers' :
        crashLines.some(l => l.includes('UnsupportedClassVersionError'))    ? 'Java version too old — Minecraft needs Java 21' :
        crashLines.some(l => l.includes('FileNotFoundException') || l.includes('corrupt')) ? 'Corrupt game files — use Repair in Settings' :
        `Exit code ${code}`;

      addLog(`⚠ Crash: ${reason}`, 'error');
      setStatus(`Crashed: ${reason}`, 'red');
      // Try to surface the actual Java crash report
      if (mc.crashReport) {
        mc.crashReport().then((r: any) => {
          if (r.ok) {
            addLog(`--- Crash report: ${r.name} ---`, 'error');
            r.content.split('\n').slice(0, 60).forEach((l: string) => { if (l.trim()) addLog(l, 'error'); });
          }
        });
      }
    } else {
      setStatus('Minecraft closed', '');
    }
    resetPlay();
  });

  mc.onError((msg: string) => {
    logVisible = true;
    logPanel.style.display = 'block';
    logToggle.textContent = 'Hide log ▼';
    addLog(`Error: ${msg}`, 'error');
    setStatus(`Error: ${msg}`, 'red');
    resetPlay();
  });
}

setStatus('Ready — login with Microsoft to play');

// ── Nav switching ─────────────────────────────────────────────────────────────
const contentEl       = document.getElementById('content')!;
const modsPanelEl     = document.getElementById('mods-panel')!;
const customizePanelEl= document.getElementById('customize-panel')!;
const settingsPanelEl = document.getElementById('settings-panel')!;
const navPlay         = document.getElementById('nav-play')!;
const navMods         = document.getElementById('nav-mods')!;
const navCustomize    = document.getElementById('nav-customize')!;
const navSettings     = document.getElementById('nav-settings')!;
const allPanels       = [contentEl, modsPanelEl, customizePanelEl, settingsPanelEl];
const allNavs         = [navPlay, navMods, navCustomize, navSettings];

function showPanel(panel: HTMLElement, nav: HTMLElement) {
  allPanels.forEach(p => p.style.display = 'none');
  allNavs.forEach(n => n.classList.remove('active'));
  panel.style.display = 'flex';
  nav.classList.add('active');
}
navPlay    .addEventListener('click', () => showPanel(contentEl,        navPlay));
navMods    .addEventListener('click', () => { showPanel(modsPanelEl,    navMods);     if (!modsPanelEl.dataset.loaded) { searchModrinth(''); modsPanelEl.dataset.loaded = '1'; } });
navCustomize.addEventListener('click',() => { showPanel(customizePanelEl, navCustomize); if (!customizePanelEl.dataset.loaded) { searchTexturePacks(''); customizePanelEl.dataset.loaded = '1'; } });
navSettings.addEventListener('click', () => showPanel(settingsPanelEl,  navSettings));

// ── Repair button ─────────────────────────────────────────────────────────────
document.getElementById('repair-btn')?.addEventListener('click', async () => {
  if (!mc) return;
  const btn = document.getElementById('repair-btn') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = 'Repairing…';
  const res = await mc.repair();
  if (res.ok) {
    btn.textContent = '✓ Done — relaunch to redownload';
    setStatus('Game files cleared — press Play to redownload', 'yellow');
  } else {
    btn.textContent = 'Repair Game';
    btn.disabled = false;
    setStatus(`Repair failed: ${res.error}`, 'red');
  }
});

// ── Reauth button ──────────────────────────────────────────────────────────────
document.getElementById('mc-reauth-btn')?.addEventListener('click', async () => {
  if (!mc) return;
  authed = false;
  mcPlayBtn.disabled = true;
  mcAuthBtn.textContent = '🔐  Login with Microsoft to Play';
  mcAuthBtn.classList.remove('authed');
  mcIgnBadge.style.display = 'none';
  setStatus('Opening Microsoft login…', 'yellow');
  const res = await mc.reauth();
  if (res?.ok) {
    authed = true;
    mcAuthBtn.textContent = `✅  Logged in as ${res.username}`;
    mcAuthBtn.classList.add('authed');
    mcIgnSpan.textContent = res.username;
    mcIgnBadge.style.display = 'inline-block';
    mcPlayBtn.disabled = false;
    setStatus(`Authenticated as ${res.username}`, 'green');
  } else {
    setStatus(`Auth failed: ${res?.error || 'Unknown error'}`, 'red');
  }
});

// ── Customize: Skin ───────────────────────────────────────────────────────────
const skinCanvas   = document.getElementById('skin-canvas') as HTMLCanvasElement;
const skinStatus   = document.getElementById('skin-status')!;
const skinApplyBtn = document.getElementById('skin-apply-btn') as HTMLButtonElement;
const skinPickBtn  = document.getElementById('skin-pick-btn') as HTMLButtonElement;
let skinBase64 = '';
let skinVariant: 'classic' | 'slim' = 'classic';

function drawSkinPreview(img: HTMLImageElement) {
  const ctx = skinCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, 92, 148);
  ctx.imageSmoothingEnabled = false;
  const s = 4; // scale factor
  // Head front (8,8 -> 16,16 on skin = 8x8 px)
  ctx.drawImage(img, 8, 8, 8, 8, 14, 0, 8*s, 8*s);
  // Body front (20,20 -> 28,32)
  ctx.drawImage(img, 20, 20, 8, 12, 14, 34, 8*s, 12*s);
  // Right arm front (44,20 -> 48,32) classic=4wide slim=3wide
  const armW = skinVariant === 'slim' ? 3 : 4;
  ctx.drawImage(img, 44, 20, armW, 12, 0, 34, armW*s, 12*s);
  // Left arm front (36,52 -> 40,64) — 1.8 skin layout
  ctx.drawImage(img, 36, 52, armW, 12, 14+8*s, 34, armW*s, 12*s);
  // Right leg (4,20 -> 8,32)
  ctx.drawImage(img, 4, 20, 4, 12, 14, 34+12*s, 4*s, 12*s);
  // Left leg (20,52 -> 24,64)
  ctx.drawImage(img, 20, 52, 4, 12, 14+4*s, 34+12*s, 4*s, 12*s);
}

skinPickBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/png';
  input.onchange = () => {
    const file = input.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      skinBase64 = dataUrl.split(',')[1];
      const img = new Image();
      img.onload = () => { drawSkinPreview(img); };
      img.src = dataUrl;
      document.getElementById('skin-name')!.textContent = file.name;
      skinApplyBtn.disabled = false;
      skinApplyBtn.style.opacity = '1';
      skinStatus.textContent = 'Skin loaded — click Apply to upload';
      skinStatus.style.color = '#3fb950';
    };
    reader.readAsDataURL(file);
  };
  input.click();
});

skinApplyBtn.addEventListener('click', async () => {
  if (!mc || !skinBase64) return;
  skinApplyBtn.disabled = true;
  skinStatus.textContent = 'Uploading…';
  skinStatus.style.color = '#d29922';
  const res = await mc.uploadSkin({ base64: skinBase64, variant: skinVariant });
  if (res.ok) {
    skinStatus.textContent = '✓ Skin applied!';
    skinStatus.style.color = '#3fb950';
  } else {
    skinStatus.textContent = `Failed: ${res.error}`;
    skinStatus.style.color = '#f85149';
  }
  skinApplyBtn.disabled = false;
});

document.querySelectorAll('.model-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.model-btn').forEach(b => {
      (b as HTMLElement).style.background = '#21262d';
      (b as HTMLElement).style.borderColor = '#30363d';
      (b as HTMLElement).style.color = '#8b949e';
    });
    const el = btn as HTMLElement;
    el.style.background = '#238636';
    el.style.borderColor = '#3fb950';
    el.style.color = '#fff';
    skinVariant = (el.dataset.model as 'classic' | 'slim') || 'classic';
  });
});

// ── Customize: Texture Packs ───────────────────────────────────────────────────
const tpList    = document.getElementById('tp-list')!;
const tpLoading = document.getElementById('tp-loading')!;
const tpSearch  = document.getElementById('tp-search') as HTMLInputElement;
let tpTimer: ReturnType<typeof setTimeout> | null = null;

async function searchTexturePacks(query: string) {
  tpLoading.style.display = 'flex';
  tpList.innerHTML = '';
  try {
    const facets = JSON.stringify([['project_type:resourcepack']]);
    const params = new URLSearchParams({ query, facets, limit: '30', index: query ? 'relevance' : 'downloads' });
    const res  = await fetch(`https://api.modrinth.com/v2/search?${params}`);
    const data = await res.json() as { hits: ModrinthHit[] };
    tpLoading.style.display = 'none';
    if (!data.hits.length) { tpList.innerHTML = '<p style="color:#484f58;text-align:center;padding:16px">No results</p>'; return; }
    data.hits.forEach(h => {
      const row = document.createElement('div');
      row.className = 'mod-card';
      const icon = h.icon_url ? `<img src="${h.icon_url}" class="mod-icon-img" alt="">` : `<div class="mod-icon">🎨</div>`;
      row.innerHTML = `${icon}
        <div class="mod-info">
          <div class="mod-name">${h.title}</div>
          <div class="mod-desc">${h.description}</div>
          <div class="mod-tags"><span class="mod-tag util">Resource Pack</span><span class="mod-tag" style="margin-left:auto">⬇ ${fmtDownloads(h.downloads)}</span></div>
        </div>
        <div class="mod-right">
          <a href="https://modrinth.com/resourcepack/${h.project_id}" target="_blank"
            style="padding:7px 14px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:12px;text-decoration:none;white-space:nowrap;">View →</a>
        </div>`;
      tpList.appendChild(row);
    });
  } catch {
    tpLoading.style.display = 'none';
    tpList.innerHTML = '<p style="color:#f85149;text-align:center;padding:16px">Could not reach Modrinth</p>';
  }
}

tpSearch.addEventListener('input', () => {
  if (tpTimer) clearTimeout(tpTimer);
  tpTimer = setTimeout(() => searchTexturePacks(tpSearch.value.trim()), 400);
});

// ── Modrinth mod search ────────────────────────────────────────────────────────
const enabledMods = new Set<string>();
const modsList    = document.getElementById('mods-list')!;
const modsSearch  = document.getElementById('mods-search') as HTMLInputElement;
const modsLoading = document.getElementById('mods-loading')!;
let searchTimer: ReturnType<typeof setTimeout> | null = null;

interface ModrinthHit {
  project_id: string;
  title: string;
  description: string;
  icon_url: string | null;
  downloads: number;
  categories: string[];
}

function fmtDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function buildModCard(mod: ModrinthHit): HTMLElement {
  const on   = enabledMods.has(mod.project_id);
  const card = document.createElement('div');
  card.className = 'mod-card' + (on ? ' enabled' : '');

  const iconHtml = mod.icon_url
    ? `<img src="${mod.icon_url}" class="mod-icon-img" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'mod-icon',textContent:'🧩'}))">`
    : `<div class="mod-icon">🧩</div>`;

  const tagHtml = mod.categories.slice(0, 3).map(cat => {
    const cls = ['optimization','performance'].includes(cat) ? 'perf'
              : ['shader','decoration','magic'].includes(cat) ? 'visual' : 'util';
    return `<span class="mod-tag ${cls}">${cat}</span>`;
  }).join('') + `<span class="mod-tag" style="margin-left:auto">⬇ ${fmtDownloads(mod.downloads)}</span>`;

  card.innerHTML = `
    ${iconHtml}
    <div class="mod-info">
      <div class="mod-name">${mod.title}</div>
      <div class="mod-desc">${mod.description}</div>
      <div class="mod-tags">${tagHtml}</div>
    </div>
    <div class="mod-right">
      <label class="toggle">
        <input type="checkbox" ${on ? 'checked' : ''} />
        <span class="toggle-slider"></span>
      </label>
    </div>`;

  card.querySelector('input')!.addEventListener('change', e => {
    const checked = (e.target as HTMLInputElement).checked;
    if (checked) enabledMods.add(mod.project_id); else enabledMods.delete(mod.project_id);
    card.className = 'mod-card' + (checked ? ' enabled' : '');
  });
  return card;
}

async function searchModrinth(query: string) {
  modsLoading.style.display = 'flex';
  modsList.innerHTML = '';
  try {
    const facets = JSON.stringify([
      ['project_type:mod'],
      ['client_side:required', 'client_side:optional'],
    ]);
    const params = new URLSearchParams({
      query, facets, limit: '50',
      index: query ? 'relevance' : 'downloads',
    });
    const res  = await fetch(`https://api.modrinth.com/v2/search?${params}`);
    const data = await res.json() as { hits: ModrinthHit[] };
    modsLoading.style.display = 'none';
    if (!data.hits.length) {
      modsList.innerHTML = '<p style="color:#484f58;padding:20px;text-align:center">No mods found</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    data.hits.forEach(h => frag.appendChild(buildModCard(h)));
    modsList.appendChild(frag);
  } catch {
    modsLoading.style.display = 'none';
    modsList.innerHTML = '<p style="color:#f85149;padding:20px;text-align:center">Could not reach Modrinth — check your connection</p>';
  }
}

modsSearch.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchModrinth(modsSearch.value.trim()), 400);
});

// ── Auto-updater UI ────────────────────────────────────────────────────────────
const updater = (window as any).updater;
if (updater) {
  const banner        = document.getElementById('update-banner')!;
  const updateText    = document.getElementById('update-text')!;
  const progressWrap2 = document.getElementById('update-progress-wrap')!;
  const progressBar2  = document.getElementById('update-progress-bar')!;
  const installBtn    = document.getElementById('update-install-btn')!;
  const checkBtn      = document.getElementById('check-updates-btn') as HTMLButtonElement | null;

  updater.onChecking(() => {
    if (checkBtn) { checkBtn.textContent = 'Checking…'; checkBtn.disabled = true; }
  });
  updater.onNotAvailable(() => {
    if (checkBtn) { checkBtn.textContent = 'Up to date'; setTimeout(() => { checkBtn.textContent = 'Check for Updates'; checkBtn.disabled = false; }, 2500); }
  });
  updater.onAvailable((ver: string) => {
    banner.style.display = 'flex';
    updateText.textContent = `⬇ Update v${ver} downloading…`;
    progressWrap2.style.display = 'block';
    if (checkBtn) { checkBtn.textContent = 'Downloading…'; checkBtn.disabled = true; }
  });
  updater.onProgress((pct: number) => {
    progressBar2.style.width = `${pct}%`;
    updateText.textContent = `⬇ Downloading update… ${pct}%`;
  });
  updater.onDownloaded(() => {
    progressWrap2.style.display = 'none';
    updateText.textContent = '✅ Update ready — restart to apply';
    installBtn.style.display = 'inline-block';
    if (checkBtn) { checkBtn.textContent = 'Restart & Update'; checkBtn.disabled = false; checkBtn.onclick = () => updater.install(); }
  });

  installBtn.addEventListener('click', () => updater.install());
  checkBtn?.addEventListener('click', () => updater.check());
}
