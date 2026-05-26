// Launcher logic — no Three.js, just UI wiring for Minecraft launch

import { ref, set, onValue, serverTimestamp, onDisconnect, update, get, increment } from 'firebase/database';
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

// ── Cached MC auth (no login needed) ──────────────────────────────────────────
if (mc) {
  mc.onAlreadyAuthed((name: string) => {
    authed = true;
    mcAuthBtn.textContent = `Logged in as ${name}`;
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
  const jSel = javaVersionSel?.value ?? 'auto';
  // Java 8 or Auto can run any MC version; 17/21/25 require 1.17+
  const noFilter = jSel === '8' || jSel === 'auto';
  const filtered = allVersions.filter(v =>
    noFilter
      ? (v.type === 'release' || (showSnapshots && v.type === 'snapshot'))
      : ((v.type === 'release' && isJava21Compatible(v.id)) ||
         (showSnapshots && v.type === 'snapshot' && isJava21Compatible(v.id)))
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
javaVersionSel.addEventListener('change', populateVersions);

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
    authed = true;
    mcAuthBtn.textContent = `Logged in as ${res.username}`;
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

function getEffectiveJavaVersion(): number {
  const sel = javaVersionSel?.value ?? 'auto';
  if (sel !== 'auto') return parseInt(sel, 10);
  // Auto: pick based on MC version
  const id = mcVersion.value;
  const m = id.match(/^(\d+)\.(\d+)/);
  if (!m) return 21;
  const maj = parseInt(m[1]);
  if (maj !== 1) return 21;       // year-based versions (26.x.x …)
  const min = parseInt(m[2]);
  if (min < 17) return 8;
  if (min < 21) return 17;
  return 21;
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
const allPanels = [contentEl, bedrockPanelEl, modsPanelEl, pvpPanelEl, bedrockModsPanelEl, resourcePacksPanelEl, skinsPanelEl, screenshotsPanelEl, accountsPanelEl, filesPanelEl, serverPanelEl, cosmeticsPanelEl, friendsPanelEl, customizePanelEl, settingsPanelEl];
const allNavs   = [navPlay, navBedrock, navMods, navPvp, navBedrockMods, navResourcePacks, navSkins, navScreenshots, navAccounts, navFiles, navServer, navCosmetics, navFriends, navCustomize, navSettings];

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

// ── Reauth button ──────────────────────────────────────────────────────────────
document.getElementById('mc-reauth-btn')?.addEventListener('click', async () => {
  if (!mc) return;
  authed = false;
  mcPlayBtn.disabled = true;
  mcAuthBtn.textContent = 'Login with Microsoft to Play';
  mcAuthBtn.classList.remove('authed');
  mcIgnBadge.style.display = 'none';
  setStatus('Opening Microsoft login…', 'yellow');
  const res = await mc.reauth();
  if (res?.ok) {
    authed = true;
    mcAuthBtn.textContent = `Logged in as ${res.username}`;
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

// ── Modrinth mod search ────────────────────────────────────────────────────────
const enabledMods = new Set<string>(Object.keys(loadInstalledMods()));
const modsList    = document.getElementById('mods-list')!;
const modsSearch  = document.getElementById('mods-search') as HTMLInputElement;
const modsLoading = document.getElementById('mods-loading')!;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let modsTabType: 'mod' | 'modpack' = 'mod';

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
        const installed = loadInstalledMods();
        installed[mod.project_id] = { filename: file.filename, name: mod.title, mcVersion: ver } as any;
        saveInstalledMods(installed);
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
  const card = document.createElement('div');
  card.className = 'mod-card';
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
    <div class="mod-right">
      <a href="https://modrinth.com/modpack/${mod.project_id}" target="_blank"
        style="padding:7px 14px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#e6edf3;font-size:12px;text-decoration:none;white-space:nowrap;">View on Modrinth →</a>
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
      <div class="mod-version" style="color:${on ? (wrongVer ? '#f6c356' : '#f5a623') : 'transparent'}">${on ? (wrongVer ? '↻' : '✓') : ''}</div>
      <label class="toggle">
        <input type="checkbox" ${on ? 'checked' : ''} />
        <span class="toggle-slider"></span>
      </label>
    </div>`;

  const input    = card.querySelector('input') as HTMLInputElement;
  const statusEl = card.querySelector('.mod-version') as HTMLElement;
  const errEl    = card.querySelector('.pvp-err') as HTMLElement;

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
  for (const [slug] of stale) {
    const mod = PVP_MOD_BY_SLUG.get(slug);
    if (!mod) continue;
    try {
      await installOneMod(mod, ver);
      done++;
      btn.textContent = `Updating ${done}/${stale.length}…`;
    } catch {}
  }
  btn.textContent = `Updated ${done}/${stale.length}`;
  btn.removeAttribute('disabled');
  renderPvpMods((document.getElementById('pvp-search') as HTMLInputElement)?.value ?? '');
}

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

  // ── Mod Profiles ──────────────────────────────────────────────────────────
  interface ModProfile { id: string; name: string; slugs: string[] }
  const PROFILES_KEY = 'voxel_mod_profiles';
  function loadProfiles(): ModProfile[] {
    try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]'); } catch { return []; }
  }
  function saveProfiles(p: ModProfile[]) { localStorage.setItem(PROFILES_KEY, JSON.stringify(p)); }

  const profileSelect  = document.getElementById('pvp-profile-select')  as HTMLSelectElement;
  const profileNameIn  = document.getElementById('pvp-profile-name')    as HTMLInputElement;
  const profileSaveBtn = document.getElementById('pvp-profile-save-btn') as HTMLButtonElement;
  const profileLoadBtn = document.getElementById('pvp-profile-load-btn') as HTMLButtonElement;
  const profileDelBtn  = document.getElementById('pvp-profile-del-btn')  as HTMLButtonElement;

  function refreshProfileSelect() {
    const profiles = loadProfiles();
    const cur = profileSelect.value;
    profileSelect.innerHTML = '<option value="">— No Profile —</option>';
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.id; opt.textContent = p.name;
      profileSelect.appendChild(opt);
    }
    if (profiles.find(p => p.id === cur)) profileSelect.value = cur;
  }
  refreshProfileSelect();

  profileSaveBtn.addEventListener('click', () => {
    const name = profileNameIn.value.trim();
    if (!name) { profileNameIn.focus(); return; }
    const slugs = Array.from(enabledMods);
    const profiles = loadProfiles();
    const existing = profiles.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.slugs = slugs;
      saveProfiles(profiles);
    } else {
      profiles.push({ id: `${Date.now()}`, name, slugs });
      saveProfiles(profiles);
    }
    refreshProfileSelect();
    profileNameIn.value = '';
    profileSaveBtn.textContent = '✓ Saved';
    setTimeout(() => { profileSaveBtn.textContent = 'Save Profile'; }, 1800);
  });

  profileLoadBtn.addEventListener('click', async () => {
    const id = profileSelect.value;
    if (!id) return;
    const profile = loadProfiles().find(p => p.id === id);
    if (!profile) return;
    profileLoadBtn.textContent = 'Loading…';
    profileLoadBtn.disabled = true;
    // Disable all currently enabled mods not in profile
    const installed = loadInstalledMods();
    for (const slug of Array.from(enabledMods)) {
      if (!profile.slugs.includes(slug)) {
        if (installed[slug]) await mc?.removeMod({ filename: installed[slug].filename });
        const upd = loadInstalledMods(); delete upd[slug]; saveInstalledMods(upd);
        enabledMods.delete(slug);
      }
    }
    renderPvpMods(searchEl.value);
    profileLoadBtn.textContent = 'Load';
    profileLoadBtn.disabled = false;
  });

  profileDelBtn.addEventListener('click', () => {
    const id = profileSelect.value;
    if (!id) return;
    const profiles = loadProfiles().filter(p => p.id !== id);
    saveProfiles(profiles);
    refreshProfileSelect();
  });
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

// ── Skins panel ───────────────────────────────────────────────────────────────
function initSkins() {
  const previewImg   = document.getElementById('skin-preview') as HTMLImageElement;
  const skinNameEl   = document.getElementById('skin-name')!;
  const fileInput    = document.getElementById('skin-file-input') as HTMLInputElement;
  const uploadBtn    = document.getElementById('skin-upload-btn') as HTMLButtonElement;
  const fileNameEl   = document.getElementById('skin-file-name')!;
  const applyBtn     = document.getElementById('skin-apply-btn') as HTMLButtonElement;
  const statusEl     = document.getElementById('skin-status')!;
  let selectedBase64 = '';

  const cosmetics = (window as any).cosmetics;
  cosmetics.getUuid().then((uuid: string | null) => {
    if (uuid) {
      previewImg.src = `https://crafatar.com/renders/body/${uuid}?size=200&overlay`;
      skinNameEl.textContent = uuid;
    } else {
      previewImg.src = 'https://crafatar.com/renders/body/MHF_Steve?size=200&overlay';
      skinNameEl.textContent = 'Offline — sign in to change skin';
    }
  });

  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    fileNameEl.textContent = file.name;
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target?.result as string;
      selectedBase64 = dataUrl.split(',')[1];
      previewImg.src = dataUrl;
      applyBtn.style.display = 'block';
    };
    reader.readAsDataURL(file);
  });

  applyBtn.addEventListener('click', async () => {
    const variant = (document.querySelector('input[name="skin-variant"]:checked') as HTMLInputElement)?.value as 'classic' | 'slim' || 'classic';
    applyBtn.disabled = true;
    statusEl.textContent = 'Uploading...'; statusEl.style.color = '#f6c356';
    const res = await mc.uploadSkin({ base64: selectedBase64, variant });
    applyBtn.disabled = false;
    if (res.ok) { statusEl.textContent = '✓ Skin applied!'; statusEl.style.color = '#f5a623'; }
    else         { statusEl.textContent = `✗ ${res.error}`; statusEl.style.color = '#e05500'; }
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
      <div class="friend-avatar">🧑</div>
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
      <div class="friend-avatar" style="font-size:16px;">🧑</div>
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



async function onServerReady(name: string, version: string) {
  const manualIp = srvIpInput.value.trim();
  const ip = manualIp || await getPublicIP();
  if (!manualIp) srvIpInput.value = ip;
  srvAddress.textContent = `localhost:25565   (public: ${ip}:25565)`;
  await publishServer(name, version, ip);
}

function srvAddLog(text: string) {
  const lines = text.split('\n').filter(l => l.trim());
  lines.forEach(l => {
    srvLogLines.push(l);
    if (srvLogLines.length > 300) srvLogLines.shift();
    const div = document.createElement('div');
    div.style.lineHeight = '1.6';
    div.style.color = l.includes('ERROR') || l.includes('WARN') ? '#f6c356'
                    : l.includes('[Host]') ? '#f6c356' : '#6e7681';
    div.textContent = l;
    srvLog.appendChild(div);
    // Detect when MC server finishes starting — show connection address
    if (srvRunning && srvAddress.textContent?.includes('Starting') &&
        (l.includes(' Done (') || l.includes('!  Done'))) {
      onServerReady(pendingSrvName, pendingSrvVersion);
    }
  });
  // Remove placeholder
  const placeholder = srvLog.querySelector('div[style*="30363d"]');
  if (placeholder) placeholder.remove();
  document.getElementById('srv-log-placeholder')?.remove();
  srvLog.scrollTop = srvLog.scrollHeight;
}

srvLogCopy?.addEventListener('click', () => copyToClipboard(srvLogLines.join('\n'), srvLogCopy));

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

function parseMcVer(id: string): number[] { return id.split('.').map(n => parseInt(n,10)||0); }
function mcVerLte(id: string): boolean {
  const v = parseMcVer(id); const m = [1,21,11];
  for (let i=0;i<3;i++) { if((v[i]??0)<m[i]) return true; if((v[i]??0)>m[i]) return false; } return true;
}

function populateSrvVersions() {
  const sel = document.getElementById('srv-version') as HTMLSelectElement;
  const showSnaps = (document.getElementById('srv-snapshots-toggle') as HTMLInputElement)?.checked;
  const prev = sel.value;
  sel.innerHTML = '';
  const filtered = srvAllVersions.filter(v =>
    (v.type === 'release' || (showSnaps && v.type === 'snapshot')) && mcVerLte(v.id)
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
      { id: '1.21.4', type: 'release' }, { id: '1.21.3', type: 'release' },
      { id: '1.21.1', type: 'release' }, { id: '1.21',   type: 'release' },
      { id: '1.20.6', type: 'release' }, { id: '1.20.4', type: 'release' },
      { id: '1.20.1', type: 'release' }, { id: '1.19.4', type: 'release' },
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

  srvRunning = true;
  srvStopBtn.style.display = 'inline-flex';
  srvStopBtn.disabled = false;
  srvStartBtn.style.display = 'none';
  srvStartBtn.textContent = 'Starting…';
  srvLog.innerHTML = '';
  srvLogLines = [];

  pendingSrvName    = name;
  pendingSrvVersion = version;

  const res = await server.start({ version, maxMem, minMem, name, port, maxPlayers, motd });
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
    srvStopBtn.style.display = 'none';
    srvStopBtn.disabled = false;
    srvStopBtn.textContent = '⏹ Stop Server';
    srvStartBtn.style.display = 'inline-flex';
    srvStartBtn.style.background = '#f5a623';
    srvStartBtn.style.color = '#0d1117';
    srvStartBtn.textContent = '▶ Start Server';
    srvStartBtn.disabled = false;
    if (!userStopped && code !== 0 && code != null) {
      srvAddLog(`[Host] Server crashed (exit code ${code}) — scroll up for errors`);
      if (code === 1) srvAddLog('[Host] Tip: may be OOM — increase RAM allocation above');
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
    banner.style.display = 'flex';
    updateText.textContent = `Update v${ver} downloading…`;
    progressWrap2.style.display = 'block';
    if (checkBtn) { checkBtn.textContent = 'Downloading…'; checkBtn.disabled = true; }
    if (updateSub) updateSub.textContent = `Downloading v${ver}…`;
  });
  updater.onProgress((pct: number) => {
    progressBar2.style.width = `${pct}%`;
    updateText.textContent = `Downloading update… ${pct}%`;
    if (updateSub) updateSub.textContent = `Downloading update… ${pct}%`;
  });
  updater.onDownloaded(() => {
    progressWrap2.style.display = 'none';
    updateText.textContent = 'Update ready — restart to apply';
    installBtn.style.display = 'inline-block';
    if (checkBtn) { checkBtn.textContent = 'Check for Updates'; checkBtn.disabled = false; }
    if (updateSub) updateSub.textContent = 'Update downloaded — click Restart & Update to apply';
    enableRestartButtons();
  });

  updater.onError?.((msg: string) => {
    progressWrap2.style.display = 'none';
    updateText.textContent = `Update error: ${msg}`;
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


