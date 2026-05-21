// Launcher logic — no Three.js, just UI wiring for Minecraft launch

import { ref, set, onValue, serverTimestamp, onDisconnect, update, get, increment } from 'firebase/database';
import { rtdb } from './firebase';

// ── Animated gradient background ──────────────────────────────────────────────
{
  const bgCanvas = document.getElementById('bg-canvas') as HTMLCanvasElement;
  const bgCtx = bgCanvas.getContext('2d')!;
  const resize = () => { bgCanvas.width = window.innerWidth; bgCanvas.height = window.innerHeight; };
  resize();
  window.addEventListener('resize', resize);

  // Slowly drifting color blobs: [cx, cy, vx, vy, radius-fraction, r, g, b]
  const blobs: [number, number, number, number, number, number, number, number][] = [
    [0.15, 0.20, 0.00022, 0.00014, 0.72,  68, 10, 130],  // deep purple
    [0.82, 0.65, -0.00017, -0.00021, 0.60, 10, 40, 100],  // deep blue
    [0.45, 0.88, 0.00019, -0.00013, 0.55,  10, 50, 32],   // deep green
    [0.25, 0.70, -0.00013, 0.00017, 0.45,  40, 10, 90],   // violet
    [0.70, 0.20, 0.00015, 0.00020, 0.50,   8, 55, 80],    // teal
  ];

  function bgAnimate() {
    const w = bgCanvas.width, h = bgCanvas.height;
    bgCtx.fillStyle = '#080c14';
    bgCtx.fillRect(0, 0, w, h);
    for (const b of blobs) {
      b[0] += b[2]; b[1] += b[3];
      if (b[0] < 0 || b[0] > 1) b[2] *= -1;
      if (b[1] < 0 || b[1] > 1) b[3] *= -1;
      const cx = b[0] * w, cy = b[1] * h, r = b[4] * Math.min(w, h);
      const g = bgCtx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(${b[5]},${b[6]},${b[7]},0.80)`);
      g.addColorStop(1, `rgba(${b[5]},${b[6]},${b[7]},0)`);
      bgCtx.fillStyle = g;
      bgCtx.fillRect(0, 0, w, h);
    }
    requestAnimationFrame(bgAnimate);
  }
  bgAnimate();
}

const mc     = (window as any).mc;
const server = (window as any).server;

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
const logCopy       = document.getElementById('log-copy') as HTMLButtonElement;
const logPanel      = document.getElementById('log-panel')!;
const logBody       = document.getElementById('log-body')!;
const logClose      = document.getElementById('log-close') as HTMLButtonElement;
const fabricToggle      = document.getElementById('fabric-toggle') as HTMLInputElement;
const fabricStatus      = document.getElementById('fabric-status')!;
const mcForceQuitBtn    = document.getElementById('mc-force-quit-btn') as HTMLButtonElement;

let authed = false;
let running = false;
let logVisible = false;
const recentLines: string[] = [];

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
    if (myUid) registerUserIndex(myUid, name);
  });
}

// ── Version list from Mojang ───────────────────────────────────────────────────
const snapshotsToggle = document.getElementById('snapshots-toggle') as HTMLInputElement;

type MCVersion = { id: string; type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha' };
let allVersions: MCVersion[] = [];
let latestRelease = '';

// Returns true for versions that work with Java 21.
// Old scheme: 1.17+ — new year-based scheme: 26.x.x and above.
function isJava21Compatible(id: string): boolean {
  const m = id.match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const major = parseInt(m[1]);
  if (major !== 1) return major > 1; // year-based versioning (26.x.x …)
  return parseInt(m[2]) >= 17;       // classic 1.x — need 1.17+
}

function populateVersions() {
  const showSnapshots = snapshotsToggle.checked;
  const filtered = allVersions.filter(v =>
    (v.type === 'release' && isJava21Compatible(v.id)) ||
    (showSnapshots && v.type === 'snapshot' && isJava21Compatible(v.id))
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
    allVersions = [
      { id: '26.1.2', type: 'release' }, { id: '26.1.1', type: 'release' },
      { id: '26.1',   type: 'release' }, { id: '1.21.11', type: 'release' },
      { id: '1.21.5', type: 'release' }, { id: '1.21.4',  type: 'release' },
      { id: '1.20.4', type: 'release' }, { id: '1.19.4',  type: 'release' },
      { id: '1.18.2', type: 'release' }, { id: '1.17.1',  type: 'release' },
    ];
    latestRelease = '26.1.2';
    populateVersions();
  });

snapshotsToggle.addEventListener('change', populateVersions);

// ── Memory slider ──────────────────────────────────────────────────────────────
mcMemory.addEventListener('input', () => {
  mcMemoryVal.textContent = mcMemory.value;
});

// ── Log panel open/close ──────────────────────────────────────────────────────
function openLog() {
  logVisible = true;
  logPanel.style.display = 'flex';
  logToggle.textContent = 'Hide log ▼';
}
function closeLog() {
  logVisible = false;
  logPanel.style.display = 'none';
  logToggle.textContent = 'Show log ▲';
}

logToggle.addEventListener('click', () => { logVisible ? closeLog() : openLog(); });
logClose.addEventListener('click', closeLog);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && logVisible) closeLog(); });

// Use Electron's native clipboard — navigator.clipboard needs a permission grant that Electron doesn't set
function copyToClipboard(text: string, btn: HTMLButtonElement) {
  (window as any).electron?.copyText(text);
  const orig = btn.textContent;
  btn.textContent = '✓ Copied!';
  btn.style.color = '#3fb950';
  setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1500);
}

logCopy?.addEventListener('click', () => copyToClipboard(recentLines.join('\n'), logCopy));

// Lines too noisy to show by default (routine JVM/MC startup spam)
const LOG_NOISE = /^\[.*\] \[.*\/(FINE|FINER|FINEST|TRACE|DEBUG)\]|^(SLF4J|OpenAL|OpenGL|LWJGL|Netty|Minecraft Realms|Narrator)/;

function addLog(text: string, cls = '') {
  const t = text.trim();
  if (!t) return;
  if (!cls && LOG_NOISE.test(t)) return; // suppress noisy lines unless it's a warning/error
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ` ${cls}` : '');
  line.textContent = t;
  logBody.appendChild(line);
  if (logBody.children.length > 300) logBody.removeChild(logBody.firstChild!);
  logBody.scrollTop = logBody.scrollHeight;
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

// ── Offline mode toggle ───────────────────────────────────────────────────────
const offlineToggle   = document.getElementById('offline-toggle') as HTMLInputElement;
const offlineNameRow  = document.getElementById('offline-name-row')!;
const offlineUsername = document.getElementById('offline-username') as HTMLInputElement;

offlineToggle.addEventListener('change', () => {
  const on = offlineToggle.checked;
  offlineNameRow.style.display = on ? 'block' : 'none';
  mcAuthBtn.style.display      = on ? 'none'  : 'block';
  if (on) {
    mcPlayBtn.disabled = false;
    setStatus('Offline mode — only LAN/offline servers work', 'yellow');
  } else {
    mcPlayBtn.disabled = !authed;
    setStatus(authed ? `Authenticated as ${mcIgnSpan.textContent}` : 'Ready', authed ? 'green' : '');
  }
});

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
    if (myUid) registerUserIndex(myUid, res.username);
  } else {
    setStatus(`Auth failed: ${res.error}`, 'red');
    addLog(`Auth error: ${res.error}`, 'error');
  }
});

// ── Launch ─────────────────────────────────────────────────────────────────────
mcPlayBtn.addEventListener('click', async () => {
  if (!mc) return;
  if (running) return;

  let version = mcVersion.value;
  const maxMem = parseInt(mcMemory.value, 10);

  running = true;
  mcPlayBtn.disabled = true;
  mcPlayBtn.classList.add('running');
  mcPlayBtn.textContent = '⏳  Launching…';
  mcForceQuitBtn.style.display = 'inline-flex';
  setStatus(`Launching Minecraft ${version}…`, 'yellow');
  setProgress(0);
  logToggle.style.display = 'inline';
  openLog();

  // Install Fabric if toggled on
  if (fabricToggle.checked) {
    fabricStatus.textContent = 'Installing Fabric…';
    fabricStatus.style.color = '#a371f7';
    const fab = await mc.installFabric({ mcVersion: version });
    if (fab.ok) {
      version = fab.fabricVersion; // launch with fabric version id
      fabricStatus.textContent = `✅ Fabric ${fab.loaderVersion}`;
      fabricStatus.style.color = '#3fb950';
    } else {
      fabricStatus.textContent = `⚠ Fabric install failed — launching vanilla`;
      fabricStatus.style.color = '#d29922';
    }
  }

  addLog(`Launching Minecraft ${version} with ${maxMem}GB RAM…`);

  const res = offlineToggle.checked
    ? await mc.launchOffline({ version, maxMem, username: offlineUsername.value.trim() || 'Player' })
    : await mc.launch({ version, maxMem });
  if (!res.ok) {
    setStatus(`Launch failed: ${res.error}`, 'red');
    addLog(`Error: ${res.error}`, 'error');
    resetPlay();
  }
});

mcForceQuitBtn.addEventListener('click', async () => {
  mcForceQuitBtn.disabled = true;
  mcForceQuitBtn.textContent = '⏳ Killing…';
  await mc.kill();
  mcForceQuitBtn.disabled = false;
  mcForceQuitBtn.textContent = '⏹ Force Quit';
});

function resetPlay() {
  running = false;
  mcPlayBtn.disabled = false;
  mcPlayBtn.classList.remove('running');
  mcPlayBtn.textContent = '▶  PLAY';
  mcForceQuitBtn.style.display = 'none';
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
      openLog();

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
    openLog();
    addLog(`Error: ${msg}`, 'error');
    setStatus(`Error: ${msg}`, 'red');
    resetPlay();
  });
}

setStatus('Ready — login with Microsoft to play');

// ── Nav switching ─────────────────────────────────────────────────────────────
const contentEl         = document.getElementById('content')!;
const bedrockPanelEl    = document.getElementById('bedrock-panel')!;
const modsPanelEl       = document.getElementById('mods-panel')!;
const pvpPanelEl        = document.getElementById('pvp-panel')!;
const bedrockModsPanelEl= document.getElementById('bedrock-mods-panel')!;
const customizePanelEl  = document.getElementById('customize-panel')!;
const settingsPanelEl   = document.getElementById('settings-panel')!;
const navPlay           = document.getElementById('nav-play')!;
const navBedrock        = document.getElementById('nav-bedrock')!;
const navMods           = document.getElementById('nav-mods')!;
const navPvp            = document.getElementById('nav-pvp')!;
const navBedrockMods    = document.getElementById('nav-bedrock-mods')!;
const navCustomize      = document.getElementById('nav-customize')!;
const navSettings       = document.getElementById('nav-settings')!;
const navServer         = document.getElementById('nav-server')!;
const navCosmetics      = document.getElementById('nav-cosmetics')!;
const navFriends        = document.getElementById('nav-friends')!;
const serverPanelEl     = document.getElementById('server-panel')!;
const cosmeticsPanelEl  = document.getElementById('cosmetics-panel')!;
const friendsPanelEl    = document.getElementById('friends-panel')!;
const allPanels = [contentEl, bedrockPanelEl, modsPanelEl, pvpPanelEl, bedrockModsPanelEl, serverPanelEl, cosmeticsPanelEl, friendsPanelEl, customizePanelEl, settingsPanelEl];
const allNavs   = [navPlay, navBedrock, navMods, navPvp, navBedrockMods, navServer, navCosmetics, navFriends, navCustomize, navSettings];

function showPanel(panel: HTMLElement, nav: HTMLElement) {
  allPanels.forEach(p => p.style.display = 'none');
  allNavs.forEach(n => n.classList.remove('active'));
  panel.style.display = 'flex';
  nav.classList.add('active');
}
navPlay       .addEventListener('click', () => showPanel(contentEl,          navPlay));
navBedrock    .addEventListener('click', () => { showPanel(bedrockPanelEl,   navBedrock); initBedrock(); if (!bedrockPanelEl.dataset.loaded) { searchBedrockAddons(''); bedrockPanelEl.dataset.loaded = '1'; } });
navMods       .addEventListener('click', () => { showPanel(modsPanelEl, navMods); if (!modsPanelEl.dataset.loaded) { loadRecommendedMods(); modsPanelEl.dataset.loaded = '1'; } });
navPvp        .addEventListener('click', () => { showPanel(pvpPanelEl, navPvp); if (!pvpPanelEl.dataset.loaded) { initPvpMods(); pvpPanelEl.dataset.loaded = '1'; } });
navBedrockMods.addEventListener('click', () => { showPanel(bedrockModsPanelEl, navBedrockMods); if (!bedrockModsPanelEl.dataset.loaded) { searchBedrockMods(''); bedrockModsPanelEl.dataset.loaded = '1'; } });
navServer     .addEventListener('click', () => { showPanel(serverPanelEl, navServer); if (!serverPanelEl.dataset.loaded) { loadServerVersions(); loadCommunityServers(); serverPanelEl.dataset.loaded = '1'; } });
navCosmetics  .addEventListener('click', () => { showPanel(cosmeticsPanelEl, navCosmetics); if (!cosmeticsPanelEl.dataset.loaded) { initCosmetics(); cosmeticsPanelEl.dataset.loaded = '1'; } });
navFriends    .addEventListener('click', () => { showPanel(friendsPanelEl,   navFriends);   if (!friendsPanelEl.dataset.loaded) { initFriendsPanel(); friendsPanelEl.dataset.loaded = '1'; } });
navCustomize  .addEventListener('click', () => { showPanel(customizePanelEl, navCustomize); if (!customizePanelEl.dataset.loaded) { initCustomize(); searchTexturePacks(''); customizePanelEl.dataset.loaded = '1'; } });
navSettings   .addEventListener('click', () => showPanel(settingsPanelEl,    navSettings));

// ── Bedrock Edition ────────────────────────────────────────────────────────────
const bedrockIcon       = document.getElementById('bedrock-icon')!;
const bedrockStatusText = document.getElementById('bedrock-status-text')!;
const bedrockStatusSub  = document.getElementById('bedrock-status-sub')!;
const bedrockLaunchBtn  = document.getElementById('bedrock-launch-btn') as HTMLButtonElement;
let bedrockInited = false;

function initBedrock() {
  if (bedrockInited) return;
  bedrockInited = true;
  // Detect via launch attempt — if minecraft: URI fails the OS won't find a handler
  // We check by trying to resolve the UWP package path via IPC
  bedrockLaunchBtn.addEventListener('click', async () => {
    if (!mc) return;
    bedrockLaunchBtn.disabled = true;
    bedrockLaunchBtn.textContent = '⏳  Launching…';
    const res = await mc.launchBedrock();
    bedrockLaunchBtn.disabled = false;
    if (res.ok) {
      bedrockLaunchBtn.textContent = '✅  Bedrock launched!';
      bedrockIcon.textContent = '✅';
      bedrockStatusText.textContent = 'Minecraft Bedrock Edition launched';
      bedrockStatusSub.textContent = 'The game should open shortly';
      setTimeout(() => { bedrockLaunchBtn.textContent = '🪨  Launch Bedrock Edition'; }, 3000);
    } else if (res.notInstalled) {
      bedrockIcon.textContent = '🛒';
      bedrockStatusText.textContent = 'Bedrock not installed';
      bedrockStatusSub.textContent = 'Opening Microsoft Store to purchase/install Minecraft for Windows…';
      bedrockLaunchBtn.textContent = '🛒  Get Bedrock Edition';
    } else {
      bedrockStatusText.textContent = `Error: ${res.error}`;
      bedrockLaunchBtn.textContent = '🪨  Launch Bedrock Edition';
    }
  });

  // Check install status without launching
  if (mc?.launchBedrock) {
    bedrockIcon.textContent = '🪨';
    bedrockStatusText.textContent = 'Minecraft Bedrock Edition';
    bedrockStatusSub.textContent = 'Click Launch to open Bedrock, or Get to install it from the Microsoft Store';
  }
}

// ── Bedrock addon search (Modrinth) ───────────────────────────────────────────
const bedrockAddonList    = document.getElementById('bedrock-addon-list')!;
const bedrockAddonLoading = document.getElementById('bedrock-addon-loading')!;
const bedrockAddonSearch  = document.getElementById('bedrock-addon-search') as HTMLInputElement;
let bedrockSearchTimer: ReturnType<typeof setTimeout> | null = null;

async function searchBedrockAddons(query: string) {
  bedrockAddonLoading.style.display = 'flex';
  bedrockAddonList.innerHTML = '';
  try {
    const facets = JSON.stringify([
      ['project_type:resourcepack', 'project_type:shader'],
    ]);
    const params = new URLSearchParams({
      query, facets, limit: '50',
      index: query ? 'relevance' : 'downloads',
    });
    const res  = await fetch(`https://api.modrinth.com/v2/search?${params}`);
    const data = await res.json() as { hits: ModrinthHit[] };
    bedrockAddonLoading.style.display = 'none';
    if (!data.hits.length) {
      bedrockAddonList.innerHTML = '<p style="color:#484f58;text-align:center;padding:16px">No results</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    data.hits.forEach(h => {
      const card = document.createElement('div');
      card.className = 'mod-card';
      const icon = h.icon_url
        ? `<img src="${h.icon_url}" class="mod-icon-img" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'mod-icon',textContent:'🪨'}))">`
        : `<div class="mod-icon">🪨</div>`;
      const type = h.categories.includes('shaders') ? 'Shader' : 'Resource Pack';
      const typeCls = h.categories.includes('shaders') ? 'visual' : 'util';
      card.innerHTML = `${icon}
        <div class="mod-info">
          <div class="mod-name">${h.title}</div>
          <div class="mod-desc">${h.description}</div>
          <div class="mod-tags">
            <span class="mod-tag ${typeCls}">${type}</span>
            <span class="mod-tag" style="margin-left:auto">⬇ ${fmtDownloads(h.downloads)}</span>
          </div>
        </div>
        <div class="mod-right">
          <a href="https://modrinth.com/resourcepack/${h.project_id}" target="_blank"
            style="padding:7px 14px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:12px;text-decoration:none;white-space:nowrap;">Get →</a>
        </div>`;
      frag.appendChild(card);
    });
    bedrockAddonList.appendChild(frag);
  } catch {
    bedrockAddonLoading.style.display = 'none';
    bedrockAddonList.innerHTML = '<p style="color:#f85149;text-align:center;padding:16px">Could not reach Modrinth — check your connection</p>';
  }
}

bedrockAddonSearch?.addEventListener('input', () => {
  if (bedrockSearchTimer) clearTimeout(bedrockSearchTimer);
  bedrockSearchTimer = setTimeout(() => searchBedrockAddons(bedrockAddonSearch.value.trim()), 400);
});

// ── Bedrock Mods tab (full panel, like Java mods) ─────────────────────────────
const bedrockModsList    = document.getElementById('bedrock-mods-list')!;
const bedrockModsLoading = document.getElementById('bedrock-mods-loading')!;
const bedrockModsSearch  = document.getElementById('bedrock-mods-search') as HTMLInputElement;
let bedrockModsTimer: ReturnType<typeof setTimeout> | null = null;

async function searchBedrockMods(query: string) {
  bedrockModsLoading.style.display = 'flex';
  bedrockModsList.innerHTML = '';
  try {
    const facets = JSON.stringify([['project_type:resourcepack', 'project_type:shader']]);
    const params = new URLSearchParams({
      query, facets, limit: '50',
      index: query ? 'relevance' : 'downloads',
    });
    const res  = await fetch(`https://api.modrinth.com/v2/search?${params}`);
    const data = await res.json() as { hits: ModrinthHit[] };
    bedrockModsLoading.style.display = 'none';
    if (!data.hits.length) {
      bedrockModsList.innerHTML = '<p style="color:#484f58;padding:20px;text-align:center">No results found</p>';
      return;
    }
    const frag = document.createDocumentFragment();
    data.hits.forEach(h => {
      const isShader = h.categories.includes('shaders');
      const card = document.createElement('div');
      card.className = 'mod-card';
      const iconHtml = h.icon_url
        ? `<img src="${h.icon_url}" class="mod-icon-img" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'mod-icon',textContent:'📦'}))">`
        : `<div class="mod-icon">📦</div>`;
      const tagHtml = h.categories.slice(0, 3).map(cat => {
        const cls = ['shaders'].includes(cat) ? 'visual' : ['optimization','performance'].includes(cat) ? 'perf' : 'util';
        return `<span class="mod-tag ${cls}">${cat}</span>`;
      }).join('') + `<span class="mod-tag" style="margin-left:auto">⬇ ${fmtDownloads(h.downloads)}</span>`;
      const linkType = isShader ? 'shader' : 'resourcepack';
      card.innerHTML = `${iconHtml}
        <div class="mod-info">
          <div class="mod-name">${h.title}</div>
          <div class="mod-desc">${h.description}</div>
          <div class="mod-tags">${tagHtml}</div>
        </div>
        <div class="mod-right">
          <a href="https://modrinth.com/${linkType}/${h.project_id}" target="_blank"
            style="padding:7px 14px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:12px;text-decoration:none;white-space:nowrap;">Get →</a>
        </div>`;
      frag.appendChild(card);
    });
    bedrockModsList.appendChild(frag);
  } catch {
    bedrockModsLoading.style.display = 'none';
    bedrockModsList.innerHTML = '<p style="color:#f85149;padding:20px;text-align:center">Could not reach Modrinth — check your connection</p>';
  }
}

bedrockModsSearch?.addEventListener('input', () => {
  if (bedrockModsTimer) clearTimeout(bedrockModsTimer);
  bedrockModsTimer = setTimeout(() => searchBedrockMods(bedrockModsSearch.value.trim()), 400);
});

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

// ── In-game background (resource pack) ───────────────────────────────────────
async function installGameBg(btn: HTMLButtonElement, statusEl: HTMLElement) {
  btn.disabled = true;
  statusEl.textContent = 'Generating panorama…';
  statusEl.style.color = '#d29922';

  // Six panorama faces — each a dark gradient with a coloured glow matching the launcher blobs
  const glowColors = [
    [68, 10, 130], [10, 40, 100], [10, 50, 32],
    [40, 10, 90],  [8,  55, 80],  [68, 10, 130],
  ];
  const images: string[] = [];
  for (let i = 0; i < 6; i++) {
    const cv  = document.createElement('canvas');
    cv.width  = 512; cv.height = 512;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#080c14';
    ctx.fillRect(0, 0, 512, 512);
    const [r, g, b] = glowColors[i];
    const glow = ctx.createRadialGradient(256, 256, 0, 256, 256, 300);
    glow.addColorStop(0,   `rgba(${r},${g},${b},0.75)`);
    glow.addColorStop(0.55,`rgba(${r},${g},${b},0.30)`);
    glow.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 512, 512);
    images.push(cv.toDataURL('image/png').split(',')[1]);
  }

  statusEl.textContent = 'Installing resource pack…';
  const res = await mc.installBg({ images });
  if (res.ok) {
    statusEl.textContent = '✅ Installed — enable "VoxelClient" in Minecraft › Options › Resource Packs';
    statusEl.style.color = '#3fb950';
    btn.textContent = '↺ Reinstall';
  } else {
    statusEl.textContent = `❌ ${res.error}`;
    statusEl.style.color = '#f85149';
  }
  btn.disabled = false;
}

function initCustomize() {
  const btn    = document.getElementById('install-bg-btn')    as HTMLButtonElement | null;
  const status = document.getElementById('install-bg-status') as HTMLElement | null;
  if (btn && status) btn.addEventListener('click', () => installGameBg(btn, status));
}

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

// ── Installed mods (persisted) ────────────────────────────────────────────────
interface InstalledMod { filename: string; name: string; }
function loadInstalledMods(): Record<string, InstalledMod> {
  try { return JSON.parse(localStorage.getItem('voxel_installed_mods') || '{}'); } catch { return {}; }
}
function saveInstalledMods(data: Record<string, InstalledMod>) {
  localStorage.setItem('voxel_installed_mods', JSON.stringify(data));
}

// ── Modrinth mod search ────────────────────────────────────────────────────────
const enabledMods = new Set<string>(Object.keys(loadInstalledMods()));
const modsList    = document.getElementById('mods-list')!;
const modsSearch  = document.getElementById('mods-search') as HTMLInputElement;
const modsLoading = document.getElementById('mods-loading')!;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let modsTabType: 'mod' | 'modpack' = 'mod';

const modsTabMods  = document.getElementById('mods-tab-mods')  as HTMLButtonElement;
const modsTabPacks = document.getElementById('mods-tab-packs') as HTMLButtonElement;

function setModsTab(type: 'mod' | 'modpack') {
  modsTabType = type;
  const isMod = type === 'mod';
  modsTabMods.style.background  = isMod ? 'rgba(63,185,80,0.15)' : '#21262d';
  modsTabMods.style.borderColor = isMod ? 'rgba(63,185,80,0.4)'  : '#30363d';
  modsTabMods.style.color       = isMod ? '#3fb950' : '#8b949e';
  modsTabPacks.style.background  = !isMod ? 'rgba(63,185,80,0.15)' : '#21262d';
  modsTabPacks.style.borderColor = !isMod ? 'rgba(63,185,80,0.4)'  : '#30363d';
  modsTabPacks.style.color       = !isMod ? '#3fb950' : '#8b949e';
  modsSearch.placeholder = isMod ? '🔍  Search mods…' : '🔍  Search modpacks…';
  searchModrinth(modsSearch.value.trim());
}

modsTabMods .addEventListener('click', () => setModsTab('mod'));
modsTabPacks.addEventListener('click', () => setModsTab('modpack'));

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
      <div class="mod-version" id="modstatus-${mod.project_id}"></div>
      <label class="toggle">
        <input type="checkbox" ${on ? 'checked' : ''} />
        <span class="toggle-slider"></span>
      </label>
    </div>`;

  const input   = card.querySelector('input') as HTMLInputElement;
  const statusEl = card.querySelector('.mod-version') as HTMLElement;

  input.addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked;
    input.disabled = true;

    if (checked) {
      statusEl.textContent = '⏳';
      statusEl.style.color = '#d29922';
      try {
        const ver = mcVersion.value || '1.21.4';
        const tryVersions = [ver, '1.21.4', '1.21.1', '1.21'];
        let versions: { files: { url: string; filename: string; primary: boolean }[] }[] = [];
        for (const tv of tryVersions) {
          const params = new URLSearchParams({ game_versions: `["${tv}"]`, loaders: '["fabric"]', limit: '5' });
          const vRes = await fetch(`https://api.modrinth.com/v2/project/${mod.project_id}/version?${params}`);
          const data = await vRes.json();
          if (Array.isArray(data) && data.length) { versions = data; break; }
        }
        if (!versions.length) throw new Error('No Fabric build available');
        const file = versions[0].files.find(f => f.primary) ?? versions[0].files[0];
        if (!file) throw new Error('No download file found');
        statusEl.textContent = '⬇';
        const res = await mc.installMod({ url: file.url, filename: file.filename });
        if (!res.ok) throw new Error(res.error);
        const installed = loadInstalledMods();
        installed[mod.project_id] = { filename: file.filename, name: mod.title };
        saveInstalledMods(installed);
        enabledMods.add(mod.project_id);
        card.className = 'mod-card enabled';
        statusEl.textContent = '✓';
        statusEl.style.color = '#3fb950';
      } catch (err: any) {
        input.checked = false;
        card.className = 'mod-card';
        statusEl.textContent = '✗';
        statusEl.style.color = '#f85149';
        statusEl.title = err.message;
      }
    } else {
      const installed = loadInstalledMods();
      const info = installed[mod.project_id];
      if (info && mc) await mc.removeMod({ filename: info.filename });
      delete installed[mod.project_id];
      saveInstalledMods(installed);
      enabledMods.delete(mod.project_id);
      card.className = 'mod-card';
      statusEl.textContent = '';
    }
    input.disabled = false;
  });

  if (on) { statusEl.textContent = '✓'; statusEl.style.color = '#3fb950'; }
  return card;
}

function buildModpackCard(mod: ModrinthHit): HTMLElement {
  const card = document.createElement('div');
  card.className = 'mod-card';
  const iconHtml = mod.icon_url
    ? `<img src="${mod.icon_url}" class="mod-icon-img" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'mod-icon',textContent:'📦'}))">`
    : `<div class="mod-icon">📦</div>`;
  const tagHtml = mod.categories.slice(0, 3).map(cat =>
    `<span class="mod-tag util">${cat}</span>`
  ).join('') + `<span class="mod-tag" style="margin-left:auto">⬇ ${fmtDownloads(mod.downloads)}</span>`;
  card.innerHTML = `
    ${iconHtml}
    <div class="mod-info">
      <div class="mod-name">${mod.title}</div>
      <div class="mod-desc">${mod.description}</div>
      <div class="mod-tags">${tagHtml}</div>
    </div>
    <div class="mod-right">
      <a href="https://modrinth.com/modpack/${mod.project_id}" target="_blank"
        style="padding:7px 14px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:12px;text-decoration:none;white-space:nowrap;">Get →</a>
    </div>`;
  return card;
}

async function loadRecommendedMods() {
  modsLoading.style.display = 'flex';
  modsList.innerHTML = '';
  try {
    const facets = JSON.stringify([
      ['project_type:mod'],
      ['client_side:required', 'client_side:optional'],
      ['categories:optimization'],
    ]);
    const params = new URLSearchParams({ facets, limit: '15', index: 'downloads' });
    const res  = await fetch(`https://api.modrinth.com/v2/search?${params}`);
    const data = await res.json() as { hits: ModrinthHit[] };
    modsLoading.style.display = 'none';
    const frag = document.createDocumentFragment();
    data.hits.forEach(h => frag.appendChild(buildModCard(h)));
    modsList.appendChild(frag);
  } catch {
    modsLoading.style.display = 'none';
    modsList.innerHTML = '<p style="color:#f85149;padding:20px;text-align:center">Could not reach Modrinth — check your connection</p>';
  }
}

async function searchModrinth(query: string) {
  modsLoading.style.display = 'flex';
  modsList.innerHTML = '';
  try {
    const facets = modsTabType === 'mod'
      ? JSON.stringify([['project_type:mod'], ['client_side:required', 'client_side:optional']])
      : JSON.stringify([['project_type:modpack']]);
    const params = new URLSearchParams({
      query, facets, limit: '50',
      index: query ? 'relevance' : 'downloads',
    });
    const res  = await fetch(`https://api.modrinth.com/v2/search?${params}`);
    const data = await res.json() as { hits: ModrinthHit[] };
    modsLoading.style.display = 'none';
    if (!data.hits.length) {
      modsList.innerHTML = `<p style="color:#484f58;padding:20px;text-align:center">No ${modsTabType === 'modpack' ? 'modpacks' : 'mods'} found</p>`;
      return;
    }
    const frag = document.createDocumentFragment();
    if (modsTabType === 'modpack') {
      data.hits.forEach(h => frag.appendChild(buildModpackCard(h)));
    } else {
      data.hits.forEach(h => frag.appendChild(buildModCard(h)));
    }
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

// ── PvP Mods panel ────────────────────────────────────────────────────────────
interface PvpModDef {
  slug: string; emoji: string; name: string; desc: string;
  group: 'HUD' | 'Visual' | 'Utility' | 'Performance';
}

const PVP_MOD_GROUPS: { label: string; color: string; mods: PvpModDef[] }[] = [
  {
    label: '⌨️ HUD & Info',
    color: '#58a6ff',
    mods: [
      { slug: 'keystrokes+',          emoji: '⌨️', name: 'Keystrokes+',        desc: 'Live WASD + click display — exactly like Lunar Client', group: 'HUD' },
      { slug: 'appleskin',           emoji: '🍎', name: 'AppleSkin',          desc: 'Shows exact saturation & exhaustion on the hunger bar', group: 'HUD' },
      { slug: 'armor-status',        emoji: '🛡️', name: 'Armor Status',       desc: 'Armor & held item durability HUD', group: 'HUD' },
      { slug: 'status-effect-bars',  emoji: '🧪', name: 'Status Effect Bars', desc: 'Duration bars under every active potion effect', group: 'HUD' },
      { slug: 'coordinates-display', emoji: '📍', name: 'Coordinates',        desc: 'Clean XYZ + direction overlay — no F3 needed', group: 'HUD' },
      { slug: 'xaeros-minimap',      emoji: '🗺️', name: "Xaero's Minimap",   desc: 'Minimap with player dots & waypoints', group: 'HUD' },
      { slug: 'betterf3',            emoji: '📊', name: 'BetterF3',           desc: 'Color-coded F3 screen with FPS, ping & TPS', group: 'HUD' },
    ],
  },
  {
    label: '✨ Visual',
    color: '#a371f7',
    mods: [
      { slug: 'custom-crosshair-mod', emoji: '🎯', name: 'Custom Crosshair',    desc: 'Change crosshair style, size, color & gap like Lunar', group: 'Visual' },
      { slug: 'natural-motion-blur',   emoji: '💨', name: 'Motion Blur',         desc: 'Smooth camera motion blur when turning', group: 'Visual' },
      { slug: 'not-enough-animations',emoji: '🏃', name: 'Not Enough Animations',desc: 'Restores eating, bow & item animations from older MC', group: 'Visual' },
      { slug: 'damage-tilt',          emoji: '💥', name: 'Damage Tilt',         desc: 'Screen tilts in the direction you take damage', group: 'Visual' },
    ],
  },
  {
    label: '⚙️ Utility',
    color: '#3fb950',
    mods: [
      { slug: 'zebrastogglesneak-fabric', emoji: '🏃', name: 'Toggle Sprint', desc: 'Toggle sprint on/off — no need to hold Ctrl', group: 'Utility' },
      { slug: 'no-chat-reports',   emoji: '🔇', name: 'No Chat Reports',  desc: 'Removes chat signing — prevents Microsoft report system', group: 'Utility' },
      { slug: 'item-highlighter',  emoji: '🔆', name: 'Item Highlighter', desc: 'Highlights newly picked up items in your hotbar', group: 'Utility' },
    ],
  },
];

function buildPvpCard(mod: PvpModDef): HTMLElement {
  const on   = enabledMods.has(mod.slug);
  const card = document.createElement('div');
  card.className = 'mod-card' + (on ? ' enabled' : '');
  card.innerHTML = `
    <div class="mod-icon" style="font-size:22px;background:none;">${mod.emoji}</div>
    <div class="mod-info">
      <div class="mod-name">${mod.name}</div>
      <div class="mod-desc">${mod.desc}</div>
    </div>
    <div class="mod-right">
      <div class="mod-version" id="pvpstatus-${mod.slug}" style="color:${on ? '#3fb950' : 'transparent'}">${on ? '✓' : '✓'}</div>
      <label class="toggle">
        <input type="checkbox" ${on ? 'checked' : ''} />
        <span class="toggle-slider"></span>
      </label>
    </div>`;

  const input    = card.querySelector('input') as HTMLInputElement;
  const statusEl = card.querySelector('.mod-version') as HTMLElement;
  if (on) { statusEl.textContent = '✓'; statusEl.style.color = '#3fb950'; }
  else     { statusEl.textContent = '';  statusEl.style.color = 'transparent'; }

  input.addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked;
    input.disabled = true;
    if (checked) {
      statusEl.textContent = '⏳'; statusEl.style.color = '#d29922';
      try {
        const ver = mcVersion.value || '1.21.4';
        const tryVersions = [ver, '1.21.4', '1.21.1', '1.21'];
        let versions: { files: { url: string; filename: string; primary: boolean }[] }[] = [];
        for (const tv of tryVersions) {
          const params = new URLSearchParams({ game_versions: `["${tv}"]`, loaders: '["fabric"]', limit: '5' });
          const vRes = await fetch(`https://api.modrinth.com/v2/project/${mod.slug}/version?${params}`);
          const data = await vRes.json();
          if (Array.isArray(data) && data.length) { versions = data; break; }
        }
        if (!versions.length) throw new Error('No Fabric build available');
        const file = versions[0].files.find(f => f.primary) ?? versions[0].files[0];
        statusEl.textContent = '⬇';
        const res = await mc.installMod({ url: file.url, filename: file.filename });
        if (!res.ok) throw new Error(res.error);
        const installed = loadInstalledMods();
        installed[mod.slug] = { filename: file.filename, name: mod.name };
        saveInstalledMods(installed);
        enabledMods.add(mod.slug);
        card.className = 'mod-card enabled';
        statusEl.textContent = '✓'; statusEl.style.color = '#3fb950';
      } catch (err: any) {
        input.checked = false;
        card.className = 'mod-card';
        statusEl.textContent = '✗'; statusEl.style.color = '#f85149';
        statusEl.title = err.message;
      }
    } else {
      const installed = loadInstalledMods();
      const info = installed[mod.slug];
      if (info && mc) await mc.removeMod({ filename: info.filename });
      delete installed[mod.slug];
      saveInstalledMods(installed);
      enabledMods.delete(mod.slug);
      card.className = 'mod-card';
      statusEl.textContent = ''; statusEl.style.color = 'transparent';
    }
    input.disabled = false;
  });

  return card;
}

function initPvpMods() {
  const list = document.getElementById('pvp-list')!;
  list.innerHTML = '';
  for (const group of PVP_MOD_GROUPS) {
    const section = document.createElement('div');
    section.innerHTML = `<div style="font-size:13px;font-weight:700;color:${group.color};letter-spacing:1px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #21262d;">${group.label}</div>`;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    for (const mod of group.mods) grid.appendChild(buildPvpCard(mod));
    section.appendChild(grid);
    list.appendChild(section);
  }
}

// ── Cosmetics panel ───────────────────────────────────────────────────────────
const CAPE_DEFS = [
  { id: 'voxel_green', name: 'Voxel Green',  top: '#3fb950', bot: '#1a4a2e', cost: 0   },
  { id: 'midnight',    name: 'Midnight Blue', top: '#58a6ff', bot: '#1a2e4a', cost: 100 },
  { id: 'crimson',     name: 'Crimson',       top: '#da3633', bot: '#5a0a0a', cost: 100 },
  { id: 'amethyst',    name: 'Amethyst',      top: '#a371f7', bot: '#4a1a9e', cost: 150 },
  { id: 'golden',      name: 'Golden',        top: '#d29922', bot: '#6b4c00', cost: 150 },
  { id: 'nether',      name: 'Nether',        top: '#f97316', bot: '#7a1a00', cost: 200 },
  { id: 'ocean',       name: 'Ocean',         top: '#7cc4db', bot: '#1a4a5a', cost: 200 },
  { id: 'void',        name: 'Void',          top: '#8b5cf6', bot: '#0a0a2e', cost: 300 },
];

let equippedCapeId: string | null = null;
let mcUuid: string | null = null;
let tokenBalance = 0;
let purchasedCapes = new Set<string>(['voxel_green']); // free cape always owned

function updateTokenBadge() {
  const count = document.getElementById('token-count');
  const display = document.getElementById('token-balance-display');
  if (count)   count.textContent   = String(tokenBalance);
  if (display) display.textContent = String(tokenBalance);
}

function initTokens(uid: string) {
  // Wire claim button here so it works as soon as the user logs in
  const claimBtn = document.getElementById('claim-tokens-btn') as HTMLButtonElement | null;
  claimBtn?.addEventListener('click', () => claimDailyTokens(uid));

  onValue(ref(rtdb, `voxel_tokens/${uid}`), snap => {
    const data = snap.val() || {};
    tokenBalance = data.balance ?? 0;
    const purchased = data.purchased || {};
    purchasedCapes = new Set(['voxel_green', ...Object.keys(purchased).filter(k => purchased[k])]);
    updateTokenBadge();
    const btn = document.getElementById('claim-tokens-btn') as HTMLButtonElement | null;
    if (btn) {
      const today = new Date().toISOString().slice(0, 10);
      if (data.lastClaim === today) {
        btn.textContent = '✓ Claimed today';
        btn.disabled = true;
      } else {
        btn.textContent = 'Claim Daily (+50)';
        btn.disabled = false;
      }
    }
    // refresh cape grid if visible
    const grid = document.getElementById('cape-grid');
    if (grid && grid.children.length) renderCapeGrid();
  });
}

async function claimDailyTokens(uid: string) {
  const claimBtn = document.getElementById('claim-tokens-btn') as HTMLButtonElement | null;
  const today = new Date().toISOString().slice(0, 10);
  if (claimBtn) { claimBtn.disabled = true; claimBtn.textContent = '⏳ Claiming…'; }
  try {
    const snap = await get(ref(rtdb, `voxel_tokens/${uid}/lastClaim`));
    if (snap.val() === today) {
      if (claimBtn) claimBtn.textContent = '✓ Claimed today';
      return;
    }
    await update(ref(rtdb, `voxel_tokens/${uid}`), { balance: increment(50), lastClaim: today });
    if (claimBtn) {
      claimBtn.textContent = '✅ +50 Tokens claimed!';
      setTimeout(() => { claimBtn.textContent = '✓ Claimed today'; }, 2500);
    }
  } catch (err: any) {
    if (claimBtn) {
      claimBtn.disabled = false;
      claimBtn.textContent = '❌ ' + (err?.message ?? 'Failed');
      setTimeout(() => { claimBtn.textContent = 'Claim Daily (+50)'; claimBtn.disabled = false; }, 3000);
    }
  }
}

// ── Presence ──────────────────────────────────────────────────────────────────
function initPresence(uid: string) {
  const presRef = ref(rtdb, `voxel_presence/${uid}`);
  set(presRef, { online: true, since: serverTimestamp() });
  onDisconnect(presRef).set({ online: false, since: serverTimestamp() });
}

function registerUserIndex(uid: string, mcName: string) {
  set(ref(rtdb, `voxel_user_index/${mcName.toLowerCase()}`), { uid, name: mcName }).catch(() => {});
}

// ── Friends ───────────────────────────────────────────────────────────────────
function initFriends(uid: string) {
  onValue(ref(rtdb, `voxel_friends/${uid}/list`), snap => {
    renderFriendsList(uid, snap.val() || {});
  });
  onValue(ref(rtdb, `voxel_friends/${uid}/requests/incoming`), snap => {
    renderFriendRequests(uid, snap.val() || {});
  });
}

function renderFriendsList(uid: string, data: Record<string, any>) {
  const listEl  = document.getElementById('friends-list');
  const emptyEl = document.getElementById('friends-empty');
  if (!listEl) return;
  listEl.querySelectorAll('.friend-card').forEach(c => c.remove());
  const friends = Object.entries(data);
  if (emptyEl) emptyEl.style.display = friends.length ? 'none' : 'block';
  friends.forEach(([fuid, info]) => {
    const card = document.createElement('div');
    card.className = 'friend-card';
    card.dataset.fuid = fuid;
    card.innerHTML = `
      <div class="friend-avatar">🧑</div>
      <div class="friend-dot" id="fdot-${fuid}"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:#e6edf3;">${info.name || fuid}</div>
        <div id="fstatus-${fuid}" style="font-size:11px;color:#484f58;margin-top:2px;">Offline</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <span id="fsrv-${fuid}" style="display:none;font-family:monospace;font-size:11px;color:#3fb950;background:rgba(63,185,80,0.06);border:1px solid rgba(63,185,80,0.15);padding:4px 8px;border-radius:6px;cursor:pointer;" title="Click to copy"></span>
        <button data-fuid="${fuid}" class="friend-remove-btn" style="padding:4px 10px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#484f58;font-size:11px;cursor:pointer;">Remove</button>
      </div>`;
    card.querySelector('.friend-remove-btn')!.addEventListener('click', async () => {
      await set(ref(rtdb, `voxel_friends/${uid}/list/${fuid}`), null);
      await set(ref(rtdb, `voxel_friends/${fuid}/list/${uid}`), null);
    });
    listEl.appendChild(card);
    // Listen to this friend's presence
    onValue(ref(rtdb, `voxel_presence/${fuid}`), pSnap => {
      const p = pSnap.val();
      const dot    = document.getElementById(`fdot-${fuid}`);
      const status = document.getElementById(`fstatus-${fuid}`);
      const srvEl  = document.getElementById(`fsrv-${fuid}`);
      const cardEl = document.querySelector(`.friend-card[data-fuid="${fuid}"]`);
      if (!dot || !status) return;
      const online = p?.online === true;
      dot.className   = 'friend-dot' + (online ? ' online' : '');
      if (cardEl) cardEl.className = 'friend-card' + (online ? ' online' : '');
      status.textContent = online ? 'Online' : 'Offline';
      if (srvEl) {
        const addr = p?.server;
        if (online && addr) {
          srvEl.style.display = 'inline';
          srvEl.textContent   = addr;
          srvEl.onclick       = () => { (window as any).electron?.copyText(addr); srvEl.textContent = '✓ Copied!'; setTimeout(() => { srvEl.textContent = addr; }, 1500); };
        } else {
          srvEl.style.display = 'none';
        }
      }
    });
  });
}

function renderFriendRequests(uid: string, data: Record<string, any>) {
  const secEl  = document.getElementById('friend-requests-section');
  const listEl = document.getElementById('friend-requests-list');
  if (!secEl || !listEl) return;
  listEl.innerHTML = '';
  const reqs = Object.entries(data);
  secEl.style.display = reqs.length ? 'block' : 'none';
  reqs.forEach(([fromUid, info]) => {
    const card = document.createElement('div');
    card.className = 'req-card';
    card.innerHTML = `
      <div class="friend-avatar" style="font-size:16px;">🧑</div>
      <div style="flex:1;font-size:13px;color:#e6edf3;font-weight:500;">${info.name || fromUid}</div>
      <button class="req-accept" style="padding:5px 12px;background:rgba(63,185,80,0.15);border:1px solid rgba(63,185,80,0.4);border-radius:6px;color:#3fb950;font-size:12px;cursor:pointer;font-weight:600;">Accept</button>
      <button class="req-decline" style="padding:5px 12px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#484f58;font-size:12px;cursor:pointer;margin-left:6px;">Decline</button>`;
    card.querySelector('.req-accept')!.addEventListener('click', async () => {
      // Add to each other's list
      await set(ref(rtdb, `voxel_friends/${uid}/list/${fromUid}`), { name: info.name, addedAt: serverTimestamp() });
      await set(ref(rtdb, `voxel_friends/${fromUid}/list/${uid}`), { name: mcIgnSpan.textContent || '', addedAt: serverTimestamp() });
      // Clear requests
      await set(ref(rtdb, `voxel_friends/${uid}/requests/incoming/${fromUid}`), null);
      await set(ref(rtdb, `voxel_friends/${fromUid}/requests/outgoing/${uid}`), null);
    });
    card.querySelector('.req-decline')!.addEventListener('click', async () => {
      await set(ref(rtdb, `voxel_friends/${uid}/requests/incoming/${fromUid}`), null);
      await set(ref(rtdb, `voxel_friends/${fromUid}/requests/outgoing/${uid}`), null);
    });
    listEl.appendChild(card);
  });
}

async function sendFriendRequest(uid: string, targetName: string) {
  const statusEl = document.getElementById('friend-add-status');
  const addBtn   = document.getElementById('friend-add-btn') as HTMLButtonElement;
  if (!statusEl || !addBtn) return;
  if (!uid) { statusEl.style.color = '#f85149'; statusEl.textContent = '⚠ Sign in first'; return; }
  const name = targetName.trim().toLowerCase();
  if (!name) return;
  addBtn.disabled = true;
  statusEl.style.color = '#484f58';
  statusEl.textContent = 'Searching…';
  const snap = await get(ref(rtdb, `voxel_user_index/${name}`));
  const target = snap.val();
  if (!target) {
    statusEl.style.color = '#f85149';
    statusEl.textContent = `⚠ "${targetName}" hasn't used Voxel Client yet`;
    addBtn.disabled = false;
    return;
  }
  const targetUid = target.uid;
  if (targetUid === uid) { statusEl.style.color = '#f85149'; statusEl.textContent = "That's you!"; addBtn.disabled = false; return; }
  // Check if already friends
  const alreadySnap = await get(ref(rtdb, `voxel_friends/${uid}/list/${targetUid}`));
  if (alreadySnap.exists()) { statusEl.style.color = '#d29922'; statusEl.textContent = 'Already friends'; addBtn.disabled = false; return; }
  // Send request
  await set(ref(rtdb, `voxel_friends/${targetUid}/requests/incoming/${uid}`), { name: mcIgnSpan.textContent || uid, sentAt: serverTimestamp() });
  await set(ref(rtdb, `voxel_friends/${uid}/requests/outgoing/${targetUid}`), { name: target.name, sentAt: serverTimestamp() });
  statusEl.style.color = '#3fb950';
  statusEl.textContent = `✅ Request sent to ${target.name}`;
  (document.getElementById('friend-add-input') as HTMLInputElement).value = '';
  addBtn.disabled = false;
}

function initFriendsPanel() {
  const addBtn   = document.getElementById('friend-add-btn')   as HTMLButtonElement;
  const addInput = document.getElementById('friend-add-input') as HTMLInputElement;
  addBtn?.addEventListener('click', () => sendFriendRequest(myUid, addInput.value));
  addInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });
  if (myUid) initFriends(myUid);
}

// Cape grid renderer (called by initCosmetics and after token updates)
let capeGridInitialized = false;
function renderCapeGrid() {
  if (!capeGridInitialized) return;
  const grid = document.getElementById('cape-grid');
  const cosmeticsStatus = document.getElementById('cosmetics-status');
  const equippedNameEl  = document.getElementById('cosmetics-equipped-name');
  const preview         = document.getElementById('cosmetics-preview');
  const removeBtn       = document.getElementById('cosmetics-remove-btn') as HTMLButtonElement | null;
  if (!grid) return;
  grid.innerHTML = '';
  for (const cape of CAPE_DEFS) {
    const owned    = purchasedCapes.has(cape.id);
    const equipped = cape.id === equippedCapeId;
    const card     = document.createElement('div');
    card.className = 'cape-card' + (equipped ? ' equipped' : '');
    const costLabel = cape.cost === 0 ? 'Free' : `🪙 ${cape.cost}`;
    const canAfford = tokenBalance >= cape.cost;
    let actionBtn = '';
    if (equipped) {
      actionBtn = `<button class="cape-equip on">✅ Equipped</button>`;
    } else if (owned) {
      actionBtn = `<button class="cape-equip off">Equip</button>`;
    } else {
      actionBtn = `<button class="cape-buy"${!canAfford ? ' disabled' : ''}>${costLabel}</button>`;
    }
    card.innerHTML = `
      <canvas class="cape-swatch" width="80" height="64"></canvas>
      <div class="cape-label">
        <div class="cape-name">${cape.name}</div>
        ${!owned && cape.cost > 0 ? `<div class="cape-cost">${costLabel}</div>` : ''}
        ${actionBtn}
      </div>`;
    const canvas = card.querySelector('canvas') as HTMLCanvasElement;
    const ctx2   = canvas.getContext('2d')!;
    ctx2.fillStyle = cape.top; ctx2.fillRect(0, 0, 80, 32);
    ctx2.fillStyle = cape.bot; ctx2.fillRect(0, 32, 80, 32);
    const btn = card.querySelector('button');
    if (!btn) { grid.appendChild(card); continue; }
    btn.addEventListener('click', async () => {
      const capeKey = mcUuid || myUid;
      if (!capeKey) {
        if (cosmeticsStatus) cosmeticsStatus.textContent = '⚠ Sign in to your launcher account first';
        return;
      }
      if (!owned) {
        // Buy
        if (!myUid || tokenBalance < cape.cost) return;
        btn.disabled = true;
        try {
          await update(ref(rtdb, `voxel_tokens/${myUid}`), { balance: increment(-cape.cost), [`purchased/${cape.id}`]: true });
          // renderCapeGrid called by onValue
        } catch { btn.disabled = false; }
        return;
      }
      // Equip — store under MC UUID (Fabric mod) or Firebase UID (launcher only)
      try {
        await set(ref(rtdb, `voxel_capes/${capeKey}`), { cape_id: cape.id, enabled: true, username: mcIgnSpan.textContent || '' });
        equippedCapeId = cape.id;
        if (equippedNameEl) equippedNameEl.textContent = cape.name;
        if (preview) preview.style.background = `linear-gradient(to bottom, ${cape.top}, ${cape.bot})`;
        if (removeBtn) removeBtn.style.display = 'inline-block';
        if (cosmeticsStatus) cosmeticsStatus.textContent = mcUuid
          ? '✅ Cape saved — visible in-game after next launch'
          : '✅ Cape saved — sign in with Microsoft to see it in-game';
        renderCapeGrid();
      } catch { if (cosmeticsStatus) cosmeticsStatus.textContent = '❌ Failed to save — check connection'; }
    });
    grid.appendChild(card);
  }
}

async function initCosmetics() {
  const cosm         = (window as any).cosmetics;
  const equippedNameEl = document.getElementById('cosmetics-equipped-name')!;
  const cosmeticsStatus = document.getElementById('cosmetics-status')!;
  const preview      = document.getElementById('cosmetics-preview')!;
  const removeBtn    = document.getElementById('cosmetics-remove-btn') as HTMLButtonElement;
  const installBtn   = document.getElementById('mod-install-btn') as HTMLButtonElement;
  const installStatus = document.getElementById('mod-install-status')!;

  // Try to get Minecraft UUID (optional — falls back to Firebase UID)
  if (cosm) mcUuid = await cosm.getUuid();
  const capeKey = mcUuid || myUid;

  if (!capeKey) {
    cosmeticsStatus.textContent = 'Sign in to your launcher account to equip capes';
  } else {
    cosmeticsStatus.textContent = mcUuid
      ? `Minecraft linked · changes take effect on next launch`
      : `Launcher account · equip capes freely (sign in with Microsoft for in-game visibility)`;
    const snap = await new Promise<any>(res => {
      const unsub = onValue(ref(rtdb, `voxel_capes/${capeKey}`), s => { unsub(); res(s.val()); });
    });
    if (snap?.cape_id && snap?.enabled) {
      equippedCapeId = snap.cape_id;
      const def = CAPE_DEFS.find(c => c.id === snap.cape_id);
      if (def) {
        equippedNameEl.textContent = def.name;
        preview.style.background = `linear-gradient(to bottom, ${def.top}, ${def.bot})`;
        removeBtn.style.display = 'inline-block';
      }
    }
  }

  capeGridInitialized = true;
  renderCapeGrid();

  removeBtn.addEventListener('click', async () => {
    const key = mcUuid || myUid;
    if (!key) return;
    await set(ref(rtdb, `voxel_capes/${key}/enabled`), false);
    equippedCapeId = null;
    equippedNameEl.textContent = 'None';
    preview.style.background = '';
    removeBtn.style.display = 'none';
    cosmeticsStatus.textContent = 'Cape removed';
    renderCapeGrid();
  });

  installBtn?.addEventListener('click', async () => {
    if (!cosm) return;
    installBtn.disabled = true;
    installBtn.textContent = '⏳ Installing…';
    const res = await cosm.installMod();
    if (res.ok) {
      installStatus.textContent = '✅ Installed! Launch with Fabric Loader to see capes.';
      installStatus.style.color = '#3fb950';
    } else {
      installStatus.textContent = `❌ ${res.error}`;
      installStatus.style.color = '#f85149';
    }
    installBtn.disabled = false;
    installBtn.textContent = '⬇ Install Cosmetics Mod';
  });
}

// ── Server Host panel ─────────────────────────────────────────────────────────
const srvStartBtn  = document.getElementById('srv-start-btn') as HTMLButtonElement;
const srvInfo      = document.getElementById('srv-info')!;
const srvAddress   = document.getElementById('srv-address')!;
const srvVerDisplay= document.getElementById('srv-ver-display')!;
const srvLog       = document.getElementById('srv-log')!;
const srvLogCopy   = document.getElementById('srv-log-copy') as HTMLButtonElement;
const srvCmdInput  = document.getElementById('srv-cmd-input') as HTMLInputElement;
const srvCmdBtn    = document.getElementById('srv-cmd-btn') as HTMLButtonElement;
const srvMemSlider = document.getElementById('srv-mem') as HTMLInputElement;
const srvMemVal    = document.getElementById('srv-mem-val')!;
const communityEl  = document.getElementById('community-servers')!;
const savedSrvEl   = document.getElementById('saved-servers')!;
const savedSrvEmpty= document.getElementById('saved-servers-empty')!;
const srvSaveBtn   = document.getElementById('srv-save-btn') as HTMLButtonElement;
const srvSaveStatus= document.getElementById('srv-save-status')!;
const srv247Toggle = document.getElementById('srv-247-toggle') as HTMLInputElement;
const srvIpInput   = document.getElementById('srv-ip') as HTMLInputElement;

let srvRunning = false;
let srvLogLines: string[] = [];
let myUid = '';

// ── Saved servers (localStorage) ──────────────────────────────────────────────
interface SavedServer { id: string; name: string; ip: string; version: string; publish: boolean; }

function loadSavedServers(): SavedServer[] {
  try { return JSON.parse(localStorage.getItem('voxel_saved_servers') || '[]'); } catch { return []; }
}
function persistSavedServers(list: SavedServer[]) {
  localStorage.setItem('voxel_saved_servers', JSON.stringify(list));
}

async function publish247(srv: SavedServer) {
  if (!myUid) return;
  await set(ref(rtdb, `mc_servers/${myUid}`), {
    name: srv.name, version: srv.version, address: srv.ip || '—',
    port: 25565, online: false, publish: true,
    owner: userName.textContent || 'Player',
  });
}
async function unpublish247() {
  if (!myUid) return;
  await set(ref(rtdb, `mc_servers/${myUid}/publish`), false);
}

function renderSavedServers() {
  const list = loadSavedServers();
  savedSrvEmpty.style.display = list.length ? 'none' : 'block';
  // Remove existing server cards (not the empty placeholder)
  savedSrvEl.querySelectorAll('.saved-srv-card').forEach(c => c.remove());
  list.forEach(srv => {
    const card = document.createElement('div');
    card.className = 'mod-card saved-srv-card';
    card.style.cursor = 'default';
    card.innerHTML = `
      <div class="mod-icon" style="font-size:20px;">🖥️</div>
      <div class="mod-info">
        <div class="mod-name">${srv.name}</div>
        <div class="mod-desc" style="font-family:monospace">${srv.ip || '(no IP)'} &nbsp;·&nbsp; ${srv.version}</div>
        <div class="mod-tags" style="margin-top:6px;">
          <span class="mod-tag ${srv.publish ? 'perf' : ''}">${srv.publish ? '🌐 24/7 Listed' : 'Local only'}</span>
        </div>
      </div>
      <div class="mod-right" style="gap:6px;">
        <button data-id="${srv.id}" class="srv-load-btn" style="padding:5px 12px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:6px;color:#3fb950;font-size:11px;cursor:pointer;white-space:nowrap;">Load</button>
        <button data-id="${srv.id}" class="srv-del-btn" style="padding:5px 12px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#8b949e;font-size:11px;cursor:pointer;">✕</button>
      </div>`;
    card.querySelector('.srv-load-btn')!.addEventListener('click', () => {
      (document.getElementById('srv-name') as HTMLInputElement).value = srv.name;
      srvIpInput.value   = srv.ip;
      srv247Toggle.checked = srv.publish;
      const sel = document.getElementById('srv-version') as HTMLSelectElement;
      if (Array.from(sel.options).find(o => o.value === srv.version)) sel.value = srv.version;
    });
    card.querySelector('.srv-del-btn')!.addEventListener('click', async () => {
      const updated = loadSavedServers().filter(s => s.id !== srv.id);
      persistSavedServers(updated);
      if (srv.publish) await unpublish247();
      renderSavedServers();
    });
    savedSrvEl.appendChild(card);
  });
}

function isValidServerDomain(addr: string): boolean {
  const host = addr.trim().replace(/:\d+$/, ''); // strip optional :port
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // block raw IPv4
  return /\.[a-zA-Z]{2,}$/.test(host); // must end with a TLD (.net, .gg, .com …)
}

srvSaveBtn?.addEventListener('click', async () => {
  const name    = (document.getElementById('srv-name') as HTMLInputElement).value.trim() || 'My Server';
  const ip      = srvIpInput.value.trim();
  const version = (document.getElementById('srv-version') as HTMLSelectElement).value;
  const publish = srv247Toggle.checked;

  if (publish && !isValidServerDomain(ip)) {
    srvSaveStatus.textContent = '⚠ Enter a domain address to list publicly (e.g. play.yourserver.net)';
    srvSaveStatus.style.color = '#f85149';
    setTimeout(() => { srvSaveStatus.textContent = ''; }, 4000);
    return;
  }

  const id  = `${Date.now()}`;
  const srv: SavedServer = { id, name, ip, version, publish };
  const list = loadSavedServers().filter(s => s.name !== name);
  list.unshift(srv);
  persistSavedServers(list);
  if (publish) await publish247(srv);
  renderSavedServers();
  srvSaveStatus.textContent = publish ? '✅ Saved & listed 24/7' : '✅ Saved locally';
  srvSaveStatus.style.color = '#3fb950';
  setTimeout(() => { srvSaveStatus.textContent = ''; }, 2500);
});

// Capture uid from user-data — init tokens, presence, friends
if ((window as any).electron) {
  (window as any).electron.onUserData((d: any) => {
    if (d.uid && d.uid !== myUid) {
      myUid = d.uid;
      initTokens(myUid);
      initPresence(myUid);
      initFriends(myUid);
    }
  });
}

srvMemSlider?.addEventListener('input', () => { srvMemVal.textContent = srvMemSlider.value; });

function srvAddLog(text: string) {
  const lines = text.split('\n').filter(l => l.trim());
  lines.forEach(l => {
    srvLogLines.push(l);
    if (srvLogLines.length > 300) srvLogLines.shift();
    const div = document.createElement('div');
    div.style.lineHeight = '1.6';
    div.style.color = l.includes('ERROR') || l.includes('WARN') ? '#d29922'
                    : l.includes('[Host]') ? '#79c0ff' : '#6e7681';
    div.textContent = l;
    srvLog.appendChild(div);
  });
  // Remove placeholder
  const placeholder = srvLog.querySelector('div[style*="30363d"]');
  if (placeholder) placeholder.remove();
  srvLog.scrollTop = srvLog.scrollHeight;
}

srvLogCopy?.addEventListener('click', () => copyToClipboard(srvLogLines.join('\n'), srvLogCopy));

// Send command to server
srvCmdBtn?.addEventListener('click', () => {
  const cmd = srvCmdInput.value.trim();
  if (!cmd || !server) return;
  server.command(cmd);
  srvAddLog(`> ${cmd}`);
  srvCmdInput.value = '';
});
srvCmdInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') srvCmdBtn.click(); });

// Fetch public IP via ipify
async function getPublicIP(): Promise<string> {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const d = await r.json();
    return d.ip || 'unknown';
  } catch { return 'unknown'; }
}

// Publish server to Firebase RTDB
async function publishServer(name: string, version: string, address: string) {
  if (!myUid) return;
  try {
    await set(ref(rtdb, `mc_servers/${myUid}`), {
      name, version, address, port: 25565,
      online: true, publish: srv247Toggle.checked,
      startedAt: serverTimestamp(),
      owner: userName.textContent || 'Player',
    });
  } catch {}
}

async function unpublishServer() {
  if (!myUid) return;
  try {
    await set(ref(rtdb, `mc_servers/${myUid}/online`), false);
    if (!srv247Toggle.checked) await set(ref(rtdb, `mc_servers/${myUid}/publish`), false);
  } catch {}
}

// Populate server version dropdown from Mojang manifest
async function loadServerVersions() {
  const sel = document.getElementById('srv-version') as HTMLSelectElement;
  if (!sel || sel.options.length > 1) return; // already loaded
  try {
    const res  = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const data = await res.json() as { versions: { id: string; type: string }[] };
    const releases = data.versions.filter(v => v.type === 'release' && isJava21Compatible(v.id));
    sel.innerHTML = '';
    releases.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = i === 0 ? `${v.id} — Latest` : v.id;
      sel.appendChild(opt);
    });
  } catch {
    // Static fallback if Mojang API is unreachable
    const fallback = ['26.1.2','26.1.1','26.1','1.21.11','1.21.5','1.21.4','1.20.4','1.19.4'];
    sel.innerHTML = '';
    fallback.forEach((id, i) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = i === 0 ? `${id} — Latest` : id;
      sel.appendChild(opt);
    });
  }
}

// Load community servers from Firebase RTDB (online OR 24/7 published)
function loadCommunityServers() {
  renderSavedServers();
  try {
    onValue(ref(rtdb, 'mc_servers'), snap => {
      const data = snap.val() as Record<string, any> | null;
      communityEl.innerHTML = '';
      if (!data) {
        communityEl.innerHTML = '<div style="color:#30363d;font-size:12px;">No servers listed</div>';
        return;
      }
      const visible = Object.values(data).filter(s => s.online || s.publish);
      if (!visible.length) {
        communityEl.innerHTML = '<div style="color:#30363d;font-size:12px;">No servers listed</div>';
        return;
      }
      visible.forEach(s => {
        const isOnline = !!s.online;
        const card = document.createElement('div');
        card.className = 'mod-card';
        card.style.cursor = 'default';
        card.innerHTML = `
          <div class="mod-icon" style="font-size:20px;">🖥️</div>
          <div class="mod-info">
            <div class="mod-name">${s.name || 'Unnamed Server'}</div>
            <div class="mod-desc">${s.owner || 'Unknown'} · ${s.version || '?'}</div>
            <div class="mod-tags" style="margin-top:6px;">
              <span class="mod-tag ${isOnline ? 'util' : ''}">${isOnline ? '🟢 Online' : '⚫ Offline'}</span>
              ${s.publish ? '<span class="mod-tag perf">24/7</span>' : ''}
            </div>
          </div>
          <div class="mod-right">
            <span style="font-family:monospace;font-size:11px;color:${isOnline ? '#3fb950' : '#484f58'};background:rgba(${isOnline ? '63,185,80' : '255,255,255'},0.06);border:1px solid rgba(${isOnline ? '63,185,80' : '255,255,255'},0.12);padding:4px 10px;border-radius:6px;">${s.address || '—'}:${s.port || 25565}</span>
          </div>`;
        communityEl.appendChild(card);
      });
    });
  } catch {}
}

// Start/stop server
srvStartBtn?.addEventListener('click', async () => {
  if (!server) return;

  if (srvRunning) {
    // Stop
    srvStartBtn.disabled = true;
    srvStartBtn.textContent = '⏹ Stopping…';
    await server.stop();
    return;
  }

  const name    = (document.getElementById('srv-name') as HTMLInputElement).value.trim() || 'My Server';
  const version = (document.getElementById('srv-version') as HTMLSelectElement).value;
  const maxMem  = parseInt(srvMemSlider.value, 10);

  srvRunning = true;
  srvStartBtn.style.background = 'linear-gradient(135deg,#8b1a1a,#da3633)';
  srvStartBtn.style.borderColor = '#f85149';
  srvStartBtn.textContent = '⏳ Starting…';
  srvLog.innerHTML = '';
  srvLogLines = [];

  const res = await server.start({ version, maxMem, name });
  if (!res.ok) {
    srvAddLog(`[Error] ${res.error}`);
    srvRunning = false;
    srvStartBtn.style.background = 'linear-gradient(135deg,#238636,#2ea043)';
    srvStartBtn.style.borderColor = '#3fb950';
    srvStartBtn.textContent = '▶ Start Server Locally';
    srvStartBtn.disabled = false;
    return;
  }

  // Show info panel + get public IP
  srvInfo.style.display = 'block';
  srvVerDisplay.textContent = version;
  srvAddress.textContent = 'Getting IP…';
  srvStartBtn.textContent = '⏹ Stop Server';
  srvStartBtn.disabled = false;

  const manualIp = srvIpInput.value.trim();
  const ip = manualIp || await getPublicIP();
  if (!manualIp) srvIpInput.value = ip; // fill in auto-detected IP
  srvAddress.textContent = `${ip}:25565`;
  await publishServer(name, version, ip);
});

// Handle server log events
if (server) {
  server.onLog((line: string) => srvAddLog(line));
  server.onClosed((_code: number) => {
    srvRunning = false;
    srvInfo.style.display = 'none';
    srvStartBtn.style.background = 'linear-gradient(135deg,#238636,#2ea043)';
    srvStartBtn.style.borderColor = '#3fb950';
    srvStartBtn.textContent = '▶ Start Server Locally';
    srvStartBtn.disabled = false;
    srvAddLog('[Host] Server stopped.');
    unpublishServer();
  });
}

// ── Auto-updater UI ────────────────────────────────────────────────────────────
const updater = (window as any).updater;
if (updater) {
  const banner         = document.getElementById('update-banner')!;
  const updateText     = document.getElementById('update-text')!;
  const progressWrap2  = document.getElementById('update-progress-wrap')!;
  const progressBar2   = document.getElementById('update-progress-bar')!;
  const installBtn     = document.getElementById('update-install-btn')!;
  const checkBtn       = document.getElementById('check-updates-btn') as HTMLButtonElement | null;
  const restartBtn     = document.getElementById('restart-update-btn') as HTMLButtonElement | null;
  const titlebarUpdate = document.getElementById('titlebar-update-btn') as HTMLButtonElement | null;
  const updateSub      = document.getElementById('update-settings-sub');

  function enableRestartButtons(label = '↺ Restart & Update') {
    if (restartBtn) {
      restartBtn.disabled = false;
      restartBtn.style.cursor = 'pointer';
      restartBtn.style.opacity = '1';
      restartBtn.textContent = label;
      restartBtn.onclick = () => updater.install();
    }
    if (titlebarUpdate) {
      titlebarUpdate.style.display = 'inline-block';
      titlebarUpdate.onclick = () => updater.install();
    }
  }

  updater.onChecking(() => {
    if (checkBtn) { checkBtn.textContent = 'Checking…'; checkBtn.disabled = true; }
    if (updateSub) updateSub.textContent = 'Checking for updates…';
  });
  updater.onNotAvailable(() => {
    if (checkBtn) { checkBtn.textContent = 'Up to date ✓'; setTimeout(() => { checkBtn.textContent = 'Check for Updates'; checkBtn.disabled = false; }, 2500); }
    if (updateSub) updateSub.textContent = 'You\'re on the latest version';
    setTimeout(() => { if (updateSub) updateSub.textContent = 'Updates download automatically in the background'; }, 3000);
  });
  updater.onAvailable((ver: string) => {
    banner.style.display = 'flex';
    updateText.textContent = `⬇ Update v${ver} downloading…`;
    progressWrap2.style.display = 'block';
    if (checkBtn) { checkBtn.textContent = 'Downloading…'; checkBtn.disabled = true; }
    if (updateSub) updateSub.textContent = `Downloading v${ver}…`;
  });
  updater.onProgress((pct: number) => {
    progressBar2.style.width = `${pct}%`;
    updateText.textContent = `⬇ Downloading update… ${pct}%`;
    if (updateSub) updateSub.textContent = `Downloading update… ${pct}%`;
  });
  updater.onDownloaded(() => {
    progressWrap2.style.display = 'none';
    updateText.textContent = '✅ Update ready — restart to apply';
    installBtn.style.display = 'inline-block';
    if (checkBtn) { checkBtn.textContent = 'Check for Updates'; checkBtn.disabled = false; }
    if (updateSub) updateSub.textContent = '✅ Update downloaded — click Restart & Update to apply';
    enableRestartButtons();
  });

  installBtn.addEventListener('click', () => updater.install());
  checkBtn?.addEventListener('click', () => updater.check());
}
