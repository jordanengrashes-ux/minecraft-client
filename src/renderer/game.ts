// Launcher logic — no Three.js, just UI wiring for Minecraft launch

import { ref, set, push, remove, onValue, onChildAdded, query, limitToLast, serverTimestamp, onDisconnect, update, get, increment } from 'firebase/database';
import { rtdb } from './firebase';


const mc     = (window as any).mc;
const server = (window as any).server;

// ── DOM ────────────────────────────────────────────────────────────────────────
const userName      = document.getElementById('user-name')!;
const mcIgnBadge    = document.getElementById('mc-username-badge')!;
const mcIgnSpan     = document.getElementById('mc-ign')!;
const mcAuthBtn     = document.getElementById('mc-auth-btn') as HTMLButtonElement;
const mcPlayBtn     = document.getElementById('mc-play-btn') as HTMLButtonElement;
const mcVersion     = document.getElementById('mc-version') as HTMLSelectElement;
const javaVersionSel = document.getElementById('java-version') as HTMLSelectElement;
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

declare const __APP_VERSION__: string;
const appVersionEl = document.getElementById('app-version');
if (appVersionEl) appVersionEl.textContent = `v${__APP_VERSION__}`;

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

const mcSwitchBtn = document.getElementById('mc-switch-btn') as HTMLButtonElement | null;

function setMcAuthed(name: string) {
  authed = true;
  mcAuthBtn.textContent = `Logged in as ${name}`;
  mcAuthBtn.classList.add('authed');
  if (mcSwitchBtn) mcSwitchBtn.style.display = 'block';
  mcIgnSpan.textContent = name;
  mcIgnBadge.style.display = 'inline-block';
  mcPlayBtn.disabled = false;
  setStatus(`Authenticated as ${name}`, 'green');
  if (myUid) registerUserIndex(myUid, name);
}

function clearMcAuthed() {
  authed = false;
  mcPlayBtn.disabled = true;
  mcAuthBtn.textContent = 'Login with Microsoft to Play';
  mcAuthBtn.classList.remove('authed');
  if (mcSwitchBtn) mcSwitchBtn.style.display = 'none';
  mcIgnBadge.style.display = 'none';
}

// ── Cached MC auth (no login needed) ──────────────────────────────────────────
if (mc) {
  mc.onAlreadyAuthed((name: string) => {
    setMcAuthed(name);
  });
}

mcSwitchBtn?.addEventListener('click', async () => {
  if (!mc) return;
  clearMcAuthed();
  setStatus('Opening Microsoft login…', 'yellow');
  const res = await mc.reauth();
  if (res?.ok) {
    setMcAuthed(res.username);
  } else {
    setStatus(`Auth failed: ${res?.error || 'Cancelled'}`, 'red');
  }
});

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
  const jSel = javaVersionSel?.value ?? 'auto';
  // Java 8 or Auto can run any MC version; 17/21/25 require 1.17+
  const noFilter = jSel === '8' || jSel === 'auto';
  const filtered = allVersions.filter(v =>
    noFilter
      ? (v.type === 'release' || (showSnapshots && v.type === 'snapshot'))
      : ((v.type === 'release' && isJava21Compatible(v.id)) ||
         (showSnapshots && v.type === 'snapshot' && isJava21Compatible(v.id)))
  );
  const prev = localStorage.getItem('voxel_mc_version') || mcVersion.value;
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
javaVersionSel.addEventListener('change', () => {
  localStorage.setItem('voxel_java_version', javaVersionSel.value);
  populateVersions();
});
mcVersion.addEventListener('change', () => localStorage.setItem('voxel_mc_version', mcVersion.value));

// ── Memory slider ──────────────────────────────────────────────────────────────
mcMemory.addEventListener('input', () => {
  mcMemoryVal.textContent = mcMemory.value;
  localStorage.setItem('voxel_mc_memory', mcMemory.value);
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
  btn.style.color = '#f5a623';
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
const offlineBanner   = document.getElementById('offline-banner')!;

function applyOfflineState(on: boolean) {
  offlineNameRow.style.display   = on ? 'block'  : 'none';
  mcAuthBtn.style.display        = on ? 'none'   : 'block';
  offlineBanner.style.display    = on ? 'block'  : 'none';
  if (on) {
    mcPlayBtn.disabled = false;
    setStatus('Offline mode — only LAN/offline servers work', 'yellow');
  } else {
    mcPlayBtn.disabled = !authed;
    setStatus(authed ? `Authenticated as ${mcIgnSpan.textContent}` : 'Ready', authed ? 'green' : '');
  }
  localStorage.setItem('voxel_offline_mode', String(on));
}

offlineToggle.addEventListener('change', () => applyOfflineState(offlineToggle.checked));

// ── Mods badge (shows installed mod count near the Fabric toggle) ─────────────
const modsBadge = document.getElementById('mods-badge') as HTMLElement;

function updateModsBadge() {
  const count = Object.keys(loadInstalledMods()).length;
  if (count === 0) { modsBadge.style.display = 'none'; return; }
  modsBadge.style.display    = 'inline-block';
  const fabricOn = fabricToggle.checked;
  modsBadge.textContent     = fabricOn
    ? `✓ ${count} mod${count !== 1 ? 's' : ''} ready`
    : `${count} mod${count !== 1 ? 's' : ''} installed — enable Fabric above`;
  modsBadge.style.color      = fabricOn ? '#f5a623'                  : '#f6c356';
  modsBadge.style.background = fabricOn ? 'rgba(245,166,35,0.10)'     : 'rgba(246,195,86,0.10)';
  modsBadge.style.borderColor= fabricOn ? 'rgba(245,166,35,0.30)'     : 'rgba(246,195,86,0.35)';
}

fabricToggle.addEventListener('change', () => {
  localStorage.setItem('voxel_fabric_on', String(fabricToggle.checked));
  updateModsBadge();
});

// ── Restore saved settings on launch ─────────────────────────────────────────
{
  const savedFabric  = localStorage.getItem('voxel_fabric_on')    === 'true';
  const savedOffline = localStorage.getItem('voxel_offline_mode') === 'true';
  if (savedFabric)  fabricToggle.checked = true;
  if (savedOffline) { offlineToggle.checked = true; applyOfflineState(true); }
  const savedMemory = localStorage.getItem('voxel_mc_memory');
  if (savedMemory) { mcMemory.value = savedMemory; mcMemoryVal.textContent = savedMemory; }
  const savedJava = localStorage.getItem('voxel_java_version');
  if (savedJava && javaVersionSel) javaVersionSel.value = savedJava;
  updateModsBadge();
}

// ── Sync localStorage with actual mods on disk ────────────────────────────────
// Removes entries from the installed-mods map when the JAR is no longer on disk
// (e.g. after Repair Game or manual deletion) so the UI reflects reality.
async function syncModsWithDisk() {
  if (!mc?.listMods) return;
  try {
    const diskFiles: string[] = await mc.listMods();
    const installed = loadInstalledMods();
    let changed = false;
    for (const slug of Object.keys(installed)) {
      if (!diskFiles.includes(installed[slug].filename)) {
        delete installed[slug];
        enabledMods.delete(slug);
        changed = true;
      }
    }
    if (changed) { saveInstalledMods(installed); updateModsBadge(); }
  } catch {}
}
// Delay slightly so the window finishes loading before the IPC round-trip
setTimeout(syncModsWithDisk, 1500);

// ── Microsoft auth ─────────────────────────────────────────────────────────────
mcAuthBtn.addEventListener('click', async () => {
  if (!mc) { setStatus('Not running in Electron', 'red'); return; }
  mcAuthBtn.disabled = true;
  setStatus('Opening Microsoft login…', 'yellow');
  const res = await mc.auth();
  mcAuthBtn.disabled = false;
  if (res.ok) {
    setMcAuthed(res.username);
  } else {
    setStatus(`Auth failed: ${res.error}`, 'red');
    addLog(`Auth error: ${res.error}`, 'error');
  }
});

function getEffectiveJavaVersion(): number {
  const sel = javaVersionSel?.value ?? 'auto';
  if (sel !== 'auto') return parseInt(sel, 10);
  // Auto: pick based on MC version
  const id = mcVersion.value;
  const m = id.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const maj = parseInt(m[1]);
  if (maj !== 1) return 25;             // year-based (26.x.x …) → Java 25
  const min = parseInt(m[2]);
  const patch = m[3] ? parseInt(m[3]) : 0;
  if (min < 17) return 8;
  if (min < 21) return 17;
  if (min === 21 && patch <= 11) return 21;
  return 25;                            // 1.21.12+ and 1.22+ → Java 25
}

// ── Launch ─────────────────────────────────────────────────────────────────────
mcPlayBtn.addEventListener('click', async () => {
  if (!mc) return;
  if (running) return;

  let version = mcVersion.value;
  const maxMem = parseInt(mcMemory.value, 10);
  const javaVersion = getEffectiveJavaVersion();

  running = true;
  mcPlayBtn.disabled = true;
  mcPlayBtn.classList.add('running');
  mcPlayBtn.textContent = 'Launching…';
  mcForceQuitBtn.style.display = 'inline-flex';
  setStatus(`Launching Minecraft ${version}…`, 'yellow');
  setProgress(0);
  logToggle.style.display = 'inline';
  openLog();

  // Install Fabric if toggled on
  if (fabricToggle.checked) {
    fabricStatus.textContent = 'Installing Fabric…';
    fabricStatus.style.color = '#f5a623';
    const fab = await mc.installFabric({ mcVersion: version });
    if (fab.ok) {
      version = fab.fabricVersion; // launch with fabric version id
      fabricStatus.textContent = `Fabric ${fab.loaderVersion}`;
      fabricStatus.style.color = '#f5a623';
    } else {
      fabricStatus.textContent = `Fabric install failed — launching vanilla`;
      fabricStatus.style.color = '#f6c356';
    }
  }

  addLog(`Launching Minecraft ${version} with ${maxMem}GB RAM, Java ${javaVersion}…`);

  const res = offlineToggle.checked
    ? await mc.launchOffline({ version, maxMem, username: offlineUsername.value.trim() || 'Player', javaVersion })
    : await mc.launch({ version, maxMem, javaVersion });
  if (!res.ok) {
    setStatus(`Launch failed: ${res.error}`, 'red');
    addLog(`Error: ${res.error}`, 'error');
    resetPlay();
  }
});

mcForceQuitBtn.addEventListener('click', async () => {
  mcForceQuitBtn.disabled = true;
  mcForceQuitBtn.textContent = 'Killing…';
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
      mcPlayBtn.textContent = 'Running';
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

      addLog(`Crash: ${reason}`, 'error');
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
const contentEl           = document.getElementById('content')!;
const bedrockPanelEl      = document.getElementById('bedrock-panel')!;
const modsPanelEl         = document.getElementById('mods-panel')!;
const pvpPanelEl          = document.getElementById('pvp-panel')!;
const bedrockModsPanelEl  = document.getElementById('bedrock-mods-panel')!;
const resourcePacksPanelEl= document.getElementById('resourcepacks-panel')!;
const skinsPanelEl        = document.getElementById('skins-panel')!;
const screenshotsPanelEl  = document.getElementById('screenshots-panel')!;
const accountsPanelEl     = document.getElementById('accounts-panel')!;
const customizePanelEl    = document.getElementById('customize-panel')!;
const settingsPanelEl     = document.getElementById('settings-panel')!;
const navPlay             = document.getElementById('nav-play')!;
const navBedrock          = document.getElementById('nav-bedrock')!;
const navMods             = document.getElementById('nav-mods')!;
const navPvp              = document.getElementById('nav-pvp')!;
const navBedrockMods      = document.getElementById('nav-bedrock-mods')!;
const navResourcePacks    = document.getElementById('nav-resourcepacks')!;
const navSkins            = document.getElementById('nav-skins')!;
const navScreenshots      = document.getElementById('nav-screenshots')!;
const navAccounts         = document.getElementById('nav-accounts')!;
const navFiles            = document.getElementById('nav-files')!;
const filesPanelEl        = document.getElementById('files-panel')!;
const navCustomize        = document.getElementById('nav-customize')!;
const navSettings         = document.getElementById('nav-settings')!;
const navServer         = document.getElementById('nav-server')!;
const navCosmetics      = document.getElementById('nav-cosmetics')!;
const navFriends        = document.getElementById('nav-friends')!;
const serverPanelEl     = document.getElementById('server-panel')!;
const cosmeticsPanelEl  = document.getElementById('cosmetics-panel')!;
const friendsPanelEl    = document.getElementById('friends-panel')!;
const chatPanelEl = document.getElementById('chat-panel')!;
const navChat     = document.getElementById('nav-chat')!;
const aiPanelEl   = document.getElementById('ai-panel')!;
const navAi       = document.getElementById('nav-ai')!;
const allPanels = [contentEl, bedrockPanelEl, modsPanelEl, pvpPanelEl, bedrockModsPanelEl, resourcePacksPanelEl, skinsPanelEl, screenshotsPanelEl, accountsPanelEl, filesPanelEl, serverPanelEl, cosmeticsPanelEl, friendsPanelEl, customizePanelEl, settingsPanelEl, chatPanelEl, aiPanelEl];
const allNavs   = [navPlay, navBedrock, navMods, navPvp, navBedrockMods, navResourcePacks, navSkins, navScreenshots, navAccounts, navFiles, navServer, navCosmetics, navFriends, navCustomize, navSettings, navChat, navAi];

function showPanel(panel: HTMLElement, nav: HTMLElement) {
  allPanels.forEach(p => p.style.display = 'none');
  allNavs.forEach(n => n.classList.remove('active'));
  panel.style.display = 'flex';
  nav.classList.add('active');
}
navPlay          .addEventListener('click', () => showPanel(contentEl,             navPlay));
navBedrock       .addEventListener('click', () => { showPanel(bedrockPanelEl,      navBedrock); initBedrock(); if (!bedrockPanelEl.dataset.loaded) { searchBedrockAddons(''); bedrockPanelEl.dataset.loaded = '1'; } });
navMods          .addEventListener('click', () => { showPanel(modsPanelEl,         navMods); if (!modsPanelEl.dataset.loaded) { loadRecommendedMods(); modsPanelEl.dataset.loaded = '1'; } });
navPvp           .addEventListener('click', () => { showPanel(pvpPanelEl,          navPvp); if (!pvpPanelEl.dataset.loaded) { initPvpMods(); pvpPanelEl.dataset.loaded = '1'; } });
navBedrockMods   .addEventListener('click', () => { showPanel(bedrockModsPanelEl,  navBedrockMods); if (!bedrockModsPanelEl.dataset.loaded) { searchBedrockMods(''); bedrockModsPanelEl.dataset.loaded = '1'; } });
navResourcePacks .addEventListener('click', () => { showPanel(resourcePacksPanelEl,navResourcePacks); if (!resourcePacksPanelEl.dataset.loaded) { initResourcePacks(); resourcePacksPanelEl.dataset.loaded = '1'; } });
navSkins         .addEventListener('click', () => { showPanel(skinsPanelEl,        navSkins); if (!skinsPanelEl.dataset.loaded) { initSkins(); skinsPanelEl.dataset.loaded = '1'; } });
navScreenshots   .addEventListener('click', () => { showPanel(screenshotsPanelEl,  navScreenshots); if (!screenshotsPanelEl.dataset.loaded) { initScreenshots(); screenshotsPanelEl.dataset.loaded = '1'; } });
navAccounts      .addEventListener('click', () => { showPanel(accountsPanelEl,     navAccounts); if (!accountsPanelEl.dataset.loaded) { initAccounts(); accountsPanelEl.dataset.loaded = '1'; } });
navFiles         .addEventListener('click', () => { showPanel(filesPanelEl,        navFiles);  if (!filesPanelEl.dataset.loaded)  { initFiles(); filesPanelEl.dataset.loaded = '1'; } });
navServer        .addEventListener('click', () => { showPanel(serverPanelEl,       navServer); if (!serverPanelEl.dataset.loaded) { loadServerVersions(); loadCommunityServers(); serverPanelEl.dataset.loaded = '1'; } });
navCosmetics     .addEventListener('click', () => { showPanel(cosmeticsPanelEl,    navCosmetics); if (!cosmeticsPanelEl.dataset.loaded) { initCosmetics(); cosmeticsPanelEl.dataset.loaded = '1'; } });
navFriends       .addEventListener('click', () => { showPanel(friendsPanelEl,      navFriends);   if (!friendsPanelEl.dataset.loaded) { initFriendsPanel(); friendsPanelEl.dataset.loaded = '1'; } });
navCustomize     .addEventListener('click', () => { showPanel(customizePanelEl,    navCustomize); if (!customizePanelEl.dataset.loaded) { initCustomize(); searchTexturePacks(''); customizePanelEl.dataset.loaded = '1'; } });
navSettings      .addEventListener('click', () => showPanel(settingsPanelEl,       navSettings));

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
    bedrockLaunchBtn.textContent = 'Launching…';
    const res = await mc.launchBedrock();
    bedrockLaunchBtn.disabled = false;
    if (res.ok) {
      bedrockLaunchBtn.textContent = 'Bedrock launched!';
      bedrockIcon.textContent = '';
      bedrockStatusText.textContent = 'Minecraft Bedrock Edition launched';
      bedrockStatusSub.textContent = 'The game should open shortly';
      setTimeout(() => { bedrockLaunchBtn.textContent = 'Launch Bedrock Edition'; }, 3000);
    } else if (res.notInstalled) {
      bedrockIcon.textContent = '';
      bedrockStatusText.textContent = 'Bedrock not installed';
      bedrockStatusSub.textContent = 'Opening Microsoft Store to purchase/install Minecraft for Windows…';
      bedrockLaunchBtn.textContent = 'Get Bedrock Edition';
    } else {
      bedrockStatusText.textContent = `Error: ${res.error}`;
      bedrockLaunchBtn.textContent = 'Launch Bedrock Edition';
    }
  });

  // Check install status without launching
  if (mc?.launchBedrock) {
    bedrockIcon.textContent = '';
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
        ? `<img src="${h.icon_url}" class="mod-icon-img" alt="" onerror="this.style.display='none'">`
        : `<div class="mod-icon"></div>`;
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
    bedrockAddonList.innerHTML = '<p style="color:#e05500;text-align:center;padding:16px">Could not reach Modrinth — check your connection</p>';
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
        ? `<img src="${h.icon_url}" class="mod-icon-img" alt="" onerror="this.style.display='none'">`
        : `<div class="mod-icon"></div>`;
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
    bedrockModsList.innerHTML = '<p style="color:#e05500;padding:20px;text-align:center">Could not reach Modrinth — check your connection</p>';
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

// ── AI key settings ───────────────────────────────────────────────────────────
{
  const ai = (window as any).ai;
  const keyInput  = document.getElementById('ai-key-input') as HTMLInputElement | null;
  const keySave   = document.getElementById('ai-key-save') as HTMLButtonElement | null;
  const keyStatus = document.getElementById('ai-key-status');
  if (ai && keyInput && keySave) {
    ai.getKey().then((masked: string) => {
      if (masked) { keyInput.placeholder = masked; if (keyStatus) keyStatus.textContent = 'Key saved'; }
    });
    keySave.addEventListener('click', async () => {
      const key = keyInput.value.trim();
      if (!key) return;
      await ai.setKey(key);
      keyInput.value = '';
      keyInput.placeholder = '••••' + key.slice(-4);
      if (keyStatus) { keyStatus.textContent = '✓ Saved'; keyStatus.style.color = '#f5a623'; }
    });
  }
}

// ── Reauth button ──────────────────────────────────────────────────────────────
document.getElementById('mc-reauth-btn')?.addEventListener('click', async () => {
  if (!mc) return;
  clearMcAuthed();
  setStatus('Opening Microsoft login…', 'yellow');
  const res = await mc.reauth();
  if (res?.ok) {
    setMcAuthed(res.username);
  } else {
    setStatus(`Auth failed: ${res?.error || 'Unknown error'}`, 'red');
  }
});

// ── In-game background (resource pack) ───────────────────────────────────────
async function installGameBg(statusEl: HTMLElement) {
  statusEl.textContent = 'Generating panorama…';
  statusEl.style.color = '#f6c356';

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
    statusEl.textContent = 'Installed — enable "VoxelClient" in Options › Resource Packs';
    statusEl.style.color = '#f5a623';
    localStorage.setItem('bg_installed', '1');
  } else {
    statusEl.textContent = res.error;
    statusEl.style.color = '#e05500';
  }
}

function initCustomize() {
  const toggle = document.getElementById('install-bg-toggle') as HTMLInputElement | null;
  const status = document.getElementById('install-bg-status') as HTMLElement | null;
  if (!toggle || !status) return;

  // Restore state
  if (localStorage.getItem('bg_installed') === '1') {
    toggle.checked = true;
    status.textContent = 'Installed — enable "VoxelClient" in Options › Resource Packs';
    status.style.color = '#f5a623';
  }

  toggle.addEventListener('change', async () => {
    if (toggle.checked) {
      toggle.disabled = true;
      await installGameBg(status);
      toggle.disabled = false;
      if (localStorage.getItem('bg_installed') !== '1') toggle.checked = false;
    } else {
      localStorage.removeItem('bg_installed');
      status.textContent = 'Background pack disabled';
      status.style.color = '#484f58';
    }
  });
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
      skinStatus.style.color = '#f5a623';
    };
    reader.readAsDataURL(file);
  };
  input.click();
});

skinApplyBtn.addEventListener('click', async () => {
  if (!mc || !skinBase64) return;
  skinApplyBtn.disabled = true;
  skinStatus.textContent = 'Uploading…';
  skinStatus.style.color = '#f6c356';
  const res = await mc.uploadSkin({ base64: skinBase64, variant: skinVariant });
  if (res.ok) {
    skinStatus.textContent = '✓ Skin applied!';
    skinStatus.style.color = '#f5a623';
  } else {
    skinStatus.textContent = `Failed: ${res.error}`;
    skinStatus.style.color = '#e05500';
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
    el.style.background = '#c07000';
    el.style.borderColor = '#f5a623';
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
      const icon = h.icon_url ? `<img src="${h.icon_url}" class="mod-icon-img" alt="">` : `<div class="mod-icon"></div>`;
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
    tpList.innerHTML = '<p style="color:#e05500;text-align:center;padding:16px">Could not reach Modrinth</p>';
  }
}

tpSearch.addEventListener('input', () => {
  if (tpTimer) clearTimeout(tpTimer);
  tpTimer = setTimeout(() => searchTexturePacks(tpSearch.value.trim()), 400);
});

// ── Installed mods (persisted) ────────────────────────────────────────────────
interface InstalledMod { filename: string; name: string; mcVersion?: string; disabled?: boolean; }
function loadInstalledMods(): Record<string, InstalledMod> {
  try { return JSON.parse(localStorage.getItem('voxel_installed_mods') || '{}'); } catch { return {}; }
}
function saveInstalledMods(data: Record<string, InstalledMod>) {
  localStorage.setItem('voxel_installed_mods', JSON.stringify(data));
}

// ── Installed modpacks (persisted) ───────────────────────────────────────────
interface InstalledModpack { projectId: string; title: string; mcVersion: string; filenames: string[] }
const INSTALLED_MODPACKS_KEY = 'voxel_installed_modpacks';
function loadInstalledModpacks(): Record<string, InstalledModpack> {
  try { return JSON.parse(localStorage.getItem(INSTALLED_MODPACKS_KEY) || '{}'); } catch { return {}; }
}
function saveInstalledModpacks(data: Record<string, InstalledModpack>) {
  localStorage.setItem(INSTALLED_MODPACKS_KEY, JSON.stringify(data));
}

// ── Modrinth mod search ────────────────────────────────────────────────────────
const enabledMods = new Set<string>(Object.keys(loadInstalledMods()));
const modsList    = document.getElementById('mods-list')!;
const modsSearch  = document.getElementById('mods-search') as HTMLInputElement;
const modsLoading = document.getElementById('mods-loading')!;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let modsTabType: 'mod' | 'modpack' = 'mod';
let modpackProgressEl: HTMLElement | null = null;
mc?.onModpackProgress?.((e: any) => {
  if (!modpackProgressEl) return;
  if (e.phase === 'fetching')    modpackProgressEl.textContent = '…';
  else if (e.phase === 'downloading') modpackProgressEl.textContent = `⬇ ${e.pct}%`;
  else if (e.phase === 'mods')        modpackProgressEl.textContent = `⬇ ${e.current}/${e.total}`;
});

const modsTypeSwitch = document.getElementById('mods-type-switch') as HTMLInputElement;
const modsLabelMods  = document.getElementById('mods-label-mods')!;
const modsLabelPacks = document.getElementById('mods-label-packs')!;

// Restore saved mods/modpacks tab choice
if (localStorage.getItem('voxel_mods_tab') === 'modpack') {
  modsTypeSwitch.checked = true; modsTabType = 'modpack';
  modsLabelMods.style.color = '#484f58'; modsLabelMods.style.fontWeight = '400';
  modsLabelPacks.style.color = '#f5a623'; modsLabelPacks.style.fontWeight = '700';
}

function setModsTab(type: 'mod' | 'modpack') {
  modsTabType = type;
  const isMod = type === 'mod';
  modsTypeSwitch.checked         = !isMod;
  modsLabelMods.style.color      = isMod  ? '#f5a623' : '#484f58';
  modsLabelMods.style.fontWeight = isMod  ? '700'     : '400';
  modsLabelPacks.style.color     = !isMod ? '#f5a623' : '#484f58';
  modsLabelPacks.style.fontWeight= !isMod ? '700'     : '400';
  modsSearch.placeholder = isMod ? 'Search mods…' : 'Search modpacks…';
  localStorage.setItem('voxel_mods_tab', type);
  searchModrinth(modsSearch.value.trim());
}

modsTypeSwitch.addEventListener('change', () => setModsTab(modsTypeSwitch.checked ? 'modpack' : 'mod'));
modsLabelMods .addEventListener('click',  () => setModsTab('mod'));
modsLabelPacks.addEventListener('click',  () => setModsTab('modpack'));

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
    ? `<img src="${mod.icon_url}" class="mod-icon-img" alt="" onerror="this.style.display='none'">`
    : `<div class="mod-icon"></div>`;

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
      statusEl.textContent = '…';
      statusEl.style.color = '#f6c356';
      try {
        const ver = mcVersion.value || '1.21.4';
        const params = new URLSearchParams({ game_versions: `["${ver}"]`, loaders: '["fabric"]', limit: '20' });
        const vRes = await fetch(`https://api.modrinth.com/v2/project/${mod.project_id}/version?${params}`);
        const searchData: any[] = await vRes.json();
        if (!Array.isArray(searchData) || !searchData.length) throw new Error(`No Fabric build for MC ${ver}`);
        const byVerNum2  = searchData.find((v: any) => typeof v.version_number === 'string' && v.version_number.includes(ver));
        const byExact2   = searchData.find((v: any) => Array.isArray(v.game_versions) && v.game_versions.length === 1 && v.game_versions[0] === ver);
        const chosenVer  = byVerNum2 ?? byExact2 ?? searchData[0];
        const file = chosenVer.files.find((f: any) => f.primary) ?? chosenVer.files[0];
        if (!file) throw new Error('No download file found');
        statusEl.textContent = '⬇';
        const res = await mc.installMod({ url: file.url, filename: file.filename });
        if (!res.ok) throw new Error(res.error);
        // Install required dependencies declared in the Modrinth version metadata
        const reqDeps = (chosenVer.dependencies || []).filter((d: any) => d.dependency_type === 'required' && d.project_id);
        const installedNow = loadInstalledMods();
        for (const dep of reqDeps) {
          if (installedNow[dep.project_id]) continue;
          try {
            statusEl.textContent = '⬇ dep';
            const dp = new URLSearchParams({ game_versions: `["${ver}"]`, loaders: '["fabric"]', limit: '5' });
            const dvRes = await fetch(`https://api.modrinth.com/v2/project/${dep.project_id}/version?${dp}`);
            const dvData: any[] = await dvRes.json();
            if (!Array.isArray(dvData) || !dvData.length) continue;
            const df = dvData[0].files.find((f: any) => f.primary) ?? dvData[0].files[0];
            if (!df) continue;
            const depRes = await mc.installMod({ url: df.url, filename: df.filename });
            if (depRes.ok) installedNow[dep.project_id] = { filename: df.filename, name: dep.project_id, mcVersion: ver };
          } catch {}
        }
        installedNow[mod.project_id] = { filename: file.filename, name: mod.title, mcVersion: ver } as any;
        saveInstalledMods(installedNow);
        enabledMods.add(mod.project_id);
        card.className = 'mod-card enabled';
        statusEl.textContent = '✓';
        statusEl.style.color = '#f5a623';
      } catch (err: any) {
        input.checked = false;
        card.className = 'mod-card';
        statusEl.textContent = '✗';
        statusEl.style.color = '#e05500';
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

  if (on) { statusEl.textContent = '✓'; statusEl.style.color = '#f5a623'; }
  return card;
}

function buildModpackCard(mod: ModrinthHit): HTMLElement {
  const packs = loadInstalledModpacks();
  const isInstalled = !!packs[mod.project_id];
  const card = document.createElement('div');
  card.className = 'mod-card' + (isInstalled ? ' enabled' : '');
  const iconHtml = mod.icon_url
    ? `<img src="${mod.icon_url}" class="mod-icon-img" alt="" onerror="this.style.display='none'">`
    : `<div class="mod-icon"></div>`;
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
    <div class="mod-right" style="gap:6px;">
      <div class="mod-version" style="color:${isInstalled ? '#f5a623' : 'transparent'}">${isInstalled ? '✓' : ''}</div>
      ${isInstalled ? `<button class="modpack-update-btn" style="padding:4px 10px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:11px;cursor:pointer;white-space:nowrap;">↻ Update</button>` : ''}
      <label class="toggle">
        <input type="checkbox" ${isInstalled ? 'checked' : ''} />
        <span class="toggle-slider"></span>
      </label>
    </div>`;

  const input     = card.querySelector('input') as HTMLInputElement;
  const statusEl  = card.querySelector('.mod-version') as HTMLElement;
  const updateBtn = card.querySelector('.modpack-update-btn') as HTMLButtonElement | null;

  updateBtn?.addEventListener('click', async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = '↻ …';
    statusEl.textContent = '…';
    statusEl.style.color = '#f6c356';
    modpackProgressEl = statusEl;
    try {
      const result = await mc.installModpack({ projectId: mod.project_id });
      if (!result.ok) throw new Error(result.error);
      const updated = loadInstalledModpacks();
      updated[mod.project_id] = { projectId: mod.project_id, title: mod.title, mcVersion: result.mcVersion, filenames: result.filenames };
      saveInstalledModpacks(updated);
      statusEl.textContent = '✓';
      statusEl.style.color = '#f5a623';
      updateBtn.textContent = '✓ Done';
      setTimeout(() => { updateBtn.textContent = '↻ Update'; updateBtn.disabled = false; }, 2000);
    } catch (err: any) {
      statusEl.textContent = '✗';
      statusEl.style.color = '#e05500';
      updateBtn.textContent = '✗ Failed';
      updateBtn.disabled = false;
    } finally {
      modpackProgressEl = null;
    }
  });

  input.addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked;
    input.disabled = true;
    if (checked) {
      statusEl.style.color = '#f6c356';
      statusEl.textContent = '…';
      modpackProgressEl = statusEl;
      try {
        // Remove any currently installed modpacks before installing this one
        const existing = loadInstalledModpacks();
        for (const pack of Object.values(existing)) {
          for (const filename of pack.filenames) {
            try { await mc.removeMod({ filename }); } catch {}
          }
        }
        saveInstalledModpacks({});

        const result = await mc.installModpack({ projectId: mod.project_id });
        if (!result.ok) throw new Error(result.error);
        const updated = loadInstalledModpacks();
        updated[mod.project_id] = { projectId: mod.project_id, title: mod.title, mcVersion: result.mcVersion, filenames: result.filenames };
        saveInstalledModpacks(updated);
        card.className = 'mod-card enabled';
        statusEl.textContent = '✓';
        statusEl.style.color = '#f5a623';
      } catch (err: any) {
        input.checked = false;
        card.className = 'mod-card';
        statusEl.textContent = '✗';
        statusEl.style.color = '#e05500';
        statusEl.title = err.message;
      } finally {
        modpackProgressEl = null;
      }
    } else {
      const updated = loadInstalledModpacks();
      const pack = updated[mod.project_id];
      if (pack) {
        for (const filename of pack.filenames) {
          try { await mc.removeMod({ filename }); } catch {}
        }
        delete updated[mod.project_id];
        saveInstalledModpacks(updated);
      }
      card.className = 'mod-card';
      statusEl.textContent = '';
      statusEl.style.color = 'transparent';
    }
    input.disabled = false;
  });

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
    modsList.innerHTML = '<p style="color:#e05500;padding:20px;text-align:center">Could not reach Modrinth — check your connection</p>';
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
    modsList.innerHTML = '<p style="color:#e05500;padding:20px;text-align:center">Could not reach Modrinth — check your connection</p>';
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
  deps?: string[];
  conflicts?: string[];
}

const PVP_MOD_GROUPS: { label: string; color: string; mods: PvpModDef[] }[] = [
  {
    label: 'Required',
    color: '#f6c356',
    mods: [
      { slug: 'fabric-api',            emoji: '🔧', name: 'Fabric API',           desc: 'Required dependency — all Fabric mods need this', group: 'Utility' },
    ],
  },
  {
    label: 'HUD & Info',
    color: '#f5a623',
    mods: [
      { slug: 'keystrokes',            emoji: '⌨️', name: 'Keystrokes',           desc: 'Live WASD + CPS overlay (Feather Keystrokes)', group: 'HUD' },
      { slug: 'appleskin',             emoji: '🍎', name: 'AppleSkin',            desc: 'Saturation & exhaustion on the hunger bar', group: 'HUD' },
      { slug: 'armor-status',          emoji: '🛡️', name: 'Armor Status',         desc: 'Armor & held item durability HUD', group: 'HUD' },
      { slug: 'status-effect-bars',    emoji: '🧪', name: 'Status Effect Bars',   desc: 'Duration bars under every active potion effect', group: 'HUD' },
      { slug: 'coordinates-display',   emoji: '📍', name: 'Coordinates',          desc: 'Clean XYZ + direction overlay — no F3 needed', group: 'HUD' },
      { slug: 'xaeros-minimap',        emoji: '🗺️', name: "Xaero's Minimap",     desc: 'Minimap with player dots & waypoints', group: 'HUD' },
      { slug: 'xaeros-world-map',      emoji: '🌍', name: "Xaero's World Map",    desc: 'Full world map — works with Xaero\'s Minimap', group: 'HUD', deps: ['xaeros-minimap'] },
      { slug: 'betterf3',              emoji: '📊', name: 'BetterF3',             desc: 'Color-coded F3 with FPS, ping & TPS (Feather HUD)', group: 'HUD' },
      { slug: 'zoomify',               emoji: '🔍', name: 'Zoomify',              desc: 'OptiFine-style smooth zoom key (Feather Zoom)', group: 'HUD' },
      { slug: 'ping-wheel',            emoji: '📡', name: 'Ping Wheel',           desc: 'Quick radial ping menu to mark locations (like Apex)', group: 'HUD' },
      { slug: 'fps-display',           emoji: '🖥️', name: 'FPS Display',          desc: 'Simple corner FPS counter overlay', group: 'HUD' },
      { slug: 'held-item-info',        emoji: 'ℹ️', name: 'Held Item Info',       desc: 'Shows name & enchantments of held item', group: 'HUD' },
    ],
  },
  {
    label: 'Visual',
    color: '#f5a623',
    mods: [
      { slug: 'custom-crosshair-mod',  emoji: '🎯', name: 'Custom Crosshair',    desc: 'Crosshair style, size, color & gap (Feather Crosshair)', group: 'Visual' },
      { slug: 'natural-motion-blur',   emoji: '💨', name: 'Motion Blur',         desc: 'Smooth camera motion blur (Feather Motion Blur)', group: 'Visual' },
      { slug: 'not-enough-animations', emoji: '🏃', name: 'Not Enough Animations',desc: 'Restores eating, bow & item animations', group: 'Visual' },
      { slug: 'damage-tilt',           emoji: '💥', name: 'Damage Tilt',         desc: 'Screen tilts when you take damage (Feather)', group: 'Visual' },
      { slug: '3dskinlayers',          emoji: '🧍', name: '3D Skin Layers',      desc: 'Renders skin as 3D geometry like Feather Client', group: 'Visual' },
      { slug: 'blur',                  emoji: '🌫️', name: 'Blur',               desc: 'Blurs the background when a menu is open', group: 'Visual' },
      { slug: 'cit-resewn',            emoji: '🎨', name: 'CIT Resewn',          desc: 'Custom Item Textures — rename items to change their look', group: 'Visual' },
      { slug: 'model-fix',             emoji: '🔲', name: 'Model Fix',           desc: 'Fixes gaps in held items & armor (like OptiFine)', group: 'Visual' },
      { slug: 'entity-model-features', emoji: '🐾', name: 'Entity Model Features',desc: 'Custom entity models from resource packs (EMF)', group: 'Visual', deps: ['entity-texture-features'] },
      { slug: 'entity-texture-features',emoji: '🖼️', name: 'Entity Texture Features',desc: 'Random & custom entity textures (ETF)', group: 'Visual' },
      { slug: 'continuity',            emoji: '🧱', name: 'Continuity',          desc: 'Connected textures like OptiFine (glass, bookshelves)', group: 'Visual', deps: ['indium'] },
      { slug: 'lambdynamiclights',     emoji: '💡', name: 'Dynamic Lights',      desc: 'Held torches & glowstone light up surroundings', group: 'Visual' },
    ],
  },
  {
    label: 'Utility',
    color: '#f5a623',
    mods: [
      { slug: 'sprinthop',             emoji: '🏃', name: 'Toggle Sprint',       desc: 'Toggle sprint & sneak — no need to hold Ctrl', group: 'Utility' },
      { slug: 'no-chat-reports',       emoji: '🔇', name: 'No Chat Reports',     desc: 'Removes chat signing — blocks Microsoft reports', group: 'Utility' },
      { slug: 'item-highlighter',      emoji: '🔆', name: 'Item Highlighter',    desc: 'Highlights newly picked up items in hotbar', group: 'Utility' },
      { slug: 'shulkerboxtooltip',     emoji: '📦', name: 'Shulker Tooltips',    desc: 'Preview shulker box contents on hover', group: 'Utility' },
      { slug: 'perspectivemod',        emoji: '📷', name: 'Perspective Mod',     desc: 'Feather Freelook — look around without turning body', group: 'Utility' },
      { slug: 'mousewheelie',          emoji: '🖱️', name: 'Mouse Wheelie',       desc: 'Scroll to move items between inventory & chest', group: 'Utility' },
      { slug: 'inventory-profiles-next',emoji: '🗂️', name: 'Inventory Profiles', desc: 'Auto-sort inventory, replace broken tools automatically', group: 'Utility' },
      { slug: 'chat-heads',            emoji: '💬', name: 'Chat Heads',          desc: 'Shows player skin head next to their chat message', group: 'Utility' },
      { slug: 'tooltipfix',            emoji: '🔤', name: 'ToolTip Fix',         desc: 'Stops tooltips from going off-screen', group: 'Utility' },
      { slug: 'reeses-sodium-options', emoji: '⚙️', name: 'Reese\'s Sodium Options',desc: 'Better settings screen for Sodium video options', group: 'Utility', deps: ['sodium'] },
      { slug: 'sodium-extra',          emoji: '➕', name: 'Sodium Extra',        desc: 'Extra options for Sodium (animations, particles)', group: 'Utility', deps: ['sodium'] },
    ],
  },
  {
    label: 'Performance',
    color: '#f97316',
    mods: [
      { slug: 'sodium',                emoji: '⚡', name: 'Sodium',              desc: 'Major FPS boost — better rendering engine', group: 'Performance' },
      { slug: 'lithium',               emoji: '🪨', name: 'Lithium',             desc: 'Game logic & tick optimizations', group: 'Performance' },
      { slug: 'iris',                  emoji: '🌈', name: 'Iris Shaders',        desc: 'Shader pack support (requires Sodium)', group: 'Performance', deps: ['sodium'] },
      { slug: 'entityculling',         emoji: '👁️', name: 'Entity Culling',      desc: 'Skip rendering entities behind walls', group: 'Performance' },
      { slug: 'memoryleakfix',         emoji: '🧠', name: 'Memory Leak Fix',     desc: 'Fixes Minecraft memory leaks — fewer crashes', group: 'Performance' },
      { slug: 'ferrite-core',          emoji: '💾', name: 'Ferrite Core',        desc: 'Reduces RAM usage of block states (Feather perf)', group: 'Performance' },
      { slug: 'indium',                emoji: '🔩', name: 'Indium',              desc: 'Sodium addon — enables Fabric Rendering API for other mods', group: 'Performance', deps: ['sodium'] },
      { slug: 'starlight',             emoji: '⭐', name: 'Starlight',           desc: 'Rewrites light engine for massive chunk load speedup', group: 'Performance', conflicts: ['c2me-fabric'] },
      { slug: 'c2me-fabric',           emoji: '🧵', name: 'C2ME',               desc: 'Multithreaded chunk generation & I/O', group: 'Performance', conflicts: ['starlight'] },
      { slug: 'noxesium',              emoji: '🚀', name: 'Noxesium',            desc: 'Reduces server-side lag on large servers', group: 'Performance' },
      { slug: 'immediatelyfast',       emoji: '💨', name: 'ImmediatelyFast',     desc: 'Optimizes immediate mode rendering (GUI, maps, text)', group: 'Performance' },
    ],
  },
];

const PVP_MOD_BY_SLUG = new Map<string, PvpModDef>(
  PVP_MOD_GROUPS.flatMap(g => g.mods).map(m => [m.slug, m])
);

async function installOneMod(mod: PvpModDef, ver: string): Promise<void> {
  async function queryModrinth(gameVer?: string): Promise<any[]> {
    const p: Record<string, string> = { loaders: '["fabric"]', limit: gameVer ? '20' : '50' };
    if (gameVer) p.game_versions = `["${gameVer}"]`;
    const r = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(mod.slug)}/version?${new URLSearchParams(p)}`);
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  }

  let data = await queryModrinth(ver);
  if (!data.length) {
    // Exact version returned nothing — fetch all fabric versions but only
    // accept builds that are tagged for exactly this MC version.
    // Do NOT use startsWith/prefix — that causes 26.x builds (Java 25+) to
    // be installed when the user is on 1.21.x (Java 21).
    const allData = await queryModrinth();
    const compat = allData.filter((v: any) =>
      Array.isArray(v.game_versions) && v.game_versions.includes(ver)
    );
    if (compat.length) data = compat;
  }
  if (!data.length) throw new Error(`No Fabric build found for ${mod.name} (MC ${ver})`);

  const byVerNum = data.find((v: any) => typeof v.version_number === 'string' && v.version_number.includes(ver));
  const chosen   = byVerNum ?? data[0];
  const file = chosen.files.find((f: any) => f.primary) ?? chosen.files[0];
  if (!file) throw new Error(`No download file for ${mod.name}`);
  const res = await mc.installMod({ url: file.url, filename: file.filename });
  if (!res.ok) throw new Error(res.error);
  const installed = loadInstalledMods();
  (installed[mod.slug] as any) = { filename: file.filename, name: mod.name, mcVersion: ver };
  saveInstalledMods(installed);
  enabledMods.add(mod.slug);
  updateModsBadge();
}

function buildPvpCard(mod: PvpModDef): HTMLElement {
  const on   = enabledMods.has(mod.slug);
  const card = document.createElement('div');
  card.className = 'mod-card' + (on ? ' enabled' : '');

  const installed = loadInstalledMods();
  const installedInfo = installed[mod.slug];
  const curVer = mcVersion.value;
  const wrongVer = on && !!installedInfo && (!installedInfo.mcVersion || installedInfo.mcVersion !== curVer);

  const depNames = (mod.deps || []).map(slug => PVP_MOD_BY_SLUG.get(slug)?.name ?? slug);
  const depsHtml = depNames.length
    ? `<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px;">${
        depNames.map(n => `<span style="font-size:10px;padding:2px 7px;border-radius:10px;background:#21262d;color:#8b949e;border:1px solid #30363d;">Needs: ${n}</span>`).join('')
      }</div>`
    : '';

  const verBadge = wrongVer
    ? `<span style="font-size:10px;color:#f6c356;background:rgba(246,195,86,0.12);border:1px solid rgba(246,195,86,0.3);border-radius:10px;padding:1px 6px;">v${installedInfo!.mcVersion}</span>`
    : on && installedInfo?.mcVersion
      ? `<span style="font-size:10px;color:#484f58;">v${installedInfo.mcVersion}</span>`
      : '';

  card.innerHTML = `
    <div class="mod-icon" style="background:none;"></div>
    <div class="mod-info">
      <div style="display:flex;align-items:center;gap:6px;">
        <div class="mod-name">${mod.name}</div>
        ${verBadge}
      </div>
      <div class="mod-desc">${mod.desc}</div>
      ${depsHtml}
      <div class="pvp-err" style="font-size:11px;color:#e05500;margin-top:4px;display:none;"></div>
    </div>
    <div class="mod-right">
      ${wrongVer ? '<button class="pvp-update-btn" style="padding:3px 9px;background:rgba(246,195,86,0.12);border:1px solid rgba(246,195,86,0.4);border-radius:5px;color:#f6c356;font-size:10px;font-weight:600;cursor:pointer;white-space:nowrap;">↻ Update</button>' : ''}
      <div class="mod-version" style="color:${on ? (wrongVer ? 'transparent' : '#f5a623') : 'transparent'}">${on && !wrongVer ? '✓' : ''}</div>
      <label class="toggle">
        <input type="checkbox" ${on ? 'checked' : ''} />
        <span class="toggle-slider"></span>
      </label>
    </div>`;

  const input    = card.querySelector('input') as HTMLInputElement;
  const statusEl = card.querySelector('.mod-version') as HTMLElement;
  const errEl    = card.querySelector('.pvp-err') as HTMLElement;
  const updateBtn = card.querySelector('.pvp-update-btn') as HTMLButtonElement | null;

  updateBtn?.addEventListener('click', async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = 'Updating…';
    try {
      await installOneMod(mod, mcVersion.value || '1.21.4');
      renderPvpMods((document.getElementById('pvp-search') as HTMLInputElement)?.value ?? '');
    } catch {
      updateBtn.textContent = '✗ Failed';
      updateBtn.disabled = false;
    }
  });

  input.addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked;
    input.disabled = true;
    errEl.style.display = 'none';
    if (checked) {
      // Check for conflicts before installing
      const conflictSlugs = (mod.conflicts || []).filter(s => enabledMods.has(s));
      if (conflictSlugs.length) {
        const conflictNames = conflictSlugs.map(s => PVP_MOD_BY_SLUG.get(s)?.name ?? s).join(', ');
        // Disable the conflicting mods
        for (const cSlug of conflictSlugs) {
          const cMod = PVP_MOD_BY_SLUG.get(cSlug);
          if (cMod) {
            const cInstalled = loadInstalledMods();
            if (cInstalled[cSlug]) await mc?.removeMod({ filename: cInstalled[cSlug].filename });
            const updated = loadInstalledMods(); delete updated[cSlug]; saveInstalledMods(updated);
            enabledMods.delete(cSlug);
          }
        }
        errEl.textContent = `⚠ Disabled ${conflictNames} — incompatible with ${mod.name}`;
        errEl.style.color = '#f6c356';
        errEl.style.display = 'block';
        // Re-render so the conflicting cards update
        setTimeout(() => renderPvpMods((document.getElementById('pvp-search') as HTMLInputElement)?.value ?? ''), 50);
      }

      statusEl.textContent = '…'; statusEl.style.color = '#f6c356';
      try {
        const ver = mcVersion.value || '1.21.4';
        const curInstalled = loadInstalledMods();
        // Install deps that are missing OR installed for the wrong MC version
        const depsToInstall = (mod.deps || [])
          .map(slug => PVP_MOD_BY_SLUG.get(slug))
          .filter((dep): dep is PvpModDef => {
            if (!dep) return false;
            const info = curInstalled[dep.slug];
            return !info || info.mcVersion !== ver;
          });
        for (const dep of depsToInstall) {
          statusEl.textContent = dep.name; statusEl.style.color = '#f5a623';
          await installOneMod(dep, ver);
        }
        statusEl.textContent = '…'; statusEl.style.color = '#f5a623';
        await installOneMod(mod, ver);
        card.className = 'mod-card enabled';
        statusEl.textContent = '✓'; statusEl.style.color = '#f5a623';
        if (depsToInstall.length) renderPvpMods((document.getElementById('pvp-search') as HTMLInputElement)?.value ?? '');
      } catch (err: any) {
        input.checked = false;
        card.className = 'mod-card';
        statusEl.textContent = '✗'; statusEl.style.color = '#e05500';
        errEl.textContent = err.message;
        errEl.style.display = 'block';
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
      updateModsBadge();
    }
    input.disabled = false;
  });

  return card;
}

function renderPvpMods(query: string) {
  const list = document.getElementById('pvp-list')!;
  const q = query.trim().toLowerCase();
  list.innerHTML = '';
  let anyVisible = false;
  for (const group of PVP_MOD_GROUPS) {
    const filtered = q ? group.mods.filter(m =>
      m.name.toLowerCase().includes(q) || m.desc.toLowerCase().includes(q) || m.slug.includes(q)
    ) : group.mods;
    if (!filtered.length) continue;
    anyVisible = true;
    const section = document.createElement('div');
    section.innerHTML = `<div style="font-size:13px;font-weight:700;color:${group.color};letter-spacing:1px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #21262d;">${group.label}</div>`;
    const grid = document.createElement('div');
    grid.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    for (const mod of filtered) grid.appendChild(buildPvpCard(mod));
    section.appendChild(grid);
    list.appendChild(section);
  }
  if (!anyVisible) {
    list.innerHTML = '<div style="color:#6e7681;font-size:13px;text-align:center;padding:40px 0;">No mods match your search</div>';
  }
}

function countStaleMods(): number {
  const cur = mcVersion.value;
  const installed = loadInstalledMods();
  return Object.values(installed).filter((m: any) => !m.mcVersion || m.mcVersion !== cur).length;
}

async function reinstallAllMods(btn: HTMLElement) {
  const ver = mcVersion.value;
  const installed = loadInstalledMods();
  const stale = Object.entries(installed).filter(([, m]) => !(m as any).mcVersion || (m as any).mcVersion !== ver);
  if (!stale.length) { btn.textContent = '✓ Up to date'; return; }
  btn.textContent = `Updating 0/${stale.length}…`;
  btn.setAttribute('disabled', '');
  let done = 0;
  for (const [slug, info] of stale) {
    const pvpMod = PVP_MOD_BY_SLUG.get(slug);
    try {
      if (pvpMod) {
        await installOneMod(pvpMod, ver);
      } else {
        // Modrinth search mod — update by project_id directly
        const p = new URLSearchParams({ game_versions: `["${ver}"]`, loaders: '["fabric"]', limit: '5' });
        const r = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version?${p}`);
        const data: any[] = await r.json();
        if (!Array.isArray(data) || !data.length) continue;
        const f = data[0].files.find((fi: any) => fi.primary) ?? data[0].files[0];
        if (!f) continue;
        const res = await mc.installMod({ url: f.url, filename: f.filename });
        if (!res.ok) continue;
        const cur = loadInstalledMods();
        cur[slug] = { filename: f.filename, name: (info as any).name || slug, mcVersion: ver };
        saveInstalledMods(cur);
      }
      done++;
      btn.textContent = `Updating ${done}/${stale.length}…`;
    } catch {}
  }
  btn.textContent = `Updated ${done}/${stale.length}`;
  btn.removeAttribute('disabled');
  renderPvpMods((document.getElementById('pvp-search') as HTMLInputElement)?.value ?? '');
}

// ── Mod Profiles ──────────────────────────────────────────────────────────
interface ModProfile { id: string; name: string; slugs: string[] }
const PROFILES_KEY = 'voxel_mod_profiles';
const ACTIVE_PROFILE_KEY = 'voxel_active_profile';
function loadProfiles(): ModProfile[] {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]'); } catch { return []; }
}
function saveProfiles(ps: ModProfile[]) { localStorage.setItem(PROFILES_KEY, JSON.stringify(ps)); }
function getActiveProfileId(): string | null { return localStorage.getItem(ACTIVE_PROFILE_KEY); }
function setActiveProfileId(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_PROFILE_KEY, id); else localStorage.removeItem(ACTIVE_PROFILE_KEY);
}

function renderModProfiles() {
  const listEl  = document.getElementById('mod-profiles-list');
  const emptyEl = document.getElementById('mod-profiles-empty');
  if (!listEl) return;
  const profiles = loadProfiles();
  const activeId = getActiveProfileId();
  Array.from(listEl.children).forEach(c => { if (c.id !== 'mod-profiles-empty') c.remove(); });
  if (!profiles.length) { if (emptyEl) emptyEl.style.display = 'block'; return; }
  if (emptyEl) emptyEl.style.display = 'none';
  for (const profile of profiles) {
    const isActive = profile.id === activeId;
    const card = document.createElement('div');
    card.className = 'mod-card' + (isActive ? ' enabled' : '');

    const info = document.createElement('div');
    info.className = 'mod-info';
    info.innerHTML = `<div class="mod-name">${profile.name}</div><div class="mod-desc">${profile.slugs.length} mod${profile.slugs.length !== 1 ? 's' : ''}</div>`;

    const updateProfileBtn = document.createElement('button');
    updateProfileBtn.textContent = '↻ Update';
    updateProfileBtn.style.cssText = 'padding:4px 9px;background:rgba(246,195,86,0.1);border:1px solid rgba(246,195,86,0.35);border-radius:5px;color:#f6c356;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all 0.15s;';

    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    delBtn.style.cssText = 'padding:4px 10px;background:none;border:1px solid rgba(248,81,73,0.25);border-radius:5px;color:#666;font-size:11px;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:all 0.15s;';

    const right = document.createElement('div');
    right.className = 'mod-right';
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'toggle';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = isActive;
    const toggleSlider = document.createElement('span');
    toggleSlider.className = 'toggle-slider';
    toggleLabel.appendChild(toggleInput);
    toggleLabel.appendChild(toggleSlider);
    right.appendChild(updateProfileBtn);
    right.appendChild(delBtn);
    right.appendChild(toggleLabel);

    card.appendChild(info);
    card.appendChild(right);
    listEl.insertBefore(card, emptyEl ?? null);

    toggleInput.addEventListener('change', async () => {
      if (toggleInput.checked) {
        setActiveProfileId(profile.id);
        const installed = loadInstalledMods();
        for (const slug of Array.from(enabledMods)) {
          if (!profile.slugs.includes(slug)) {
            if (installed[slug]) await mc?.removeMod({ filename: installed[slug].filename });
            const upd = loadInstalledMods(); delete upd[slug]; saveInstalledMods(upd);
            enabledMods.delete(slug);
          }
        }
        updateModsBadge();
      } else {
        if (getActiveProfileId() === profile.id) setActiveProfileId(null);
      }
      renderModProfiles();
    });

    updateProfileBtn.addEventListener('click', async () => {
      const ver = mcVersion.value || '1.21.4';
      updateProfileBtn.disabled = true;
      let done = 0;
      for (const slug of profile.slugs) {
        const mod = PVP_MOD_BY_SLUG.get(slug);
        if (!mod) continue;
        updateProfileBtn.textContent = `↻ ${done}/${profile.slugs.length}`;
        try { await installOneMod(mod, ver); done++; } catch {}
      }
      updateProfileBtn.textContent = `✓ ${done} updated`;
      updateProfileBtn.disabled = false;
      setTimeout(() => { updateProfileBtn.textContent = '↻ Update'; }, 2000);
    });

    let confirmPending = false;
    let confirmTimer: ReturnType<typeof setTimeout> | null = null;
    delBtn.addEventListener('click', () => {
      if (!confirmPending) {
        confirmPending = true;
        delBtn.textContent = 'Sure?';
        delBtn.style.color = '#f85149';
        delBtn.style.borderColor = 'rgba(248,81,73,0.7)';
        confirmTimer = setTimeout(() => {
          confirmPending = false;
          delBtn.textContent = 'Delete';
          delBtn.style.color = '#666';
          delBtn.style.borderColor = 'rgba(248,81,73,0.25)';
        }, 3000);
      } else {
        if (confirmTimer) clearTimeout(confirmTimer);
        const updated = loadProfiles().filter(p => p.id !== profile.id);
        saveProfiles(updated);
        if (getActiveProfileId() === profile.id) setActiveProfileId(null);
        renderModProfiles();
      }
    });
  }
}

document.getElementById('mod-profile-save-btn')?.addEventListener('click', () => {
  const nameEl = document.getElementById('mod-profile-name-input') as HTMLInputElement | null;
  const name = nameEl?.value.trim() ?? '';
  if (!name) { nameEl?.focus(); return; }
  const profiles = loadProfiles();
  const id = `${Date.now()}`;
  profiles.push({ id, name, slugs: Array.from(enabledMods) });
  saveProfiles(profiles);
  setActiveProfileId(id);
  if (nameEl) nameEl.value = '';
  renderModProfiles();
  const btn = document.getElementById('mod-profile-save-btn') as HTMLButtonElement;
  if (btn) { btn.textContent = '✓ Saved!'; setTimeout(() => { btn.textContent = 'Save Current Mods'; }, 1500); }
});

renderModProfiles();

function initPvpMods() {
  renderPvpMods('');
  const searchEl = document.getElementById('pvp-search') as HTMLInputElement;
  searchEl.addEventListener('input', () => renderPvpMods(searchEl.value));

  // Re-render mod cards when MC version changes so stale badges update
  mcVersion.addEventListener('change', () => {
    if (pvpPanelEl.style.display !== 'none') renderPvpMods(searchEl.value);
    updateReinstallBtn();
  });

  // Reinstall button (shown when mods are stale)
  const reinstallBtn = document.getElementById('pvp-reinstall-btn') as HTMLButtonElement | null;
  function updateReinstallBtn() {
    if (!reinstallBtn) return;
    const stale = countStaleMods();
    reinstallBtn.style.display = stale > 0 ? 'inline-flex' : 'none';
    reinstallBtn.textContent = `↻ Update ${stale} mod${stale !== 1 ? 's' : ''} to MC ${mcVersion.value}`;
  }
  reinstallBtn?.addEventListener('click', () => reinstallAllMods(reinstallBtn));
  updateReinstallBtn();
}

// ── Resource Packs panel ──────────────────────────────────────────────────────
const RP_STORAGE_KEY = 'voxel_installed_rps';
function loadInstalledRPs(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(RP_STORAGE_KEY) || '{}'); } catch { return {}; }
}
function saveInstalledRPs(data: Record<string, string>) {
  localStorage.setItem(RP_STORAGE_KEY, JSON.stringify(data));
}

async function fetchRPDownloadUrl(projectId: string): Promise<{ url: string; filename: string }> {
  const r = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version?limit=5`);
  if (!r.ok) throw new Error(`Modrinth API ${r.status}`);
  const versions: any[] = await r.json();
  if (!versions.length) throw new Error('No versions found for this resource pack');
  const file = versions[0].files?.find((f: any) => f.primary) ?? versions[0].files?.[0];
  if (!file?.url) throw new Error('No download file found');
  return { url: file.url, filename: file.filename };
}

function buildRPCard(name: string, slug: string, projectId: string, icon: string, desc: string, installed: boolean): HTMLElement {
  const card = document.createElement('div');
  card.className = 'mod-card' + (installed ? ' enabled' : '');
  card.innerHTML = `
    <div class="mod-icon" style="font-size:22px;background:none;">${icon}</div>
    <div class="mod-info">
      <div class="mod-name">${name}</div>
      <div class="mod-desc">${desc}</div>
      <div class="pvp-err" style="font-size:11px;color:#e05500;margin-top:4px;display:none;"></div>
    </div>
    <div class="mod-right">
      <div class="mod-version" style="color:${installed ? '#f5a623' : 'transparent'}">✓</div>
      <label class="toggle"><input type="checkbox" ${installed ? 'checked' : ''} /><span class="toggle-slider"></span></label>
    </div>`;
  const input    = card.querySelector('input') as HTMLInputElement;
  const statusEl = card.querySelector('.mod-version') as HTMLElement;
  const errEl    = card.querySelector('.pvp-err') as HTMLElement;
  input.addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked;
    input.disabled = true;
    errEl.style.display = 'none';
    const rps = loadInstalledRPs();
    if (checked) {
      statusEl.textContent = '…'; statusEl.style.color = '#f5a623';
      try {
        const { url, filename } = await fetchRPDownloadUrl(projectId);
        const res = await mc.installResourcePack({ url, filename });
        if (!res.ok) throw new Error(res.error);
        rps[slug] = filename;
        saveInstalledRPs(rps);
        card.className = 'mod-card enabled';
        statusEl.textContent = '✓'; statusEl.style.color = '#f5a623';
      } catch (err: any) {
        input.checked = false;
        card.className = 'mod-card';
        statusEl.textContent = '✗'; statusEl.style.color = '#e05500';
        errEl.textContent = err.message; errEl.style.display = 'block';
      }
    } else {
      if (rps[slug]) await mc.removeResourcePack({ filename: rps[slug] });
      delete rps[slug];
      saveInstalledRPs(rps);
      card.className = 'mod-card';
      statusEl.textContent = ''; statusEl.style.color = 'transparent';
    }
    input.disabled = false;
  });
  return card;
}

async function searchResourcePacks(query: string) {
  const rpList    = document.getElementById('rp-list')!;
  const rpLoading = document.getElementById('rp-loading')!;
  rpList.innerHTML = '';
  rpLoading.style.display = 'block';
  try {
    const facets = JSON.stringify([['project_type:resourcepack']]);
    const params = new URLSearchParams({ query, facets, limit: '20' });
    const res  = await fetch(`https://api.modrinth.com/v2/search?${params}`);
    const data = await res.json();
    const rps  = loadInstalledRPs();
    rpLoading.style.display = 'none';
    for (const hit of (data.hits || [])) {
      const installed = !!rps[hit.slug];
      const card = buildRPCard(hit.title, hit.slug, hit.project_id, '', hit.description, installed);
      rpList.appendChild(card);
    }
    if (!data.hits?.length) rpList.innerHTML = '<div style="color:#6e7681;font-size:13px;text-align:center;padding:20px 0;">No results</div>';
  } catch { rpLoading.style.display = 'none'; rpList.innerHTML = '<div style="color:#e05500;font-size:13px;text-align:center;padding:20px 0;">Search failed</div>'; }
}

function initResourcePacks() {
  const rps = loadInstalledRPs();
  const installedEl = document.getElementById('rp-installed')!;
  installedEl.innerHTML = '';
  if (Object.keys(rps).length) {
    const label = document.createElement('div');
    label.style.cssText = 'font-size:13px;font-weight:700;color:#f5a623;margin-bottom:8px;';
    label.textContent = '✓ Installed';
    installedEl.appendChild(label);
    for (const [slug, filename] of Object.entries(rps)) {
      installedEl.appendChild(buildRPCard(filename.replace('.zip',''), slug, '', filename, true, '', filename));
    }
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid #21262d;margin:8px 0 4px;';
    installedEl.appendChild(sep);
  }
  const searchEl = document.getElementById('rp-search') as HTMLInputElement;
  let rpTimer: ReturnType<typeof setTimeout> | null = null;
  searchEl.addEventListener('input', () => {
    if (rpTimer) clearTimeout(rpTimer);
    rpTimer = setTimeout(() => searchResourcePacks(searchEl.value), 400);
  });
  searchResourcePacks('');
}

// ── Skins / Wardrobe panel ────────────────────────────────────────────────────
const WARDROBE_PRESETS = [
  { name: 'Steve',    user: 'MHF_Steve',    variant: 'classic' },
  { name: 'Alex',     user: 'MHF_Alex',     variant: 'slim'    },
  { name: 'Herobrine',user: 'MHF_Herobrine',variant: 'classic' },
  { name: 'Enderman', user: 'MHF_Enderman', variant: 'classic' },
  { name: 'Creeper',  user: 'MHF_Creeper',  variant: 'classic' },
  { name: 'Villager', user: 'MHF_Villager', variant: 'classic' },
  { name: 'Iron Golem',user:'MHF_Golem',    variant: 'classic' },
  { name: 'Piglin',   user: 'MHF_PigZombie',variant: 'classic' },
  { name: 'TNT',      user: 'MHF_TNT',      variant: 'classic' },
  { name: 'Notch',    user: 'Notch',         variant: 'classic' },
];

async function fetchSkinBase64(username: string): Promise<string | null> {
  try {
    const profileRes = await fetch(`https://api.mojang.com/users/profiles/minecraft/${username}`);
    if (!profileRes.ok) return null;
    const { id } = await profileRes.json();
    const sessionRes = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`);
    if (!sessionRes.ok) return null;
    const session = await sessionRes.json();
    const texProp = session.properties?.find((p: any) => p.name === 'textures');
    if (!texProp) return null;
    const texData = JSON.parse(atob(texProp.value));
    const skinUrl = texData.textures?.SKIN?.url;
    if (!skinUrl) return null;
    const imgRes = await fetch(skinUrl);
    const buf = await imgRes.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin);
  } catch { return null; }
}

const VIEWS = ['Front', 'Back', 'Left', 'Right'] as const;
type SkinView = typeof VIEWS[number];

function drawSkinOnCanvas(canvas: HTMLCanvasElement, img: HTMLImageElement, view: SkinView, slim: boolean) {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  const s = 4;
  const aw = slim ? 3 : 4; // arm width

  // Helper: draw a skin region to canvas coords
  const d = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number) =>
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw * s, sh * s);

  if (view === 'Front') {
    // Base layers
    d(8, 8, 8, 8, 14, 2);              // Head
    d(20, 20, 8, 12, 14, 36);          // Body
    d(44, 20, aw, 12, 14 - aw * s, 36); // R arm
    d(36, 52, aw, 12, 14 + 8 * s, 36); // L arm
    d(4, 20, 4, 12, 14, 84);           // R leg
    d(20, 52, 4, 12, 30, 84);          // L leg
    // Overlay layers (hat, jacket, sleeves, pants)
    d(40, 8, 8, 8, 13, 1);             // Hat
    d(20, 36, 8, 12, 14, 36);          // Jacket
    d(44, 36, aw, 12, 14 - aw * s, 36); // R sleeve
    d(52, 52, aw, 12, 14 + 8 * s, 36); // L sleeve
    d(4, 36, 4, 12, 14, 84);           // R leg overlay
    d(4, 52, 4, 12, 30, 84);           // L leg overlay
  } else if (view === 'Back') {
    d(24, 8, 8, 8, 14, 2);             // Head back
    d(32, 20, 8, 12, 14, 36);          // Body back
    d(52, 20, aw, 12, 14 + 8 * s, 36); // R arm back (screen right from behind)
    d(44, 52, aw, 12, 14 - aw * s, 36); // L arm back
    d(12, 20, 4, 12, 30, 84);          // R leg back
    d(28, 52, 4, 12, 14, 84);          // L leg back
    d(56, 8, 8, 8, 13, 1);             // Hat back
    d(32, 36, 8, 12, 14, 36);          // Jacket back
    d(52, 36, aw, 12, 14 + 8 * s, 36); // R sleeve back
    d(60, 52, aw, 12, 14 - aw * s, 36); // L sleeve back
    d(12, 36, 4, 12, 30, 84);          // R leg back overlay
    d(12, 52, 4, 12, 14, 84);          // L leg back overlay
  } else if (view === 'Left') {
    d(16, 8, 8, 8, 14, 2);             // Head left
    d(28, 20, 4, 12, 14, 36);          // Body left side
    d(40, 20, 4, 12, 14 - 4 * s, 36);  // R arm left side
    d(32, 52, 4, 12, 14 + 8 * s, 36);  // L arm left side
    d(8, 20, 4, 12, 14, 84);           // R leg left
    d(24, 52, 4, 12, 30, 84);          // L leg left
    d(48, 8, 8, 8, 13, 1);             // Hat left
    d(28, 36, 4, 12, 14, 36);          // Jacket left
  } else {
    d(0, 8, 8, 8, 14, 2);              // Head right
    d(16, 20, 4, 12, 14, 36);          // Body right side
    d(48, 20, 4, 12, 14 - 4 * s, 36);  // R arm right side
    d(40, 52, 4, 12, 14 + 8 * s, 36);  // L arm right side
    d(0, 20, 4, 12, 14, 84);           // R leg right
    d(20, 52, 4, 12, 30, 84);          // wait...
    d(32, 8, 8, 8, 13, 1);             // Hat right
    d(16, 36, 4, 12, 14, 36);          // Jacket right
  }
}

function loadSkinImage(b64: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/png;base64,${b64}`;
  });
}

function initSkins() {
  const skinCanvas   = document.getElementById('skin-preview-canvas') as HTMLCanvasElement;
  const skinNameEl   = document.getElementById('skin-name')!;
  const viewLabel    = document.getElementById('skin-view-label')!;
  const prevBtn      = document.getElementById('skin-view-prev') as HTMLButtonElement;
  const nextBtn      = document.getElementById('skin-view-next') as HTMLButtonElement;
  const fileInput    = document.getElementById('skin-file-input') as HTMLInputElement;
  const uploadBtn    = document.getElementById('skin-upload-btn') as HTMLButtonElement;
  const fileNameEl   = document.getElementById('skin-file-name')!;
  const applyBtn     = document.getElementById('skin-apply-btn') as HTMLButtonElement;
  const statusEl     = document.getElementById('skin-status')!;
  const lookupInput  = document.getElementById('skin-lookup-input') as HTMLInputElement;
  const lookupBtn    = document.getElementById('skin-lookup-btn') as HTMLButtonElement;
  const wardrobeGrid = document.getElementById('skin-wardrobe-grid')!;
  let selectedBase64 = '';
  let selectedVariant: 'classic' | 'slim' = 'classic';
  let currentSkinImg: HTMLImageElement | null = null;
  let viewIdx = 0;

  function refreshCanvas() {
    if (!currentSkinImg) return;
    drawSkinOnCanvas(skinCanvas, currentSkinImg, VIEWS[viewIdx], selectedVariant === 'slim');
    viewLabel.textContent = VIEWS[viewIdx];
  }

  prevBtn.addEventListener('click', () => { viewIdx = (viewIdx + VIEWS.length - 1) % VIEWS.length; refreshCanvas(); });
  nextBtn.addEventListener('click', () => { viewIdx = (viewIdx + 1) % VIEWS.length; refreshCanvas(); });

  // Drag to rotate
  let dragStartX = 0;
  skinCanvas.addEventListener('mousedown', e => { dragStartX = e.clientX; });
  skinCanvas.addEventListener('mouseup', e => {
    const dx = e.clientX - dragStartX;
    if (Math.abs(dx) > 20) {
      viewIdx = dx < 0
        ? (viewIdx + 1) % VIEWS.length
        : (viewIdx + VIEWS.length - 1) % VIEWS.length;
      refreshCanvas();
    }
  });
  skinCanvas.style.cursor = 'ew-resize';

  async function setPreviewSkin(b64: string, name: string, variant: 'classic' | 'slim') {
    selectedBase64 = b64;
    selectedVariant = variant;
    skinNameEl.textContent = name;
    try {
      currentSkinImg = await loadSkinImage(b64);
      viewIdx = 0;
      refreshCanvas();
    } catch {}
  }

  // Load current skin
  const cosmetics = (window as any).cosmetics;
  cosmetics.getUuid().then(async (uuid: string | null) => {
    if (uuid) {
      skinNameEl.textContent = 'Your skin';
      const b64 = await fetchSkinBase64(uuid).catch(() => null);
      if (b64) { currentSkinImg = await loadSkinImage(b64).catch(() => null); refreshCanvas(); }
    } else {
      skinNameEl.textContent = 'Not logged in';
      const b64 = await fetchSkinBase64('MHF_Steve').catch(() => null);
      if (b64) { currentSkinImg = await loadSkinImage(b64).catch(() => null); refreshCanvas(); }
    }
  });

  // Build preset grid
  WARDROBE_PRESETS.forEach(preset => {
    const card = document.createElement('div');
    card.className = 'wardrobe-card';
    card.innerHTML = `<img src="https://minotar.net/avatar/${preset.user}/48" alt="${escHtml(preset.name)}" onerror="this.style.display='none'"><span>${escHtml(preset.name)}</span>`;
    card.addEventListener('click', async () => {
      wardrobeGrid.querySelectorAll('.wardrobe-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      statusEl.textContent = `Loading ${preset.name}…`; statusEl.style.color = '#f6c356';
      applyBtn.style.display = 'none';
      const b64 = await fetchSkinBase64(preset.user);
      if (b64) {
        await setPreviewSkin(b64, preset.name, preset.variant as 'classic' | 'slim');
        applyBtn.style.display = 'inline-block';
        statusEl.textContent = `${preset.name} ready — click Apply`; statusEl.style.color = '#aaaaaa';
      } else {
        statusEl.textContent = `Could not load ${preset.name} skin`; statusEl.style.color = '#e05500';
      }
    });
    wardrobeGrid.appendChild(card);
  });

  // Lookup by username
  const doLookup = async () => {
    const name = lookupInput.value.trim();
    if (!name) return;
    lookupBtn.disabled = true; lookupBtn.textContent = '…';
    statusEl.textContent = `Loading ${name}…`; statusEl.style.color = '#f6c356';
    applyBtn.style.display = 'none';
    wardrobeGrid.querySelectorAll('.wardrobe-card').forEach(c => c.classList.remove('selected'));
    const b64 = await fetchSkinBase64(name);
    lookupBtn.disabled = false; lookupBtn.textContent = 'Load';
    if (b64) {
      await setPreviewSkin(b64, name, 'classic');
      applyBtn.style.display = 'inline-block';
      statusEl.textContent = `${name}'s skin ready — click Apply`; statusEl.style.color = '#aaaaaa';
    } else {
      statusEl.textContent = `Player "${name}" not found`; statusEl.style.color = '#e05500';
    }
  };
  lookupBtn.addEventListener('click', doLookup);
  lookupInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLookup(); });

  // File upload
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileNameEl.textContent = file.name;
    const reader = new FileReader();
    reader.onload = async e => {
      const dataUrl = e.target?.result as string;
      const b64 = dataUrl.split(',')[1];
      const variant = (document.querySelector('input[name="skin-variant"]:checked') as HTMLInputElement)?.value as 'classic' | 'slim' || 'classic';
      await setPreviewSkin(b64, file.name, variant);
      wardrobeGrid.querySelectorAll('.wardrobe-card').forEach(c => c.classList.remove('selected'));
      applyBtn.style.display = 'inline-block';
      statusEl.textContent = 'Custom skin loaded — click Apply'; statusEl.style.color = '#aaaaaa';
    };
    reader.readAsDataURL(file);
  });

  document.querySelectorAll('input[name="skin-variant"]').forEach(r => {
    r.addEventListener('change', () => {
      selectedVariant = (r as HTMLInputElement).value as 'classic' | 'slim';
      refreshCanvas();
    });
  });

  applyBtn.addEventListener('click', async () => {
    if (!selectedBase64) return;
    applyBtn.disabled = true;
    statusEl.textContent = 'Uploading…'; statusEl.style.color = '#f6c356';
    const res = await mc.uploadSkin({ base64: selectedBase64, variant: selectedVariant });
    applyBtn.disabled = false;
    if (res.ok) {
      statusEl.textContent = '✓ Skin applied!'; statusEl.style.color = '#f5a623';
    } else if (res.error?.includes('401') || res.error?.includes('Unauthorized') || res.error?.includes('Not authenticated')) {
      statusEl.textContent = '✗ Session expired — go to Settings and click Re-authenticate';
      statusEl.style.color = '#e05500';
    } else {
      statusEl.textContent = `✗ ${res.error}`; statusEl.style.color = '#e05500';
    }
  });
}

// ── Screenshots panel ─────────────────────────────────────────────────────────
function initScreenshots() {
  const listEl = document.getElementById('screenshots-list')!;
  document.getElementById('screenshots-open-folder')!.addEventListener('click', () => mc.showScreenshotsFolder());

  listEl.innerHTML = '<div style="color:#6e7681;font-size:13px;text-align:center;padding:30px 0;">Loading...</div>';
  mc.listScreenshots().then((shots: { name: string; path: string; mtime: number; sizeKb: number }[]) => {
    listEl.innerHTML = '';
    if (!shots.length) {
      listEl.innerHTML = '<div style="color:#6e7681;font-size:13px;text-align:center;padding:40px 0;">No screenshots yet — press <strong style="color:#e6edf3;">F2</strong> in-game to take one</div>';
      return;
    }
    for (const s of shots) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:14px;background:rgba(13,17,23,0.6);border:1px solid #21262d;border-radius:10px;padding:12px 16px;cursor:pointer;transition:background 0.15s;';
      row.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div style="color:#e6edf3;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.name}</div>
          <div style="color:#6e7681;font-size:11px;margin-top:2px;">${new Date(s.mtime).toLocaleString()} · ${s.sizeKb} KB</div>
        </div>
        <button style="background:#21262d;border:1px solid #30363d;color:#8b949e;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">Open</button>`;
      row.querySelector('button')!.addEventListener('click', e => { e.stopPropagation(); mc.openScreenshot(s.path); });
      row.addEventListener('click', () => mc.openScreenshot(s.path));
      row.addEventListener('mouseover', () => row.style.background = 'rgba(33,38,45,0.6)');
      row.addEventListener('mouseout',  () => row.style.background = 'rgba(13,17,23,0.6)');
      listEl.appendChild(row);
    }
  });
}

// ── Accounts panel ────────────────────────────────────────────────────────────
const ACCOUNTS_KEY = 'voxel_saved_accounts';
function loadAccounts(): { name: string; added: number }[] {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '[]'); } catch { return []; }
}
function saveAccountsList(list: { name: string; added: number }[]) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
}

function renderAccountsList() {
  const listEl  = document.getElementById('accounts-list')!;
  const accounts = loadAccounts();
  listEl.innerHTML = '';
  if (!accounts.length) {
    listEl.innerHTML = '<div style="color:#6e7681;font-size:13px;">No saved accounts yet — add one above</div>';
    return;
  }
  const offlineInput = document.getElementById('offline-username') as HTMLInputElement | null;
  for (const acc of accounts) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;background:rgba(13,17,23,0.6);border:1px solid #21262d;border-radius:10px;padding:11px 16px;';
    const isActive = offlineInput?.value === acc.name;
    row.innerHTML = `
      <img src="https://crafatar.com/avatars/${encodeURIComponent(acc.name)}?size=32&overlay" onerror="this.src=''" style="width:32px;height:32px;border-radius:4px;image-rendering:pixelated;background:#21262d;" />
      <div style="flex:1;">
        <div style="color:#e6edf3;font-size:13px;font-weight:600;">${acc.name}</div>
        <div style="color:#6e7681;font-size:11px;">Added ${new Date(acc.added).toLocaleDateString()}</div>
      </div>
      ${isActive ? '<span style="color:#f5a623;font-size:12px;font-weight:600;">● Active</span>' : '<button class="switch-btn" style="background:#21262d;border:1px solid #30363d;color:#8b949e;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;">Switch</button>'}
      <button class="remove-btn" style="background:none;border:none;color:#6e7681;cursor:pointer;font-size:16px;padding:0 4px;" title="Remove">✕</button>`;
    row.querySelector('.switch-btn')?.addEventListener('click', () => {
      if (offlineInput) { offlineInput.value = acc.name; offlineInput.dispatchEvent(new Event('input')); }
      (document.getElementById('offline-toggle') as HTMLInputElement | null)?.dispatchEvent(new Event('change'));
      renderAccountsList();
    });
    row.querySelector('.remove-btn')!.addEventListener('click', () => {
      const list = loadAccounts().filter(a => a.name !== acc.name);
      saveAccountsList(list);
      renderAccountsList();
    });
    listEl.appendChild(row);
  }
}

function initAccounts() {
  renderAccountsList();
  const input  = document.getElementById('account-name-input') as HTMLInputElement;
  const addBtn = document.getElementById('account-add-btn') as HTMLButtonElement;
  const doAdd = () => {
    const name = input.value.trim();
    if (!name || name.length < 2) return;
    const list = loadAccounts();
    if (list.find(a => a.name === name)) return;
    list.unshift({ name, added: Date.now() });
    saveAccountsList(list);
    input.value = '';
    renderAccountsList();
  };
  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
}

// ── Cosmetics panel ───────────────────────────────────────────────────────────
const CAPE_DEFS = [
  { id: 'voxel_green', name: 'Voxel Green',  top: '#f5a623', bot: '#1a4a2e', cost: 0   },
  { id: 'midnight',    name: 'Midnight Blue', top: '#f5a623', bot: '#1a2e4a', cost: 100 },
  { id: 'crimson',     name: 'Crimson',       top: '#e05500', bot: '#5a0a0a', cost: 100 },
  { id: 'amethyst',    name: 'Amethyst',      top: '#f5a623', bot: '#4a1a9e', cost: 150 },
  { id: 'golden',      name: 'Golden',        top: '#f6c356', bot: '#6b4c00', cost: 150 },
  { id: 'nether',      name: 'Nether',        top: '#f97316', bot: '#7a1a00', cost: 200 },
  { id: 'ocean',       name: 'Ocean',         top: '#7cc4db', bot: '#1a4a5a', cost: 200 },
  { id: 'void',        name: 'Void',          top: '#f5a623', bot: '#0a0a2e', cost: 300 },
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
  if (claimBtn) { claimBtn.disabled = true; claimBtn.textContent = 'Claiming…'; }
  try {
    const snap = await get(ref(rtdb, `voxel_tokens/${uid}/lastClaim`));
    if (snap.val() === today) {
      if (claimBtn) claimBtn.textContent = '✓ Claimed today';
      return;
    }
    await update(ref(rtdb, `voxel_tokens/${uid}`), { balance: increment(50), lastClaim: today });
    if (claimBtn) {
      claimBtn.textContent = '+50 Tokens claimed!';
      setTimeout(() => { claimBtn.textContent = '✓ Claimed today'; }, 2500);
    }
  } catch (err: any) {
    if (claimBtn) {
      claimBtn.disabled = false;
      claimBtn.textContent = 'Error: ' + (err?.message ?? 'Failed');
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
      <div class="friend-avatar"></div>
      <div class="friend-dot" id="fdot-${fuid}"></div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:600;color:#e6edf3;">${info.name || fuid}</div>
        <div id="fstatus-${fuid}" style="font-size:11px;color:#484f58;margin-top:2px;">Offline</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <span id="fsrv-${fuid}" style="display:none;font-family:monospace;font-size:11px;color:#f5a623;background:rgba(245,166,35,0.06);border:1px solid rgba(245,166,35,0.15);padding:4px 8px;border-radius:6px;cursor:pointer;" title="Click to copy"></span>
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
      <div class="friend-avatar"></div>
      <div style="flex:1;font-size:13px;color:#e6edf3;font-weight:500;">${info.name || fromUid}</div>
      <button class="req-accept" style="padding:5px 12px;background:rgba(245,166,35,0.15);border:1px solid rgba(245,166,35,0.4);border-radius:6px;color:#f5a623;font-size:12px;cursor:pointer;font-weight:600;">Accept</button>
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
  if (!uid) { statusEl.style.color = '#e05500'; statusEl.textContent = 'Sign in first'; return; }
  const name = targetName.trim().toLowerCase();
  if (!name) return;
  addBtn.disabled = true;
  statusEl.style.color = '#484f58';
  statusEl.textContent = 'Searching…';
  const snap = await get(ref(rtdb, `voxel_user_index/${name}`));
  const target = snap.val();
  if (!target) {
    statusEl.style.color = '#e05500';
    statusEl.textContent = `"${targetName}" hasn't used Voxel Client yet`;
    addBtn.disabled = false;
    return;
  }
  const targetUid = target.uid;
  if (targetUid === uid) { statusEl.style.color = '#e05500'; statusEl.textContent = "That's you!"; addBtn.disabled = false; return; }
  // Check if already friends
  const alreadySnap = await get(ref(rtdb, `voxel_friends/${uid}/list/${targetUid}`));
  if (alreadySnap.exists()) { statusEl.style.color = '#f6c356'; statusEl.textContent = 'Already friends'; addBtn.disabled = false; return; }
  // Send request
  await set(ref(rtdb, `voxel_friends/${targetUid}/requests/incoming/${uid}`), { name: mcIgnSpan.textContent || uid, sentAt: serverTimestamp() });
  await set(ref(rtdb, `voxel_friends/${uid}/requests/outgoing/${targetUid}`), { name: target.name, sentAt: serverTimestamp() });
  statusEl.style.color = '#f5a623';
  statusEl.textContent = `Request sent to ${target.name}`;
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
    const costLabel = cape.cost === 0 ? 'Free' : `${cape.cost} tokens`;
    const canAfford = tokenBalance >= cape.cost;
    let actionBtn = '';
    if (equipped) {
      actionBtn = `<button class="cape-equip on">Equipped</button>`;
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
        if (cosmeticsStatus) cosmeticsStatus.textContent = 'Sign in to your launcher account first';
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
          ? 'Cape saved — visible in-game after next launch'
          : 'Cape saved — sign in with Microsoft to see it in-game';
        renderCapeGrid();
      } catch { if (cosmeticsStatus) cosmeticsStatus.textContent = 'Failed to save — check connection'; }
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
    installBtn.textContent = 'Installing…';
    const res = await cosm.installMod();
    if (res.ok) {
      installStatus.textContent = 'Installed! Launch with Fabric Loader to see capes.';
      installStatus.style.color = '#f5a623';
    } else {
      installStatus.textContent = res.error;
      installStatus.style.color = '#e05500';
    }
    installBtn.disabled = false;
    installBtn.textContent = 'Install Cosmetics Mod';
  });
}

// ── Server Host panel ─────────────────────────────────────────────────────────
const srvStartBtn  = document.getElementById('srv-start-btn') as HTMLButtonElement;
const srvStopBtn   = document.getElementById('srv-stop-btn')  as HTMLButtonElement;
const srvInfo      = document.getElementById('srv-info')!;
const srvAddress   = document.getElementById('srv-address')!;
const srvVerDisplay= document.getElementById('srv-ver-display')!;
const srvLog       = document.getElementById('srv-log')!;
const srvLogCopy   = document.getElementById('srv-log-copy') as HTMLButtonElement;
const srvCmdInput  = document.getElementById('srv-cmd-input') as HTMLInputElement;
const srvCmdBtn    = document.getElementById('srv-cmd-btn') as HTMLButtonElement;
const srvMemSlider    = document.getElementById('srv-mem')    as HTMLInputElement;
const srvMemVal       = document.getElementById('srv-mem-val')!;
const srvMinMemSlider = document.getElementById('srv-minmem') as HTMLInputElement;
const srvMinMemVal    = document.getElementById('srv-minmem-val')!;
const communityEl  = document.getElementById('community-servers')!;
const savedSrvEl   = document.getElementById('saved-servers')!;
const savedSrvEmpty= document.getElementById('saved-servers-empty')!;
const srvSaveBtn   = document.getElementById('srv-save-btn') as HTMLButtonElement;
const srvNewBtn    = document.getElementById('srv-new-btn') as HTMLButtonElement;
const srvSaveStatus= document.getElementById('srv-save-status')!;
const srv247Toggle = document.getElementById('srv-247-toggle') as HTMLInputElement;
const srvIpInput   = document.getElementById('srv-ip') as HTMLInputElement;

let srvRunning = false;
let selectedWorldPath: string | null = null;

// World selector (From Saves dropdown + Browse Folder fallback)
const srvWorldLabel    = document.getElementById('srv-world-label')!;
const srvClearWorldBtn = document.getElementById('srv-clear-world-btn') as HTMLButtonElement | null;
const fromSavesBtn     = document.getElementById('srv-from-saves-btn')  as HTMLButtonElement | null;
const savesMenu        = document.getElementById('srv-saves-menu')!;
const browseWorldBtn   = document.getElementById('srv-browse-world-btn') as HTMLButtonElement | null;

function setWorldPath(fullPath: string, label: string) {
  selectedWorldPath = fullPath;
  srvWorldLabel.textContent = `World: ${label}`;
  srvWorldLabel.style.color = '#f5a623';
  if (srvClearWorldBtn) srvClearWorldBtn.style.display = 'inline-flex';
}

fromSavesBtn?.addEventListener('click', async () => {
  if (savesMenu.style.display !== 'none') { savesMenu.style.display = 'none'; return; }

  // Position below the button using fixed coords so overflow:hidden doesn't clip it
  const rect = fromSavesBtn!.getBoundingClientRect();
  savesMenu.style.top  = `${rect.bottom + 4}px`;
  savesMenu.style.left = `${rect.left}px`;

  savesMenu.innerHTML = '<div style="padding:8px 14px;font-size:12px;color:#555;">Loading…</div>';
  savesMenu.style.display = 'block';

  const files = (window as any).files;
  const saves: string[] = await files?.listWorlds() ?? [];
  const savesDir: string = await files?.savesDir() ?? '';
  const sep = savesDir.includes('\\') ? '\\' : '/';

  savesMenu.innerHTML = '';
  if (!saves.length) {
    savesMenu.innerHTML = '<div style="padding:10px 14px;font-size:12px;color:#555;">No worlds found — play single-player first</div>';
    return;
  }
  for (const name of saves) {
    const item = document.createElement('div');
    item.style.cssText = 'padding:9px 14px;font-size:12px;color:#cccccc;cursor:pointer;border-bottom:1px solid #1e1e1e;';
    item.textContent = name;
    item.addEventListener('mouseenter', () => { item.style.background = '#1e1e1e'; });
    item.addEventListener('mouseleave', () => { item.style.background = ''; });
    item.addEventListener('click', () => {
      setWorldPath(`${savesDir}${sep}${name}`, name);
      savesMenu.style.display = 'none';
    });
    savesMenu.appendChild(item);
  }
});

document.addEventListener('click', (e) => {
  if (!savesMenu || savesMenu.style.display === 'none') return;
  if (!fromSavesBtn?.contains(e.target as Node) && !savesMenu.contains(e.target as Node)) {
    savesMenu.style.display = 'none';
  }
});

browseWorldBtn?.addEventListener('click', async () => {
  if (!server) return;
  const picked = await server.pickWorld();
  if (!picked) return;
  const folderName = picked.replace(/\\/g, '/').split('/').pop() ?? picked;
  setWorldPath(picked, folderName);
});

srvClearWorldBtn?.addEventListener('click', () => {
  selectedWorldPath = null;
  srvWorldLabel.textContent = 'No world selected — generates fresh each time';
  srvWorldLabel.style.color = '#555555';
  srvClearWorldBtn.style.display = 'none';
});
let srvLogLines: string[] = [];

// ── Dedicated server mode ──────────────────────────────────────────────────────
const DEDICATED_KEY = 'voxel_srv_dedicated_v1';
const dedicatedToggle = document.getElementById('srv-dedicated-toggle') as HTMLInputElement;
const bootToggle      = document.getElementById('srv-boot-toggle')      as HTMLInputElement;
const dedicatedDot    = document.getElementById('srv-dedicated-dot')!;
const dedicatedStatus = document.getElementById('srv-dedicated-status')!;

function setDedicatedDot(active: boolean) {
  dedicatedDot.style.background   = active ? '#3fb950' : '#30363d';
  dedicatedStatus.style.color     = active ? '#3fb950' : '#555555';
  dedicatedStatus.textContent     = active ? 'Active — server will auto-start' : 'Inactive';
}

function saveDedicatedSettings() {
  localStorage.setItem(DEDICATED_KEY, JSON.stringify({ dedicated: dedicatedToggle?.checked, boot: bootToggle?.checked }));
}

function loadDedicatedSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(DEDICATED_KEY) || '{}');
    if (dedicatedToggle) dedicatedToggle.checked = !!s.dedicated;
    if (bootToggle)      bootToggle.checked      = !!s.boot;
    setDedicatedDot(!!s.dedicated);
  } catch {}
}

dedicatedToggle?.addEventListener('change', () => {
  saveDedicatedSettings();
  setDedicatedDot(dedicatedToggle.checked);
  if (dedicatedToggle.checked && !srvRunning) {
    // Auto-start immediately if not already running
    setTimeout(() => { if (!srvRunning) srvStartBtn?.click(); }, 500);
  }
});

bootToggle?.addEventListener('change', async () => {
  saveDedicatedSettings();
  await (server as any)?.setAutoStart?.(bootToggle.checked);
});

// Sync boot toggle from OS setting on load
(async () => {
  const r = await (server as any)?.getAutoStart?.();
  if (bootToggle && r?.ok) bootToggle.checked = !!r.enabled;
})();

loadDedicatedSettings();
let myUid = '';
let pendingSrvName = '';
let pendingSrvVersion = '';

// ── Saved servers (localStorage) ──────────────────────────────────────────────
interface SavedServer { id: string; name: string; ip: string; version: string; publish: boolean; port?: number; maxPlayers?: number; motd?: string; maxMem?: number; minMem?: number; }

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

function applyServerConfig(srv: SavedServer) {
  (document.getElementById('srv-name') as HTMLInputElement).value = srv.name;
  srvIpInput.value = srv.ip;
  srv247Toggle.checked = srv.publish;
  const sel = document.getElementById('srv-version') as HTMLSelectElement;
  if (Array.from(sel.options).find(o => o.value === srv.version)) sel.value = srv.version;
  const portEl = document.getElementById('srv-port') as HTMLInputElement;
  if (portEl) portEl.value = String(srv.port ?? 25565);
  const maxPlayersEl = document.getElementById('srv-maxplayers') as HTMLInputElement;
  if (maxPlayersEl) maxPlayersEl.value = String(srv.maxPlayers ?? 20);
  const motdEl = document.getElementById('srv-motd') as HTMLInputElement;
  if (motdEl) motdEl.value = srv.motd ?? 'Voxel Client Server';
  const memEl = document.getElementById('srv-mem') as HTMLInputElement;
  if (memEl) { memEl.value = String(srv.maxMem ?? 2); document.getElementById('srv-mem-val')!.textContent = String(srv.maxMem ?? 2); }
  const minMemEl = document.getElementById('srv-minmem') as HTMLInputElement;
  if (minMemEl) { minMemEl.value = String(srv.minMem ?? 512); document.getElementById('srv-minmem-val')!.textContent = String(srv.minMem ?? 512); }
  srvLog.innerHTML = '<div id="srv-log-placeholder" style="color:#444444;">Select a version and click Start Server</div>';
  srvLogLines = [];
}

function renderSavedServers() {
  const list = loadSavedServers();
  savedSrvEmpty.style.display = list.length ? 'none' : 'block';
  // Remove existing server cards (not the empty placeholder)
  savedSrvEl.querySelectorAll('.saved-srv-card').forEach(c => c.remove());
  list.forEach(srv => {
    const card = document.createElement('div');
    card.className = 'mod-card saved-srv-card';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      <div class="mod-icon" style="font-size:20px;"></div>
      <div class="mod-info">
        <div class="mod-name">${srv.name}</div>
        <div class="mod-desc" style="font-family:monospace">${srv.ip || '(no IP)'} &nbsp;·&nbsp; ${srv.version}</div>
        <div class="mod-tags" style="margin-top:6px;">
          <span class="mod-tag ${srv.publish ? 'perf' : ''}">${srv.publish ? '24/7 Listed' : 'Local only'}</span>
        </div>
      </div>
      <div class="mod-right" style="gap:6px;">
        <button data-id="${srv.id}" class="srv-del-btn" style="padding:5px 12px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#8b949e;font-size:11px;cursor:pointer;">✕</button>
      </div>`;
    card.addEventListener('click', () => applyServerConfig(srv));
    card.querySelector('.srv-del-btn')!.addEventListener('click', async (e) => {
      e.stopPropagation();
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

srvNewBtn?.addEventListener('click', () => {
  (document.getElementById('srv-name') as HTMLInputElement).value = 'My Server';
  srvIpInput.value = '';
  srv247Toggle.checked = false;
  const sel = document.getElementById('srv-version') as HTMLSelectElement;
  if (sel.options.length > 0) sel.selectedIndex = 0;
  const mem = document.getElementById('srv-mem') as HTMLInputElement;
  mem.value = '2';
  document.getElementById('srv-mem-val')!.textContent = '2';
  srvSaveStatus.textContent = '';
});

srvSaveBtn?.addEventListener('click', async () => {
  const name       = (document.getElementById('srv-name') as HTMLInputElement).value.trim() || 'My Server';
  const ip         = srvIpInput.value.trim();
  const version    = (document.getElementById('srv-version') as HTMLSelectElement).value;
  const publish    = srv247Toggle.checked;
  const port       = parseInt((document.getElementById('srv-port') as HTMLInputElement)?.value) || 25565;
  const maxPlayers = parseInt((document.getElementById('srv-maxplayers') as HTMLInputElement)?.value) || 20;
  const motd       = (document.getElementById('srv-motd') as HTMLInputElement)?.value.trim() || 'Voxel Client Server';
  const maxMem     = parseInt((document.getElementById('srv-mem') as HTMLInputElement)?.value) || 2;
  const minMem     = parseInt((document.getElementById('srv-minmem') as HTMLInputElement)?.value) || 512;

  if (publish && !isValidServerDomain(ip)) {
    srvSaveStatus.textContent = 'Enter a domain address to list publicly (e.g. play.yourserver.net)';
    srvSaveStatus.style.color = '#e05500';
    setTimeout(() => { srvSaveStatus.textContent = ''; }, 4000);
    return;
  }

  const id  = `${Date.now()}`;
  const srv: SavedServer = { id, name, ip, version, publish, port, maxPlayers, motd, maxMem, minMem };
  const list = loadSavedServers().filter(s => s.name !== name);
  list.unshift(srv);
  persistSavedServers(list);
  if (publish) await publish247(srv);
  renderSavedServers();
  srvSaveStatus.textContent = publish ? 'Saved & listed 24/7' : 'Saved locally';
  srvSaveStatus.style.color = '#f5a623';
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



async function onServerReady(name: string, version: string, port: number) {
  const manualIp = srvIpInput.value.trim();
  const ip = manualIp || await getPublicIP();
  if (!manualIp) srvIpInput.value = ip;
  srvAddress.textContent = `localhost:${port}   (public: ${ip}:${port})`;
  // Update status dot to green "Ready"
  const dot = document.getElementById('srv-dedicated-dot');
  const status = document.getElementById('srv-dedicated-status');
  if (dot) dot.style.background = '#3fb950';
  if (status) { status.textContent = 'Ready — accepting connections'; status.style.color = '#3fb950'; }
  srvAddLog(`[Host] ✓ Server is READY — connect with localhost:${port}`);
  await publishServer(name, version, ip);
}

function srvAddHint(msg: string) {
  const div = document.createElement('div');
  div.style.cssText = 'line-height:1.6;color:#f5a623;padding-left:14px;font-style:italic;';
  div.textContent = `↳ ${msg}`;
  srvLog.appendChild(div);
  srvLogLines.push(`↳ ${msg}`);
}

function srvAddLog(text: string) {
  const lines = text.split('\n').filter(l => l.trim());
  lines.forEach(l => {
    srvLogLines.push(l);
    if (srvLogLines.length > 300) srvLogLines.shift();
    const div = document.createElement('div');
    div.style.lineHeight = '1.6';
    if (l.includes('[Host] ✓')) {
      div.style.color = '#3fb950'; div.style.fontWeight = '600';
    } else if (l.includes('FATAL') || l.includes('Exception in') || l.includes(']: Error') || l.includes('crashed')) {
      div.style.color = '#f85149';
    } else if (l.includes('ERROR') || l.includes('WARN')) {
      div.style.color = '#f6c356';
    } else if (l.includes('[Host]')) {
      div.style.color = '#f6c356';
    } else {
      div.style.color = '#6e7681';
    }
    div.textContent = l;
    srvLog.appendChild(div);

    // Inline hints for common failure patterns
    if (l.includes('Address already in use') || l.includes('FAILED TO BIND TO PORT')) {
      srvAddHint('Port already taken — change the port number above and restart');
    } else if (l.includes('OutOfMemoryError') || l.includes('Could not reserve enough space')) {
      srvAddHint('Out of memory — increase Max RAM above');
    } else if (l.includes('Invalid or corrupt jarfile') || l.includes('Error opening zip file')) {
      srvAddHint('server.jar is corrupt — open the Files folder, delete server.jar, and restart');
    } else if (l.includes('Unable to access jarfile')) {
      srvAddHint('server.jar not found — it may have been moved or deleted');
    } else if (l.includes('UnsupportedClassVersionError')) {
      srvAddHint('Java version too old for this Minecraft version — restart to re-download Java');
    }
  });
  document.getElementById('srv-log-placeholder')?.remove();
  srvLog.scrollTop = srvLog.scrollHeight;
}

document.getElementById('srv-log-copy')?.addEventListener('click', function() {
  const text = srvLogLines.join('\n');
  if (!text) { (this as HTMLButtonElement).textContent = 'Nothing yet'; setTimeout(() => { (this as HTMLButtonElement).textContent = 'Copy'; }, 1200); return; }
  (window as any).electron?.copyText(text);
  (this as HTMLButtonElement).textContent = '✓ Copied!';
  (this as HTMLButtonElement).style.color = '#f5a623';
  setTimeout(() => { (this as HTMLButtonElement).textContent = 'Copy'; (this as HTMLButtonElement).style.color = ''; }, 1500);
});

// Copy address button
document.getElementById('srv-copy-addr-btn')?.addEventListener('click', () => {
  const addr = srvAddress.textContent || 'localhost:25565';
  (window as any).electron?.copyText(addr);
  const btn = document.getElementById('srv-copy-addr-btn') as HTMLButtonElement;
  if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); }
});

// Open server files folder
document.getElementById('srv-open-folder-btn')?.addEventListener('click', () => {
  const ver = (document.getElementById('srv-version') as HTMLSelectElement)?.value || 'default';
  (server as any)?.openFolder?.(ver);
});

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

let srvAllVersions: { id: string; type: string }[] = [];

function populateSrvVersions() {
  const sel = document.getElementById('srv-version') as HTMLSelectElement;
  const showSnaps = (document.getElementById('srv-snapshots-toggle') as HTMLInputElement)?.checked;
  const prev = sel.value;
  sel.innerHTML = '';
  const filtered = srvAllVersions.filter(v =>
    v.type === 'release' || (showSnaps && v.type === 'snapshot')
  );
  filtered.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = i === 0
      ? `${v.id} — ${v.type === 'snapshot' ? 'Latest Snapshot' : 'Latest'}`
      : v.type === 'snapshot' ? `${v.id} ✦` : v.id;
    sel.appendChild(opt);
  });
  if (filtered.find(v => v.id === prev)) sel.value = prev;
  loadSrvSettings();
}

// Populate server version dropdown from Mojang manifest
async function loadServerVersions() {
  const sel = document.getElementById('srv-version') as HTMLSelectElement;
  if (!sel) return;
  try {
    const res  = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
    const data = await res.json() as { versions: { id: string; type: string }[] };
    srvAllVersions = data.versions.filter(v => v.type === 'release' || v.type === 'snapshot');
    populateSrvVersions();
  } catch {
    srvAllVersions = [
      { id: '1.21.5', type: 'release' }, { id: '1.21.4', type: 'release' },
      { id: '1.21.3', type: 'release' }, { id: '1.21.1', type: 'release' },
      { id: '1.21',   type: 'release' }, { id: '1.20.6', type: 'release' },
      { id: '1.20.4', type: 'release' }, { id: '1.20.1', type: 'release' },
      { id: '1.19.4', type: 'release' },
    ];
    populateSrvVersions();
  }
  maybeDedicatedAutoStart();
}

document.getElementById('srv-snapshots-toggle')?.addEventListener('change', populateSrvVersions);

function maybeDedicatedAutoStart() {
  try {
    const s = JSON.parse(localStorage.getItem(DEDICATED_KEY) || '{}');
    if (s.dedicated && !srvRunning) {
      srvAddLog('[Dedicated] Auto-starting server…');
      setTimeout(() => { if (!srvRunning) srvStartBtn?.click(); }, 800);
    }
  } catch {}
}

// ── Persist server settings across sessions ────────────────────────────────────
const SRV_SETTINGS_KEY = 'voxel_srv_settings';
function loadSrvSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SRV_SETTINGS_KEY) || '{}');
    const nameEl   = document.getElementById('srv-name')       as HTMLInputElement;
    const verSel   = document.getElementById('srv-version')    as HTMLSelectElement;
    const portEl   = document.getElementById('srv-port')       as HTMLInputElement;
    const maxPEl   = document.getElementById('srv-maxplayers') as HTMLInputElement;
    const motdEl   = document.getElementById('srv-motd')       as HTMLInputElement;
    const arEl     = document.getElementById('srv-autorestart')as HTMLInputElement;
    if (s.name)    nameEl.value = s.name;
    if (s.version && Array.from(verSel.options).find(o => o.value === s.version)) verSel.value = s.version;
    if (s.mem)     { srvMemSlider.value = s.mem;       srvMemVal.textContent    = s.mem; }
    if (s.minMem)  { srvMinMemSlider.value = s.minMem; srvMinMemVal.textContent = s.minMem; }
    if (s.port)    portEl.value   = s.port;
    if (s.maxP)    maxPEl.value   = s.maxP;
    if (s.motd)    motdEl.value   = s.motd;
    if (arEl)      arEl.checked   = !!s.autoRestart;
  } catch {}
}
function saveSrvSettings() {
  const nameEl = document.getElementById('srv-name')       as HTMLInputElement;
  const verSel = document.getElementById('srv-version')    as HTMLSelectElement;
  const portEl = document.getElementById('srv-port')       as HTMLInputElement;
  const maxPEl = document.getElementById('srv-maxplayers') as HTMLInputElement;
  const motdEl = document.getElementById('srv-motd')       as HTMLInputElement;
  const arEl   = document.getElementById('srv-autorestart')as HTMLInputElement;
  localStorage.setItem(SRV_SETTINGS_KEY, JSON.stringify({
    name: nameEl?.value,
    version: verSel?.value,
    mem:    srvMemSlider?.value,
    minMem: srvMinMemSlider?.value,
    port:   portEl?.value,
    maxP:   maxPEl?.value,
    motd:   motdEl?.value,
    autoRestart: arEl?.checked,
  }));
}
srvMemSlider?.addEventListener('input', () => { srvMemVal.textContent = srvMemSlider.value; saveSrvSettings(); });
srvMinMemSlider?.addEventListener('input', () => { srvMinMemVal.textContent = srvMinMemSlider.value; saveSrvSettings(); });
document.getElementById('srv-name')?.addEventListener('input', saveSrvSettings);
document.getElementById('srv-version')?.addEventListener('change', saveSrvSettings);
document.getElementById('srv-port')?.addEventListener('input', saveSrvSettings);
document.getElementById('srv-maxplayers')?.addEventListener('input', saveSrvSettings);
document.getElementById('srv-motd')?.addEventListener('input', saveSrvSettings);
document.getElementById('srv-autorestart')?.addEventListener('change', saveSrvSettings);

document.getElementById('srv-preset-btn')?.addEventListener('click', () => {
  (document.getElementById('srv-name')       as HTMLInputElement).value = 'Voxels Default';
  (document.getElementById('srv-port')       as HTMLInputElement).value = '25565';
  (document.getElementById('srv-maxplayers') as HTMLInputElement).value = '20';
  (document.getElementById('srv-motd')       as HTMLInputElement).value = 'Voxel Client Server';
  const sel = document.getElementById('srv-version') as HTMLSelectElement;
  const latest = Array.from(sel.options).find(o => o.value && !o.disabled);
  if (latest) sel.value = latest.value;
  srvMemSlider.value = '4'; srvMemVal.textContent = '4';
  srvMinMemSlider.value = '512'; srvMinMemVal.textContent = '512';
  saveSrvSettings();
});

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
          <div class="mod-icon" style="font-size:20px;"></div>
          <div class="mod-info">
            <div class="mod-name">${s.name || 'Unnamed Server'}</div>
            <div class="mod-desc">${s.owner || 'Unknown'} · ${s.version || '?'}</div>
            <div class="mod-tags" style="margin-top:6px;">
              <span class="mod-tag ${isOnline ? 'util' : ''}">${isOnline ? 'Online' : 'Offline'}</span>
              ${s.publish ? '<span class="mod-tag perf">24/7</span>' : ''}
            </div>
          </div>
          <div class="mod-right">
            <span style="font-family:monospace;font-size:11px;color:${isOnline ? '#f5a623' : '#484f58'};background:rgba(${isOnline ? '63,185,80' : '255,255,255'},0.06);border:1px solid rgba(${isOnline ? '63,185,80' : '255,255,255'},0.12);padding:4px 10px;border-radius:6px;">${s.address || '—'}:${s.port || 25565}</span>
          </div>`;
        communityEl.appendChild(card);
      });
    });
  } catch {}
}

// Start/stop server
srvStartBtn?.addEventListener('click', async () => {
  if (!server) return;

  const name       = (document.getElementById('srv-name')       as HTMLInputElement).value.trim() || 'My Server';
  const version    = (document.getElementById('srv-version')    as HTMLSelectElement).value;
  const maxMem     = parseInt(srvMemSlider.value, 10);
  const minMem     = parseInt((document.getElementById('srv-minmem') as HTMLInputElement)?.value || '512', 10);
  const port       = parseInt((document.getElementById('srv-port') as HTMLInputElement)?.value || '25565', 10);
  const maxPlayers = parseInt((document.getElementById('srv-maxplayers') as HTMLInputElement)?.value || '20', 10);
  const motd       = (document.getElementById('srv-motd') as HTMLInputElement)?.value.trim() || 'Voxel Client Server';
  const seed       = (document.getElementById('srv-seed') as HTMLInputElement)?.value.trim() || undefined;
  const worldPath  = selectedWorldPath ?? undefined;
  const srvJavaSel = (document.getElementById('srv-java-version') as HTMLSelectElement)?.value ?? 'auto';
  const javaVersion = srvJavaSel === 'auto' ? undefined : parseInt(srvJavaSel, 10);

  srvRunning = true;
  srvStopBtn.style.display = 'inline-flex';
  srvStopBtn.disabled = false;
  srvStartBtn.style.display = 'none';
  srvStartBtn.textContent = 'Starting…';
  srvLog.innerHTML = '';
  srvLogLines = [];

  pendingSrvName    = name;
  pendingSrvVersion = version;

  const res = await server.start({ version, maxMem, minMem, name, port, maxPlayers, motd, seed, worldPath, javaVersion });
  if (!res.ok) {
    srvAddLog(`[Error] ${res.error}`);
    srvRunning = false;
    srvStopBtn.style.display = 'none';
    srvStartBtn.style.display = 'inline-flex';
    srvStartBtn.style.background = '#f5a623';
    srvStartBtn.style.color = '#0d1117';
    srvStartBtn.textContent = '▶ Start Server';
    srvStartBtn.disabled = false;
    return;
  }

  srvInfo.style.display = 'flex';
  srvVerDisplay.textContent = version;
  const portDisplay = document.getElementById('srv-port-display');
  const maxPDisplay = document.getElementById('srv-maxplayers-display');
  const playersBadge = document.getElementById('srv-players-badge');
  if (portDisplay) portDisplay.textContent = String(port);
  if (maxPDisplay) maxPDisplay.textContent = String(maxPlayers);
  if (playersBadge) playersBadge.textContent = `0/${maxPlayers} players`;
  srvAddress.textContent = `Starting… connect via localhost:${port} once ready`;
  // IP + publish happen in srvAddLog when MC logs "Done"
});

srvStopBtn?.addEventListener('click', async () => {
  if (!server || !srvRunning) return;
  srvStopBtn.disabled = true;
  srvStopBtn.textContent = 'Stopping…';
  await server.stop();
});

// Handle server log events
if (server) {
  server.onLog((line: string) => srvAddLog(line));

  (server as any).onReady?.((port: number) => {
    onServerReady(pendingSrvName, pendingSrvVersion, port);
  });

  (server as any).onPlayerJoin?.((name: string) => {
    srvAddLog(`[Host] >> ${name} joined the server`);
    // Flash a toast notification
    const toast = document.createElement('div');
    toast.textContent = `${name} joined the server`;
    toast.style.cssText = 'position:fixed;bottom:80px;right:24px;background:#1e1e1e;border:1px solid #f5a623;border-radius:8px;color:#ffffff;font-size:13px;padding:10px 18px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.3s;font-family:Roboto,sans-serif;';
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = '1'; });
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 350); }, 3500);
  });

  (server as any).onPlayerCount?.((cur: number, max: number) => {
    const badge = document.getElementById('srv-players-badge');
    const maxD  = document.getElementById('srv-maxplayers-display');
    if (badge) badge.textContent = `${cur}/${max} players`;
    if (maxD)  maxD.textContent  = String(max);
  });

  server.onClosed((info: any) => {
    const code = typeof info === 'object' ? info?.code : info;
    const userStopped = typeof info === 'object' ? info?.userStopped : false;
    srvRunning = false;
    srvInfo.style.display = 'none';
    // Reset ready indicator
    const dot = document.getElementById('srv-dedicated-dot');
    const status = document.getElementById('srv-dedicated-status');
    if (dot) dot.style.background = '#30363d';
    if (status) { status.textContent = 'Inactive'; status.style.color = '#555555'; }
    srvStopBtn.style.display = 'none';
    srvStopBtn.disabled = false;
    srvStopBtn.textContent = '⏹ Stop Server';
    srvStartBtn.style.display = 'inline-flex';
    srvStartBtn.style.background = '#f5a623';
    srvStartBtn.style.color = '#0d1117';
    srvStartBtn.textContent = '▶ Start Server';
    srvStartBtn.disabled = false;
    if (!userStopped && code !== 0 && code != null) {
      const codeHex = code < 0 ? `0x${(code >>> 0).toString(16).toUpperCase()}` : String(code);
      const codeDesc: Record<number, string> = {
        1:             'General server error',
        2:             'Bad Java arguments',
        137:           'Killed by OS — likely out of memory',
        [-1073741819]: 'Windows access violation (0xC0000005) — corrupt JAR or Java install',
        [-1073741571]: 'Windows stack overflow (0xC00000FD) — try increasing RAM',
        [-1073740791]: 'Windows heap corruption — try reinstalling Java',
      };
      const desc = codeDesc[code] || 'Unexpected exit';
      srvAddLog(`[Host] ✗ Server stopped — exit code ${codeHex} (${desc})`);
      srvLog.lastElementChild && ((srvLog.lastElementChild as HTMLElement).style.color = '#f85149');
      srvLog.lastElementChild && ((srvLog.lastElementChild as HTMLElement).style.fontWeight = '600');
      const autoRestart = (document.getElementById('srv-autorestart') as HTMLInputElement)?.checked;
      const dedicatedOn = (() => { try { return JSON.parse(localStorage.getItem(DEDICATED_KEY) || '{}').dedicated; } catch { return false; } })();
      if (autoRestart || dedicatedOn) {
        const label = dedicatedOn ? '[Dedicated]' : '[Host]';
        srvAddLog(`${label} Restarting server in 5s…`);
        setTimeout(() => { if (!srvRunning) srvStartBtn.click(); }, 5000);
      }
    } else {
      srvAddLog('[Host] Server stopped.');
    }
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
    // Download silently — don't interrupt the user until it's ready
    if (checkBtn) { checkBtn.textContent = 'Downloading…'; checkBtn.disabled = true; }
    if (updateSub) updateSub.textContent = `Downloading v${ver} in background…`;
  });
  updater.onProgress((pct: number) => {
    if (updateSub) updateSub.textContent = `Downloading update… ${pct}%`;
  });
  updater.onDownloaded(() => {
    // Update downloaded — auto-installs in 10s if Minecraft isn't running
    banner.style.display = 'flex';
    progressWrap2.style.display = 'none';
    installBtn.style.display = 'inline-block';
    if (checkBtn) { checkBtn.textContent = 'Check for Updates'; checkBtn.disabled = false; }
    if (updateSub) updateSub.textContent = 'Update downloaded — restarting automatically';
    let secs = 10;
    updateText.textContent = `Update ready — installing in ${secs}s`;
    const cd = setInterval(() => {
      secs--;
      if (secs <= 0) { clearInterval(cd); updateText.textContent = 'Installing update…'; }
      else updateText.textContent = `Update ready — installing in ${secs}s`;
    }, 1000);
    enableRestartButtons();
  });

  updater.onError?.((msg: string) => {
    if (checkBtn) { checkBtn.textContent = 'Retry'; checkBtn.disabled = false; }
    if (updateSub) updateSub.textContent = `Update failed: ${msg}`;
  });

  installBtn.addEventListener('click', () => updater.install());
  checkBtn?.addEventListener('click', () => updater.check());
}

// ── Files panel ───────────────────────────────────────────────────────────────
function makeDropZone(zoneId: string, accept: string[], onDrop: (paths: string[]) => void) {
  const zone = document.getElementById(zoneId)!;
  const highlight = () => { zone.style.borderColor = '#f5a623'; zone.style.background = 'rgba(245,166,35,0.06)'; };
  const unhighlight = () => { zone.style.borderColor = '#30363d'; zone.style.background = 'rgba(13,17,23,0.5)'; };
  zone.addEventListener('dragover',  e => { e.preventDefault(); highlight(); });
  zone.addEventListener('dragleave', () => unhighlight());
  zone.addEventListener('drop', e => {
    e.preventDefault(); unhighlight();
    const paths: string[] = [];
    if (e.dataTransfer?.files) {
      for (const f of Array.from(e.dataTransfer.files)) {
        const fp = (f as any).path as string;
        if (fp) paths.push(fp);
      }
    }
    if (paths.length) onDrop(paths);
  });
  zone.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept.length) input.accept = accept.join(',');
    input.multiple = true;
    input.addEventListener('change', () => {
      const paths = Array.from(input.files || []).map(f => (f as any).path as string).filter(Boolean);
      if (paths.length) onDrop(paths);
    });
    input.click();
  });
}

function renderFileList(listId: string, items: string[]) {
  const list = document.getElementById(listId)!;
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = `<div style="color:#484f58;font-size:12px;padding:4px 0;">No files yet — drop one above</div>`;
    return;
  }
  for (const name of items) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(13,17,23,0.6);border:1px solid #21262d;border-radius:8px;';
    row.innerHTML = `<span style="flex:1;font-size:12px;color:#e6edf3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${name}</span>`;
    list.appendChild(row);
  }
}

async function refreshFileLists() {
  const filesApi = (window as any).files;
  if (!filesApi) return;
  const [worlds, schematics] = await Promise.all([filesApi.listWorlds(), filesApi.listSchematics()]);
  renderFileList('worlds-list',     worlds);
  renderFileList('schematics-list', schematics);
}

function initFiles() {
  const filesApi = (window as any).files;

  // Drop zones
  makeDropZone('worlds-dropzone', ['.zip'], async (paths) => {
    if (!filesApi) return;
    for (const p of paths) {
      const res = await filesApi.installWorld(p);
      if (!res?.ok) alert(`Failed to install world: ${res?.error}`);
    }
    refreshFileLists();
  });

  makeDropZone('schematics-dropzone', ['.schematic', '.litematic', '.schem', '.nbt'], async (paths) => {
    if (!filesApi) return;
    for (const p of paths) {
      const ext = p.split('.').pop()?.toLowerCase() || '';
      if (!['schematic','litematic','schem','nbt'].includes(ext)) continue;
      const res = await filesApi.installSchematic(p);
      if (!res?.ok) alert(`Failed: ${res?.error}`);
    }
    refreshFileLists();
  });

  // Open folder buttons
  document.getElementById('files-open-saves')?.addEventListener('click', () => filesApi?.openFolder('saves'));
  document.getElementById('files-open-schematics')?.addEventListener('click', () => filesApi?.openFolder('schematics'));
  document.querySelectorAll('.files-folder-btn').forEach(btn => {
    btn.addEventListener('click', () => filesApi?.openFolder((btn as HTMLElement).dataset.folder || 'root'));
  });

  // Quick-open button styles
  document.querySelectorAll<HTMLElement>('.files-folder-btn').forEach(btn => {
    btn.style.cssText = 'padding:7px 14px;background:rgba(33,38,45,0.6);border:1px solid #30363d;border-radius:7px;color:#8b949e;font-size:12px;cursor:pointer;';
    btn.onmouseenter = () => { btn.style.borderColor = '#f5a623'; btn.style.color = '#f5a623'; };
    btn.onmouseleave = () => { btn.style.borderColor = '#30363d'; btn.style.color = '#8b949e'; };
  });

  refreshFileLists();
}

// ── Global Chat & Voice Calls ─────────────────────────────────────────────────
const STUN_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// ── Group voice channel state ─────────────────────────────────────────────────
const GROOM = 'voxel_voice/groom';
let groomPeers: Map<string, RTCPeerConnection> = new Map();
let groomAudios: Map<string, HTMLAudioElement> = new Map();
let groomStream: MediaStream | null = null;
let inGroom = false;
let groomMuted = false;
let chatUnread = 0;
let chatNotifEnabled = localStorage.getItem('voxel_chat_notif') !== 'false';
let chatStartedAt = 0;
let adminList: Set<string> = new Set();
let chatTimeouts: Record<string, { until: number; reason: string; by: string }> = {};
let timeoutTargetUser = '';
let timeoutDurMins = 5;

function getChatClientId(): string {
  let id = localStorage.getItem('voxel_client_id');
  if (!id) {
    id = `vc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('voxel_client_id', id);
  }
  return id;
}

function getChatUsername(): string {
  const mcName = (document.getElementById('mc-ign') as HTMLElement | null)?.textContent?.trim();
  if (mcName && mcName !== 'Loading…') return mcName;
  const offName = (document.getElementById('offline-username') as HTMLInputElement | null)?.value?.trim();
  if (offName) return offName;
  let guest = localStorage.getItem('voxel_guest_name');
  if (!guest) {
    guest = 'Guest_' + Math.random().toString(36).slice(2, 6).toUpperCase();
    localStorage.setItem('voxel_guest_name', guest);
  }
  return guest;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateChatBadge() {
  const badge = document.getElementById('chat-badge')!;
  if (chatUnread > 0) {
    badge.textContent = chatUnread > 99 ? '99+' : String(chatUnread);
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function usernameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue},55%,42%)`;
}

function appendChatMessage(m: { user: string; text: string; ts: number; type?: string }, container: HTMLElement, myName: string) {
  const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (m.type === 'announcement') {
    const div = document.createElement('div');
    div.className = 'chat-announcement';
    div.innerHTML =
      `<span style="font-size:10px;color:#8b949e;font-weight:600;letter-spacing:0.5px;text-transform:uppercase;">Announcement</span>` +
      `<div style="color:#ffffff;font-size:13px;margin-top:5px;word-break:break-word;">${escHtml(m.text)}</div>` +
      `<span style="font-size:10px;color:#484f58;margin-top:4px;display:block;">— ${escHtml(m.user)} · ${time}</span>`;
    container.appendChild(div);
    return;
  }
  const isMe = m.user === myName;
  const isAdmin = adminList.has(m.user);
  const adminBadge = isAdmin ? ` <span class="chat-admin-badge">ADMIN</span>` : '';

  const row = document.createElement('div');
  // My messages: bubble pushed to right. Others: avatar + bubble on left.
  row.style.cssText = `display:flex;align-items:flex-end;gap:7px;${isMe ? 'justify-content:flex-end;' : ''}`;

  const bubble = document.createElement('div');
  bubble.style.cssText = `display:flex;flex-direction:column;align-items:${isMe ? 'flex-end' : 'flex-start'};gap:2px;max-width:75%;`;
  bubble.innerHTML =
    `<span style="font-size:10px;color:#484f58;">${isMe ? '' : escHtml(m.user) + adminBadge + ' · '}${time}</span>` +
    `<div style="background:${isMe ? 'rgba(245,166,35,0.15)' : '#141414'};border:1px solid ${isMe ? 'rgba(245,166,35,0.28)' : '#222222'};border-radius:10px;padding:6px 11px;font-size:13px;color:#ffffff;word-break:break-word;">${escHtml(m.text)}</div>`;

  if (!isMe) {
    // Show skin face for others, colored initial as fallback
    const avatarColor = usernameColor(m.user);
    const initial = (m.user[0] || '?').toUpperCase();
    const avatarWrap = document.createElement('div');
    avatarWrap.style.cssText = 'flex-shrink:0;width:24px;height:24px;position:relative;';
    const img = document.createElement('img');
    img.src = `https://minotar.net/avatar/${encodeURIComponent(m.user)}/24`;
    img.style.cssText = 'width:24px;height:24px;border-radius:50%;image-rendering:pixelated;display:block;';
    const fallback = document.createElement('span');
    fallback.className = 'chat-msg-avatar';
    fallback.style.cssText = `display:none;background:${avatarColor};`;
    fallback.textContent = initial;
    img.onerror = () => { img.style.display = 'none'; fallback.style.display = 'flex'; };
    avatarWrap.appendChild(img);
    avatarWrap.appendChild(fallback);
    row.appendChild(avatarWrap);
  }

  row.appendChild(bubble);
  container.appendChild(row);
}

function renderChatUsers(val: Record<string, any>, container: HTMLElement) {
  container.innerHTML = '';
  const myId = getChatClientId();
  const myName = getChatUsername();
  const amIAdmin = adminList.has(myName);

  // self row
  const selfRow = document.createElement('div');
  selfRow.className = 'chat-user-row';
  const selfBadge = amIAdmin ? ` <span class="chat-admin-badge">ADMIN</span>` : '';
  selfRow.innerHTML =
    `<span style="width:7px;height:7px;background:#3fb950;border-radius:50%;flex-shrink:0;"></span>` +
    `<span style="font-size:12px;color:#f5a623;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;">${escHtml(myName)}${selfBadge}</span>`;
  container.appendChild(selfRow);

  Object.entries(val).forEach(([id, v]: [string, any]) => {
    if (id === myId) return;
    const isThisAdmin = adminList.has(v.name);
    const adminBadge = isThisAdmin ? ` <span class="chat-admin-badge">ADMIN</span>` : '';
    const timeoutBtn = (amIAdmin && !isThisAdmin) ? `<button class="chat-timeout-btn" title="Timeout ${escHtml(v.name)}">⏱</button>` : '';
    const row = document.createElement('div');
    row.className = 'chat-user-row';
    row.innerHTML =
      `<span style="width:7px;height:7px;background:#3fb950;border-radius:50%;flex-shrink:0;"></span>` +
      `<span style="font-size:12px;color:#ffffff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(v.name)}${adminBadge}</span>` +
      timeoutBtn;
    if (amIAdmin && !isThisAdmin) {
      row.querySelector<HTMLButtonElement>('.chat-timeout-btn')!.addEventListener('click', (e) => {
        e.stopPropagation();
        openTimeoutModal(v.name);
      });
    }
    container.appendChild(row);
  });
}

function openTimeoutModal(username: string) {
  timeoutTargetUser = username;
  timeoutDurMins = 5;
  document.getElementById('timeout-target-name')!.textContent = username;
  (document.getElementById('timeout-reason') as HTMLInputElement).value = '';
  document.querySelectorAll<HTMLButtonElement>('.timeout-dur-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.mins) === 5);
  });
  (document.getElementById('chat-timeout-modal') as HTMLElement).style.display = 'flex';
}

// ── Group Voice Channel ────────────────────────────────────────────────────────

function updateVoiceBar() {
  const bar     = document.getElementById('chat-call-bar')!;
  const joinBtn = document.getElementById('chat-voice-join-btn')!;
  const membEl  = document.getElementById('chat-voice-members')!;
  bar.style.display    = inGroom ? 'flex' : 'none';
  joinBtn.style.display = inGroom ? 'none' : 'inline-block';
  if (inGroom) {
    get(ref(rtdb, `${GROOM}/members`)).then(s => {
      const names = Object.values((s.val() || {}) as Record<string, { name: string }>).map(v => v.name);
      membEl.textContent = names.join(', ') || '…';
    }).catch(() => {});
  }
}

function groomAddPeer(peerId: string): RTCPeerConnection {
  const pc = new RTCPeerConnection(STUN_CONFIG);
  groomPeers.set(peerId, pc);
  groomStream!.getTracks().forEach(t => pc.addTrack(t, groomStream!));
  const remote = new MediaStream();
  const audio = new Audio();
  groomAudios.set(peerId, audio);
  pc.ontrack = e => {
    e.streams[0].getTracks().forEach(t => remote.addTrack(t));
    audio.srcObject = remote;
    audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      groomPeers.get(peerId)?.close();
      groomPeers.delete(peerId);
      const a = groomAudios.get(peerId);
      if (a) { a.srcObject = null; groomAudios.delete(peerId); }
      updateVoiceBar();
    }
  };
  return pc;
}

async function joinVoiceChannel() {
  if (inGroom) return;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('MediaDevices API not available');
    groomStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }
  catch (micErr: any) {
    const reason = micErr?.name === 'NotFoundError'    ? 'No microphone found — plug one in and try again'
                 : micErr?.name === 'NotReadableError' ? 'Microphone is in use by another app — close it and try again'
                 : micErr?.name === 'NotAllowedError'  ? 'Blocked by Windows — open Settings and allow mic access'
                 : `Error: ${micErr?.message || micErr?.name || 'unknown'}`;

    // Auto-open Windows mic privacy settings if it's a permission issue
    if (micErr?.name === 'NotAllowedError' || !micErr?.name) {
      (window as any).electron?.openExternal('ms-settings:privacy-microphone');
    }

    // Show a small "Try Again" toast — settings window is already open
    const existing = document.getElementById('mic-blocked-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'mic-blocked-toast';
    toast.style.cssText = 'position:fixed;bottom:80px;right:24px;background:#141414;border:1px solid rgba(248,81,73,0.5);border-radius:10px;padding:14px 18px;z-index:9999;max-width:280px;font-family:inherit;box-shadow:0 8px 32px rgba(0,0,0,0.7);';
    toast.innerHTML = `<div style="color:#f85149;font-weight:700;font-size:13px;margin-bottom:6px;">Microphone blocked</div>
      <div style="color:#f6c356;font-size:11px;font-family:monospace;background:#0d0d0d;border-radius:5px;padding:6px 8px;margin-bottom:8px;">${reason}</div>
      <div style="color:#aaaaaa;font-size:11px;line-height:1.6;margin-bottom:10px;">If you just enabled it in Windows Settings,<br><strong style="color:#ffffff;">you must restart the app</strong> for it to take effect.</div>
      <div style="display:flex;gap:8px;">
        <button id="mic-restart" style="flex:1;padding:7px;background:rgba(245,166,35,0.15);border:1px solid rgba(245,166,35,0.4);border-radius:6px;color:#f5a623;font-size:12px;cursor:pointer;font-weight:600;">↺ Restart App</button>
        <button id="mic-retry" style="flex:1;padding:7px;background:rgba(63,185,80,0.15);border:1px solid rgba(63,185,80,0.4);border-radius:6px;color:#3fb950;font-size:12px;cursor:pointer;font-weight:600;">Try Again</button>
        <button id="mic-dismiss" style="padding:7px 10px;background:none;border:1px solid #2a2a2a;border-radius:6px;color:#777777;font-size:12px;cursor:pointer;">✕</button>
      </div>`;
    document.body.appendChild(toast);
    toast.querySelector('#mic-restart')!.addEventListener('click', () => (window as any).electron?.relaunch());
    toast.querySelector('#mic-retry')!.addEventListener('click', () => { toast.remove(); joinVoiceChannel(); });
    toast.querySelector('#mic-dismiss')!.addEventListener('click', () => toast.remove());
    return;
  }

  inGroom = true;
  const myId   = getChatClientId();
  const myName = getChatUsername();

  const myRef = ref(rtdb, `${GROOM}/members/${myId}`);
  set(myRef, { name: myName, ts: Date.now() }).catch(() => {});
  onDisconnect(myRef).remove().catch(() => {});
  updateVoiceBar();

  // Create offers to anyone already in the channel
  const snap = await get(ref(rtdb, `${GROOM}/members`)).catch(() => null);
  if (snap?.exists()) {
    for (const peerId of Object.keys(snap.val())) {
      if (peerId === myId || groomPeers.has(peerId)) continue;
      const pc = groomAddPeer(peerId);
      pc.onicecandidate = e => {
        if (e.candidate) push(ref(rtdb, `${GROOM}/ice/${myId}/${peerId}`), e.candidate.toJSON()).catch(() => {});
      };
      onChildAdded(ref(rtdb, `${GROOM}/ice/${peerId}/${myId}`), async s => {
        await pc.addIceCandidate(new RTCIceCandidate(s.val())).catch(() => {});
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await set(ref(rtdb, `${GROOM}/offers/${peerId}/${myId}`), { type: offer.type, sdp: offer.sdp }).catch(() => {});
    }
  }

  // Listen for offers TO me (from new joiners)
  onValue(ref(rtdb, `${GROOM}/offers/${myId}`), async offSnap => {
    if (!inGroom || !offSnap.exists()) return;
    for (const [fromId, offer] of Object.entries(offSnap.val() as Record<string, any>)) {
      if (groomPeers.has(fromId)) continue;
      const pc = groomAddPeer(fromId);
      pc.onicecandidate = e => {
        if (e.candidate) push(ref(rtdb, `${GROOM}/ice/${myId}/${fromId}`), e.candidate.toJSON()).catch(() => {});
      };
      onChildAdded(ref(rtdb, `${GROOM}/ice/${fromId}/${myId}`), async s => {
        await pc.addIceCandidate(new RTCIceCandidate(s.val())).catch(() => {});
      });
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await set(ref(rtdb, `${GROOM}/answers/${fromId}/${myId}`), { type: answer.type, sdp: answer.sdp }).catch(() => {});
      updateVoiceBar();
    }
  });

  // Listen for answers to MY offers
  onValue(ref(rtdb, `${GROOM}/answers/${myId}`), async ansSnap => {
    if (!inGroom || !ansSnap.exists()) return;
    for (const [calleeId, answer] of Object.entries(ansSnap.val() as Record<string, any>)) {
      const pc = groomPeers.get(calleeId);
      if (!pc || pc.currentRemoteDescription) continue;
      await pc.setRemoteDescription(new RTCSessionDescription(answer)).catch(() => {});
      updateVoiceBar();
    }
  });
}

function leaveVoiceChannel() {
  const myId = getChatClientId();
  inGroom = false;
  remove(ref(rtdb, `${GROOM}/members/${myId}`)).catch(() => {});
  remove(ref(rtdb, `${GROOM}/offers/${myId}`)).catch(() => {});
  remove(ref(rtdb, `${GROOM}/answers/${myId}`)).catch(() => {});
  remove(ref(rtdb, `${GROOM}/ice/${myId}`)).catch(() => {});
  groomPeers.forEach((pc, peerId) => {
    pc.close();
    remove(ref(rtdb, `${GROOM}/offers/${peerId}/${myId}`)).catch(() => {});
    remove(ref(rtdb, `${GROOM}/answers/${peerId}/${myId}`)).catch(() => {});
    remove(ref(rtdb, `${GROOM}/ice/${peerId}/${myId}`)).catch(() => {});
  });
  groomPeers.clear();
  groomAudios.forEach(a => { a.srcObject = null; });
  groomAudios.clear();
  groomStream?.getTracks().forEach(t => t.stop());
  groomStream = null;
  groomMuted = false;
  document.getElementById('chat-mute-btn')!.textContent = 'Mute';
  updateVoiceBar();
}

function initChat() {
  const myName    = getChatUsername();
  const myId      = getChatClientId();
  const msgsEl    = document.getElementById('chat-messages')!;
  const inputEl   = document.getElementById('chat-input') as HTMLInputElement;
  const sendBtn   = document.getElementById('chat-send-btn')!;
  const notifBtn  = document.getElementById('chat-notif-btn')!;
  const usersEl   = document.getElementById('chat-users-list')!;
  const countEl   = document.getElementById('chat-online-count')!;

  // Notification toggle
  const syncNotifBtn = () => { notifBtn.textContent = chatNotifEnabled ? 'Notif: On' : 'Notif: Off'; };
  syncNotifBtn();
  notifBtn.addEventListener('click', () => {
    chatNotifEnabled = !chatNotifEnabled;
    localStorage.setItem('voxel_chat_notif', String(chatNotifEnabled));
    syncNotifBtn();
  });

  // Chat presence
  const presRef = ref(rtdb, `voxel_chat_online/${myId}`);
  set(presRef, { name: myName, ts: Date.now() }).catch(() => {});
  onDisconnect(presRef).remove().catch(() => {});

  // Track last known online val so admin/user list can re-render on either change
  let lastOnlineVal: Record<string, any> = {};

  // Admin list subscription
  onValue(ref(rtdb, 'voxel_admins'), adminSnap => {
    const adminVal = adminSnap.val() || {};
    adminList = new Set(Object.keys(adminVal));
    document.getElementById('chat-admin-bar')!.style.display = adminList.has(myName) ? 'flex' : 'none';
    renderChatUsers(lastOnlineVal, usersEl);
  });

  // Timeout subscription for myself
  const toNotice = document.getElementById('chat-timeout-notice')!;
  onValue(ref(rtdb, `voxel_timeouts/${myName}`), toSnap => {
    if (!toSnap.exists()) {
      delete chatTimeouts[myName];
      toNotice.style.display = 'none';
      inputEl.disabled = false;
      (document.getElementById('chat-send-btn') as HTMLButtonElement).disabled = false;
      return;
    }
    const toData = toSnap.val() as { until: number; reason: string; by: string };
    if (Date.now() >= toData.until) {
      remove(ref(rtdb, `voxel_timeouts/${myName}`)).catch(() => {});
      return;
    }
    chatTimeouts[myName] = toData;
    const left = Math.ceil((toData.until - Date.now()) / 60000);
    toNotice.textContent = `You are timed out for ${left} more minute${left === 1 ? '' : 's'}${toData.reason ? ' — ' + toData.reason : ''}.`;
    toNotice.style.display = 'block';
    inputEl.disabled = true;
    (document.getElementById('chat-send-btn') as HTMLButtonElement).disabled = true;
  });

  // Online users
  onValue(ref(rtdb, 'voxel_chat_online'), snap => {
    lastOnlineVal = snap.val() || {};
    const total = Object.keys(lastOnlineVal).length;
    countEl.textContent = String(total);
    renderChatUsers(lastOnlineVal, usersEl);
  });

  // Messages — initial load
  const msgsQuery = query(ref(rtdb, 'voxel_chat/messages'), limitToLast(100));
  onValue(msgsQuery, snap => {
    const val = snap.val() || {};
    const msgs: { user: string; text: string; ts: number; type?: string }[] = Object.values(val);
    msgs.sort((a, b) => a.ts - b.ts);
    const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop <= msgsEl.clientHeight + 60;
    msgsEl.innerHTML = '';
    if (msgs.length === 0) {
      msgsEl.innerHTML = '<div style="color:#2a2a2a;font-size:12px;text-align:center;margin:auto;">No messages yet — say hi!</div>';
    } else {
      msgs.forEach(m => appendChatMessage(m, msgsEl, myName));
    }
    if (atBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
  }, { onlyOnce: true });

  // New messages (for notifications + live feed)
  chatStartedAt = Date.now();
  onChildAdded(query(ref(rtdb, 'voxel_chat/messages'), limitToLast(50)), snap => {
    const m = snap.val() as { user: string; text: string; ts: number; type?: string };
    if (!m || m.ts < chatStartedAt - 2000) return;
    if (m.user !== myName) {
      const visible = chatPanelEl.style.display !== 'none';
      if (!visible && chatNotifEnabled) {
        chatUnread++;
        updateChatBadge();
        if (Notification.permission === 'granted') {
          const title = m.type === 'announcement' ? 'Announcement' : m.user;
          new Notification(title, { body: m.text });
        }
      }
    }
    const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop <= msgsEl.clientHeight + 80;
    appendChatMessage(m, msgsEl, myName);
    if (atBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
  });

  // Send message
  const send = () => {
    const text = inputEl.value.trim();
    if (!text) return;
    const to = chatTimeouts[myName];
    if (to && Date.now() < to.until) return;
    inputEl.value = '';
    push(ref(rtdb, 'voxel_chat/messages'), { user: getChatUsername(), text, ts: Date.now() }).catch(() => {});
    setTimeout(() => { msgsEl.scrollTop = msgsEl.scrollHeight; }, 80);
  };
  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  // Voice channel buttons
  document.getElementById('chat-voice-join-btn')!.addEventListener('click', () => joinVoiceChannel());
  document.getElementById('chat-mute-btn')!.addEventListener('click', () => {
    groomMuted = !groomMuted;
    groomStream?.getAudioTracks().forEach(t => { t.enabled = !groomMuted; });
    const btn = document.getElementById('chat-mute-btn')!;
    btn.textContent = groomMuted ? 'Unmute' : 'Mute';
    btn.style.borderColor = groomMuted ? '#f85149' : '#2a2a2a';
  });
  document.getElementById('chat-hangup-btn')!.addEventListener('click', () => leaveVoiceChannel());

  // Announce modal
  const announceModal = document.getElementById('chat-announce-modal')!;
  document.getElementById('chat-announce-btn')!.addEventListener('click', () => {
    (document.getElementById('chat-announce-text') as HTMLTextAreaElement).value = '';
    announceModal.style.display = 'flex';
  });
  document.getElementById('chat-announce-cancel')!.addEventListener('click', () => {
    announceModal.style.display = 'none';
  });
  document.getElementById('chat-announce-send')!.addEventListener('click', () => {
    const text = (document.getElementById('chat-announce-text') as HTMLTextAreaElement).value.trim();
    if (!text) return;
    push(ref(rtdb, 'voxel_chat/messages'), { user: myName, text, ts: Date.now(), type: 'announcement' }).catch(() => {});
    announceModal.style.display = 'none';
    setTimeout(() => { msgsEl.scrollTop = msgsEl.scrollHeight; }, 80);
  });

  // Timeout modal
  const timeoutModal = document.getElementById('chat-timeout-modal')!;
  document.querySelectorAll<HTMLButtonElement>('.timeout-dur-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      timeoutDurMins = Number(btn.dataset.mins);
      document.querySelectorAll<HTMLButtonElement>('.timeout-dur-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.getElementById('timeout-cancel')!.addEventListener('click', () => {
    timeoutModal.style.display = 'none';
  });
  document.getElementById('timeout-confirm')!.addEventListener('click', () => {
    if (!timeoutTargetUser) return;
    const reason = (document.getElementById('timeout-reason') as HTMLInputElement).value.trim();
    const until = Date.now() + timeoutDurMins * 60 * 1000;
    set(ref(rtdb, `voxel_timeouts/${timeoutTargetUser}`), { until, reason, by: myName, ts: Date.now() }).catch(() => {});
    timeoutModal.style.display = 'none';
  });

  // Notification permission
  if (Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

navChat.addEventListener('click', () => {
  chatUnread = 0;
  updateChatBadge();
  showPanel(chatPanelEl, navChat);
  if (!chatPanelEl.dataset.loaded) {
    chatPanelEl.dataset.loaded = '1';
    initChat();
  }
});

navAi.addEventListener('click', () => {
  showPanel(aiPanelEl, navAi);
  if (!aiPanelEl.dataset.loaded) { aiPanelEl.dataset.loaded = '1'; initGuide(); }
});

// ── Minecraft Guide ────────────────────────────────────────────────────────────

const WIKI = (n: string) => `https://minecraft.wiki/w/Special:FilePath/Invicon_${n}.png`;
const MWIKI = (n: string) => `https://minecraft.wiki/w/Special:FilePath/${n}`;

// Language translations
const LANGS: Record<string, Record<string, string>> = {
  en: { crafting:'Crafting', mobs:'Mobs', tips:'Tips', chat:'AI Chat', search:'Search…', cat_all:'All', cat_combat:'Combat', cat_mine:'Mining', cat_farm:'Farming', cat_build:'Building', cat_surv:'Survival', cat_red:'Redstone', hp:'HP', atk:'Attack', armor:'Armor', xp:'XP', drops:'Drops', spawn:'Spawns', type_pass:'Passive', type_neut:'Neutral', type_host:'Hostile', type_boss:'Boss', recipe_for:'Recipe for', ingredients:'Ingredients', result:'Result' },
  es: { crafting:'Crafteo', mobs:'Mobs', tips:'Consejos', chat:'Chat IA', search:'Buscar…', cat_all:'Todo', cat_combat:'Combate', cat_mine:'Minería', cat_farm:'Agricultura', cat_build:'Construcción', cat_surv:'Supervivencia', cat_red:'Redstone', hp:'Vida', atk:'Ataque', armor:'Armadura', xp:'XP', drops:'Botín', spawn:'Aparece', type_pass:'Pasivo', type_neut:'Neutral', type_host:'Hostil', type_boss:'Jefe', recipe_for:'Receta de', ingredients:'Ingredientes', result:'Resultado' },
  fr: { crafting:'Fabrication', mobs:'Créatures', tips:'Conseils', chat:'Chat IA', search:'Rechercher…', cat_all:'Tout', cat_combat:'Combat', cat_mine:'Minage', cat_farm:'Agriculture', cat_build:'Construction', cat_surv:'Survie', cat_red:'Redstone', hp:'Vie', atk:'Attaque', armor:'Armure', xp:'XP', drops:'Butin', spawn:'Apparaît', type_pass:'Passif', type_neut:'Neutre', type_host:'Hostile', type_boss:'Boss', recipe_for:'Recette de', ingredients:'Ingrédients', result:'Résultat' },
  pt: { crafting:'Artesanato', mobs:'Mobs', tips:'Dicas', chat:'Chat IA', search:'Pesquisar…', cat_all:'Tudo', cat_combat:'Combate', cat_mine:'Mineração', cat_farm:'Fazenda', cat_build:'Construção', cat_surv:'Sobrevivência', cat_red:'Redstone', hp:'Vida', atk:'Ataque', armor:'Armadura', xp:'XP', drops:'Itens', spawn:'Aparece', type_pass:'Passivo', type_neut:'Neutro', type_host:'Hostil', type_boss:'Chefe', recipe_for:'Receita de', ingredients:'Ingredientes', result:'Resultado' },
  de: { crafting:'Craften', mobs:'Kreaturen', tips:'Tipps', chat:'KI-Chat', search:'Suchen…', cat_all:'Alle', cat_combat:'Kampf', cat_mine:'Bergbau', cat_farm:'Landwirtschaft', cat_build:'Bauen', cat_surv:'Überleben', cat_red:'Redstone', hp:'Leben', atk:'Angriff', armor:'Rüstung', xp:'XP', drops:'Beute', spawn:'Erscheint', type_pass:'Passiv', type_neut:'Neutral', type_host:'Feindlich', type_boss:'Boss', recipe_for:'Rezept für', ingredients:'Zutaten', result:'Ergebnis' },
  zh: { crafting:'合成', mobs:'生物', tips:'技巧', chat:'AI对话', search:'搜索…', cat_all:'全部', cat_combat:'战斗', cat_mine:'采矿', cat_farm:'农业', cat_build:'建筑', cat_surv:'生存', cat_red:'红石', hp:'生命值', atk:'攻击', armor:'护甲', xp:'经验', drops:'掉落', spawn:'刷新', type_pass:'被动', type_neut:'中立', type_host:'敌对', type_boss:'首领', recipe_for:'合成方法', ingredients:'材料', result:'结果' },
  ja: { crafting:'クラフト', mobs:'モブ', tips:'ヒント', chat:'AIチャット', search:'検索…', cat_all:'全て', cat_combat:'戦闘', cat_mine:'採掘', cat_farm:'農業', cat_build:'建築', cat_surv:'サバイバル', cat_red:'レッドストーン', hp:'体力', atk:'攻撃', armor:'防御', xp:'経験値', drops:'ドロップ', spawn:'出現', type_pass:'中立', type_neut:'ニュートラル', type_host:'敵対', type_boss:'ボス', recipe_for:'レシピ', ingredients:'材料', result:'結果' },
  ru: { crafting:'Крафт', mobs:'Мобы', tips:'Советы', chat:'ИИ Чат', search:'Поиск…', cat_all:'Все', cat_combat:'Бой', cat_mine:'Добыча', cat_farm:'Фермерство', cat_build:'Строительство', cat_surv:'Выживание', cat_red:'Красный камень', hp:'Здоровье', atk:'Атака', armor:'Броня', xp:'Опыт', drops:'Дроп', spawn:'Спавн', type_pass:'Мирный', type_neut:'Нейтральный', type_host:'Враждебный', type_boss:'Босс', recipe_for:'Рецепт', ingredients:'Ингредиенты', result:'Результат' },
};

let guideLang = localStorage.getItem('guide_lang') || 'en';
const t = (k: string) => (LANGS[guideLang] || LANGS.en)[k] || k;

// ── Crafting database ────
interface MCRecipe { name: string; img: string; grid: (string|null)[]; count?: number; cat: string; tags?: string; }
const RECIPES: MCRecipe[] = [
  // Tools
  {name:'Wooden Pickaxe',img:'Wooden_Pickaxe',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Stone Pickaxe',img:'Stone_Pickaxe',grid:[WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Iron Pickaxe',img:'Iron_Pickaxe',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Diamond Pickaxe',img:'Diamond_Pickaxe',grid:[WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Netherite Pickaxe',img:'Netherite_Pickaxe',grid:[null,null,null,null,null,null,WIKI('Diamond_Pickaxe'),WIKI('Netherite_Ingot'),null],cat:'tool',tags:'upgrade smithing'},
  {name:'Wooden Axe',img:'Wooden_Axe',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Iron Axe',img:'Iron_Axe',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Diamond Axe',img:'Diamond_Axe',grid:[WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Diamond'),WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Wooden Shovel',img:'Wooden_Shovel',grid:[null,WIKI('Oak_Planks'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Iron Shovel',img:'Iron_Shovel',grid:[null,WIKI('Iron_Ingot'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Wooden Hoe',img:'Wooden_Hoe',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Iron Hoe',img:'Iron_Hoe',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Flint and Steel',img:'Flint_and_Steel',grid:[WIKI('Iron_Ingot'),null,null,null,WIKI('Flint'),null,null,null,null],cat:'tool'},
  {name:'Shears',img:'Shears',grid:[null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null,null,null,null,null],cat:'tool'},
  {name:'Fishing Rod',img:'Fishing_Rod',grid:[null,null,WIKI('Stick'),null,WIKI('Stick'),WIKI('String'),WIKI('Stick'),null,WIKI('String')],cat:'tool'},
  {name:'Compass',img:'Compass',grid:[null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Redstone_Dust'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null],cat:'tool'},
  {name:'Clock',img:'Clock',grid:[null,WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot'),WIKI('Redstone_Dust'),WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot'),null],cat:'tool'},
  // Weapons
  {name:'Wooden Sword',img:'Wooden_Sword',grid:[null,WIKI('Oak_Planks'),null,null,WIKI('Oak_Planks'),null,null,WIKI('Stick'),null],cat:'weapon'},
  {name:'Stone Sword',img:'Stone_Sword',grid:[null,WIKI('Cobblestone'),null,null,WIKI('Cobblestone'),null,null,WIKI('Stick'),null],cat:'weapon'},
  {name:'Iron Sword',img:'Iron_Sword',grid:[null,WIKI('Iron_Ingot'),null,null,WIKI('Iron_Ingot'),null,null,WIKI('Stick'),null],cat:'weapon'},
  {name:'Diamond Sword',img:'Diamond_Sword',grid:[null,WIKI('Diamond'),null,null,WIKI('Diamond'),null,null,WIKI('Stick'),null],cat:'weapon'},
  {name:'Netherite Sword',img:'Netherite_Sword',grid:[null,null,null,null,null,null,WIKI('Diamond_Sword'),WIKI('Netherite_Ingot'),null],cat:'weapon',tags:'upgrade smithing'},
  {name:'Bow',img:'Bow',grid:[null,WIKI('Stick'),WIKI('String'),WIKI('Stick'),null,WIKI('String'),null,WIKI('Stick'),WIKI('String')],cat:'weapon'},
  {name:'Arrow',img:'Arrow',grid:[null,WIKI('Flint'),null,null,WIKI('Stick'),null,null,WIKI('Feather'),null],count:4,cat:'weapon'},
  {name:'Crossbow',img:'Crossbow',grid:[WIKI('Stick'),WIKI('Iron_Ingot'),WIKI('Stick'),null,WIKI('String'),null,WIKI('Stick'),WIKI('Tripwire_Hook'),WIKI('Stick')],cat:'weapon'},
  {name:'Shield',img:'Shield',grid:[WIKI('Oak_Planks'),WIKI('Iron_Ingot'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),null],cat:'weapon'},
  {name:'Trident',img:'Trident',grid:[null,null,null,null,null,null,null,null,null],cat:'weapon',tags:'drowned drop cannot craft'},
  // Armor
  {name:'Iron Helmet',img:'Iron_Helmet',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null,null,null],cat:'armor'},
  {name:'Iron Chestplate',img:'Iron_Chestplate',grid:[WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot')],cat:'armor'},
  {name:'Iron Leggings',img:'Iron_Leggings',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot')],cat:'armor'},
  {name:'Iron Boots',img:'Iron_Boots',grid:[null,null,null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot')],cat:'armor'},
  {name:'Diamond Helmet',img:'Diamond_Helmet',grid:[WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Diamond'),null,null,null],cat:'armor'},
  {name:'Diamond Chestplate',img:'Diamond_Chestplate',grid:[WIKI('Diamond'),null,WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond')],cat:'armor'},
  {name:'Diamond Leggings',img:'Diamond_Leggings',grid:[WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Diamond')],cat:'armor'},
  {name:'Diamond Boots',img:'Diamond_Boots',grid:[null,null,null,WIKI('Diamond'),null,WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Diamond')],cat:'armor'},
  {name:'Leather Helmet',img:'Leather_Cap',grid:[WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),null,WIKI('Leather'),null,null,null],cat:'armor'},
  {name:'Leather Chestplate',img:'Leather_Tunic',grid:[WIKI('Leather'),null,WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather')],cat:'armor'},
  // Building
  {name:'Crafting Table',img:'Crafting_Table',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,null,null,null],cat:'build'},
  {name:'Furnace',img:'Furnace',grid:[WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),null,WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone')],cat:'build'},
  {name:'Blast Furnace',img:'Blast_Furnace',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Furnace'),WIKI('Iron_Ingot'),WIKI('Smooth_Stone'),WIKI('Smooth_Stone'),WIKI('Smooth_Stone')],cat:'build'},
  {name:'Smoker',img:'Smoker',grid:[null,WIKI('Oak_Log'),null,WIKI('Oak_Log'),WIKI('Furnace'),WIKI('Oak_Log'),null,WIKI('Oak_Log'),null],cat:'build'},
  {name:'Chest',img:'Chest',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],cat:'build'},
  {name:'Barrel',img:'Barrel',grid:[WIKI('Oak_Planks'),WIKI('Oak_Slab'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Slab'),WIKI('Oak_Planks')],cat:'build'},
  {name:'Hopper',img:'Hopper',grid:[WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Chest'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null],cat:'build'},
  {name:'Dropper',img:'Dropper',grid:[WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),null,WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Redstone_Dust'),WIKI('Cobblestone')],cat:'build'},
  {name:'Dispenser',img:'Dispenser',grid:[WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Bow'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Redstone_Dust'),WIKI('Cobblestone')],cat:'build'},
  {name:'Enchanting Table',img:'Enchanting_Table',grid:[null,WIKI('Book'),null,WIKI('Diamond'),WIKI('Obsidian'),WIKI('Diamond'),WIKI('Obsidian'),WIKI('Obsidian'),WIKI('Obsidian')],cat:'build'},
  {name:'Anvil',img:'Anvil',grid:[WIKI('Iron_Block'),WIKI('Iron_Block'),WIKI('Iron_Block'),null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot')],cat:'build'},
  {name:'Beacon',img:'Beacon',grid:[WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Nether_Star'),WIKI('Glass'),WIKI('Obsidian'),WIKI('Obsidian'),WIKI('Obsidian')],cat:'build'},
  {name:'Bookshelf',img:'Bookshelf',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Book'),WIKI('Book'),WIKI('Book'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],cat:'build'},
  {name:'TNT',img:'TNT',grid:[WIKI('Gunpowder'),WIKI('Sand'),WIKI('Gunpowder'),WIKI('Sand'),WIKI('Gunpowder'),WIKI('Sand'),WIKI('Gunpowder'),WIKI('Sand'),WIKI('Gunpowder')],cat:'build'},
  {name:'Piston',img:'Piston',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Cobblestone'),WIKI('Iron_Ingot'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Redstone_Dust'),WIKI('Cobblestone')],cat:'build'},
  {name:'Sticky Piston',img:'Sticky_Piston',grid:[null,null,null,null,null,null,WIKI('Slimeball'),WIKI('Piston'),null],cat:'build'},
  {name:'Observer',img:'Observer',grid:[WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Redstone_Dust'),WIKI('Quartz'),WIKI('Redstone_Dust'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone')],cat:'build'},
  // Redstone
  {name:'Redstone Torch',img:'Redstone_Torch',grid:[null,WIKI('Redstone_Dust'),null,null,WIKI('Stick'),null,null,null,null],cat:'redstone'},
  {name:'Lever',img:'Lever',grid:[null,WIKI('Stick'),null,null,WIKI('Cobblestone'),null,null,null,null],cat:'redstone'},
  {name:'Redstone Repeater',img:'Redstone_Repeater',grid:[WIKI('Redstone_Torch'),WIKI('Redstone_Dust'),WIKI('Redstone_Torch'),WIKI('Stone'),WIKI('Stone'),WIKI('Stone'),null,null,null],cat:'redstone'},
  {name:'Redstone Comparator',img:'Redstone_Comparator',grid:[null,WIKI('Redstone_Torch'),null,WIKI('Redstone_Torch'),WIKI('Nether_Quartz'),WIKI('Redstone_Torch'),WIKI('Stone'),WIKI('Stone'),WIKI('Stone')],cat:'redstone'},
  {name:'Redstone Lamp',img:'Redstone_Lamp',grid:[null,WIKI('Redstone_Dust'),null,WIKI('Redstone_Dust'),WIKI('Glowstone'),WIKI('Redstone_Dust'),null,WIKI('Redstone_Dust'),null],cat:'redstone'},
  {name:'Daylight Detector',img:'Daylight_Detector',grid:[WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Nether_Quartz'),WIKI('Nether_Quartz'),WIKI('Nether_Quartz'),WIKI('Oak_Slab'),WIKI('Oak_Slab'),WIKI('Oak_Slab')],cat:'redstone'},
  {name:'Tripwire Hook',img:'Tripwire_Hook',grid:[null,WIKI('Iron_Ingot'),null,null,WIKI('Stick'),null,null,WIKI('Oak_Planks'),null],count:2,cat:'redstone'},
  // Food
  {name:'Bread',img:'Bread',grid:[null,null,null,WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat'),null,null,null],cat:'food'},
  {name:'Cookie',img:'Cookie',grid:[null,null,null,WIKI('Wheat'),WIKI('Cocoa_Beans'),WIKI('Wheat'),null,null,null],count:8,cat:'food'},
  {name:'Cake',img:'Cake',grid:[WIKI('Milk_Bucket'),WIKI('Milk_Bucket'),WIKI('Milk_Bucket'),WIKI('Sugar'),WIKI('Egg'),WIKI('Sugar'),WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat')],cat:'food'},
  {name:'Golden Apple',img:'Golden_Apple',grid:[WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Apple'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot')],cat:'food'},
  {name:'Pumpkin Pie',img:'Pumpkin_Pie',grid:[null,null,null,WIKI('Pumpkin'),WIKI('Sugar'),WIKI('Egg'),null,null,null],cat:'food'},
  {name:'Mushroom Stew',img:'Mushroom_Stew',grid:[null,null,null,WIKI('Red_Mushroom'),WIKI('Brown_Mushroom'),null,null,WIKI('Bowl'),null],cat:'food'},
  // Misc
  {name:'Book',img:'Book',grid:[null,null,null,WIKI('Paper'),WIKI('Paper'),WIKI('Paper'),WIKI('Leather'),null,null],cat:'misc'},
  {name:'Bookshelf',img:'Bookshelf',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Book'),WIKI('Book'),WIKI('Book'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],cat:'misc'},
  {name:'Map',img:'Map',grid:[WIKI('Paper'),WIKI('Paper'),WIKI('Paper'),WIKI('Paper'),WIKI('Compass'),WIKI('Paper'),WIKI('Paper'),WIKI('Paper'),WIKI('Paper')],cat:'misc'},
  {name:'Bucket',img:'Bucket',grid:[null,null,null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null],cat:'misc'},
  {name:'Minecart',img:'Minecart',grid:[null,null,null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot')],cat:'misc'},
  {name:'Rails',img:'Rail',grid:[WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Stick'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot')],count:16,cat:'misc'},
  {name:'Torch',img:'Torch',grid:[null,WIKI('Coal'),null,null,WIKI('Stick'),null,null,null,null],count:4,cat:'misc'},
  {name:'Ladder',img:'Ladder',grid:[WIKI('Stick'),null,WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),null,WIKI('Stick')],count:3,cat:'misc'},
  {name:'Glass Pane',img:'Glass_Pane',grid:[null,null,null,WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Glass')],count:16,cat:'misc'},
  {name:'Iron Block',img:'Iron_Block',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot')],cat:'misc'},
  {name:'Gold Block',img:'Gold_Block',grid:[WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot')],cat:'misc'},
  {name:'Diamond Block',img:'Diamond_Block',grid:[WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond')],cat:'misc'},
];

// ── Mob database ────
interface MCMob { name: string; img: string; hp: number; atk: number; armor: number; xp: number; spawn: string; drops: string[]; tips: string[]; type: string; }
const MOBS: MCMob[] = [
  {name:'Zombie',img:MWIKI('Zombie.png'),hp:20,atk:3,armor:2,xp:5,spawn:'Overworld, dark (light<0)',drops:['Rotten Flesh','Iron Ingot (rare)','Carrot/Potato (rare)'],tips:['Burns in sunlight','Weak to fire and smite enchantment','Can break down doors on Hard'],type:'hostile'},
  {name:'Skeleton',img:MWIKI('Skeleton.png'),hp:20,atk:2,armor:0,xp:5,spawn:'Overworld, dark',drops:['Bone','Arrow','Bow (rare)'],tips:['Use a shield to block arrows','Melee attack while circling','Burns in sunlight','Spiders can spawn as jockeys'],type:'hostile'},
  {name:'Creeper',img:MWIKI('Creeper.png'),hp:20,atk:49,armor:0,xp:5,spawn:'Overworld, dark',drops:['Gunpowder','Music Disc (if killed by skeleton)'],tips:['Flint & Steel ignites without triggering','Kill before it starts hissing (1.5s fuse)','Knockback resets fuse','Cats scare creepers'],type:'hostile'},
  {name:'Spider',img:MWIKI('Spider.png'),hp:16,atk:2,armor:0,xp:5,spawn:'Overworld (neutral in daylight)',drops:['String','Spider Eye'],tips:['Neutral in daylight if not provoked','Cannot walk through 1-block gaps','Climb walls — keep ceiling above you'],type:'neutral'},
  {name:'Enderman',img:MWIKI('Enderman.png'),hp:40,atk:7,armor:0,xp:5,spawn:'All dimensions',drops:['Ender Pearl (0–1)'],tips:['Do not look at face — neutral otherwise','Water damages them','Pumpkin helmet prevents aggro','Teleports to avoid arrows'],type:'neutral'},
  {name:'Witch',img:MWIKI('Witch.png'),hp:26,atk:0,armor:0,xp:5,spawn:'Swamp Hut, anywhere at night',drops:['Potion','Sugar','Spider Eye','Glowstone'],tips:['Throws harmful potions','Drinks milk/health potions to recover','Use bow from distance','Fire resistant'],type:'hostile'},
  {name:'Blaze',img:MWIKI('Blaze.png'),hp:20,atk:6,armor:2,xp:10,spawn:'Nether Fortress',drops:['Blaze Rod (0–2)'],tips:['Snowballs deal 3 damage each','Immune to fire','Shoots 3 fireballs per burst','Blaze rods needed for Eyes of Ender'],type:'hostile'},
  {name:'Warden',img:MWIKI('Warden.png'),hp:500,atk:30,armor:0,xp:5,spawn:'Deep Dark biome, sculk shrieker',drops:['Sculk Catalyst'],tips:['Strongest hostile mob in the game','Blind — uses sound and vibration','Sneak to reduce vibrations','Best strategy: avoid completely'],type:'hostile'},
  {name:'Ender Dragon',img:MWIKI('Ender_Dragon.png'),hp:200,atk:6,armor:0,xp:12000,spawn:'The End',drops:['Dragon Egg','Elytra (end city)','12,000 XP'],tips:['Destroy End Crystals on pillars first','Attacks from perched position deal most damage','Dragon Breath can be bottled','Can only be hit when perched or without crystal healing'],type:'boss'},
  {name:'Wither',img:MWIKI('Wither.png'),hp:300,atk:8,armor:4,xp:50,spawn:'Spawned by player (3 soul sand + 3 wither skeleton skulls)',drops:['Nether Star'],tips:['Immune to fire and lava','Explosive skulls can break blocks','Summon in the Nether or underground to contain blast','Healing is halved on Hard mode'],type:'boss'},
  {name:'Pig',img:MWIKI('Pig.png'),hp:10,atk:0,armor:0,xp:1,spawn:'Overworld, grassy areas',drops:['Porkchop (1–3)'],tips:['Breed with carrots, beetroot, potatoes','Saddle + carrot on a stick to ride','Lightning strike turns pig into Zombified Piglin'],type:'passive'},
  {name:'Cow',img:MWIKI('Cow.png'),hp:10,atk:0,armor:0,xp:1,spawn:'Overworld, grassy areas',drops:['Beef (1–3)','Leather (0–2)'],tips:['Right-click with bucket to get milk','Breed with wheat','Milk removes potion effects'],type:'passive'},
  {name:'Sheep',img:MWIKI('Sheep.png'),hp:8,atk:0,armor:0,xp:1,spawn:'Overworld, grassy areas',drops:['Mutton','Wool'],tips:['Shear for wool without killing','Breed with wheat','Dye sheep before shearing for colored wool'],type:'passive'},
  {name:'Wolf',img:MWIKI('Wolf.png'),hp:8,atk:4,armor:0,xp:1,spawn:'Forest, Taiga',drops:['—'],tips:['Tame with bones (33% chance each)','Tamed wolf: 20 HP, attacks your targets','Neutral to players — hostile if attacked'],type:'neutral'},
  {name:'Iron Golem',img:MWIKI('Iron_Golem.png'),hp:100,atk:21,armor:0,xp:0,spawn:'Villages, spawned by player',drops:['Iron Ingot (3–5)','Poppy'],tips:['Craft: 4 iron blocks + pumpkin (T-shape)','Protects villagers from hostile mobs','Rose toss indicates friendship','Player-created golems are always neutral'],type:'neutral'},
  {name:'Pillager',img:MWIKI('Pillager.png'),hp:24,atk:4,armor:0,xp:5,spawn:'Pillager Outpost, Raids',drops:['Arrow','Crossbow (rare)'],tips:['Killing captain gives Bad Omen effect','Bad Omen triggers raid when entering village','Use shield to block crossbow bolts','Illager Banner from captain'],type:'hostile'},
  {name:'Phantom',img:MWIKI('Phantom.png'),hp:20,atk:6,armor:0,xp:5,spawn:'Overworld, when player hasnt slept 3+ days',drops:['Phantom Membrane (0–1)'],tips:['Sleep to prevent spawning','Cats scare phantoms away','Attacks from above in swooping dive','Membrane used to repair Elytra'],type:'hostile'},
  {name:'Elder Guardian',img:MWIKI('Elder_Guardian.png'),hp:80,atk:8,armor:8,xp:10,spawn:'Ocean Monument',drops:['Wet Sponge','Prismarine Shard','Fish'],tips:['Inflicts Mining Fatigue III — drink milk to clear','Only 3 per monument','Use turtle shell helmet for water breathing','Drops sponge needed to drain monuments'],type:'boss'},
  {name:'Ghast',img:MWIKI('Ghast.png'),hp:10,atk:17,armor:0,xp:5,spawn:'Nether',drops:['Gunpowder','Ghast Tear'],tips:['Deflect fireballs with any melee hit','Only 10 HP — one deflected fireball kills it','Flying mobs — hard to reach in melee','Cry sounds can be heard from far away'],type:'hostile'},
  {name:'Magma Cube',img:MWIKI('Magma_Cube.png'),hp:16,atk:6,armor:6,xp:4,spawn:'Nether',drops:['Magma Cream (0–1)'],tips:['Splits into smaller cubes when killed','Immune to fire and lava','Jumps to move — time your hits','Large ones have high armor'],type:'hostile'},
];

// ── Tips database ────
interface MCTip { text: string; cat: string; }
const TIPS: MCTip[] = [
  // Mining
  {cat:'mine',text:'<strong>Best Y-level for Diamonds:</strong> Y = -58 (1.18+). Strip mine at this level for maximum diamond ore exposure.'},
  {cat:'mine',text:'<strong>Ancient Debris:</strong> Found at Y = 8–22 in the Nether. Use beds to blow it up safely (beds explode in Nether). Immune to normal explosions.'},
  {cat:'mine',text:'<strong>Branch Mining:</strong> Dig a main tunnel, then branch off every 3 blocks to maximize ore coverage while minimizing blocks mined.'},
  {cat:'mine',text:'<strong>Fortune III vs Silk Touch:</strong> Use Fortune III on diamond/emerald/gold ore for up to 4× drops. Use Silk Touch to collect the ore block itself.'},
  {cat:'mine',text:'<strong>Lava Lakes:</strong> Common at Y = -55 in 1.18+. Carry a Fire Resistance potion or water bucket when deep mining.'},
  {cat:'mine',text:'<strong>Emeralds:</strong> Only spawn in Mountain biomes. Trade with villagers for renewable emeralds without mining.'},
  {cat:'mine',text:'<strong>Copper Ore:</strong> Most abundant at Y = 48. Smelt or use Fortune for more ingots.'},
  {cat:'mine',text:'<strong>Deepslate:</strong> Generates below Y = 0. Deepslate ores give the same drops but are harder to break — use Efficiency V pickaxe.'},
  // Combat
  {cat:'combat',text:'<strong>Critical Hits:</strong> Jump and attack at the apex of your jump to deal 150% damage. Look for the star particles.'},
  {cat:'combat',text:'<strong>Shield Blocking:</strong> Right-click to raise shield. Blocks most projectiles and 100% of melee for 5 seconds. Axes disable shields for 5 seconds on hit.'},
  {cat:'combat',text:'<strong>Sweeping Edge:</strong> Enchantment that adds area damage to sweeping attacks (left-click while grounded). Great for crowds.'},
  {cat:'combat',text:'<strong>Potions:</strong> Strength II + Sharpness V sword one-shots most mobs. Speed II lets you chase or escape.'},
  {cat:'combat',text:'<strong>Lava against Endermen:</strong> Water damages Endermen. They teleport away from it, so place water sources to cut off teleport paths.'},
  {cat:'combat',text:'<strong>Looting III:</strong> Increases rare mob drops (wither skulls, ender pearls, blaze rods) significantly. Priority enchantment for grinding.'},
  {cat:'combat',text:'<strong>Respiration + Aqua Affinity:</strong> For underwater combat — full-speed mining and extended breathing.'},
  {cat:'combat',text:'<strong>Wither Strategy:</strong> Spawn the Wither underground or in the End void area. It cannot fly through 1-block gaps. Beacon + Smite V sword makes it easy.'},
  // Farming
  {cat:'farm',text:'<strong>Crop Growth:</strong> Crops grow faster with more light (need ≥9), hydrated farmland (within 4 blocks of water), and random tick speed.'},
  {cat:'farm',text:'<strong>Bone Meal:</strong> Instantly grows crops and certain plants. Composters turn most plant items into bone meal (7 uses).'},
  {cat:'farm',text:'<strong>Automatic Farms:</strong> Chickens lay eggs automatically. Use a hopper minecart under a farmland row for auto-harvesting.'},
  {cat:'farm',text:'<strong>Villager Trading:</strong> Lock favorable trades by curing a Zombie Villager with Weakness + Golden Apple. They become permanent master traders.'},
  {cat:'farm',text:'<strong>Iron Golem Farm:</strong> Needs 10 villagers, beds, and a job site. Generates 30+ iron per hour on Java.'},
  {cat:'farm',text:'<strong>Mob Spawning:</strong> Mobs only spawn on opaque blocks in darkness (light ≤0 in 1.18+). Build spawners at Y = 80+ for more surface area.'},
  {cat:'farm',text:'<strong>Bamboo/Kelp:</strong> Fastest growing plants — good for fuel (bamboo) or XP smelting (kelp → dried kelp). Kelp fully smelts with 1 kelp block.'},
  {cat:'farm',text:'<strong>Sweet Berries:</strong> Grow in Taiga biomes. Foxes carry them — breed foxes then lead babies away for tamed foxes that pick up items.'},
  // Building
  {cat:'build',text:'<strong>Odd vs Even:</strong> Odd-width structures look more natural. 7×7 rooms feel bigger than 6×6 due to a center block.'},
  {cat:'build',text:'<strong>Depth:</strong> Vary wall depth — add pillars, indent windows, use slabs/stairs for detail. Flat walls look plain.'},
  {cat:'build',text:'<strong>Terraforming:</strong> Blend builds with landscape — extend hills, add rivers, clear forest patches for clearings.'},
  {cat:'build',text:'<strong>Lighting:</strong> Use lanterns, sea lanterns, or glowstone under trapdoors/carpet to hide light sources while keeping areas bright.'},
  {cat:'build',text:'<strong>Color Palettes:</strong> Limit to 3-4 block types per build. Contrast primary material with trim (e.g., Oak + Stone + Dark Oak).'},
  {cat:'build',text:'<strong>Roofs:</strong> Add stairs on the roof ridge for detail. Dutch gable and mansard roofs add character to larger structures.'},
  // Survival
  {cat:'surv',text:'<strong>First Night:</strong> Punch a tree, craft a crafting table, make wood pickaxe, mine stone, make stone tools + furnace. Sleep in a bed ASAP.'},
  {cat:'surv',text:'<strong>Food Priority:</strong> Cooked meat restores saturation best. Bread from wheat is easiest early. Avoid raw food.'},
  {cat:'surv',text:'<strong>Nether Portal:</strong> Mine obsidian or use lava + water mold method. Portal can be 4×5 minimum (inside 2×3).'},
  {cat:'surv',text:'<strong>Ender Eye Route:</strong> Blaze Rods (Nether fortress) → Blaze Powder → Eyes of Ender (with Ender Pearls) → find stronghold → End Portal.'},
  {cat:'surv',text:'<strong>Elytra:</strong> Found in End City chests after killing Dragon. Use Rockets for horizontal flight. Enchant with Unbreaking III + Mending.'},
  {cat:'surv',text:'<strong>Beds in The End:</strong> Beds EXPLODE in the End. Use them to destroy End Crystals on towers from a distance.'},
  {cat:'surv',text:'<strong>Feather Falling IV:</strong> Priority boot enchantment. Reduces fall damage by 48%. Combine with Depth Strider for water movement.'},
  // Redstone
  {cat:'red',text:'<strong>Repeater Lock:</strong> Side-powered repeater locks its current output state — great for memory cells and latches.'},
  {cat:'red',text:'<strong>Comparator Output:</strong> Outputs signal based on container fullness (0-15). Full chest = 15, empty = 0. Use for item sorters.'},
  {cat:'red',text:'<strong>BUD Switch:</strong> Block Update Detector — triggers when a nearby block updates. Used in complex contraptions.'},
  {cat:'red',text:'<strong>Observer:</strong> Detects block state changes in front of it. Useful for crop farms, lava/water detectors.'},
  {cat:'red',text:'<strong>Slime Blocks:</strong> Move adjacent blocks when pushed by a piston. Foundation of flying machines and Elytra launchers.'},
  {cat:'red',text:'<strong>Item Sorter:</strong> Use hoppers + named items in comparators to sort any item type into chests automatically.'},
];

// ── Guide rendering ────
function initGuide() {
  const contentEl  = document.getElementById('guide-content')!;
  const searchEl   = document.getElementById('guide-search') as HTMLInputElement;
  const searchBar  = document.getElementById('guide-search-bar')!;
  const langSel    = document.getElementById('guide-lang') as HTMLSelectElement;
  const chatInputEl= document.getElementById('guide-chat-input')!;
  const aiInputEl  = document.getElementById('ai-input') as HTMLInputElement;
  const aiSendBtn  = document.getElementById('ai-send') as HTMLButtonElement;
  let activeTab = 'recipes';
  let tipCat = 'all';

  langSel.value = guideLang;
  langSel.addEventListener('change', () => {
    guideLang = langSel.value;
    localStorage.setItem('guide_lang', guideLang);
    updateTabLabels();
    renderTab();
  });

  function updateTabLabels() {
    document.querySelectorAll('.guide-tab').forEach(btn => {
      const tab = (btn as HTMLElement).dataset.tab || '';
      const label = btn.querySelector('.gt-label');
      if (label) label.textContent = t(tab === 'recipes' ? 'crafting' : tab === 'mobs' ? 'mobs' : tab === 'tips' ? 'tips' : 'chat');
      (btn as HTMLInputElement).placeholder = t('search');
    });
    searchEl.placeholder = t('search');
  }

  // Tab switching
  document.querySelectorAll<HTMLButtonElement>('.guide-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.guide-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab || 'recipes';
      searchEl.value = '';
      searchBar.style.display = activeTab === 'chat' ? 'none' : 'block';
      chatInputEl.style.display = activeTab === 'chat' ? 'flex' : 'none';
      renderTab();
    });
  });

  searchEl.addEventListener('input', () => renderTab());

  function renderTab() {
    const q = searchEl.value.toLowerCase().trim();
    if (activeTab === 'recipes') renderRecipes(q);
    else if (activeTab === 'mobs') renderMobs(q);
    else if (activeTab === 'tips') renderTips(q);
    else renderChat();
  }

  // ── Recipes tab ────
  function itemCell(url: string | null, name?: string): string {
    if (!url) return `<div class="recipe-cell"></div>`;
    const tip = name ? `<span class="rc-tip">${escHtml(name)}</span>` : '';
    return `<div class="recipe-cell">${tip}<img src="${url}" alt="" onerror="this.style.display='none'"></div>`;
  }

  function showRecipeDetail(r: MCRecipe) {
    const names: Record<string, string> = {};
    // Map wiki URLs back to readable names
    r.grid.forEach(url => {
      if (url) {
        const n = url.split('Invicon_')[1]?.replace('.png','').replace(/_/g,' ') || '';
        if (n) names[url] = n;
      }
    });
    const cells = r.grid.map(url => itemCell(url || null, url ? names[url] : undefined)).join('');
    const ingredients = [...new Set(r.grid.filter(Boolean))].map(url => {
      const n = url!.split('Invicon_')[1]?.replace('.png','').replace(/_/g,' ') || url;
      return `<span style="display:inline-flex;align-items:center;gap:4px;background:#1a1a1a;border:1px solid #222;border-radius:5px;padding:2px 7px;font-size:11px;"><img src="${url}" style="width:16px;height:16px;image-rendering:pixelated;" onerror="this.style.display='none'"> ${escHtml(n!)}</span>`;
    }).join('');
    contentEl.innerHTML = `
      <button id="guide-back" style="background:none;border:none;color:#f5a623;font-size:12px;cursor:pointer;padding:0 0 10px;display:flex;align-items:center;gap:4px;">← ${t('crafting')}</button>
      <div style="font-size:16px;font-weight:700;color:#ffffff;margin-bottom:14px;">${t('recipe_for')} ${escHtml(r.name)}</div>
      <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin-bottom:16px;">
        <div>
          <div style="font-size:10px;color:#484f58;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">${t('ingredients')}</div>
          <div class="recipe-grid">${cells}</div>
        </div>
        <div style="font-size:24px;color:#484f58;">→</div>
        <div>
          <div style="font-size:10px;color:#484f58;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">${t('result')}</div>
          <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
            <div class="recipe-cell"><img src="${WIKI(r.img)}" alt="" onerror="this.style.display='none'"></div>
            ${r.count && r.count > 1 ? `<span style="font-size:11px;color:#f5a623;">×${r.count}</span>` : ''}
            <span style="font-size:11px;color:#aaaaaa;">${escHtml(r.name)}</span>
          </div>
        </div>
      </div>
      <div style="margin-top:8px;">
        <div style="font-size:10px;color:#484f58;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">${t('ingredients')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:5px;">${ingredients}</div>
      </div>`;
    document.getElementById('guide-back')!.addEventListener('click', () => renderRecipes(searchEl.value.toLowerCase().trim()));
  }

  function renderRecipes(q: string) {
    const filtered = RECIPES.filter(r =>
      !q || r.name.toLowerCase().includes(q) || (r.tags || '').includes(q) || r.cat.includes(q)
    );
    if (!filtered.length) { contentEl.innerHTML = `<div style="color:#484f58;text-align:center;padding:30px 0;font-size:13px;">No recipes found for "${escHtml(q)}"</div>`; return; }
    const frag = document.createDocumentFragment();
    filtered.forEach(r => {
      const card = document.createElement('div');
      card.className = 'recipe-card';
      card.style.marginBottom = '6px';
      card.innerHTML = `<img src="${WIKI(r.img)}" alt="${escHtml(r.name)}" onerror="this.style.display='none'"><div style="flex:1"><div style="font-size:13px;font-weight:600;color:#ffffff;">${escHtml(r.name)}</div><div style="font-size:10px;color:#484f58;text-transform:uppercase;letter-spacing:0.5px;">${r.cat}</div></div><span style="font-size:11px;color:#484f58;">▶</span>`;
      card.addEventListener('click', () => showRecipeDetail(r));
      frag.appendChild(card);
    });
    contentEl.innerHTML = '';
    contentEl.appendChild(frag);
  }

  // ── Mobs tab ────
  function statBar(val: number, max: number, color: string): string {
    const pct = Math.min(100, Math.round((val / max) * 100));
    return `<div class="stat-bar"><div class="stat-fill" style="width:${pct}%;background:${color};"></div></div>`;
  }

  function renderMobs(q: string) {
    const filtered = MOBS.filter(m => !q || m.name.toLowerCase().includes(q) || m.spawn.toLowerCase().includes(q) || m.type.includes(q));
    if (!filtered.length) { contentEl.innerHTML = `<div style="color:#484f58;text-align:center;padding:30px 0;font-size:13px;">No mobs found</div>`; return; }
    const typeColors: Record<string, string> = { passive: '#3fb950', neutral: '#f5a623', hostile: '#f85149', boss: '#d2a8ff' };
    const frag = document.createDocumentFragment();
    filtered.forEach(m => {
      const card = document.createElement('div');
      card.className = 'mob-card';
      card.style.marginBottom = '8px';
      const tc = typeColors[m.type] || '#aaaaaa';
      card.innerHTML = `
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <img src="${m.img}" alt="${escHtml(m.name)}" style="width:52px;height:52px;image-rendering:pixelated;object-fit:contain;flex-shrink:0;" onerror="this.style.display='none'">
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <span style="font-size:14px;font-weight:700;color:#ffffff;">${escHtml(m.name)}</span>
              <span style="font-size:10px;padding:2px 8px;border-radius:10px;background:${tc}22;color:${tc};border:1px solid ${tc}44;font-weight:600;">${t('type_'+m.type.slice(0,4))}</span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;">
              <div><div style="font-size:10px;color:#484f58;">${t('hp')} ${m.hp}</div>${statBar(m.hp, 500, '#3fb950')}</div>
              <div><div style="font-size:10px;color:#484f58;">${t('atk')} ${m.atk}</div>${statBar(m.atk, 40, '#f85149')}</div>
              <div><div style="font-size:10px;color:#484f58;">${t('armor')} ${m.armor}</div>${statBar(m.armor, 20, '#58a6ff')}</div>
              <div><div style="font-size:10px;color:#484f58;">${t('xp')} ${m.xp}</div>${statBar(m.xp, 50, '#f6c356')}</div>
            </div>
            <div style="margin-top:8px;font-size:11px;color:#484f58;">${t('spawn')}: <span style="color:#aaaaaa;">${escHtml(m.spawn)}</span></div>
            <div style="margin-top:4px;font-size:11px;color:#484f58;">${t('drops')}: <span style="color:#aaaaaa;">${m.drops.map(d => escHtml(d)).join(', ')}</span></div>
            ${m.tips.length ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:3px;">${m.tips.map(tip => `<div style="font-size:11px;color:#8b949e;padding-left:10px;border-left:2px solid #21262d;">${escHtml(tip)}</div>`).join('')}</div>` : ''}
          </div>
        </div>`;
      frag.appendChild(card);
    });
    contentEl.innerHTML = '';
    contentEl.appendChild(frag);
  }

  // ── Tips tab ────
  function renderTips(q: string) {
    const cats = ['all','mine','combat','farm','build','surv','red'];
    const catBar = document.createElement('div');
    catBar.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px;';
    cats.forEach(c => {
      const btn = document.createElement('button');
      btn.className = 'cat-btn' + (tipCat === c ? ' active' : '');
      btn.textContent = c === 'all' ? t('cat_all') : t('cat_'+c);
      btn.addEventListener('click', () => { tipCat = c; renderTips(searchEl.value.toLowerCase().trim()); });
      catBar.appendChild(btn);
    });
    const filtered = TIPS.filter(tip =>
      (tipCat === 'all' || tip.cat === tipCat) &&
      (!q || tip.text.toLowerCase().includes(q))
    );
    contentEl.innerHTML = '';
    contentEl.appendChild(catBar);
    if (!filtered.length) { contentEl.insertAdjacentHTML('beforeend', `<div style="color:#484f58;text-align:center;padding:30px 0;font-size:13px;">No tips found</div>`); return; }
    const frag = document.createDocumentFragment();
    filtered.forEach(tip => {
      const card = document.createElement('div');
      card.className = 'tip-card';
      card.style.marginBottom = '7px';
      card.innerHTML = tip.text;
      frag.appendChild(card);
    });
    contentEl.appendChild(frag);
  }

  // ── AI Chat tab ────
  const chatHistory: { role: string; content: string }[] = [];
  let chatBusy = false;

  function addBubble(text: string, isUser: boolean) {
    const div = document.createElement('div');
    div.className = isUser ? 'ai-msg-user' : 'ai-msg-ai';
    if (isUser) { div.textContent = text; }
    else {
      div.innerHTML = text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^[-•] (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>[\s\S]*?<\/li>)+/g, m => `<ul>${m}</ul>`)
        .replace(/\n/g, '<br>');
    }
    contentEl.appendChild(div);
    contentEl.scrollTop = contentEl.scrollHeight;
  }

  async function sendChat(q: string) {
    if (chatBusy || !q.trim()) return;
    chatBusy = true; aiSendBtn.disabled = true;
    addBubble(q, true);
    chatHistory.push({ role: 'user', content: q });
    const typing = document.createElement('div');
    typing.className = 'ai-typing'; typing.textContent = '…';
    contentEl.appendChild(typing);
    contentEl.scrollTop = contentEl.scrollHeight;
    const res = await (window as any).ai?.chat(chatHistory) || { ok: false, error: 'AI not configured' };
    typing.remove();
    if (res.ok) {
      addBubble(res.text, false);
      chatHistory.push({ role: 'assistant', content: res.text });
      if (chatHistory.length > 20) chatHistory.splice(0, 2);
    } else {
      const err = document.createElement('div');
      err.style.cssText = 'color:#f85149;font-size:12px;padding:4px 0;';
      err.textContent = `Error: ${res.error}`;
      contentEl.appendChild(err);
    }
    chatBusy = false; aiSendBtn.disabled = false;
    aiInputEl.focus();
  }

  function renderChat() {
    if (contentEl.children.length === 0) {
      addBubble('Ask me anything about Minecraft — crafting, commands, biomes, mobs, strategies, or Voxel Client features!', false);
    }
  }

  aiSendBtn.addEventListener('click', () => { const q = aiInputEl.value.trim(); if (q) { aiInputEl.value = ''; sendChat(q); } });
  aiInputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const q = aiInputEl.value.trim(); if (q) { aiInputEl.value = ''; sendChat(q); } } });

  updateTabLabels();
  renderRecipes('');
}

