// Launcher logic — no Three.js, just UI wiring for Minecraft launch

import { ref, set, push, remove, onValue, onChildAdded, query, limitToLast, serverTimestamp, onDisconnect, update, get, increment } from 'firebase/database';
import { rtdb } from './firebase';
import { auth, signOut } from './firebase';
import { initVersionPicker, loadBedrockArt } from './version-picker';
import { createCapeViewer, loadCape, drawCapeFront, frameAt, type CapeViewer } from './cape-viewer';


const mc     = (window as any).mc;
let myUid = '';

// ── DOM ────────────────────────────────────────────────────────────────────────
const userName      = document.getElementById('user-name')!;
const mcIgnBadge    = document.getElementById('mc-username-badge')!;
const mcIgnSpan     = document.getElementById('mc-ign')!;
// Prefer the Minecraft IGN (only set after Microsoft auth) but fall back to
// the app account/guest name — mcIgnSpan is blank for guest/offline users,
// so using it alone showed a raw UID or nothing in friends' lists.
function myDisplayName(): string {
  return mcIgnSpan.textContent || userName.textContent || 'Player';
}
const mcAuthBtn     = document.getElementById('mc-auth-btn') as HTMLButtonElement;
const mcPlayBtn     = document.getElementById('mc-play-btn') as HTMLButtonElement;
const mcPlayLabel   = document.getElementById('mc-play-label')!;
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
const modLoaderSelect   = document.getElementById('modloader-select') as HTMLSelectElement;
const fabricStatus      = document.getElementById('fabric-status')!;
const mcForceQuitBtn    = document.getElementById('mc-force-quit-btn') as HTMLButtonElement;
const offlineToggle   = document.getElementById('offline-toggle') as HTMLInputElement;
const offlineNameRow  = document.getElementById('offline-name-row')!;
const offlineUsername = document.getElementById('offline-username') as HTMLInputElement;
const offlineBanner   = document.getElementById('offline-banner')!;
const vsyncToggle       = document.getElementById('vsync-toggle')      as HTMLInputElement | null;
const shaderpackSelect  = document.getElementById('shaderpack-select') as HTMLSelectElement | null;

// ── UI helpers ────────────────────────────────────────────────────────────────
// Icons come from the SVG sprite at the top of game.html; tones are the status
// colours defined in its CSS ([data-tone]), so nothing here hard-codes a colour.
type Tone = 'accent' | 'ok' | 'pending' | 'error' | 'muted' | '';
const icon = (name: string) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
function setTone(el: HTMLElement, tone: Tone) {
  if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}
// Status mark beside a card: working (…), done (check), failed (x), downloading.
function setMark(el: HTMLElement, state: 'busy' | 'done' | 'failed' | 'download' | '', label = '') {
  const glyph = { busy: '…', done: icon('check'), failed: icon('x'), download: icon('download'), '': '' }[state];
  el.innerHTML = glyph + (label ? ` ${label}` : '');
  setTone(el, ({ busy: 'pending', done: 'accent', failed: 'error', download: 'pending', '': '' } as const)[state]);
}
// A one-line message in place of an empty or failed list.
const listMsg = (text: string, tone: Tone = 'muted') => `<p class="list-msg"${tone ? ` data-tone="${tone}"` : ''}>${text}</p>`;

// A notice in the bottom-right corner (#toasts). `text` is HTML — escape anything
// that came from another player. Returns the element so callers can update it.
interface ToastAction { label: string; primary?: boolean; onClick: () => void }
function showToast(o: { id?: string; title: string; text?: string; icon?: string; tone?: Tone; actions?: ToastAction[]; timeout?: number }): HTMLElement {
  if (o.id) document.getElementById(o.id)?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  if (o.id) el.id = o.id;
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <span class="toast-icon"${o.tone ? ` data-tone="${o.tone}"` : ''}>${icon(o.icon ?? 'info')}</span>
    <div class="toast-body">
      <div class="toast-title"></div>
      ${o.text ? `<div class="toast-text">${o.text}</div>` : ''}
      ${o.actions?.length ? '<div class="toast-actions"></div>' : ''}
    </div>
    <button class="toast-close btn btn-ghost btn-icon btn-sm" aria-label="Dismiss">${icon('x')}</button>`;
  el.querySelector('.toast-title')!.textContent = o.title;
  const actions = el.querySelector('.toast-actions');
  for (const a of o.actions ?? []) {
    const b = document.createElement('button');
    b.className = 'btn btn-sm' + (a.primary ? ' btn-primary' : '');
    b.textContent = a.label;
    b.addEventListener('click', () => { el.remove(); a.onClick(); });
    actions!.appendChild(b);
  }
  el.querySelector('.toast-close')!.addEventListener('click', () => el.remove());
  document.getElementById('toasts')!.appendChild(el);
  if (o.timeout) setTimeout(() => el.remove(), o.timeout);
  return el;
}

declare const __APP_VERSION__: string;
const appVersionEl = document.getElementById('app-version');
if (appVersionEl) appVersionEl.textContent = `v${__APP_VERSION__}`;

let authed = false;
let running = false;
let logVisible = false;
const recentLines: string[] = [];

// ── User data from Electron ────────────────────────────────────────────────────
function applyAccountName(name: string) {
  userName.textContent = name || 'Player';
  // Until a Microsoft account gives us a skin to show, the avatar is the initial.
  const avatarEl = document.getElementById('user-avatar')!;
  if (!avatarEl.querySelector('img')) avatarEl.textContent = (name || 'P').charAt(0).toUpperCase();
  // Prefill the offline/Minecraft username with the account name the first
  // time — after that the user's own edits (saved below) take priority.
  if (!localStorage.getItem('voxel_offline_username') && name) {
    offlineUsername.value = name;
  }
}

if ((window as any).electron) {
  (window as any).electron.onUserData((d: any) => {
    applyAccountName(d.name || 'Player');
    if (d.uid && d.uid !== myUid) {
      myUid = d.uid;
      initTokens(myUid);
      initPresence(myUid);
      initFriends(myUid);
      // So guests/offline-account users (no Microsoft auth) can still be
      // found by name when someone sends them a friend request.
      registerUserIndex(myUid, myDisplayName());
    }
  });
} else {
  const stored = sessionStorage.getItem('userData');
  if (stored) {
    const p = JSON.parse(stored);
    applyAccountName(p.name || 'Player');
  }
}

// ── Log out ─────────────────────────────────────────────────────────────────
document.getElementById('logout-btn')?.addEventListener('click', async () => {
  try { await signOut(auth); } catch {}
  if ((window as any).electron?.logout) {
    (window as any).electron.logout();
  } else {
    sessionStorage.removeItem('userData');
    window.location.href = './login.html';
  }
});

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
  showSkinAvatar(name);
}

// The sidebar profile picture: the player's skin face (with hat layer).
// Crafatar only takes UUIDs (usernames get a 422), so this uses mc-heads,
// which takes either — the account's UUID once known, so a recent name change
// can't briefly show someone else's skin. Falls back to the name's initial.
function showSkinAvatar(name: string) {
  const avatarEl = document.getElementById('user-avatar')!;
  const initial = () => { avatarEl.textContent = (name || 'P').charAt(0).toUpperCase(); };
  const img = new Image();
  img.alt = '';
  img.onerror = initial;
  img.src = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/72`;
  avatarEl.replaceChildren(img);
  (window as any).cosmetics?.getUuid?.()
    .then((uuid: string | null) => { if (uuid) img.src = `https://mc-heads.net/avatar/${uuid}/72`; })
    .catch(() => {});
}

function clearMcAuthed() {
  authed = false;
  mcPlayBtn.disabled = true;
  mcAuthBtn.textContent = 'Sign in with Microsoft';
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

type MCVersion = { id: string; type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'; releaseTime?: string };
let allVersions: MCVersion[] = [];
let latestRelease = '';
const versionPicker = initVersionPicker(mcVersion);

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
        ? `${v.id} (snapshot)`
        : v.id;
    mcVersion.appendChild(opt);
  }
  if (filtered.find(v => v.id === prev)) mcVersion.value = prev;
  versionPicker.render(filtered, latestRelease);
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
mcVersion.addEventListener('change', () => {
  localStorage.setItem('voxel_mc_version', mcVersion.value);
  // Re-filter mod browse results for the newly selected version
  // (the picker lives on the Play page, so a loaded tab is re-searched when next opened)
  if (modsPanelEl.dataset.loaded) modsPanelEl.dataset.stale = '1';
  if (cfPanelEl.dataset.loaded)   cfPanelEl.dataset.stale = '1';
  if (modsPanelEl.style.display === 'flex') searchModrinth(modsSearch.value.trim());
  if (cfPanelEl.style.display   === 'flex') searchCurseForge((document.getElementById('cf-search') as HTMLInputElement)?.value.trim() || '');
  // Re-check mod/modpack compatibility immediately against the newly
  // selected version, not just whenever Play happens to get clicked next.
  if (modAutoUpdateToggle.checked && !running) runModUpdateCheck(mcVersion.value, true);
  updateModsBadge();
});

// ── Memory slider ──────────────────────────────────────────────────────────────
// --fill paints the amber part of the track up to the thumb.
function paintMemoryFill() {
  const pct = (+mcMemory.value - +mcMemory.min) / (+mcMemory.max - +mcMemory.min) * 100;
  mcMemory.style.setProperty('--fill', `${pct}%`);
}
mcMemory.addEventListener('input', () => {
  mcMemoryVal.textContent = mcMemory.value;
  localStorage.setItem('voxel_mc_memory', mcMemory.value);
  paintMemoryFill();
});
paintMemoryFill();

// ── Log panel open/close ──────────────────────────────────────────────────────
function openLog() {
  logVisible = true;
  logPanel.style.display = 'flex';
  logToggle.textContent = 'Hide log';
}
function closeLog() {
  logVisible = false;
  logPanel.style.display = 'none';
  logToggle.textContent = 'Show log';
}

logToggle.addEventListener('click', () => { logVisible ? closeLog() : openLog(); });
logClose.addEventListener('click', closeLog);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && logVisible) closeLog(); });

// Use Electron's native clipboard — navigator.clipboard needs a permission grant that Electron doesn't set
function copyToClipboard(text: string, btn: HTMLButtonElement) {
  (window as any).electron?.copyText(text);
  const orig = btn.textContent;
  btn.innerHTML = `${icon('check')}Copied`;
  setTone(btn, 'accent');
  setTimeout(() => { btn.textContent = orig; setTone(btn, ''); }, 1500);
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
offlineUsername.addEventListener('input', () => {
  localStorage.setItem('voxel_offline_username', offlineUsername.value.trim());
});

function applyOfflineState(on: boolean) {
  offlineNameRow.style.display   = on ? 'block'  : 'none';
  mcAuthBtn.style.display        = on ? 'none'   : '';
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
const modsToggleAllBtn = document.getElementById('mods-toggle-all-btn') as HTMLButtonElement;

function modsForCurrentVersion(): [string, InstalledMod][] {
  return Object.entries(loadInstalledMods()).filter(([, m]) => m.mcVersion === mcVersion.value);
}

// Modpack-installed files aren't individually tracked in loadInstalledMods(), so they
// need their own disabled-state store keyed by mcVersion for the master toggle to reach them.
const DISABLED_PACK_FILES_KEY = 'voxel_disabled_pack_files';
function loadDisabledPackFiles(): Record<string, string[]> {
  try { return JSON.parse(localStorage.getItem(DISABLED_PACK_FILES_KEY) || '{}'); } catch { return {}; }
}
function saveDisabledPackFiles(data: Record<string, string[]>) {
  localStorage.setItem(DISABLED_PACK_FILES_KEY, JSON.stringify(data));
}
function packFilesForCurrentVersion(): string[] {
  const files: string[] = [];
  for (const pack of Object.values(loadInstalledModpacks())) {
    if (pack.mcVersion === mcVersion.value) files.push(...pack.filenames);
  }
  return files;
}

function updateModsBadge() {
  const modCount = Object.keys(loadInstalledMods()).length;
  const packModCount = Object.values(loadInstalledModpacks()).reduce((sum, p) => sum + p.filenames.length, 0);
  const count = modCount + packModCount;
  if (count === 0) { modsBadge.style.display = 'none'; modsToggleAllBtn.style.display = 'none'; return; }
  modsBadge.style.display    = 'inline-block';
  const loaderOn = modLoaderSelect.value !== 'none';
  modsBadge.textContent     = loaderOn
    ? `${count} mod${count !== 1 ? 's' : ''} ready`
    : `${count} mod${count !== 1 ? 's' : ''} installed — pick a loader to use them`;
  setTone(modsBadge, loaderOn ? 'accent' : 'pending');

  const currentVerMods = modsForCurrentVersion();
  const currentPackFiles = packFilesForCurrentVersion();
  if (!currentVerMods.length && !currentPackFiles.length) { modsToggleAllBtn.style.display = 'none'; return; }
  modsToggleAllBtn.style.display = 'inline-block';
  const disabledPackFiles = new Set(loadDisabledPackFiles()[mcVersion.value] ?? []);
  const anyEnabled = currentVerMods.some(([, m]) => !m.disabled) || currentPackFiles.some(f => !disabledPackFiles.has(f));
  modsToggleAllBtn.textContent = anyEnabled ? 'Disable All' : 'Enable All';
}

modsToggleAllBtn.addEventListener('click', async () => {
  modsToggleAllBtn.disabled = true;
  const ver = mcVersion.value;
  const mods = modsForCurrentVersion();
  const packFiles = packFilesForCurrentVersion();
  const disabledPackFilesByVer = loadDisabledPackFiles();
  const disabledPackFiles = new Set(disabledPackFilesByVer[ver] ?? []);
  const shouldEnable = !(mods.some(([, m]) => !m.disabled) || packFiles.some(f => !disabledPackFiles.has(f))); // currently all disabled -> enable all

  const installed = loadInstalledMods();
  for (const [slug, m] of mods) {
    try { await mc?.toggleMod({ filename: m.filename, enable: shouldEnable, mcVersion: m.mcVersion || ver }); } catch {}
    installed[slug] = { ...m, disabled: !shouldEnable };
    if (shouldEnable) enabledMods.add(slug); else enabledMods.delete(slug);
  }
  saveInstalledMods(installed);

  for (const filename of packFiles) {
    try { await mc?.toggleMod({ filename, enable: shouldEnable, mcVersion: ver }); } catch {}
  }
  disabledPackFilesByVer[ver] = shouldEnable ? [] : [...packFiles];
  saveDisabledPackFiles(disabledPackFilesByVer);

  updateModsBadge();
  modsToggleAllBtn.disabled = false;
});

modLoaderSelect.addEventListener('change', () => {
  localStorage.setItem('voxel_modloader', modLoaderSelect.value);
  updateModsBadge();
});

vsyncToggle?.addEventListener('change', () => {
  localStorage.setItem('voxel_vsync', String(vsyncToggle!.checked));
});
shaderpackSelect?.addEventListener('change', () => {
  localStorage.setItem('voxel_shaderpack', shaderpackSelect!.value);
});

// ── Restore saved settings on launch ─────────────────────────────────────────
{
  const savedLoader = localStorage.getItem('voxel_modloader');
  // Legacy fallback from before the loader dropdown existed
  if (savedLoader) modLoaderSelect.value = savedLoader;
  else if (localStorage.getItem('voxel_fabric_on') === 'true') modLoaderSelect.value = 'fabric';
  // Default to offline/guest mode so Play works without a Microsoft account —
  // only honor an explicit "false" the user previously chose.
  const offlineModeRaw = localStorage.getItem('voxel_offline_mode');
  const savedOffline = offlineModeRaw === null ? true : offlineModeRaw === 'true';
  const savedUsername = localStorage.getItem('voxel_offline_username');
  if (savedUsername) offlineUsername.value = savedUsername;
  offlineToggle.checked = savedOffline;
  applyOfflineState(savedOffline);
  const savedMemory = localStorage.getItem('voxel_mc_memory');
  if (savedMemory) { mcMemory.value = savedMemory; mcMemoryVal.textContent = savedMemory; paintMemoryFill(); }
  const savedJava = localStorage.getItem('voxel_java_version');
  if (savedJava && javaVersionSel) javaVersionSel.value = savedJava;
  const savedVsync = localStorage.getItem('voxel_vsync');
  if (vsyncToggle) vsyncToggle.checked = savedVsync !== null ? savedVsync === 'true' : true;
  refreshShaderpackDropdown();
  updateModsBadge();
}

// Games started from Server Control Center use these same Play settings.
function saveLaunchSettings() {
  (window as any).mscc?.saveLaunchSettings?.({
    maxMem: parseInt(mcMemory.value, 10) || 4,
    loader: modLoaderSelect.value,
    vsync: vsyncToggle?.checked !== false,
    shaderpack: shaderpackSelect?.value ?? '',
  });
}
for (const el of [mcMemory, modLoaderSelect, vsyncToggle, shaderpackSelect]) el?.addEventListener('change', saveLaunchSettings);
mcMemory.addEventListener('input', saveLaunchSettings);
setTimeout(saveLaunchSettings, 1500);

// ── Sync localStorage with actual mods on disk ────────────────────────────────
// Removes entries from the installed-mods map when the JAR is no longer on disk
// (e.g. after Repair Game or manual deletion) so the UI reflects reality.
async function syncModsWithDisk() {
  if (!mc?.listMods) return;
  try {
    const installed = loadInstalledMods();
    // Mods live in per-MC-version folders now — check each mod against its
    // own recorded version's disk listing, not one shared listing.
    const versionGroups = new Map<string, string[]>();
    for (const mod of Object.values(installed)) {
      const v = mod.mcVersion || '';
      if (!versionGroups.has(v)) versionGroups.set(v, []);
    }
    const diskByVersion = new Map<string, string[]>();
    for (const v of versionGroups.keys()) {
      diskByVersion.set(v, await mc.listMods({ mcVersion: v }));
    }
    let changed = false;
    for (const slug of Object.keys(installed)) {
      const mod = installed[slug];
      const diskFiles = diskByVersion.get(mod.mcVersion || '') ?? [];
      if (!diskFiles.includes(mod.filename)) {
        delete installed[slug];
        enabledMods.delete(slug);
        changed = true;
      }
    }
    if (changed) { saveInstalledMods(installed); updateModsBadge(); }
  } catch {}
}

// Same idea as syncModsWithDisk but for modpacks — a modpack record with no
// files left on disk (Repair Game, manual deletion, or a failed update that
// removed the old files) must not keep claiming to be installed forever.
async function syncModpacksWithDisk() {
  if (!mc?.listMods) return;
  try {
    const packs = loadInstalledModpacks();
    let changed = false;
    for (const [projectId, pack] of Object.entries(packs)) {
      const diskFiles = await mc.listMods({ mcVersion: pack.mcVersion });
      const anyRemain = pack.filenames.some(f => diskFiles.includes(f));
      if (!anyRemain) { delete packs[projectId]; changed = true; }
    }
    if (changed) { saveInstalledModpacks(packs); updateModsBadge(); }
  } catch {}
}
// Delay slightly so the window finishes loading before the IPC round-trip
setTimeout(syncModsWithDisk, 1500);
setTimeout(syncModpacksWithDisk, 1500);

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
  // set by the quick-join bar: connect to this server as soon as the game starts
  const server = pendingServer ?? undefined;
  pendingServer = null;

  running = true;
  mcPlayBtn.disabled = true;
  mcPlayBtn.classList.add('running');
  mcPlayLabel.textContent = 'Launching…';
  mcForceQuitBtn.style.display = 'inline-flex';
  setStatus(server ? `Launching Minecraft ${version} and joining ${server}…` : `Launching Minecraft ${version}…`, 'yellow');
  setProgress(0);
  logToggle.style.display = 'inline';
  openLog();

  // Auto-update mods before launch, if enabled — but skip if the continuous
  // background check (every 5 min, or on version change) already ran
  // recently, so clicking Play doesn't pay for a redundant network round
  // of checks right when the user wants to play now.
  if (modAutoUpdateToggle.checked && Date.now() - lastModCheckTs > 60_000) {
    setStatus('Checking mods for updates…', 'yellow');
    await runModUpdateCheck(version, true);
  }

  // Install the selected mod loader
  let forgePath: string | undefined;
  const loader = modLoaderSelect.value;
  if (loader === 'fabric') {
    fabricStatus.textContent = 'Installing Fabric…';
    setTone(fabricStatus, 'accent');
    const fab = await mc.installFabric({ mcVersion: version });
    if (fab.ok) {
      version = fab.fabricVersion; // launch with fabric version id
      fabricStatus.textContent = `Fabric ${fab.loaderVersion}`;
      setTone(fabricStatus, 'accent');
    } else {
      fabricStatus.textContent = `Fabric install failed (${fab.error}) — launching vanilla`;
      setTone(fabricStatus, 'pending');
    }
  } else if (loader === 'forge' || loader === 'neoforge') {
    const label = loader === 'forge' ? 'Forge' : 'NeoForge';
    fabricStatus.textContent = `Installing ${label}…`;
    setTone(fabricStatus, 'accent');
    const res = loader === 'forge' ? await mc.installForge({ mcVersion: version }) : await mc.installNeoForge({ mcVersion: version });
    if (res.ok) {
      forgePath = res.installerPath;
      fabricStatus.textContent = `${label} ${res.loaderVersion}`;
      setTone(fabricStatus, 'accent');
    } else {
      fabricStatus.textContent = `${label} install failed (${res.error}) — launching vanilla`;
      setTone(fabricStatus, 'pending');
    }
  }

  addLog(`Launching Minecraft ${version} with ${maxMem}GB RAM, Java ${javaVersion}…`);

  const vsync      = vsyncToggle?.checked !== false;
  const shaderpack = shaderpackSelect?.value ?? '';
  const res = offlineToggle.checked
    ? await mc.launchOffline({ version, maxMem, username: offlineUsername.value.trim() || 'Player', javaVersion, vsync, shaderpack, forgePath, server })
    : await mc.launch({ version, maxMem, javaVersion, vsync, shaderpack, forgePath, server });
  if (!res.ok) {
    setStatus(`Launch failed: ${res.error}`, 'red');
    addLog(`Error: ${res.error}`, 'error');
    resetPlay();
  }
});

const forceQuitLabel = mcForceQuitBtn.querySelector('span')!;
mcForceQuitBtn.addEventListener('click', async () => {
  mcForceQuitBtn.disabled = true;
  forceQuitLabel.textContent = 'Stopping…';
  await mc.kill();
  mcForceQuitBtn.disabled = false;
  forceQuitLabel.textContent = 'Force quit';
});

function resetPlay() {
  running = false;
  mcPlayBtn.disabled = false;
  mcPlayBtn.classList.remove('running');
  mcPlayLabel.textContent = 'Play';
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
      mcPlayLabel.textContent = 'Running';
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
const settingsPanelEl     = document.getElementById('settings-panel')!;
const libraryPanelEl      = document.getElementById('library-panel')!;
const managePanelEl       = document.getElementById('manage-panel')!;
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
const navSettings         = document.getElementById('nav-settings')!;
const navLibrary          = document.getElementById('nav-library')!;
const navManage           = document.getElementById('nav-manage')!;
const navServer         = document.getElementById('nav-server')!;
const navCosmetics      = document.getElementById('nav-cosmetics')!;
const navFriends        = document.getElementById('nav-friends')!;
const cosmeticsPanelEl  = document.getElementById('cosmetics-panel')!;
const friendsPanelEl    = document.getElementById('friends-panel')!;
const chatPanelEl = document.getElementById('chat-panel')!;
const navChat     = document.getElementById('nav-chat')!;
const aiPanelEl   = document.getElementById('ai-panel')!;
const navAi       = document.getElementById('nav-ai')!;
const cfPanelEl   = document.getElementById('curseforge-panel')!;
const navCf       = document.getElementById('nav-curseforge')!;
// The five library tabs share one page (#library-panel) with its own header
// and tab bar; the sidebar has a single "Mods & packs" entry for all of them.
const libraryPanels = [modsPanelEl, cfPanelEl, pvpPanelEl, resourcePacksPanelEl, managePanelEl];
const allPanels = [contentEl, bedrockPanelEl, ...libraryPanels, bedrockModsPanelEl, skinsPanelEl, screenshotsPanelEl, accountsPanelEl, filesPanelEl, cosmeticsPanelEl, friendsPanelEl, settingsPanelEl, chatPanelEl, aiPanelEl];
const allNavs   = [navPlay, navBedrock, navMods, navCf, navPvp, navResourcePacks, navManage, navBedrockMods, navSkins, navScreenshots, navAccounts, navFiles, navCosmetics, navFriends, navSettings, navChat, navAi];

function showPanel(panel: HTMLElement, nav: HTMLElement) {
  allPanels.forEach(p => p.style.display = 'none');
  allNavs.forEach(n => n.classList.remove('active'));
  panel.style.display = 'flex';
  nav.classList.add('active');
  const inLibrary = libraryPanels.includes(panel);
  libraryPanelEl.style.display = inLibrary ? 'flex' : 'none';
  navLibrary.classList.toggle('active', inLibrary);
  if (inLibrary) localStorage.setItem('voxel_library_tab', nav.id);
}
navLibrary       .addEventListener('click', () => {
  const last = document.getElementById(localStorage.getItem('voxel_library_tab') || '');
  (last && allNavs.includes(last) ? last : navMods).click();
});
navPlay          .addEventListener('click', () => showPanel(contentEl,             navPlay));
navBedrock       .addEventListener('click', () => { showPanel(bedrockPanelEl,      navBedrock); initBedrock(); if (!bedrockPanelEl.dataset.loaded) { loadBedrockArt(document.getElementById('bedrock-stage')!, document.getElementById('bedrock-art-caption')!); bedrockPanelEl.dataset.loaded = '1'; } });
navManage        .addEventListener('click', () => showPanel(managePanelEl,         navManage));
navMods          .addEventListener('click', () => {
  showPanel(modsPanelEl, navMods);
  if (!modsPanelEl.dataset.loaded) { loadRecommendedMods(); initAvengersFeaturedCard(); modsPanelEl.dataset.loaded = '1'; }
  else if (modsPanelEl.dataset.stale) searchModrinth(modsSearch.value.trim());
  delete modsPanelEl.dataset.stale;
});
navCf            .addEventListener('click', () => {
  showPanel(cfPanelEl, navCf);
  if (!cfPanelEl.dataset.loaded) { initCurseForge(); cfPanelEl.dataset.loaded = '1'; }
  else if (cfPanelEl.dataset.stale) searchCurseForge((document.getElementById('cf-search') as HTMLInputElement).value.trim());
  delete cfPanelEl.dataset.stale;
});
navPvp           .addEventListener('click', () => { showPanel(pvpPanelEl,          navPvp); if (!pvpPanelEl.dataset.loaded) { initPvpMods(); pvpPanelEl.dataset.loaded = '1'; } });
navBedrockMods   .addEventListener('click', () => { showPanel(bedrockModsPanelEl,  navBedrockMods); if (!bedrockModsPanelEl.dataset.loaded) { searchBedrockMods(''); bedrockModsPanelEl.dataset.loaded = '1'; } });
navResourcePacks .addEventListener('click', () => { showPanel(resourcePacksPanelEl,navResourcePacks); if (!resourcePacksPanelEl.dataset.loaded) { initResourcePacks(); resourcePacksPanelEl.dataset.loaded = '1'; } });
navSkins         .addEventListener('click', () => { showPanel(skinsPanelEl,        navSkins); if (!skinsPanelEl.dataset.loaded) { initSkins(); skinsPanelEl.dataset.loaded = '1'; } });
navScreenshots   .addEventListener('click', () => { showPanel(screenshotsPanelEl,  navScreenshots); initScreenshots(); });
navAccounts      .addEventListener('click', () => { showPanel(accountsPanelEl,     navAccounts); if (!accountsPanelEl.dataset.loaded) { initAccounts(); accountsPanelEl.dataset.loaded = '1'; } });
navFiles         .addEventListener('click', () => { showPanel(filesPanelEl,        navFiles);  if (!filesPanelEl.dataset.loaded)  { initFiles(); filesPanelEl.dataset.loaded = '1'; } });
navServer        .addEventListener('click', () => {
  const url = 'https://voxelhosting.vercel.app/';
  (window as any).electron?.openExternal?.(url) || window.open(url);
});
navCosmetics     .addEventListener('click', () => { showPanel(cosmeticsPanelEl,    navCosmetics); if (!cosmeticsPanelEl.dataset.loaded) { initCosmetics(); cosmeticsPanelEl.dataset.loaded = '1'; } });
navFriends       .addEventListener('click', () => { showPanel(friendsPanelEl,      navFriends);   if (!friendsPanelEl.dataset.loaded) { initFriendsPanel(); friendsPanelEl.dataset.loaded = '1'; } });
navSettings      .addEventListener('click', () => { showPanel(settingsPanelEl,       navSettings); initShaderpackSettings(); if (!settingsPanelEl.dataset.loaded) { initTitleScreenBg(); settingsPanelEl.dataset.loaded = '1'; } });

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

// ── Bedrock Mods tab (full panel, like Java mods) ─────────────────────────────
const bedrockModsList    = document.getElementById('bedrock-mods-list')!;
const bedrockModsLoading = document.getElementById('bedrock-mods-loading')!;
const bedrockModsSearch  = document.getElementById('bedrock-mods-search') as HTMLInputElement;
let bedrockModsTimer: ReturnType<typeof setTimeout> | null = null;

let bedrockInstalledPacks: { packId: string; packType: string; name: string }[] = [];
async function refreshBedrockInstalled() {
  const res = await (window as any).mc?.listBedrockPacks?.();
  bedrockInstalledPacks = res?.ok ? res.packs : [];
}

async function searchBedrockMods(query: string) {
  bedrockModsLoading.style.display = 'flex';
  bedrockModsList.innerHTML = '';
  try {
    await refreshBedrockInstalled();
    const facets = JSON.stringify([['project_type:resourcepack', 'project_type:shader']]);
    const params = new URLSearchParams({
      query, facets, limit: '50',
      index: query ? 'relevance' : 'downloads',
    });
    const res  = await fetch(`https://api.modrinth.com/v2/search?${params}`);
    const data = await res.json() as { hits: ModrinthHit[] };
    bedrockModsLoading.style.display = 'none';
    if (!data.hits.length) {
      bedrockModsList.innerHTML = listMsg('No add-ons match that search.');
      return;
    }
    const frag = document.createDocumentFragment();
    data.hits.forEach(h => {
      const isShader = h.categories.includes('shaders');
      const isOn = bedrockInstalledPacks.some(p => p.name === h.title);
      const card = document.createElement('div');
      card.className = 'mod-card' + (isOn ? ' enabled' : '');
      const iconHtml = h.icon_url
        ? `<img src="${h.icon_url}" class="mod-icon-img" alt="" onerror="this.style.display='none'">`
        : `<div class="mod-icon"></div>`;
      const tagHtml = h.categories.slice(0, 3).map(cat => {
        const cls = ['shaders'].includes(cat) ? 'visual' : ['optimization','performance'].includes(cat) ? 'perf' : 'util';
        return `<span class="mod-tag ${cls}">${cat}</span>`;
      }).join('') + `<span class="mod-tag dl push">${icon('download')}${fmtDownloads(h.downloads)}</span>`;
      card.innerHTML = `${iconHtml}
        <div class="mod-info">
          <div class="mod-name">${h.title}</div>
          <div class="mod-desc">${h.description}</div>
          <div class="mod-tags">${tagHtml}</div>
        </div>
        <div class="mod-right">
          <div class="mod-version"></div>
          <label class="toggle">
            <input type="checkbox" ${isOn ? 'checked' : ''} />
            <span class="toggle-slider"></span>
          </label>
        </div>`;

      const input    = card.querySelector('input') as HTMLInputElement;
      const statusEl = card.querySelector('.mod-version') as HTMLElement;
      if (isOn) { setMark(statusEl, 'done'); }

      input.addEventListener('change', async e => {
        const checked = (e.target as HTMLInputElement).checked;
        input.disabled = true;
        if (checked) {
          setMark(statusEl, 'busy');
          try {
            const vRes = await fetch(`https://api.modrinth.com/v2/project/${h.project_id}/version?limit=5`);
            const versions: any[] = await vRes.json();
            if (!Array.isArray(versions) || !versions.length) throw new Error('No downloadable version found');
            const file = versions[0].files.find((f: any) => f.primary) ?? versions[0].files[0];
            if (!file) throw new Error('No download file found');
            const install = await (window as any).mc.installBedrockPack({ url: file.url, name: h.title });
            if (!install.ok) throw new Error(install.error);
            card.className = 'mod-card enabled';
            setMark(statusEl, 'done');
            await refreshBedrockInstalled();
          } catch (err: any) {
            input.checked = false; card.className = 'mod-card';
            setMark(statusEl, 'failed');
            statusEl.title = err.message.includes('manifest.json')
              ? 'Not a Bedrock-format pack (Modrinth mostly hosts Java Edition content)'
              : err.message;
          }
        } else {
          const pack = bedrockInstalledPacks.find(p => p.name === h.title);
          if (pack) await (window as any).mc.removeBedrockPack({ packId: pack.packId, packType: pack.packType });
          card.className = 'mod-card';
          setMark(statusEl, '');
          await refreshBedrockInstalled();
        }
        input.disabled = false;
      });

      frag.appendChild(card);
    });
    bedrockModsList.appendChild(frag);
  } catch {
    bedrockModsLoading.style.display = 'none';
    bedrockModsList.innerHTML = listMsg('Could not reach Modrinth. Check your connection and try again.', 'error');
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
    btn.innerHTML = `${icon('check')}Done — launch again to re-download`;
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
      if (keyStatus) { keyStatus.textContent = 'Saved'; setTone(keyStatus, 'accent'); }
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
  setTone(statusEl, 'pending');

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
    setTone(statusEl, 'accent');
    localStorage.setItem('bg_installed', '1');
  } else {
    statusEl.textContent = res.error;
    setTone(statusEl, 'error');
  }
}

// Settings › Custom title screen (installs the VoxelClient panorama resource pack)
function initTitleScreenBg() {
  const toggle = document.getElementById('install-bg-toggle') as HTMLInputElement | null;
  const status = document.getElementById('install-bg-status') as HTMLElement | null;
  if (!toggle || !status) return;

  // Restore state
  if (localStorage.getItem('bg_installed') === '1') {
    toggle.checked = true;
    status.textContent = 'Installed — enable "VoxelClient" in Options › Resource Packs';
    setTone(status, 'accent');
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
      setTone(status, 'muted');
    }
  });
}

// ── Installed mods (persisted) ────────────────────────────────────────────────
interface InstalledMod { filename: string; name: string; mcVersion?: string; disabled?: boolean; cfId?: number; fileId?: number; modrinthVersionId?: string; }
function loadInstalledMods(): Record<string, InstalledMod> {
  try { return JSON.parse(localStorage.getItem('voxel_installed_mods') || '{}'); } catch { return {}; }
}
function saveInstalledMods(data: Record<string, InstalledMod>) {
  localStorage.setItem('voxel_installed_mods', JSON.stringify(data));
}

// ── Mod auto-update (CurseForge-sourced mods) ─────────────────────────────────
const modUpdateStatusEl = document.getElementById('mod-update-status') as HTMLElement;
const modUpdateAllBtn   = document.getElementById('mod-update-all-btn') as HTMLButtonElement;
const modAutoUpdateToggle = document.getElementById('mod-autoupdate-toggle') as HTMLInputElement;

function showModUpdateStatus(msg: string, autoHide = true) {
  modUpdateStatusEl.textContent = msg;
  modUpdateStatusEl.style.display = msg ? 'block' : 'none';
  if (msg && autoHide) setTimeout(() => { modUpdateStatusEl.style.display = 'none'; }, 6000);
}

// Checks every installed CurseForge mod against `mcVer`. Mods with no
// compatible file for that version get disabled (with an on-screen notice)
// instead of silently failing at launch; outdated-but-compatible mods are
// re-downloaded in place.
interface ModUpdateResult {
  compatible: boolean;
  checkFailed?: boolean;
  upToDate?: boolean;
  filename?: string;
  url?: string;
  versionKey?: string | number; // fileId (CurseForge) or version id (Modrinth)
}

async function runBatched<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(...await Promise.all(items.slice(i, i + batchSize).map(fn)));
  }
  return out;
}

async function checkModrinthUpdate(projectId: string, mod: InstalledMod, mcVer: string): Promise<ModUpdateResult> {
  try {
    const params = new URLSearchParams({ game_versions: `["${mcVer}"]`, loaders: '["fabric"]', limit: '5' });
    const res = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version?${params}`);
    if (res.status === 429) return { compatible: false, checkFailed: true };
    if (!res.ok) return { compatible: false, checkFailed: true };
    const versions: any[] = await res.json();
    if (!Array.isArray(versions) || !versions.length) return { compatible: false };
    const latest = versions[0];
    const file = latest.files.find((f: any) => f.primary) ?? latest.files[0];
    if (!file) return { compatible: false };
    return {
      compatible: true,
      upToDate: latest.id === mod.modrinthVersionId,
      filename: file.filename, url: file.url, versionKey: latest.id,
    };
  } catch {
    return { compatible: false, checkFailed: true };
  }
}

let lastModCheckTs = 0;
async function runModUpdateCheck(mcVer: string, silent = false): Promise<void> {
  lastModCheckTs = Date.now();
  const cfApi = (window as any).curseforge;
  if (!mc) return;

  const installed = loadInstalledMods();
  const allEntries = Object.entries(installed);
  const cfEntries       = allEntries.filter(([slug, m]) => slug.startsWith('cf_') && m.cfId != null);
  const modrinthEntries = allEntries.filter(([slug, m]) => !slug.startsWith('cf_') && m.cfId == null);

  if (cfEntries.length === 0 && modrinthEntries.length === 0) {
    if (!silent) showModUpdateStatus('No mods installed.');
    return;
  }

  if (!silent) showModUpdateStatus('Checking for mod updates…', false);

  const results = new Map<string, ModUpdateResult>();

  if (cfEntries.length && cfApi?.checkUpdates) {
    const res = await cfApi.checkUpdates(cfEntries.map(([, m]) => ({ modId: m.cfId, fileId: m.fileId ?? 0 })), mcVer);
    if (res?.ok) {
      for (const [slug, mod] of cfEntries) {
        const r = res.results.find((x: any) => x.modId === mod.cfId);
        if (r) results.set(slug, { compatible: r.compatible, checkFailed: r.checkFailed, upToDate: r.upToDate, filename: r.filename, url: r.url, versionKey: r.fileId });
      }
    } else if (!silent) {
      showModUpdateStatus(`Couldn't check CurseForge mods: ${res?.error || 'unknown error'}`, false);
    }
  }

  if (modrinthEntries.length) {
    const modrinthResults = await runBatched(modrinthEntries, 5, async ([slug, mod]) => [slug, await checkModrinthUpdate(slug, mod, mcVer)] as const);
    for (const [slug, r] of modrinthResults) results.set(slug, r);
  }

  let updated = 0, removedCount = 0, upToDate = 0, checkFailed = 0;
  const removedNames: string[] = [];
  for (const [slug, mod] of allEntries) {
    const result = results.get(slug);
    if (!result) continue;

    // A failed/rate-limited check is NOT the same as confirmed incompatibility
    // — leave the mod alone rather than removing it on a network hiccup.
    if (result.checkFailed) { checkFailed++; continue; }

    if (!result.compatible) {
      try { await mc.removeMod({ filename: mod.filename, mcVersion: mod.mcVersion || mcVer }); } catch {}
      delete installed[slug];
      enabledMods.delete(slug);
      removedCount++;
      removedNames.push(mod.name);
      continue;
    }

    // A compatible file was found for a previously-disabled mod — re-enable
    // it (covers both a genuine version change and mods that were wrongly
    // disabled by a past bug in this check).
    if (mod.disabled) {
      try { await mc.toggleMod({ filename: mod.filename, enable: true, mcVersion: mod.mcVersion || mcVer }); } catch {}
      installed[slug] = { ...mod, disabled: false };
      enabledMods.add(slug);
    }

    if (result.upToDate) { upToDate++; continue; }

    try {
      const installRes = await mc.installMod({ url: result.url!, filename: result.filename!, mcVersion: mcVer });
      if (!installRes.ok) throw new Error(installRes.error);
      if (result.filename !== mod.filename) {
        try { await mc.removeMod({ filename: mod.filename, mcVersion: mod.mcVersion || mcVer }); } catch {}
      }
      const isCf = slug.startsWith('cf_');
      installed[slug] = {
        ...mod, filename: result.filename!,
        ...(isCf ? { fileId: result.versionKey as number } : { modrinthVersionId: result.versionKey as string }),
      };
      updated++;
    } catch {
      // Leave the existing file in place if the re-download fails
    }
  }

  saveInstalledMods(installed);
  updateModsBadge();

  // Modpacks: check the installed pack (usually just one — installing a new
  // one already removes the previous) for a newer Modrinth release. The
  // launcher's selected version is the user's explicit choice and is never
  // changed automatically — a modpack update is only applied if its game
  // version actually matches what's currently selected; otherwise it's
  // skipped so the user's chosen version/mods stay intact.
  let modpackUpdated = false;
  const packs = loadInstalledModpacks();
  for (const [projectId, pack] of Object.entries(packs)) {
    try {
      const res = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version?game_versions=["${mcVer}"]&limit=5`);
      if (!res.ok) continue;
      const versions: any[] = await res.json();
      if (!Array.isArray(versions) || !versions.length) continue; // no release for the selected version — leave as-is
      if (versions[0].id === pack.versionId) continue;

      // Remove the previous pack's files first — installModpack only adds
      // files from the new .mrpack index, it doesn't know which old files
      // to clean up, so skipping this leaves stale + new versions of the
      // same mod jars side by side (causes NoSuchMethodError-style crashes).
      for (const filename of pack.filenames) {
        try { await mc.removeMod({ filename, mcVersion: pack.mcVersion }); } catch {}
      }

      const result = await mc.installModpack({ projectId });
      if (!result.ok) continue;
      packs[projectId] = { projectId, title: pack.title, mcVersion: result.mcVersion, filenames: result.filenames, versionId: result.versionId };
      modpackUpdated = true;
    } catch {
      // Leave the modpack as-is if the check/update fails
    }
  }
  if (modpackUpdated) saveInstalledModpacks(packs);

  if (!silent || updated > 0 || removedCount > 0 || modpackUpdated) {
    const parts = [];
    if (updated)        parts.push(`${updated} updated`);
    if (removedCount)   parts.push(`${removedCount} removed (incompatible: ${removedNames.slice(0, 3).join(', ')}${removedNames.length > 3 ? `, +${removedNames.length - 3} more` : ''})`);
    if (upToDate)       parts.push(`${upToDate} up to date`);
    if (checkFailed)    parts.push(`${checkFailed} couldn't be checked`);
    if (modpackUpdated) parts.push('modpack updated');
    showModUpdateStatus(parts.length ? parts.join(' · ') : 'All mods up to date.');
  }
}

modUpdateAllBtn.addEventListener('click', async () => {
  modUpdateAllBtn.disabled = true;
  const label = modUpdateAllBtn.textContent;
  modUpdateAllBtn.textContent = 'Checking…';
  try {
    await runModUpdateCheck(mcVersion.value);
  } finally {
    modUpdateAllBtn.disabled = false;
    modUpdateAllBtn.textContent = label || 'Update All Mods';
  }
});

modAutoUpdateToggle.addEventListener('change', () => {
  localStorage.setItem('voxel_mod_autoupdate', String(modAutoUpdateToggle.checked));
});
// Default to on so mods/modpacks stay current without any manual step —
// only honor an explicit "false" the user previously chose.
{
  const autoUpdateRaw = localStorage.getItem('voxel_mod_autoupdate');
  modAutoUpdateToggle.checked = autoUpdateRaw === null ? true : autoUpdateRaw === 'true';
}

// Keep checking in the background the whole time the app is open — not just
// once when Play happens to get clicked. Skipped while a game is actually
// running so it doesn't compete for network/disk with an active launch.
setInterval(() => {
  if (modAutoUpdateToggle.checked && !running) runModUpdateCheck(mcVersion.value, true);
}, 5 * 60 * 1000);

// ── Installed modpacks (persisted) ───────────────────────────────────────────
interface InstalledModpack { projectId: string; title: string; mcVersion: string; filenames: string[]; versionId?: string; cfId?: number; fileId?: number }
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
  else if (e.phase === 'downloading') setMark(modpackProgressEl, 'download', `${e.pct}%`);
  else if (e.phase === 'mods')        setMark(modpackProgressEl, 'download', `${e.current}/${e.total}`);
});

const modsTypeSwitch = document.getElementById('mods-type-switch') as HTMLInputElement;
const modsLabelMods  = document.getElementById('mods-label-mods')!;
const modsLabelPacks = document.getElementById('mods-label-packs')!;

// Restore saved mods/modpacks tab choice
if (localStorage.getItem('voxel_mods_tab') === 'modpack') {
  modsTypeSwitch.checked = true; modsTabType = 'modpack';
  modsLabelMods.classList.remove('on');
  modsLabelPacks.classList.add('on');
}

function setModsTab(type: 'mod' | 'modpack') {
  modsTabType = type;
  const isMod = type === 'mod';
  modsTypeSwitch.checked = !isMod;
  modsLabelMods.classList.toggle('on', isMod);
  modsLabelPacks.classList.toggle('on', !isMod);
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

// Populates each browse-list card's build-version badge without hammering
// the API — cards queue themselves, and the queue drains in small batches.
const modBuildVerQueue: Array<{ projectId: string; el: HTMLElement }> = [];
let modBuildVerFlushTimer: ReturnType<typeof setTimeout> | null = null;
function queueModBuildVersion(projectId: string, el: HTMLElement) {
  modBuildVerQueue.push({ projectId, el });
  if (modBuildVerFlushTimer) return;
  modBuildVerFlushTimer = setTimeout(flushModBuildVerQueue, 80);
}
async function flushModBuildVerQueue() {
  modBuildVerFlushTimer = null;
  const batch = modBuildVerQueue.splice(0, modBuildVerQueue.length);
  const ver = mcVersion.value || '26.1.2';
  await runBatched(batch, 5, async ({ projectId, el }) => {
    try {
      const params = new URLSearchParams({ game_versions: `["${ver}"]`, loaders: '["fabric"]', limit: '5' });
      const res = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version?${params}`);
      const versions: any[] = await res.json();
      if (Array.isArray(versions) && versions.length && versions[0].version_number) {
        el.textContent = versions[0].version_number;
        setTone(el, 'accent');
      } else {
        el.textContent = '';
      }
    } catch { el.textContent = ''; }
  });
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
  }).join('') + `<span class="mod-tag mod-build-ver push">…</span><span class="mod-tag dl">${icon('download')}${fmtDownloads(mod.downloads)}</span>`;

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
  const buildVerEl = card.querySelector('.mod-build-ver') as HTMLElement;

  input.addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked;
    input.disabled = true;

    if (checked) {
      setMark(statusEl, 'busy');
      try {
        const ver = mcVersion.value || '26.1.2';
        const params = new URLSearchParams({ game_versions: `["${ver}"]`, loaders: '["fabric"]', limit: '20' });
        const vRes = await fetch(`https://api.modrinth.com/v2/project/${mod.project_id}/version?${params}`);
        const searchData: any[] = await vRes.json();
        if (!Array.isArray(searchData) || !searchData.length) throw new Error(`No Fabric build for MC ${ver}`);
        const byVerNum2  = searchData.find((v: any) => typeof v.version_number === 'string' && v.version_number.includes(ver));
        const byExact2   = searchData.find((v: any) => Array.isArray(v.game_versions) && v.game_versions.length === 1 && v.game_versions[0] === ver);
        const chosenVer  = byVerNum2 ?? byExact2 ?? searchData[0];
        const file = chosenVer.files.find((f: any) => f.primary) ?? chosenVer.files[0];
        if (!file) throw new Error('No download file found');
        setMark(statusEl, 'download');
        const res = await mc.installMod({ url: file.url, filename: file.filename, mcVersion: ver });
        if (!res.ok) throw new Error(res.error);
        // Install required dependencies declared in the Modrinth version metadata
        const reqDeps = (chosenVer.dependencies || []).filter((d: any) => d.dependency_type === 'required' && d.project_id);
        const installedNow = loadInstalledMods();
        for (const dep of reqDeps) {
          if (installedNow[dep.project_id]) continue;
          try {
            setMark(statusEl, 'download', 'dependency');
            const dp = new URLSearchParams({ game_versions: `["${ver}"]`, loaders: '["fabric"]', limit: '5' });
            const dvRes = await fetch(`https://api.modrinth.com/v2/project/${dep.project_id}/version?${dp}`);
            const dvData: any[] = await dvRes.json();
            if (!Array.isArray(dvData) || !dvData.length) continue;
            const df = dvData[0].files.find((f: any) => f.primary) ?? dvData[0].files[0];
            if (!df) continue;
            const depRes = await mc.installMod({ url: df.url, filename: df.filename, mcVersion: ver });
            if (depRes.ok) installedNow[dep.project_id] = { filename: df.filename, name: dep.project_id, mcVersion: ver };
          } catch {}
        }
        installedNow[mod.project_id] = { filename: file.filename, name: mod.title, mcVersion: ver, modrinthVersionId: chosenVer.id };
        saveInstalledMods(installedNow);
        enabledMods.add(mod.project_id);
        card.className = 'mod-card enabled';
        setMark(statusEl, 'done');
      } catch (err: any) {
        input.checked = false;
        card.className = 'mod-card';
        setMark(statusEl, 'failed');
        statusEl.title = err.message;
      }
    } else {
      const installed = loadInstalledMods();
      const info = installed[mod.project_id];
      if (info && mc) await mc.removeMod({ filename: info.filename, mcVersion: info.mcVersion || mcVersion.value });
      delete installed[mod.project_id];
      saveInstalledMods(installed);
      enabledMods.delete(mod.project_id);
      card.className = 'mod-card';
      statusEl.textContent = '';
    }
    input.disabled = false;
  });

  if (on) { setMark(statusEl, 'done'); }
  queueModBuildVersion(mod.project_id, buildVerEl);
  return card;
}

// The "Avengers Mod" featured slot used to zip up source code from a path
// hardcoded to one machine, which meant it never worked for anyone else.
// It's a real published Modrinth project, so it gets the same toggle-install
// card as everything else instead of a one-off download button.
const AVENGERS_MOD_PROJECT_ID = 'jaRugO3N';
async function initAvengersFeaturedCard() {
  const slot = document.getElementById('avengers-featured-slot');
  if (!slot) return;
  try {
    const res = await fetch(`https://api.modrinth.com/v2/project/${AVENGERS_MOD_PROJECT_ID}`);
    if (!res.ok) throw new Error(`Modrinth API ${res.status}`);
    const proj = await res.json();
    const hit: ModrinthHit = {
      project_id: proj.id,
      title: proj.title,
      description: proj.description,
      icon_url: proj.icon_url,
      downloads: proj.downloads,
      categories: proj.categories ?? [],
    };
    slot.innerHTML = '';
    slot.appendChild(buildModCard(hit));
  } catch {
    slot.innerHTML = '';
  }
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
  ).join('') + `<span class="mod-tag dl push">${icon('download')}${fmtDownloads(mod.downloads)}</span>`;
  card.innerHTML = `
    ${iconHtml}
    <div class="mod-info">
      <div class="mod-name">${mod.title}</div>
      <div class="mod-desc">${mod.description}</div>
      <div class="mod-tags">${tagHtml}</div>
    </div>
    <div class="mod-right">
      <div class="mod-version"${isInstalled ? ' data-tone="accent"' : ''}>${isInstalled ? icon('check') : ''}</div>
      ${isInstalled ? `<button class="modpack-update-btn btn btn-sm">${icon('refresh')}Update</button>` : ''}
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
    updateBtn.innerHTML = `${icon('refresh')}Updating…`;
    setMark(statusEl, 'busy');
    modpackProgressEl = statusEl;
    try {
      // Clean up the previous version's files first — installModpack only
      // adds files from the new .mrpack index, so skipping this leaves old
      // + new mod jars side by side if the update targets a new MC version.
      const existingPack = loadInstalledModpacks()[mod.project_id];
      if (existingPack) {
        for (const filename of existingPack.filenames) {
          try { await mc.removeMod({ filename, mcVersion: existingPack.mcVersion }); } catch {}
        }
      }
      const result = await mc.installModpack({ projectId: mod.project_id });
      if (!result.ok) throw new Error(result.error);
      const updated = loadInstalledModpacks();
      updated[mod.project_id] = { projectId: mod.project_id, title: mod.title, mcVersion: result.mcVersion, filenames: result.filenames, versionId: result.versionId };
      saveInstalledModpacks(updated);
      setMark(statusEl, 'done');
      updateBtn.innerHTML = `${icon('check')}Updated`;
      setTimeout(() => { updateBtn.innerHTML = `${icon('refresh')}Update`; updateBtn.disabled = false; }, 2000);
    } catch (err: any) {
      // The old pack's files were already removed above before the reinstall
      // attempt — if the reinstall itself failed, the stale record must be
      // cleared too, or localStorage keeps claiming files are installed that
      // no longer exist on disk (toggle would show "installed" forever).
      const updated = loadInstalledModpacks();
      delete updated[mod.project_id];
      saveInstalledModpacks(updated);
      card.className = 'mod-card';
      input.checked = false;
      setMark(statusEl, 'failed');
      updateBtn.innerHTML = `${icon('x')}Failed`;
      updateBtn.disabled = false;
    } finally {
      modpackProgressEl = null;
    }
  });

  input.addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked;
    input.disabled = true;
    if (checked) {
      setMark(statusEl, 'busy');
      modpackProgressEl = statusEl;
      try {
        // Remove any currently installed modpacks before installing this one
        const existing = loadInstalledModpacks();
        for (const pack of Object.values(existing)) {
          for (const filename of pack.filenames) {
            try { await mc.removeMod({ filename, mcVersion: pack.mcVersion }); } catch {}
          }
        }
        saveInstalledModpacks({});

        const result = await mc.installModpack({ projectId: mod.project_id });
        if (!result.ok) throw new Error(result.error);
        const updated = loadInstalledModpacks();
        updated[mod.project_id] = { projectId: mod.project_id, title: mod.title, mcVersion: result.mcVersion, filenames: result.filenames, versionId: result.versionId };
        saveInstalledModpacks(updated);
        card.className = 'mod-card enabled';
        setMark(statusEl, 'done');
      } catch (err: any) {
        input.checked = false;
        card.className = 'mod-card';
        setMark(statusEl, 'failed');
        statusEl.title = err.message;
      } finally {
        modpackProgressEl = null;
      }
    } else {
      const updated = loadInstalledModpacks();
      const pack = updated[mod.project_id];
      if (pack) {
        for (const filename of pack.filenames) {
          try { await mc.removeMod({ filename, mcVersion: pack.mcVersion }); } catch {}
        }
        delete updated[mod.project_id];
        saveInstalledModpacks(updated);
      }
      card.className = 'mod-card';
      statusEl.textContent = '';
      setTone(statusEl, '');
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
    modsList.innerHTML = listMsg('Could not reach Modrinth. Check your connection and try again.', 'error');
  }
}

async function searchModrinth(query: string) {
  modsLoading.style.display = 'flex';
  modsList.innerHTML = '';
  try {
    const ver = mcVersion.value || '26.1.2';
    const facets = modsTabType === 'mod'
      ? JSON.stringify([['project_type:mod'], ['client_side:required', 'client_side:optional'], [`versions:${ver}`]])
      : JSON.stringify([['project_type:modpack'], [`versions:${ver}`]]);
    const params = new URLSearchParams({
      query, facets, limit: '50',
      index: query ? 'relevance' : 'downloads',
    });
    const res  = await fetch(`https://api.modrinth.com/v2/search?${params}`);
    const data = await res.json() as { hits: ModrinthHit[] };
    modsLoading.style.display = 'none';
    if (!data.hits.length) {
      modsList.innerHTML = listMsg(`No ${modsTabType === 'modpack' ? 'modpacks' : 'mods'} found for Minecraft ${ver}.`);
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
    modsList.innerHTML = listMsg('Could not reach Modrinth. Check your connection and try again.', 'error');
  }
}

modsSearch.addEventListener('input', () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchModrinth(modsSearch.value.trim()), 400);
});

// ── PvP Mods panel ────────────────────────────────────────────────────────────
interface PvpModDef {
  slug: string; name: string; desc: string;
  group: 'HUD' | 'Visual' | 'Utility' | 'Performance';
  deps?: string[];
  conflicts?: string[];
}

const PVP_MOD_GROUPS: { label: string; mods: PvpModDef[] }[] = [
  {
    label: 'Required',
    mods: [
      { slug: 'fabric-api',            name: 'Fabric API',           desc: 'Required dependency — all Fabric mods need this', group: 'Utility' },
    ],
  },
  {
    label: 'HUD & Info',
    mods: [
      { slug: 'keystrokes',            name: 'Keystrokes',           desc: 'Live WASD + CPS overlay (Feather Keystrokes)', group: 'HUD' },
      { slug: 'appleskin',             name: 'AppleSkin',            desc: 'Saturation & exhaustion on the hunger bar', group: 'HUD' },
      { slug: 'armor-status',          name: 'Armor Status',         desc: 'Armor & held item durability HUD', group: 'HUD' },
      { slug: 'status-effect-bars',    name: 'Status Effect Bars',   desc: 'Duration bars under every active potion effect', group: 'HUD' },
      { slug: 'coordinates-display',   name: 'Coordinates',          desc: 'Clean XYZ + direction overlay — no F3 needed', group: 'HUD' },
      { slug: 'xaeros-minimap',        name: "Xaero's Minimap",     desc: 'Minimap with player dots & waypoints', group: 'HUD' },
      { slug: 'xaeros-world-map',      name: "Xaero's World Map",    desc: 'Full world map — works with Xaero\'s Minimap', group: 'HUD', deps: ['xaeros-minimap'] },
      { slug: 'betterf3',              name: 'BetterF3',             desc: 'Color-coded F3 with FPS, ping & TPS (Feather HUD)', group: 'HUD' },
      { slug: 'zoomify',               name: 'Zoomify',              desc: 'OptiFine-style smooth zoom key (Feather Zoom)', group: 'HUD' },
      { slug: 'ping-wheel',            name: 'Ping Wheel',           desc: 'Quick radial ping menu to mark locations (like Apex)', group: 'HUD' },
      { slug: 'fps-display',           name: 'FPS Display',          desc: 'Simple corner FPS counter overlay', group: 'HUD' },
      { slug: 'held-item-info',        name: 'Held Item Info',       desc: 'Shows name & enchantments of held item', group: 'HUD' },
    ],
  },
  {
    label: 'Visual',
    mods: [
      { slug: 'custom-crosshair-mod',  name: 'Custom Crosshair',    desc: 'Crosshair style, size, color & gap (Feather Crosshair)', group: 'Visual' },
      { slug: 'natural-motion-blur',   name: 'Motion Blur',         desc: 'Smooth camera motion blur (Feather Motion Blur)', group: 'Visual' },
      { slug: 'not-enough-animations', name: 'Not Enough Animations',desc: 'Restores eating, bow & item animations', group: 'Visual' },
      { slug: 'damage-tilt',           name: 'Damage Tilt',         desc: 'Screen tilts when you take damage (Feather)', group: 'Visual' },
      { slug: '3dskinlayers',          name: '3D Skin Layers',      desc: 'Renders skin as 3D geometry like Feather Client', group: 'Visual' },
      { slug: 'blur-plus',             name: 'Blur+',              desc: 'Blurs the background when a menu is open', group: 'Visual' },
      { slug: 'cit-resewn',            name: 'CIT Resewn',          desc: 'Custom Item Textures — rename items to change their look', group: 'Visual' },
      { slug: 'modelfix',              name: 'Model Gap Fix',         desc: 'Fixes gaps in held items & armor (like OptiFine)', group: 'Visual' },
      { slug: 'entity-model-features', name: 'Entity Model Features',desc: 'Custom entity models from resource packs (EMF)', group: 'Visual', deps: ['entitytexturefeatures'] },
      { slug: 'entitytexturefeatures', name: 'Entity Texture Features',desc: 'Random & custom entity textures (ETF)', group: 'Visual' },
      { slug: 'continuity',            name: 'Continuity',          desc: 'Connected textures like OptiFine (glass, bookshelves)', group: 'Visual', deps: ['indium'] },
      { slug: 'lambdynamiclights',     name: 'Dynamic Lights',      desc: 'Held torches & glowstone light up surroundings', group: 'Visual' },
    ],
  },
  {
    label: 'Utility',
    mods: [
      { slug: 'toggle-sprint',           name: 'Toggle Sprint',       desc: 'Toggle sprint & sneak — no need to hold Ctrl', group: 'Utility' },
      { slug: 'no-chat-reports',       name: 'No Chat Reports',     desc: 'Removes chat signing — blocks Microsoft reports', group: 'Utility' },
      { slug: 'item-highlighter',      name: 'Item Highlighter',    desc: 'Highlights newly picked up items in hotbar', group: 'Utility' },
      { slug: 'shulkerboxtooltip',     name: 'Shulker Tooltips',    desc: 'Preview shulker box contents on hover', group: 'Utility' },
      { slug: 'perspectivemod',        name: 'Perspective Mod',     desc: 'Feather Freelook — look around without turning body', group: 'Utility' },
      { slug: 'mouse-wheelie',         name: 'Mouse Wheelie',       desc: 'Scroll to move items between inventory & chest', group: 'Utility' },
      { slug: 'inventory-profiles-next',name: 'Inventory Profiles', desc: 'Auto-sort inventory, replace broken tools automatically', group: 'Utility' },
      { slug: 'chat-heads',            name: 'Chat Heads',          desc: 'Shows player skin head next to their chat message', group: 'Utility' },
      { slug: 'tooltipfix',            name: 'ToolTip Fix',         desc: 'Stops tooltips from going off-screen', group: 'Utility' },
      { slug: 'reeses-sodium-options', name: 'Reese\'s Sodium Options',desc: 'Better settings screen for Sodium video options', group: 'Utility', deps: ['sodium'] },
      { slug: 'sodium-extra',          name: 'Sodium Extra',        desc: 'Extra options for Sodium (animations, particles)', group: 'Utility', deps: ['sodium'] },
    ],
  },
  {
    label: 'Performance',
    mods: [
      { slug: 'sodium',                name: 'Sodium',              desc: 'Major FPS boost — better rendering engine', group: 'Performance' },
      { slug: 'lithium',               name: 'Lithium',             desc: 'Game logic & tick optimizations', group: 'Performance' },
      { slug: 'iris',                  name: 'Iris Shaders',        desc: 'Shader pack support (requires Sodium)', group: 'Performance', deps: ['sodium'] },
      { slug: 'entityculling',         name: 'Entity Culling',      desc: 'Skip rendering entities behind walls', group: 'Performance' },
      { slug: 'memoryleakfix',         name: 'Memory Leak Fix',     desc: 'Fixes Minecraft memory leaks — fewer crashes', group: 'Performance' },
      { slug: 'ferrite-core',          name: 'Ferrite Core',        desc: 'Reduces RAM usage of block states (Feather perf)', group: 'Performance' },
      { slug: 'indium',                name: 'Indium',              desc: 'Sodium addon — enables Fabric Rendering API for other mods', group: 'Performance', deps: ['sodium'] },
      { slug: 'starlight',             name: 'Starlight',           desc: 'Rewrites light engine for massive chunk load speedup', group: 'Performance', conflicts: ['c2me-fabric'] },
      { slug: 'c2me-fabric',           name: 'C2ME',               desc: 'Multithreaded chunk generation & I/O', group: 'Performance', conflicts: ['starlight'] },
      { slug: 'noxesium',              name: 'Noxesium',            desc: 'Reduces server-side lag on large servers', group: 'Performance' },
      { slug: 'immediatelyfast',       name: 'ImmediatelyFast',     desc: 'Optimizes immediate mode rendering (GUI, maps, text)', group: 'Performance' },
    ],
  },
];

const PVP_MOD_BY_SLUG = new Map<string, PvpModDef>(
  PVP_MOD_GROUPS.flatMap(g => g.mods).map(m => [m.slug, m])
);

// Each curated mod shows its real Modrinth icon, all fetched in one request.
const pvpIcons = new Map<string, string>();
let pvpIconsLoading: Promise<void> | null = null;
function loadPvpIcons(): Promise<void> {
  if (!pvpIconsLoading) {
    const ids = JSON.stringify([...PVP_MOD_BY_SLUG.keys()]);
    pvpIconsLoading = fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(ids)}`)
      .then(r => r.json())
      .then((projects: any[]) => { for (const p of projects) if (p.icon_url) pvpIcons.set(p.slug, p.icon_url); })
      .catch(() => {});
  }
  return pvpIconsLoading;
}
function pvpIconHtml(slug: string): string {
  const url = pvpIcons.get(slug);
  return url
    ? `<img src="${url}" class="mod-icon-img" alt="" onerror="this.style.visibility='hidden'">`
    : `<div class="mod-icon" data-pvp-icon="${slug}"></div>`;
}

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
  const res = await mc.installMod({ url: file.url, filename: file.filename, mcVersion: ver });
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
    ? `<div class="mod-tags">${depNames.map(n => `<span class="mod-tag">Needs ${n}</span>`).join('')}</div>`
    : '';

  const verBadge = wrongVer
    ? `<span class="pill pill-warn" title="Installed for a different Minecraft version">Built for ${installedInfo!.mcVersion}</span>`
    : on && installedInfo?.mcVersion
      ? `<span class="mod-meta">${installedInfo.mcVersion}</span>`
      : '';

  card.innerHTML = `
    ${pvpIconHtml(mod.slug)}
    <div class="mod-info">
      <div class="mod-name-row">
        <div class="mod-name">${mod.name}</div>
        ${verBadge}
      </div>
      <div class="mod-desc">${mod.desc}</div>
      ${depsHtml}
      <div class="pvp-err mod-err" data-tone="error"></div>
    </div>
    <div class="mod-right">
      ${wrongVer ? `<button class="pvp-update-btn btn btn-sm btn-soft">${icon('refresh')}Update</button>` : ''}
      <div class="mod-version"${on && !wrongVer ? ' data-tone="accent"' : ''}>${on && !wrongVer ? icon('check') : ''}</div>
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
      await installOneMod(mod, mcVersion.value || '26.1.2');
      renderPvpMods((document.getElementById('pvp-search') as HTMLInputElement)?.value ?? '');
    } catch {
      updateBtn.innerHTML = `${icon('x')}Failed`;
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
            if (cInstalled[cSlug]) await mc?.removeMod({ filename: cInstalled[cSlug].filename, mcVersion: cInstalled[cSlug].mcVersion || mcVersion.value });
            const updated = loadInstalledMods(); delete updated[cSlug]; saveInstalledMods(updated);
            enabledMods.delete(cSlug);
          }
        }
        errEl.textContent = `Turned off ${conflictNames}: it doesn't work alongside ${mod.name}.`;
        setTone(errEl, 'pending');
        errEl.style.display = 'block';
        // Re-render so the conflicting cards update
        setTimeout(() => renderPvpMods((document.getElementById('pvp-search') as HTMLInputElement)?.value ?? ''), 50);
      }

      setMark(statusEl, 'busy');
      try {
        const ver = mcVersion.value || '26.1.2';
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
          setMark(statusEl, 'download', dep.name);
          await installOneMod(dep, ver);
        }
        setMark(statusEl, 'busy');
        await installOneMod(mod, ver);
        card.className = 'mod-card enabled';
        setMark(statusEl, 'done');
        if (depsToInstall.length) renderPvpMods((document.getElementById('pvp-search') as HTMLInputElement)?.value ?? '');
      } catch (err: any) {
        input.checked = false;
        card.className = 'mod-card';
        setMark(statusEl, 'failed');
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    } else {
      const installed = loadInstalledMods();
      const info = installed[mod.slug];
      if (info && mc) await mc.removeMod({ filename: info.filename, mcVersion: info.mcVersion || mcVersion.value });
      delete installed[mod.slug];
      saveInstalledMods(installed);
      enabledMods.delete(mod.slug);
      card.className = 'mod-card';
      statusEl.textContent = ''; setTone(statusEl, '');
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
    section.innerHTML = `<div class="list-group-title">${group.label}</div>`;
    const grid = document.createElement('div');
    grid.className = 'list-group';
    for (const mod of filtered) grid.appendChild(buildPvpCard(mod));
    section.appendChild(grid);
    list.appendChild(section);
  }
  if (!anyVisible) {
    list.innerHTML = listMsg('No mods match your search.');
  }
  // swap the placeholder boxes for real icons once they arrive
  if (!pvpIcons.size) loadPvpIcons().then(() => {
    list.querySelectorAll<HTMLElement>('[data-pvp-icon]').forEach(el => {
      if (pvpIcons.has(el.dataset.pvpIcon!)) el.outerHTML = pvpIconHtml(el.dataset.pvpIcon!);
    });
  });
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
  if (!stale.length) { btn.textContent = 'All mods are up to date'; return; }
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
        const res = await mc.installMod({ url: f.url, filename: f.filename, mcVersion: ver });
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
    updateProfileBtn.className = 'btn btn-sm';
    updateProfileBtn.innerHTML = `${icon('refresh')}Update`;

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-ghost';
    delBtn.textContent = 'Delete';

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
        toggleInput.disabled = true;
        const ver = mcVersion.value || '26.1.2';
        const installed = loadInstalledMods();
        for (const slug of Array.from(enabledMods)) {
          if (!profile.slugs.includes(slug)) {
            if (installed[slug]) await mc?.removeMod({ filename: installed[slug].filename, mcVersion: installed[slug].mcVersion || mcVersion.value });
            const upd = loadInstalledMods(); delete upd[slug]; saveInstalledMods(upd);
            enabledMods.delete(slug);
          }
        }
        // The profile's own mods that aren't currently enabled must actually be
        // (re)installed here too — previously this loop only removed extras,
        // so switching to a profile never turned its mods back on once they'd
        // been uninstalled by a prior profile switch.
        for (const slug of profile.slugs) {
          if (enabledMods.has(slug)) continue;
          try {
            const pvpMod = PVP_MOD_BY_SLUG.get(slug);
            if (pvpMod) {
              await installOneMod(pvpMod, ver);
            } else if (slug.startsWith('cf_')) {
              const modId = Number(slug.slice(3));
              const dlRes = await (window as any).curseforge?.getDownload?.({ modId, mcVersion: ver });
              if (dlRes?.ok) {
                const installRes = await mc.installMod({ url: dlRes.url, filename: dlRes.filename, mcVersion: ver });
                if (installRes.ok) {
                  const cur = loadInstalledMods();
                  cur[slug] = { filename: dlRes.filename, name: slug, mcVersion: ver, cfId: modId, fileId: dlRes.fileId };
                  saveInstalledMods(cur);
                  enabledMods.add(slug);
                }
              }
            } else {
              const p = new URLSearchParams({ game_versions: `["${ver}"]`, loaders: '["fabric"]', limit: '5' });
              const r = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version?${p}`);
              const data: any[] = await r.json();
              if (Array.isArray(data) && data.length) {
                const f = data[0].files.find((fi: any) => fi.primary) ?? data[0].files[0];
                if (f) {
                  const res = await mc.installMod({ url: f.url, filename: f.filename, mcVersion: ver });
                  if (res.ok) {
                    const cur = loadInstalledMods();
                    cur[slug] = { filename: f.filename, name: slug, mcVersion: ver, modrinthVersionId: data[0].id };
                    saveInstalledMods(cur);
                    enabledMods.add(slug);
                  }
                }
              }
            }
          } catch {}
        }
        updateModsBadge();
        toggleInput.disabled = false;
      } else {
        if (getActiveProfileId() === profile.id) setActiveProfileId(null);
      }
      renderModProfiles();
    });

    updateProfileBtn.addEventListener('click', async () => {
      const ver = mcVersion.value || '26.1.2';
      updateProfileBtn.disabled = true;
      let done = 0;
      for (const slug of profile.slugs) {
        const mod = PVP_MOD_BY_SLUG.get(slug);
        if (!mod) continue;
        updateProfileBtn.innerHTML = `${icon('refresh')}${done}/${profile.slugs.length}`;
        try { await installOneMod(mod, ver); done++; } catch {}
      }
      updateProfileBtn.innerHTML = `${icon('check')}${done} updated`;
      updateProfileBtn.disabled = false;
      setTimeout(() => { updateProfileBtn.innerHTML = `${icon('refresh')}Update`; }, 2000);
    });

    let confirmPending = false;
    let confirmTimer: ReturnType<typeof setTimeout> | null = null;
    delBtn.addEventListener('click', () => {
      if (!confirmPending) {
        confirmPending = true;
        delBtn.textContent = 'Delete it?';
        delBtn.className = 'btn btn-sm btn-danger';
        confirmTimer = setTimeout(() => {
          confirmPending = false;
          delBtn.textContent = 'Delete';
          delBtn.className = 'btn btn-sm btn-ghost';
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
  if (btn) { btn.innerHTML = `${icon('check')}Saved`; setTimeout(() => { btn.textContent = 'Save current mods'; }, 1500); }
});

renderModProfiles();

// ── CurseForge browser (mods / modpacks / resource packs / shaders / worlds) ──
const cf = (window as any).curseforge;
type CfContentType = 'mod' | 'modpack' | 'resourcepack' | 'shader' | 'world';
let cfContentType: CfContentType = 'mod';

function initCurseForge() {
  const searchEl = document.getElementById('cf-search') as HTMLInputElement;
  document.querySelectorAll('.cf-type-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = (btn as HTMLElement).dataset.type as CfContentType;
      if (type === cfContentType) return;
      cfContentType = type;
      document.querySelectorAll('.cf-type-tab').forEach(b => b.classList.toggle('active', b === btn));
      const labels: Record<CfContentType, string> = {
        mod: 'mods', modpack: 'modpacks', resourcepack: 'resource packs', shader: 'shaders', world: 'worlds',
      };
      searchEl.placeholder = `Search CurseForge ${labels[type]}…`;
      searchCurseForge(searchEl.value.trim());
    });
  });
  searchCurseForge('');
  let cfTimer: ReturnType<typeof setTimeout> | null = null;
  searchEl.addEventListener('input', () => {
    if (cfTimer) clearTimeout(cfTimer);
    cfTimer = setTimeout(() => searchCurseForge(searchEl.value.trim()), 500);
  });
}

// Same batched-badge pattern as Modrinth's queueModBuildVersion, but peeking
// CurseForge's file list (a plain GET — doesn't install anything) to show
// the actual matched build's filename for the selected MC version.
const cfBuildVerQueue: Array<{ modId: number; mcVersion: string; contentType: CfContentType; el: HTMLElement }> = [];
let cfBuildVerFlushTimer: ReturnType<typeof setTimeout> | null = null;
function queueCfBuildVersion(modId: number, mcVersion: string, contentType: CfContentType, el: HTMLElement) {
  cfBuildVerQueue.push({ modId, mcVersion, contentType, el });
  if (cfBuildVerFlushTimer) return;
  cfBuildVerFlushTimer = setTimeout(flushCfBuildVerQueue, 80);
}
async function flushCfBuildVerQueue() {
  cfBuildVerFlushTimer = null;
  const batch = cfBuildVerQueue.splice(0, cfBuildVerQueue.length);
  await runBatched(batch, 5, async ({ modId, mcVersion, contentType, el }) => {
    try {
      const res = await cf.getDownload({ modId, mcVersion, contentType });
      if (res?.ok && res.filename) {
        el.textContent = res.filename.replace(/\.(jar|zip)$/i, '');
        setTone(el, 'accent');
      } else {
        el.textContent = '';
      }
    } catch { el.textContent = ''; }
  });
}

function fmtCfDownloads(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function cfCardShell(mod: any): { card: HTMLElement; statusEl: HTMLElement; buildVerEl: HTMLElement | null } {
  const card = document.createElement('div');
  card.className = 'mod-card';
  const logoHtml = mod.logo?.thumbnailUrl
    ? `<img src="${mod.logo.thumbnailUrl}" class="mod-icon-img" alt="" onerror="this.style.display='none'">`
    : `<div class="mod-icon"></div>`;
  const showBuildVer = cfContentType === 'mod' || cfContentType === 'modpack';
  card.innerHTML = `
    ${logoHtml}
    <div class="mod-info">
      <div class="mod-name">${mod.name}</div>
      <div class="mod-desc">${mod.summary}</div>
      <div class="mod-tags">
        ${showBuildVer ? `<span class="mod-tag cf-build-ver push">…</span>` : ''}
        <span class="mod-tag dl${showBuildVer ? '' : ' push'}">${icon('download')}${fmtCfDownloads(mod.downloadCount)}</span>
      </div>
    </div>
    <div class="mod-right" id="cf-right-${mod.id}"></div>`;
  const statusEl = document.createElement('div');
  statusEl.className = 'mod-version';
  const buildVerEl = card.querySelector('.cf-build-ver') as HTMLElement | null;
  return { card, statusEl, buildVerEl };
}

function buildCfModCard(mod: any, ver: string): HTMLElement {
  const { card, statusEl, buildVerEl } = cfCardShell(mod);
  const installed = loadInstalledMods();
  const isOn = !!Object.values(installed).find((m: any) => m.cfId === mod.id);
  card.className = 'mod-card' + (isOn ? ' enabled' : '');
  const right = card.querySelector(`#cf-right-${mod.id}`)!;
  right.appendChild(statusEl);
  right.innerHTML += `<label class="toggle"><input type="checkbox" ${isOn ? 'checked' : ''} /><span class="toggle-slider"></span></label>`;
  const input = right.querySelector('input') as HTMLInputElement;
  if (isOn) { setMark(statusEl, 'done'); }
  if (buildVerEl) queueCfBuildVersion(mod.id, ver, 'mod', buildVerEl);

  input.addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked;
    input.disabled = true;
    if (checked) {
      setMark(statusEl, 'busy');
      try {
        const dlRes = await cf.getDownload({ modId: mod.id, mcVersion: ver, contentType: 'mod' });
        if (!dlRes.ok) throw new Error(dlRes.error);
        setMark(statusEl, 'download');
        const installRes = await mc.installMod({ url: dlRes.url, filename: dlRes.filename, mcVersion: ver });
        if (!installRes.ok) throw new Error(installRes.error);
        const ins = loadInstalledMods();
        ins[`cf_${mod.id}`] = { filename: dlRes.filename, name: mod.name, mcVersion: ver, cfId: mod.id, fileId: dlRes.fileId };
        saveInstalledMods(ins);
        card.className = 'mod-card enabled';
        setMark(statusEl, 'done');
        updateModsBadge();
      } catch (err: any) {
        input.checked = false; card.className = 'mod-card';
        setMark(statusEl, 'failed');
        statusEl.title = err.message;
      }
    } else {
      const ins = loadInstalledMods();
      const info = ins[`cf_${mod.id}`];
      if (info && mc) await mc.removeMod({ filename: info.filename, mcVersion: info.mcVersion || ver });
      delete ins[`cf_${mod.id}`];
      saveInstalledMods(ins);
      card.className = 'mod-card';
      statusEl.textContent = '';
      updateModsBadge();
    }
    input.disabled = false;
  });
  return card;
}

function buildCfModpackCard(mod: any, ver: string): HTMLElement {
  const { card, statusEl, buildVerEl } = cfCardShell(mod);
  const key = `cf_${mod.id}`;
  const packs = loadInstalledModpacks();
  const isOn = !!packs[key];
  card.className = 'mod-card' + (isOn ? ' enabled' : '');
  const right = card.querySelector(`#cf-right-${mod.id}`)!;
  right.appendChild(statusEl);
  right.innerHTML += `<label class="toggle"><input type="checkbox" ${isOn ? 'checked' : ''} /><span class="toggle-slider"></span></label>`;
  const input = right.querySelector('input') as HTMLInputElement;
  if (isOn) { setMark(statusEl, 'done'); }
  if (buildVerEl) queueCfBuildVersion(mod.id, ver, 'modpack', buildVerEl);

  input.addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked;
    input.disabled = true;
    if (checked) {
      setMark(statusEl, 'busy');
      modpackProgressEl = statusEl;
      try {
        // Remove any currently installed modpacks first — mirrors the
        // Modrinth modpack install behavior (one active pack at a time).
        const existing = loadInstalledModpacks();
        for (const pack of Object.values(existing)) {
          for (const filename of pack.filenames) {
            try { await mc.removeMod({ filename, mcVersion: pack.mcVersion }); } catch {}
          }
        }
        saveInstalledModpacks({});

        const result = await cf.installModpack({ modId: mod.id });
        if (!result.ok) throw new Error(result.error);
        const updated = loadInstalledModpacks();
        updated[key] = { projectId: '', title: mod.name, mcVersion: result.mcVersion, filenames: result.filenames, cfId: mod.id, fileId: result.fileId };
        saveInstalledModpacks(updated);
        card.className = 'mod-card enabled';
        setMark(statusEl, 'done');
        updateModsBadge();
      } catch (err: any) {
        input.checked = false; card.className = 'mod-card';
        setMark(statusEl, 'failed');
        statusEl.title = err.message;
      } finally {
        modpackProgressEl = null;
      }
    } else {
      const updated = loadInstalledModpacks();
      const pack = updated[key];
      if (pack) {
        for (const filename of pack.filenames) {
          try { await mc.removeMod({ filename, mcVersion: pack.mcVersion }); } catch {}
        }
        delete updated[key];
        saveInstalledModpacks(updated);
      }
      card.className = 'mod-card';
      statusEl.textContent = '';
      updateModsBadge();
    }
    input.disabled = false;
  });
  return card;
}

function buildCfResourceOrShaderCard(mod: any, ver: string, kind: 'resourcepack' | 'shader'): HTMLElement {
  const { card, statusEl } = cfCardShell(mod);
  const right = card.querySelector(`#cf-right-${mod.id}`)!;
  right.appendChild(statusEl);
  right.innerHTML += `<label class="toggle"><input type="checkbox" /><span class="toggle-slider"></span></label>`;
  const input = right.querySelector('input') as HTMLInputElement;

  (async () => {
    const disk = kind === 'resourcepack' ? await mc.listResourcePacks() : await listInstalledShaderpacks();
    const dlRes = await cf.getDownload({ modId: mod.id, mcVersion: ver, contentType: kind });
    const filename = dlRes?.ok ? dlRes.filename : null;
    const isOn = !!filename && disk.includes(filename);
    input.checked = isOn;
    card.className = 'mod-card' + (isOn ? ' enabled' : '');
    if (isOn) { setMark(statusEl, 'done'); }
    input.dataset.filename = filename ?? '';
  })();

  input.addEventListener('change', async e => {
    const checked = (e.target as HTMLInputElement).checked;
    input.disabled = true;
    if (checked) {
      setMark(statusEl, 'busy');
      try {
        const dlRes = await cf.getDownload({ modId: mod.id, mcVersion: ver, contentType: kind });
        if (!dlRes.ok) throw new Error(dlRes.error);
        setMark(statusEl, 'download');
        const installRes = kind === 'resourcepack'
          ? await mc.installResourcePack({ url: dlRes.url, filename: dlRes.filename })
          : await mc.installShaderpack({ url: dlRes.url, filename: dlRes.filename });
        if (!installRes.ok) throw new Error(installRes.error);
        input.dataset.filename = dlRes.filename;
        card.className = 'mod-card enabled';
        setMark(statusEl, 'done');
        if (kind === 'shader') refreshShaderpackDropdown();
      } catch (err: any) {
        input.checked = false; card.className = 'mod-card';
        setMark(statusEl, 'failed');
        statusEl.title = err.message;
      }
    } else {
      const filename = input.dataset.filename;
      if (filename) {
        try {
          if (kind === 'resourcepack') await mc.removeResourcePack({ filename });
          else { await mc.removeShaderpack({ filename }); refreshShaderpackDropdown(); }
        } catch {}
      }
      card.className = 'mod-card';
      statusEl.textContent = '';
    }
    input.disabled = false;
  });
  return card;
}

function buildCfWorldCard(mod: any, ver: string): HTMLElement {
  const { card, statusEl } = cfCardShell(mod);
  const right = card.querySelector(`#cf-right-${mod.id}`)!;
  right.appendChild(statusEl);
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm btn-soft';
  btn.textContent = 'Import';
  right.appendChild(btn);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    setMark(statusEl, 'download'); setTone(statusEl, 'pending');
    btn.textContent = 'Importing…';
    try {
      const res = await cf.installWorld({ modId: mod.id, mcVersion: ver });
      if (!res.ok) throw new Error(res.error);
      setMark(statusEl, 'done');
      btn.innerHTML = `${icon('check')}Imported`;
      setTimeout(() => { btn.textContent = 'Import'; btn.disabled = false; }, 2000);
    } catch (err: any) {
      setMark(statusEl, 'failed');
      statusEl.title = err.message;
      btn.innerHTML = `${icon('x')}Failed`;
      setTimeout(() => { btn.textContent = 'Import'; btn.disabled = false; }, 2500);
    }
  });
  return card;
}

async function searchCurseForge(query: string) {
  const list    = document.getElementById('cf-list')!;
  const loading = document.getElementById('cf-loading')!;
  list.innerHTML = '';
  loading.style.display = 'flex';
  const ver = (document.getElementById('mc-version') as HTMLSelectElement)?.value || '26.1.2';
  const res = await cf?.search({ query, mcVersion: ver, contentType: cfContentType });
  loading.style.display = 'none';
  if (!res?.ok) {
    const q = encodeURIComponent(query || '');
    const classSlug: Record<CfContentType, string> = {
      mod: 'mc-mods', modpack: 'modpacks', resourcepack: 'texture-packs', shader: 'shaders', world: 'worlds',
    };
    const url = `https://www.curseforge.com/minecraft/search?search=${q}&class=${classSlug[cfContentType]}`;
    list.innerHTML = `<div class="list-msg">
      <p>CurseForge can't be reached from the launcher right now.</p>
      <a class="btn btn-soft" href="${url}" data-external>Browse on curseforge.com${icon('external')}</a>
    </div>`;
    list.querySelector<HTMLAnchorElement>('[data-external]')?.addEventListener('click', e => {
      e.preventDefault();
      (window as any).electron?.openExternal?.(url) || window.open(url);
    });
    return;
  }
  if (!res.data?.length) {
    list.innerHTML = listMsg('No results. Try a different search.');
    return;
  }
  const frag = document.createDocumentFragment();
  for (const mod of res.data) {
    const card = cfContentType === 'mod'          ? buildCfModCard(mod, ver)
               : cfContentType === 'modpack'       ? buildCfModpackCard(mod, ver)
               : cfContentType === 'world'          ? buildCfWorldCard(mod, ver)
               : buildCfResourceOrShaderCard(mod, ver, cfContentType);
    frag.appendChild(card);
  }
  list.appendChild(frag);
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
    reinstallBtn.innerHTML = `${icon('refresh')}Update ${stale} mod${stale !== 1 ? 's' : ''} for ${mcVersion.value}`;
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

function buildRPCard(name: string, slug: string, projectId: string, iconUrl: string, desc: string, installed: boolean): HTMLElement {
  const card = document.createElement('div');
  card.className = 'mod-card' + (installed ? ' enabled' : '');
  card.innerHTML = `
    ${iconUrl ? `<img src="${iconUrl}" class="mod-icon-img" alt="" onerror="this.style.visibility='hidden'">` : '<div class="mod-icon"></div>'}
    <div class="mod-info">
      <div class="mod-name">${name}</div>
      <div class="mod-desc">${desc}</div>
      <div class="pvp-err mod-err" data-tone="error"></div>
    </div>
    <div class="mod-right">
      <div class="mod-version"${installed ? ' data-tone="accent"' : ''}>${installed ? icon('check') : ''}</div>
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
      setMark(statusEl, 'busy');
      try {
        const { url, filename } = await fetchRPDownloadUrl(projectId);
        const res = await mc.installResourcePack({ url, filename });
        if (!res.ok) throw new Error(res.error);
        rps[slug] = filename;
        saveInstalledRPs(rps);
        card.className = 'mod-card enabled';
        setMark(statusEl, 'done');
      } catch (err: any) {
        input.checked = false;
        card.className = 'mod-card';
        setMark(statusEl, 'failed');
        errEl.textContent = err.message; errEl.style.display = 'block';
      }
    } else {
      if (rps[slug]) await mc.removeResourcePack({ filename: rps[slug] });
      delete rps[slug];
      saveInstalledRPs(rps);
      card.className = 'mod-card';
      statusEl.textContent = ''; setTone(statusEl, '');
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
      const card = buildRPCard(hit.title, hit.slug, hit.project_id, hit.icon_url || '', hit.description, installed);
      rpList.appendChild(card);
    }
    if (!data.hits?.length) rpList.innerHTML = listMsg('No resource packs match that search.');
  } catch { rpLoading.style.display = 'none'; rpList.innerHTML = listMsg('Could not reach Modrinth. Check your connection and try again.', 'error'); }
}

function initResourcePacks() {
  const rps = loadInstalledRPs();
  const installedEl = document.getElementById('rp-installed')!;
  installedEl.innerHTML = '';
  if (Object.keys(rps).length) {
    const label = document.createElement('div');
    label.className = 'list-group-title';
    label.textContent = 'Installed';
    installedEl.appendChild(label);
    for (const [slug, filename] of Object.entries(rps)) {
      installedEl.appendChild(buildRPCard(filename.replace(/\.zip$/i, ''), slug, '', '', filename, true));
    }
    const sep = document.createElement('div');
    sep.className = 'list-group-title';
    sep.textContent = 'Browse';
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

// ── Shader packs (installed on-demand from Modrinth, like mods/resource packs) ─
const SHADERPACK_CATALOG = [
  { slug: 'complementary-reimagined', name: 'Complementary Reimagined', match: 'reimagined' },
  { slug: 'complementary-unbound',    name: 'Complementary Unbound',    match: 'unbound' },
  { slug: 'bsl-shaders',              name: 'BSL Shaders',              match: 'bsl' },
  { slug: 'bliss-shader',             name: 'Bliss Shaders',            match: 'bliss' },
  { slug: 'photon-shader',            name: 'Photon Shaders',           match: 'photon' },
];

async function listInstalledShaderpacks(): Promise<string[]> {
  return await (window as any).mc?.listShaderpacks?.() ?? [];
}

async function refreshShaderpackDropdown() {
  if (!shaderpackSelect) return;
  const installed = await listInstalledShaderpacks();
  const current = shaderpackSelect.value || localStorage.getItem('voxel_shaderpack') || '';
  shaderpackSelect.innerHTML = '<option value="">None (vanilla)</option>' +
    installed.map(f => `<option value="${escHtml(f)}">${escHtml(f.replace(/\.zip$/i, ''))}</option>`).join('');
  if (current && installed.includes(current)) shaderpackSelect.value = current;
}

async function initShaderpackSettings() {
  await refreshShaderpackDropdown();
  const listEl = document.getElementById('shaderpack-install-list');
  if (!listEl) return;
  const installed = await listInstalledShaderpacks();
  listEl.innerHTML = '';
  for (const pack of SHADERPACK_CATALOG) {
    const existing = installed.find(f => f.toLowerCase().includes(pack.match));
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <span class="item-row-name">${pack.name}</span>
      <span class="sp-status" data-tone="accent"${existing ? '' : ' style="display:none"'}>${icon('check')}Installed</span>
      <button class="sp-btn btn btn-sm${existing ? '' : ' btn-soft'}">${existing ? 'Remove' : 'Install'}</button>`;
    const btn = row.querySelector('.sp-btn') as HTMLButtonElement;
    const statusEl = row.querySelector('.sp-status') as HTMLElement;
    let currentFile = existing;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      if (currentFile) {
        btn.textContent = 'Removing…';
        await (window as any).mc.removeShaderpack({ filename: currentFile });
        currentFile = undefined;
        statusEl.style.display = 'none';
        btn.textContent = 'Install';
        btn.classList.add('btn-soft');
      } else {
        btn.textContent = 'Installing…';
        try {
          const vRes = await fetch(`https://api.modrinth.com/v2/project/${pack.slug}/version?limit=1`);
          const versions: any[] = await vRes.json();
          const file = versions[0]?.files.find((f: any) => f.primary) ?? versions[0]?.files[0];
          if (!file) throw new Error('No download found');
          const res = await (window as any).mc.installShaderpack({ url: file.url, filename: file.filename });
          if (!res.ok) throw new Error(res.error);
          currentFile = file.filename;
          statusEl.style.display = '';
          setTone(statusEl, 'accent');
          statusEl.innerHTML = `${icon('check')}Installed`;
          btn.textContent = 'Remove';
          btn.classList.remove('btn-soft');
        } catch (err: any) {
          btn.textContent = 'Failed';
          statusEl.style.display = '';
          setTone(statusEl, 'error');
          statusEl.textContent = err.message;
          setTimeout(() => { btn.textContent = 'Install'; statusEl.style.display = 'none'; }, 2500);
        }
      }
      await refreshShaderpackDropdown();
      btn.disabled = false;
    });
    listEl.appendChild(row);
  }
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
      statusEl.textContent = `Loading ${preset.name}…`; setTone(statusEl, 'pending');
      applyBtn.style.display = 'none';
      const b64 = await fetchSkinBase64(preset.user);
      if (b64) {
        await setPreviewSkin(b64, preset.name, preset.variant as 'classic' | 'slim');
        applyBtn.style.display = 'inline-block';
        statusEl.textContent = `${preset.name} ready — click Apply`; setTone(statusEl, 'muted');
      } else {
        statusEl.textContent = `Could not load ${preset.name} skin`; setTone(statusEl, 'error');
      }
    });
    wardrobeGrid.appendChild(card);
  });

  // Lookup by username
  const doLookup = async () => {
    const name = lookupInput.value.trim();
    if (!name) return;
    lookupBtn.disabled = true; lookupBtn.textContent = '…';
    statusEl.textContent = `Loading ${name}…`; setTone(statusEl, 'pending');
    applyBtn.style.display = 'none';
    wardrobeGrid.querySelectorAll('.wardrobe-card').forEach(c => c.classList.remove('selected'));
    const b64 = await fetchSkinBase64(name);
    lookupBtn.disabled = false; lookupBtn.textContent = 'Load';
    if (b64) {
      await setPreviewSkin(b64, name, 'classic');
      applyBtn.style.display = 'inline-block';
      statusEl.textContent = `${name}'s skin ready — click Apply`; setTone(statusEl, 'muted');
    } else {
      statusEl.textContent = `Player "${name}" not found`; setTone(statusEl, 'error');
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
      statusEl.textContent = 'Custom skin loaded — click Apply'; setTone(statusEl, 'muted');
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
    statusEl.textContent = 'Uploading…'; setTone(statusEl, 'pending');
    const res = await mc.uploadSkin({ base64: selectedBase64, variant: selectedVariant });
    applyBtn.disabled = false;
    if (res.ok) {
      statusEl.textContent = 'Skin applied. It shows in-game the next time you join a world.'; setTone(statusEl, 'accent');
    } else if (res.error?.includes('401') || res.error?.includes('Unauthorized') || res.error?.includes('Not authenticated')) {
      statusEl.textContent = 'Your Microsoft session expired. Sign in again from Accounts, then try once more.';
      setTone(statusEl, 'error');
    } else {
      statusEl.textContent = `Couldn't apply the skin: ${res.error}`; setTone(statusEl, 'error');
    }
  });
}

// ── Screenshots panel ─────────────────────────────────────────────────────────
function initScreenshots() {
  const listEl = document.getElementById('screenshots-list')!;
  document.getElementById('screenshots-open-folder')!.addEventListener('click', () => mc.showScreenshotsFolder());

  listEl.innerHTML = listMsg('Loading screenshots…');
  mc.listScreenshots().then((shots: { name: string; path: string; mtime: number; sizeKb: number }[]) => {
    listEl.innerHTML = '';
    if (!shots.length) {
      listEl.innerHTML = listMsg('No screenshots yet. Press <kbd>F2</kbd> in-game to take one.');
      return;
    }
    for (const s of shots) {
      const row = document.createElement('div');
      row.className = 'item-row is-clickable';
      row.innerHTML = `
        ${icon('image')}
        <div class="item-row-text">
          <div class="item-row-name">${s.name}</div>
          <div class="item-row-meta">${new Date(s.mtime).toLocaleString()} · ${s.sizeKb} KB</div>
        </div>
        <button class="btn btn-sm">Open</button>`;
      row.querySelector('button')!.addEventListener('click', e => { e.stopPropagation(); mc.openScreenshot(s.path); });
      row.addEventListener('click', () => mc.openScreenshot(s.path));
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
    listEl.innerHTML = '<div class="empty">No offline profiles yet. Add a username above.</div>';
    return;
  }
  const offlineInput = document.getElementById('offline-username') as HTMLInputElement | null;
  for (const acc of accounts) {
    const row = document.createElement('div');
    row.className = 'item-row' + (offlineInput?.value === acc.name ? ' is-active' : '');
    const isActive = offlineInput?.value === acc.name;
    row.innerHTML = `
      <img class="item-row-avatar" src="https://mc-heads.net/avatar/${encodeURIComponent(acc.name)}/32" alt="" onerror="this.style.visibility='hidden'" />
      <div class="item-row-text">
        <div class="item-row-name">${acc.name}</div>
        <div class="item-row-meta">Added ${new Date(acc.added).toLocaleDateString()}</div>
      </div>
      ${isActive ? '<span class="pill">Active</span>' : '<button class="switch-btn btn btn-sm">Use</button>'}
      <button class="remove-btn btn btn-ghost btn-icon btn-sm" title="Remove" aria-label="Remove ${acc.name}">${icon('x')}</button>`;
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
        btn.textContent = 'Claimed today';
        btn.disabled = true;
      } else {
        btn.textContent = 'Claim daily +50';
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
      if (claimBtn) claimBtn.textContent = 'Claimed today';
      return;
    }
    await update(ref(rtdb, `voxel_tokens/${uid}`), { balance: increment(50), lastClaim: today });
    if (claimBtn) {
      claimBtn.textContent = '+50 tokens';
      setTimeout(() => { claimBtn.textContent = 'Claimed today'; }, 2500);
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
    // names come from other players' data — always escape before inserting
    const friendName = escHtml(info.name || fuid);
    card.innerHTML = `
      <img class="friend-avatar" src="https://mc-heads.net/avatar/${encodeURIComponent(info.name || '')}/32" alt="" onerror="this.style.visibility='hidden'">
      <div class="friend-dot" id="fdot-${fuid}"></div>
      <div class="item-row-text">
        <div class="item-row-name">${friendName}</div>
        <div class="item-row-meta" id="fstatus-${fuid}">Offline</div>
      </div>
      <div class="row-control">
        <button id="fsrv-${fuid}" class="server-chip" style="display:none" title="Copy server address"></button>
        <button data-fuid="${fuid}" class="friend-remove-btn btn btn-sm btn-ghost">Remove</button>
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
          srvEl.style.display = 'inline-flex';
          srvEl.textContent   = addr;
          srvEl.onclick       = () => { (window as any).electron?.copyText(addr); srvEl.innerHTML = `${icon('check')}Copied`; setTimeout(() => { srvEl.textContent = addr; }, 1500); };
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
      <img class="friend-avatar" src="https://mc-heads.net/avatar/${encodeURIComponent(info.name || '')}/32" alt="" onerror="this.style.visibility='hidden'">
      <div class="item-row-text"><div class="item-row-name">${escHtml(info.name || fromUid)}</div><div class="item-row-meta">Wants to be friends</div></div>
      <button class="req-accept btn btn-sm btn-primary">Accept</button>
      <button class="req-decline btn btn-sm btn-ghost">Decline</button>`;
    card.querySelector('.req-accept')!.addEventListener('click', async () => {
      // Add to each other's list
      await set(ref(rtdb, `voxel_friends/${uid}/list/${fromUid}`), { name: info.name, addedAt: serverTimestamp() });
      await set(ref(rtdb, `voxel_friends/${fromUid}/list/${uid}`), { name: myDisplayName(), addedAt: serverTimestamp() });
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
  if (!uid) { setTone(statusEl, 'error'); statusEl.textContent = 'Sign in first'; return; }
  const name = targetName.trim().toLowerCase();
  if (!name) return;
  addBtn.disabled = true;
  setTone(statusEl, 'muted');
  statusEl.textContent = 'Searching…';
  const snap = await get(ref(rtdb, `voxel_user_index/${name}`));
  const target = snap.val();
  if (!target) {
    setTone(statusEl, 'error');
    statusEl.textContent = `"${targetName}" hasn't used Voxel Client yet`;
    addBtn.disabled = false;
    return;
  }
  const targetUid = target.uid;
  if (targetUid === uid) { setTone(statusEl, 'error'); statusEl.textContent = "That's you!"; addBtn.disabled = false; return; }
  // Check if already friends
  const alreadySnap = await get(ref(rtdb, `voxel_friends/${uid}/list/${targetUid}`));
  if (alreadySnap.exists()) { setTone(statusEl, 'pending'); statusEl.textContent = 'Already friends'; addBtn.disabled = false; return; }
  // Send request
  await set(ref(rtdb, `voxel_friends/${targetUid}/requests/incoming/${uid}`), { name: myDisplayName(), sentAt: serverTimestamp() });
  await set(ref(rtdb, `voxel_friends/${uid}/requests/outgoing/${targetUid}`), { name: target.name, sentAt: serverTimestamp() });
  setTone(statusEl, 'accent');
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

// ── Cosmetics page ────────────────────────────────────────────────────────────
// Capes are previewed on a walking 3D player (cape-viewer.ts). Clicking a card
// tries that cape on; its button, or the one on the preview, buys or equips
// it. An equipped cape is stored under the Minecraft UUID, which is what the
// in-game mod looks up for every player it renders.
let capeGridInitialized = false;
let capeViewer: CapeViewer | null = null;
let previewCapeId: string | null = null;

async function capeAction(cape: typeof CAPE_DEFS[number]) {
  const cosmeticsStatus = document.getElementById('cosmetics-status');
  const capeKey = mcUuid || myUid;
  if (!capeKey) {
    if (cosmeticsStatus) cosmeticsStatus.textContent = 'Sign in to your launcher account first';
    return;
  }
  if (!purchasedCapes.has(cape.id)) {
    // Buy — renderCapeGrid runs again from the token listener once it lands
    if (!myUid || tokenBalance < cape.cost) return;
    try {
      await update(ref(rtdb, `voxel_tokens/${myUid}`), { balance: increment(-cape.cost), [`purchased/${cape.id}`]: true });
    } catch { /* leave the button usable */ }
    return;
  }
  // Equip — store under MC UUID (Fabric mod) or Firebase UID (launcher only)
  try {
    await set(ref(rtdb, `voxel_capes/${capeKey}`), { cape_id: cape.id, enabled: true, username: myDisplayName() });
    equippedCapeId = cape.id;
    const equippedNameEl = document.getElementById('cosmetics-equipped-name');
    const removeBtn = document.getElementById('cosmetics-remove-btn');
    if (equippedNameEl) equippedNameEl.textContent = cape.name;
    if (removeBtn) removeBtn.style.display = 'inline-flex';
    if (cosmeticsStatus) cosmeticsStatus.textContent = mcUuid
      ? 'Cape saved — visible in-game after next launch'
      : 'Cape saved — sign in with Microsoft to see it in-game';
    renderCapeGrid();
  } catch { if (cosmeticsStatus) cosmeticsStatus.textContent = 'Failed to save — check connection'; }
}

// Puts a cape on the preview player and fills in its name, state and button.
function showCapePreview(id: string | null) {
  previewCapeId = id;
  capeViewer?.setCape(id);
  document.querySelectorAll<HTMLElement>('#cape-grid .cape-card').forEach(c => c.classList.toggle('previewing', c.dataset.cape === id));
  const def = CAPE_DEFS.find(c => c.id === id);
  const owned = !!def && purchasedCapes.has(def.id);
  const equipped = !!def && def.id === equippedCapeId;
  const nameEl = document.getElementById('cosmetics-preview-name');
  const stateEl = document.getElementById('cosmetics-preview-state');
  const actionEl = document.getElementById('cosmetics-preview-action') as HTMLButtonElement | null;
  if (nameEl) nameEl.textContent = def?.name ?? 'No cape';
  if (stateEl) stateEl.textContent = !def ? 'Pick a cape below to try it on'
    : equipped ? 'Equipped'
    : owned ? 'Yours — not equipped'
    : `${def.cost} tokens`;
  if (actionEl) {
    actionEl.hidden = !def || equipped;
    if (def && !equipped) {
      actionEl.textContent = owned ? 'Equip' : `Buy for ${def.cost} tokens`;
      actionEl.disabled = !owned && tokenBalance < def.cost;
      actionEl.onclick = async () => {
        actionEl.disabled = true;
        try { await capeAction(def); } finally { actionEl.disabled = false; }
      };
    }
  }
}

// Card swatches show each cape's outside; animated ones play while the page is open.
let swatchTimer: ReturnType<typeof setInterval> | null = null;
function startSwatchTicker() {
  if (swatchTimer) return;
  swatchTimer = setInterval(() => {
    if (cosmeticsPanelEl.style.display !== 'flex') return;
    document.querySelectorAll<HTMLCanvasElement>('#cape-grid canvas[data-animated]').forEach(c => {
      loadCape(c.dataset.cape!).then(s => { if (s) drawCapeFront(c.getContext('2d')!, s, frameAt(s, performance.now())); });
    });
  }, 100);
}

// Cape grid renderer (called by initCosmetics and after token updates)
function renderCapeGrid() {
  if (!capeGridInitialized) return;
  const grid = document.getElementById('cape-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const cape of CAPE_DEFS) {
    const owned    = purchasedCapes.has(cape.id);
    const equipped = cape.id === equippedCapeId;
    const card     = document.createElement('div');
    card.className = 'cape-card' + (equipped ? ' equipped' : '');
    card.dataset.cape = cape.id;
    card.title = `Try on ${cape.name}`;
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
      <canvas class="cape-swatch" width="120" height="96"></canvas>
      <div class="cape-label">
        <div class="cape-name">${cape.name}</div>
        ${!owned && cape.cost > 0 ? `<div class="cape-cost">${costLabel}</div>` : ''}
        ${actionBtn}
      </div>`;
    const canvas = card.querySelector('canvas')!;
    canvas.dataset.cape = cape.id;
    loadCape(cape.id).then(s => {
      if (!s) return;
      drawCapeFront(canvas.getContext('2d')!, s, frameAt(s, performance.now()));
      if (s.frames > 1) canvas.dataset.animated = '1';
    });
    card.addEventListener('click', () => showCapePreview(cape.id));
    const btn = card.querySelector('button');
    btn?.addEventListener('click', async e => {
      e.stopPropagation();
      showCapePreview(cape.id);
      btn.disabled = true;
      try { await capeAction(cape); } finally { if (btn.isConnected) btn.disabled = false; }
    });
    grid.appendChild(card);
  }
  startSwatchTicker();
  showCapePreview(previewCapeId);
}

async function initCosmetics() {
  const cosm         = (window as any).cosmetics;
  const equippedNameEl = document.getElementById('cosmetics-equipped-name')!;
  const cosmeticsStatus = document.getElementById('cosmetics-status')!;
  const removeBtn    = document.getElementById('cosmetics-remove-btn') as HTMLButtonElement;
  const viewerEl     = document.getElementById('cape-viewer')!;

  // three.js loads on first open; without WebGL the page still works.
  createCapeViewer(viewerEl)
    .then(v => { capeViewer = v; v.setCape(previewCapeId); })
    .catch(() => viewerEl.classList.add('unavailable'));

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
        removeBtn.style.display = 'inline-flex';
      }
    }
  }

  previewCapeId = equippedCapeId ?? CAPE_DEFS[0].id;
  capeGridInitialized = true;
  renderCapeGrid();

  removeBtn.addEventListener('click', async () => {
    const key = mcUuid || myUid;
    if (!key) return;
    await set(ref(rtdb, `voxel_capes/${key}/enabled`), false);
    equippedCapeId = null;
    equippedNameEl.textContent = 'None';
    removeBtn.style.display = 'none';
    cosmeticsStatus.textContent = 'Cape removed';
    renderCapeGrid();
  });
}

// ── Updates ──────────────────────────────────────────────────────────────────
// The main process checks at start-up and every 30 minutes and downloads new
// versions in the background. Here: a toast shows the download, then offers
// Restart now / Later. With Minecraft closed the launcher restarts by itself
// after a 10-second countdown; with it running, the update waits and installs
// when the launcher closes.
const updater = (window as any).updater;
if (updater) {
  const checkBtn       = document.getElementById('check-updates-btn') as HTMLButtonElement | null;
  const restartBtn     = document.getElementById('restart-update-btn') as HTMLButtonElement | null;
  const titlebarUpdate = document.getElementById('titlebar-update-btn') as HTMLButtonElement | null;
  const updateSub      = document.getElementById('update-settings-sub');
  const DEFAULT_SUB    = 'Checks for updates every 30 minutes and downloads them in the background';

  let toast: HTMLElement | null = null;
  let countdown: ReturnType<typeof setInterval> | null = null;
  let readyVersion = '';
  let manualCheck = false;

  const stopCountdown = () => { if (countdown) { clearInterval(countdown); countdown = null; } };
  function installNow() {
    if (running) { setStatus('Close Minecraft first — the update installs when the launcher restarts', 'yellow'); return; }
    stopCountdown();
    updater.install();
  }

  updater.onChecking(() => {
    if (checkBtn) { checkBtn.textContent = 'Checking…'; checkBtn.disabled = true; }
    if (updateSub) updateSub.textContent = 'Checking for updates…';
  });

  updater.onNotAvailable(() => {
    if (checkBtn) { checkBtn.textContent = 'Check for updates'; checkBtn.disabled = false; }
    if (updateSub) updateSub.textContent = `You're on the latest version (${__APP_VERSION__})`;
    if (manualCheck) showToast({ title: "You're up to date", text: `Voxel Client ${__APP_VERSION__} is the latest version.`, icon: 'check', tone: 'ok', timeout: 3500 });
    manualCheck = false;
  });

  updater.onAvailable((ver: string) => {
    if (checkBtn) { checkBtn.textContent = 'Downloading…'; checkBtn.disabled = true; }
    if (updateSub) updateSub.textContent = `Downloading version ${ver}…`;
    toast = showToast({
      id: 'update-toast',
      title: `Downloading Voxel Client ${ver}`,
      text: 'Keep playing — it installs on the next restart.<div class="toast-progress"><div class="toast-progress-bar"></div></div>',
      icon: 'download',
      tone: 'pending',
    });
  });

  updater.onProgress((pct: number) => {
    if (updateSub) updateSub.textContent = `Downloading update… ${pct}%`;
    const bar = toast?.querySelector<HTMLElement>('.toast-progress-bar');
    if (bar) bar.style.width = `${pct}%`;
  });

  updater.onDownloaded((ver: string) => {
    readyVersion = ver || readyVersion;
    const label = readyVersion ? `Voxel Client ${readyVersion}` : 'The update';
    if (checkBtn) { checkBtn.textContent = 'Check for updates'; checkBtn.disabled = false; }
    if (updateSub) updateSub.textContent = `${label} is ready — restart to install it`;
    if (restartBtn) { restartBtn.disabled = false; restartBtn.onclick = installNow; }
    if (titlebarUpdate) { titlebarUpdate.style.display = 'inline-flex'; titlebarUpdate.onclick = installNow; }

    toast = showToast({
      id: 'update-toast',
      title: `${label} is ready`,
      text: running ? 'It installs when you close the launcher.' : '<span class="toast-countdown"></span>',
      icon: 'download',
      tone: 'accent',
      actions: [
        { label: 'Later', onClick: stopCountdown },
        { label: 'Restart now', primary: true, onClick: installNow },
      ],
    });
    toast.querySelector('.toast-close')?.addEventListener('click', stopCountdown);
    if (running) return;
    const countdownEl = toast.querySelector('.toast-countdown')!;
    let secs = 10;
    const tick = () => { countdownEl.textContent = `Restarting to install in ${secs}s.`; };
    tick();
    stopCountdown();
    countdown = setInterval(() => {
      if (running) { stopCountdown(); countdownEl.textContent = 'It installs when you close the launcher.'; return; }
      if (--secs <= 0) { stopCountdown(); countdownEl.textContent = 'Restarting…'; updater.install(); return; }
      tick();
    }, 1000);
  });

  updater.onError?.((msg: string) => {
    if (checkBtn) { checkBtn.textContent = 'Try again'; checkBtn.disabled = false; }
    if (updateSub) updateSub.textContent = `Couldn't update: ${msg}`;
    // background checks fail quietly (offline etc.); say something only when asked or mid-download
    if (manualCheck || document.getElementById('update-toast')) {
      showToast({ id: 'update-toast', title: "Couldn't check for updates", text: 'Check your connection and try again from Settings.', icon: 'x', tone: 'error', timeout: 6000 });
    }
    manualCheck = false;
  });

  checkBtn?.addEventListener('click', () => { manualCheck = true; updater.check(); });
  if (updateSub) updateSub.textContent = DEFAULT_SUB;

  // First launch after an update: say which version this is, once.
  try {
    const last = localStorage.getItem('voxel_last_version');
    if (last && last !== __APP_VERSION__) {
      showToast({ title: `Updated to ${__APP_VERSION__}`, text: 'Voxel Client is on the latest version.', icon: 'check', tone: 'ok', timeout: 6000 });
    }
    localStorage.setItem('voxel_last_version', __APP_VERSION__);
  } catch { /* storage unavailable */ }
}

// ── Files panel ───────────────────────────────────────────────────────────────
function makeDropZone(zoneId: string, accept: string[], onDrop: (paths: string[]) => void) {
  const zone = document.getElementById(zoneId)!;
  const highlight = () => zone.classList.add('is-over');
  const unhighlight = () => zone.classList.remove('is-over');
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
    list.innerHTML = '<div class="empty" style="padding:4px 0">Nothing here yet. Drop a file above.</div>';
    return;
  }
  for (const name of items) {
    const row = document.createElement('div');
    row.className = 'item-row is-compact';
    row.innerHTML = `${icon('folder')}<span class="item-row-name">${name}</span>`;
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

function appendChatMessage(m: { user: string; text: string; ts: number; type?: string }, container: HTMLElement, myName: string, fireKey?: string) {
  const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (m.type === 'announcement') {
    const div = document.createElement('div');
    div.className = 'chat-announcement';
    if (fireKey) div.dataset.fireKey = fireKey;
    div.innerHTML =
      `<div class="chat-announcement-title">${icon('info')}Announcement</div>` +
      `<div class="chat-announcement-text">${escHtml(m.text)}</div>` +
      `<div class="chat-announcement-meta">${escHtml(m.user)} · ${time}</div>`;
    container.appendChild(div);
    return;
  }
  const isMe = m.user === myName;
  const isAdmin = adminList.has(m.user);
  const adminBadge = isAdmin ? ` <span class="chat-admin-badge">ADMIN</span>` : '';

  const row = document.createElement('div');
  if (fireKey) row.dataset.fireKey = fireKey;
  // My messages: bubble pushed to right. Others: avatar + bubble on left.
  row.className = 'chat-msg' + (isMe ? ' is-me' : '');

  const bubble = document.createElement('div');
  bubble.className = 'chat-msg-body';
  bubble.innerHTML =
    `<span class="chat-msg-meta">${isMe ? '' : escHtml(m.user) + adminBadge + ' · '}${time}</span>` +
    `<div class="chat-bubble">${escHtml(m.text)}</div>`;

  // Show a chat head for every message, including your own (previously only
  // other players' messages got an avatar).
  const avatarColor = usernameColor(m.user);
  const initial = (m.user[0] || '?').toUpperCase();
  const avatarWrap = document.createElement('div');
  avatarWrap.className = 'chat-msg-head';
  const img = document.createElement('img');
  img.src = `https://mc-heads.net/avatar/${encodeURIComponent(m.user)}/24`;
  img.alt = '';
  const fallback = document.createElement('span');
  fallback.className = 'chat-msg-avatar';
  fallback.hidden = true;
  fallback.style.background = avatarColor;
  fallback.textContent = initial;
  img.onerror = () => { img.hidden = true; fallback.hidden = false; };
  avatarWrap.appendChild(img);
  avatarWrap.appendChild(fallback);

  if (isMe) row.appendChild(bubble);
  row.appendChild(avatarWrap);
  if (!isMe) row.appendChild(bubble);
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
    `<span class="online-dot"></span>` +
    `<span class="chat-user-name is-self">${escHtml(myName)}${selfBadge}</span>`;
  container.appendChild(selfRow);

  Object.entries(val).forEach(([id, v]: [string, any]) => {
    if (id === myId) return;
    const isThisAdmin = adminList.has(v.name);
    const adminBadge = isThisAdmin ? ` <span class="chat-admin-badge">ADMIN</span>` : '';
    const timeoutBtn = (amIAdmin && !isThisAdmin) ? `<button class="chat-timeout-btn" title="Time out ${escHtml(v.name)}" aria-label="Time out ${escHtml(v.name)}">${icon('clock')}</button>` : '';
    const row = document.createElement('div');
    row.className = 'chat-user-row';
    row.innerHTML =
      `<span class="online-dot"></span>` +
      `<span class="chat-user-name">${escHtml(v.name)}${adminBadge}</span>` +
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
    showToast({
      id: 'mic-blocked-toast',
      title: 'Microphone blocked',
      text: `<code>${escHtml(String(reason))}</code> If you just allowed it in Windows Settings, restart the launcher for it to take effect.`,
      icon: 'mic',
      tone: 'error',
      actions: [
        { label: 'Restart launcher', onClick: () => (window as any).electron?.relaunch() },
        { label: 'Try again', primary: true, onClick: () => joinVoiceChannel() },
      ],
    });
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

  // Admin list subscription (voxel_admins is read-only — manage via Firebase console)
  onValue(ref(rtdb, 'voxel_admins'), adminSnap => {
    const adminVal = adminSnap.val() || {};
    adminList = new Set(Object.keys(adminVal));
    document.getElementById('chat-admin-bar')!.style.display = adminList.has(myName) ? 'flex' : 'none';
    renderChatUsers(lastOnlineVal, usersEl);
  });

  // ── Feedback system ────
  const feedbackViewBtn   = document.getElementById('chat-feedback-view-btn') as HTMLButtonElement;
  const feedbackPanel     = document.getElementById('admin-feedback-panel')!;
  const feedbackList      = document.getElementById('admin-feedback-list')!;
  const feedbackCloseBtn  = document.getElementById('admin-feedback-close') as HTMLButtonElement;
  const feedbackClearBtn  = document.getElementById('admin-feedback-clear-read') as HTMLButtonElement;
  const feedbackCountBadge= document.getElementById('feedback-count-badge')!;

  let feedbackOpen = false;
  feedbackViewBtn.addEventListener('click', () => {
    feedbackOpen = !feedbackOpen;
    feedbackPanel.style.display = feedbackOpen ? 'flex' : 'none';
  });
  feedbackCloseBtn.addEventListener('click', () => { feedbackOpen = false; feedbackPanel.style.display = 'none'; });
  feedbackClearBtn.addEventListener('click', async () => {
    const snap = await get(ref(rtdb, 'voxel_feedback')).catch(() => null);
    if (!snap?.exists()) return;
    const updates: Record<string, null> = {};
    Object.keys(snap.val()).forEach(k => { updates[`voxel_feedback/${k}`] = null; });
    await update(ref(rtdb, '/'), updates).catch(() => {});
  });

  // Subscribe to feedback (admin only — panel rendered when admin bar visible)
  onValue(ref(rtdb, 'voxel_feedback'), snap => {
    const val = snap.val() || {};
    const items = Object.entries(val).sort((a: any, b: any) => b[1].ts - a[1].ts);
    feedbackCountBadge.textContent = String(items.length);
    feedbackCountBadge.style.display = items.length > 0 ? 'inline' : 'none';
    feedbackList.innerHTML = '';
    if (items.length === 0) {
      feedbackList.innerHTML = listMsg('No feedback yet.');
      return;
    }
    items.forEach(([id, fb]: [string, any]) => {
      const d = document.createElement('div');
      d.className = 'feedback-item';
      const ago = Math.round((Date.now() - fb.ts) / 60000);
      const timeStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago/60)}h ago` : `${Math.round(ago/1440)}d ago`;
      d.innerHTML = `<div class="feedback-item-body"><span class="feedback-cat-chip">${escHtml(fb.category || 'other')}</span><span class="feedback-item-text">${escHtml(fb.text)}</span><div class="feedback-item-meta">${escHtml(fb.user)} · ${timeStr}</div></div><button class="feedback-item-del btn btn-ghost btn-icon btn-sm" title="Delete" aria-label="Delete feedback">${icon('trash')}</button>`;
      d.querySelector<HTMLButtonElement>('.feedback-item-del')!.addEventListener('click', () => {
        remove(ref(rtdb, `voxel_feedback/${id}`)).catch(() => {});
      });
      feedbackList.appendChild(d);
    });
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
    const entries = Object.entries(val) as [string, { user: string; text: string; ts: number; type?: string }][];
    entries.sort(([,a], [,b]) => a.ts - b.ts);
    const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop <= msgsEl.clientHeight + 60;
    msgsEl.innerHTML = '';
    if (entries.length === 0) {
      msgsEl.innerHTML = '<p class="list-msg" style="margin:auto">No messages yet. Say hi!</p>';
    } else {
      entries.forEach(([key, m]) => appendChatMessage(m, msgsEl, myName, key));
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
    appendChatMessage(m, msgsEl, myName, snap.key!);
    if (atBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
  });

  // Send message — rate-limited: 1s cooldown between messages + a rolling
  // per-minute word budget, both client-side, to keep chat from being flooded.
  const rateNotice = document.getElementById('chat-rate-notice')!;
  let rateNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  function showRateNotice(msg: string) {
    rateNotice.textContent = msg;
    rateNotice.style.display = 'block';
    if (rateNoticeTimer) clearTimeout(rateNoticeTimer);
    rateNoticeTimer = setTimeout(() => { rateNotice.style.display = 'none'; }, 2500);
  }

  const SEND_COOLDOWN_MS = 4000;
  const WORD_LIMIT_PER_MIN = 100;
  const CHAR_LIMIT = 200;
  let lastSendTs = 0;
  let recentSends: { ts: number; words: number }[] = [];

  const send = () => {
    const text = inputEl.value.trim();
    if (!text) return;
    if (text.length > CHAR_LIMIT) {
      showRateNotice(`Message too long — ${CHAR_LIMIT} characters max.`);
      return;
    }
    const to = chatTimeouts[myName];
    if (to && Date.now() < to.until) return;

    const now = Date.now();
    if (now - lastSendTs < SEND_COOLDOWN_MS) {
      const waitSec = Math.ceil((SEND_COOLDOWN_MS - (now - lastSendTs)) / 1000);
      showRateNotice(`Slow down — wait ${waitSec}s between messages.`);
      return;
    }
    recentSends = recentSends.filter(e => now - e.ts < 60000);
    const wordsInText = text.split(/\s+/).filter(Boolean).length;
    const wordsUsed = recentSends.reduce((sum, e) => sum + e.words, 0);
    if (wordsUsed + wordsInText > WORD_LIMIT_PER_MIN) {
      showRateNotice("You've hit the chat word limit for this minute — try again shortly.");
      return;
    }

    lastSendTs = now;
    recentSends.push({ ts: now, words: wordsInText });
    inputEl.value = '';
    push(ref(rtdb, 'voxel_chat/messages'), { user: getChatUsername(), text, ts: Date.now() }).catch(() => {});
    setTimeout(() => { msgsEl.scrollTop = msgsEl.scrollHeight; }, 80);
  };
  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  // Admin: clear all global chat messages — click-to-arm, click again to
  // confirm, instead of window.confirm() (unreliable in frameless windows).
  const clearChatBtn = document.getElementById('chat-clear-btn') as HTMLButtonElement;
  let clearChatArmed = false;
  let clearChatArmTimer: ReturnType<typeof setTimeout> | null = null;
  clearChatBtn.addEventListener('click', async () => {
    if (!clearChatArmed) {
      clearChatArmed = true;
      clearChatBtn.textContent = 'Click again to confirm';
      setTone(clearChatBtn, 'error');
      clearChatArmTimer = setTimeout(() => {
        clearChatArmed = false;
        clearChatBtn.textContent = 'Clear Chat';
        setTone(clearChatBtn, 'muted');
      }, 3000);
      return;
    }
    if (clearChatArmTimer) clearTimeout(clearChatArmTimer);
    clearChatArmed = false;
    clearChatBtn.disabled = true;
    clearChatBtn.textContent = 'Clearing…';
    try {
      await remove(ref(rtdb, 'voxel_chat/messages'));
    } catch (err: any) {
      showRateNotice(`Failed to clear chat: ${err.message}`);
    }
    clearChatBtn.disabled = false;
    clearChatBtn.textContent = 'Clear Chat';
    setTone(clearChatBtn, 'muted');
  });

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

  // Right-click context menu (admin: delete message)
  const ctxMenu   = document.getElementById('chat-ctx-menu')!;
  const ctxDelete = document.getElementById('chat-ctx-delete')!;
  let ctxKey: string | null = null;

  msgsEl.addEventListener('contextmenu', e => {
    if (!adminList.has(myName)) return;
    const target = (e.target as HTMLElement).closest('[data-fire-key]') as HTMLElement | null;
    if (!target) return;
    e.preventDefault();
    ctxKey = target.dataset.fireKey || null;
    ctxMenu.style.display = 'block';
    ctxMenu.style.left = e.clientX + 'px';
    ctxMenu.style.top  = e.clientY + 'px';
  });

  document.addEventListener('click', () => { ctxMenu.style.display = 'none'; ctxKey = null; }, true);

  ctxDelete.addEventListener('click', () => {
    if (ctxKey) remove(ref(rtdb, `voxel_chat/messages/${ctxKey}`)).catch(() => {});
    ctxKey = null;
    ctxMenu.style.display = 'none';
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

// ── Global Feedback modal ──────────────────────────────────────────────────────
(function initFeedback() {
  const modal       = document.getElementById('feedback-modal')!;
  const textEl      = document.getElementById('feedback-text') as HTMLTextAreaElement;
  const submitBtn   = document.getElementById('feedback-submit') as HTMLButtonElement;
  const cancelBtn   = document.getElementById('feedback-cancel') as HTMLButtonElement;
  const openBtn     = document.getElementById('feedback-btn') as HTMLButtonElement;
  let selectedCat   = 'feature';

  document.querySelectorAll<HTMLButtonElement>('.feedback-cat').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.cat === 'feature');
    btn.addEventListener('click', () => {
      selectedCat = btn.dataset.cat || 'feature';
      document.querySelectorAll<HTMLButtonElement>('.feedback-cat').forEach(b => b.classList.toggle('on', b === btn));
    });
  });

  openBtn.addEventListener('click', () => { textEl.value = ''; modal.style.display = 'flex'; textEl.focus(); });
  cancelBtn.addEventListener('click', () => { modal.style.display = 'none'; });
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

  submitBtn.addEventListener('click', async () => {
    const text = textEl.value.trim();
    if (!text) return;
    submitBtn.disabled = true; submitBtn.textContent = 'Sending…';
    const user = (document.getElementById('mc-ign') as HTMLElement | null)?.textContent?.trim() ||
                 (document.getElementById('offline-username') as HTMLInputElement | null)?.value?.trim() ||
                 localStorage.getItem('voxel_guest_name') || 'Anonymous';
    await push(ref(rtdb, 'voxel_feedback'), { user, text, category: selectedCat, ts: Date.now() }).catch(() => {});
    submitBtn.disabled = false; submitBtn.textContent = 'Send';
    modal.style.display = 'none';
    showToast({ title: 'Feedback sent', text: 'Thanks. It goes straight to the developer.', icon: 'check', tone: 'ok', timeout: 3000 });
  });
})();

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
  // Pickaxes
  {name:'Wooden Pickaxe',img:'Wooden_Pickaxe',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Stone Pickaxe',img:'Stone_Pickaxe',grid:[WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Gold Pickaxe',img:'Golden_Pickaxe',grid:[WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Iron Pickaxe',img:'Iron_Pickaxe',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Diamond Pickaxe',img:'Diamond_Pickaxe',grid:[WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Netherite Pickaxe',img:'Netherite_Pickaxe',grid:[null,null,null,null,null,null,WIKI('Diamond_Pickaxe'),WIKI('Netherite_Ingot'),null],cat:'tool',tags:'upgrade smithing'},
  // Axes
  {name:'Wooden Axe',img:'Wooden_Axe',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Stone Axe',img:'Stone_Axe',grid:[WIKI('Cobblestone'),WIKI('Cobblestone'),null,WIKI('Cobblestone'),WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Gold Axe',img:'Golden_Axe',grid:[WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot'),WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Iron Axe',img:'Iron_Axe',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Diamond Axe',img:'Diamond_Axe',grid:[WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Diamond'),WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Netherite Axe',img:'Netherite_Axe',grid:[null,null,null,null,null,null,WIKI('Diamond_Axe'),WIKI('Netherite_Ingot'),null],cat:'tool',tags:'upgrade smithing'},
  // Shovels
  {name:'Wooden Shovel',img:'Wooden_Shovel',grid:[null,WIKI('Oak_Planks'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Stone Shovel',img:'Stone_Shovel',grid:[null,WIKI('Cobblestone'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Gold Shovel',img:'Golden_Shovel',grid:[null,WIKI('Gold_Ingot'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Iron Shovel',img:'Iron_Shovel',grid:[null,WIKI('Iron_Ingot'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Diamond Shovel',img:'Diamond_Shovel',grid:[null,WIKI('Diamond'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Netherite Shovel',img:'Netherite_Shovel',grid:[null,null,null,null,null,null,WIKI('Diamond_Shovel'),WIKI('Netherite_Ingot'),null],cat:'tool',tags:'upgrade smithing'},
  // Hoes
  {name:'Wooden Hoe',img:'Wooden_Hoe',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Stone Hoe',img:'Stone_Hoe',grid:[WIKI('Cobblestone'),WIKI('Cobblestone'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Gold Hoe',img:'Golden_Hoe',grid:[WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Iron Hoe',img:'Iron_Hoe',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Diamond Hoe',img:'Diamond_Hoe',grid:[WIKI('Diamond'),WIKI('Diamond'),null,null,WIKI('Stick'),null,null,WIKI('Stick'),null],cat:'tool'},
  {name:'Netherite Hoe',img:'Netherite_Hoe',grid:[null,null,null,null,null,null,WIKI('Diamond_Hoe'),WIKI('Netherite_Ingot'),null],cat:'tool',tags:'upgrade smithing'},
  // Other tools
  {name:'Flint and Steel',img:'Flint_and_Steel',grid:[WIKI('Iron_Ingot'),null,null,null,WIKI('Flint'),null,null,null,null],cat:'tool'},
  {name:'Shears',img:'Shears',grid:[null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null,null,null,null,null],cat:'tool'},
  {name:'Fishing Rod',img:'Fishing_Rod',grid:[null,null,WIKI('Stick'),null,WIKI('Stick'),WIKI('String'),WIKI('Stick'),null,WIKI('String')],cat:'tool'},
  {name:'Compass',img:'Compass',grid:[null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Redstone_Dust'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null],cat:'tool'},
  {name:'Clock',img:'Clock',grid:[null,WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot'),WIKI('Redstone_Dust'),WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot'),null],cat:'tool'},
  {name:'Spyglass',img:'Spyglass',grid:[null,WIKI('Amethyst_Shard'),null,null,WIKI('Copper_Ingot'),null,null,WIKI('Copper_Ingot'),null],cat:'tool'},
  // Swords
  {name:'Wooden Sword',img:'Wooden_Sword',grid:[null,WIKI('Oak_Planks'),null,null,WIKI('Oak_Planks'),null,null,WIKI('Stick'),null],cat:'weapon'},
  {name:'Stone Sword',img:'Stone_Sword',grid:[null,WIKI('Cobblestone'),null,null,WIKI('Cobblestone'),null,null,WIKI('Stick'),null],cat:'weapon'},
  {name:'Gold Sword',img:'Golden_Sword',grid:[null,WIKI('Gold_Ingot'),null,null,WIKI('Gold_Ingot'),null,null,WIKI('Stick'),null],cat:'weapon'},
  {name:'Iron Sword',img:'Iron_Sword',grid:[null,WIKI('Iron_Ingot'),null,null,WIKI('Iron_Ingot'),null,null,WIKI('Stick'),null],cat:'weapon'},
  {name:'Diamond Sword',img:'Diamond_Sword',grid:[null,WIKI('Diamond'),null,null,WIKI('Diamond'),null,null,WIKI('Stick'),null],cat:'weapon'},
  {name:'Netherite Sword',img:'Netherite_Sword',grid:[null,null,null,null,null,null,WIKI('Diamond_Sword'),WIKI('Netherite_Ingot'),null],cat:'weapon',tags:'upgrade smithing'},
  {name:'Bow',img:'Bow',grid:[null,WIKI('Stick'),WIKI('String'),WIKI('Stick'),null,WIKI('String'),null,WIKI('Stick'),WIKI('String')],cat:'weapon'},
  {name:'Arrow',img:'Arrow',grid:[null,WIKI('Flint'),null,null,WIKI('Stick'),null,null,WIKI('Feather'),null],count:4,cat:'weapon'},
  {name:'Crossbow',img:'Crossbow',grid:[WIKI('Stick'),WIKI('Iron_Ingot'),WIKI('Stick'),null,WIKI('String'),null,WIKI('Stick'),WIKI('Tripwire_Hook'),WIKI('Stick')],cat:'weapon'},
  {name:'Shield',img:'Shield',grid:[WIKI('Oak_Planks'),WIKI('Iron_Ingot'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),null],cat:'weapon'},
  {name:'Mace',img:'Mace',grid:[null,WIKI('Heavy_Core'),null,null,WIKI('Breeze_Rod'),null,null,null,null],cat:'weapon',tags:'1.21 trial chambers'},
  {name:'Trident',img:'Trident',grid:[null,null,null,null,null,null,null,null,null],cat:'weapon',tags:'drowned drop cannot craft'},
  // Leather armor
  {name:'Leather Helmet',img:'Leather_Cap',grid:[WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),null,WIKI('Leather'),null,null,null],cat:'armor'},
  {name:'Leather Chestplate',img:'Leather_Tunic',grid:[WIKI('Leather'),null,WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather')],cat:'armor'},
  {name:'Leather Leggings',img:'Leather_Pants',grid:[WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),null,WIKI('Leather'),WIKI('Leather'),null,WIKI('Leather')],cat:'armor'},
  {name:'Leather Boots',img:'Leather_Boots',grid:[null,null,null,WIKI('Leather'),null,WIKI('Leather'),WIKI('Leather'),null,WIKI('Leather')],cat:'armor'},
  // Gold armor
  {name:'Gold Helmet',img:'Golden_Helmet',grid:[WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot'),null,null,null],cat:'armor'},
  {name:'Gold Chestplate',img:'Golden_Chestplate',grid:[WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot')],cat:'armor'},
  {name:'Gold Leggings',img:'Golden_Leggings',grid:[WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot')],cat:'armor'},
  {name:'Gold Boots',img:'Golden_Boots',grid:[null,null,null,WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot')],cat:'armor'},
  // Iron armor
  {name:'Iron Helmet',img:'Iron_Helmet',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null,null,null],cat:'armor'},
  {name:'Iron Chestplate',img:'Iron_Chestplate',grid:[WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot')],cat:'armor'},
  {name:'Iron Leggings',img:'Iron_Leggings',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot')],cat:'armor'},
  {name:'Iron Boots',img:'Iron_Boots',grid:[null,null,null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot')],cat:'armor'},
  // Diamond armor
  {name:'Diamond Helmet',img:'Diamond_Helmet',grid:[WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Diamond'),null,null,null],cat:'armor'},
  {name:'Diamond Chestplate',img:'Diamond_Chestplate',grid:[WIKI('Diamond'),null,WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond')],cat:'armor'},
  {name:'Diamond Leggings',img:'Diamond_Leggings',grid:[WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Diamond')],cat:'armor'},
  {name:'Diamond Boots',img:'Diamond_Boots',grid:[null,null,null,WIKI('Diamond'),null,WIKI('Diamond'),WIKI('Diamond'),null,WIKI('Diamond')],cat:'armor'},
  // Netherite armor upgrades
  {name:'Netherite Helmet',img:'Netherite_Helmet',grid:[null,null,null,null,null,null,WIKI('Diamond_Helmet'),WIKI('Netherite_Ingot'),null],cat:'armor',tags:'upgrade smithing'},
  {name:'Netherite Chestplate',img:'Netherite_Chestplate',grid:[null,null,null,null,null,null,WIKI('Diamond_Chestplate'),WIKI('Netherite_Ingot'),null],cat:'armor',tags:'upgrade smithing'},
  {name:'Netherite Leggings',img:'Netherite_Leggings',grid:[null,null,null,null,null,null,WIKI('Diamond_Leggings'),WIKI('Netherite_Ingot'),null],cat:'armor',tags:'upgrade smithing'},
  {name:'Netherite Boots',img:'Netherite_Boots',grid:[null,null,null,null,null,null,WIKI('Diamond_Boots'),WIKI('Netherite_Ingot'),null],cat:'armor',tags:'upgrade smithing'},
  // Special armor
  {name:'Turtle Shell',img:'Turtle_Shell',grid:[WIKI('Scute'),WIKI('Scute'),WIKI('Scute'),WIKI('Scute'),null,WIKI('Scute'),null,null,null],cat:'armor',tags:'water breathing helmet'},
  {name:'Wolf Armor',img:'Wolf_Armor',grid:[null,WIKI('Armadillo_Scute'),null,WIKI('Armadillo_Scute'),WIKI('Armadillo_Scute'),WIKI('Armadillo_Scute'),null,WIKI('Armadillo_Scute'),null],cat:'armor',tags:'1.21 wolf'},
  // Food
  {name:'Bread',img:'Bread',grid:[null,null,null,WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat'),null,null,null],cat:'food'},
  {name:'Cookie',img:'Cookie',grid:[null,null,null,WIKI('Wheat'),WIKI('Cocoa_Beans'),WIKI('Wheat'),null,null,null],count:8,cat:'food'},
  {name:'Cake',img:'Cake',grid:[WIKI('Milk_Bucket'),WIKI('Milk_Bucket'),WIKI('Milk_Bucket'),WIKI('Sugar'),WIKI('Egg'),WIKI('Sugar'),WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat')],cat:'food'},
  {name:'Golden Apple',img:'Golden_Apple',grid:[WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Apple'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot')],cat:'food'},
  {name:'Golden Carrot',img:'Golden_Carrot',grid:[WIKI('Gold_Nugget'),WIKI('Gold_Nugget'),WIKI('Gold_Nugget'),WIKI('Gold_Nugget'),WIKI('Carrot'),WIKI('Gold_Nugget'),WIKI('Gold_Nugget'),WIKI('Gold_Nugget'),WIKI('Gold_Nugget')],cat:'food'},
  {name:'Pumpkin Pie',img:'Pumpkin_Pie',grid:[null,null,null,WIKI('Pumpkin'),WIKI('Sugar'),WIKI('Egg'),null,null,null],cat:'food'},
  {name:'Mushroom Stew',img:'Mushroom_Stew',grid:[null,null,null,WIKI('Red_Mushroom'),WIKI('Brown_Mushroom'),null,null,WIKI('Bowl'),null],cat:'food'},
  {name:'Rabbit Stew',img:'Rabbit_Stew',grid:[null,WIKI('Cooked_Rabbit'),null,WIKI('Carrot'),WIKI('Bowl'),WIKI('Baked_Potato'),null,WIKI('Brown_Mushroom'),null],cat:'food'},
  {name:'Beetroot Soup',img:'Beetroot_Soup',grid:[WIKI('Beetroot'),WIKI('Beetroot'),WIKI('Beetroot'),WIKI('Beetroot'),WIKI('Beetroot'),WIKI('Beetroot'),null,WIKI('Bowl'),null],cat:'food'},
  {name:'Sugar',img:'Sugar',grid:[null,null,null,null,WIKI('Sugar_Cane'),null,null,null,null],cat:'food'},
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
  {name:'Anvil',img:'Anvil',grid:[WIKI('Block_of_Iron'),WIKI('Block_of_Iron'),WIKI('Block_of_Iron'),null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot')],cat:'build'},
  {name:'Beacon',img:'Beacon',grid:[WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Nether_Star'),WIKI('Glass'),WIKI('Obsidian'),WIKI('Obsidian'),WIKI('Obsidian')],cat:'build'},
  {name:'Bookshelf',img:'Bookshelf',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Book'),WIKI('Book'),WIKI('Book'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],cat:'build'},
  {name:'TNT',img:'TNT',grid:[WIKI('Gunpowder'),WIKI('Sand'),WIKI('Gunpowder'),WIKI('Sand'),WIKI('Gunpowder'),WIKI('Sand'),WIKI('Gunpowder'),WIKI('Sand'),WIKI('Gunpowder')],cat:'build'},
  {name:'Piston',img:'Piston',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Cobblestone'),WIKI('Iron_Ingot'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Redstone_Dust'),WIKI('Cobblestone')],cat:'build'},
  {name:'Sticky Piston',img:'Sticky_Piston',grid:[null,null,null,null,null,null,WIKI('Slimeball'),WIKI('Piston'),null],cat:'build'},
  {name:'Observer',img:'Observer',grid:[WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Redstone_Dust'),WIKI('Nether_Quartz'),WIKI('Redstone_Dust'),WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone')],cat:'build'},
  {name:'Brewing Stand',img:'Brewing_Stand',grid:[null,null,null,null,WIKI('Blaze_Rod'),null,WIKI('Cobblestone'),WIKI('Cobblestone'),WIKI('Cobblestone')],cat:'build'},
  {name:'Cauldron',img:'Cauldron',grid:[WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot')],cat:'build'},
  {name:'White Bed',img:'White_Bed',grid:[null,null,null,WIKI('White_Wool'),WIKI('White_Wool'),WIKI('White_Wool'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],cat:'build'},
  {name:'Campfire',img:'Campfire',grid:[null,WIKI('Stick'),null,WIKI('Stick'),WIKI('Coal'),WIKI('Stick'),WIKI('Oak_Log'),WIKI('Oak_Log'),WIKI('Oak_Log')],cat:'build'},
  {name:'Soul Campfire',img:'Soul_Campfire',grid:[null,WIKI('Stick'),null,WIKI('Stick'),WIKI('Soul_Sand'),WIKI('Stick'),WIKI('Oak_Log'),WIKI('Oak_Log'),WIKI('Oak_Log')],cat:'build'},
  {name:'Lantern',img:'Lantern',grid:[WIKI('Iron_Nugget'),WIKI('Iron_Nugget'),WIKI('Iron_Nugget'),WIKI('Iron_Nugget'),WIKI('Torch'),WIKI('Iron_Nugget'),WIKI('Iron_Nugget'),WIKI('Iron_Nugget'),WIKI('Iron_Nugget')],cat:'build'},
  {name:'Soul Lantern',img:'Soul_Lantern',grid:[WIKI('Iron_Nugget'),WIKI('Iron_Nugget'),WIKI('Iron_Nugget'),WIKI('Iron_Nugget'),WIKI('Soul_Torch'),WIKI('Iron_Nugget'),WIKI('Iron_Nugget'),WIKI('Iron_Nugget'),WIKI('Iron_Nugget')],cat:'build'},
  {name:'Composter',img:'Composter',grid:[WIKI('Oak_Slab'),null,WIKI('Oak_Slab'),WIKI('Oak_Slab'),null,WIKI('Oak_Slab'),WIKI('Oak_Slab'),WIKI('Oak_Slab'),WIKI('Oak_Slab')],cat:'build'},
  {name:'Grindstone',img:'Grindstone',grid:[WIKI('Stick'),WIKI('Stone_Slab'),WIKI('Stick'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),null,null,null],cat:'build'},
  {name:'Smithing Table',img:'Smithing_Table',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),null],cat:'build'},
  {name:'Cartography Table',img:'Cartography_Table',grid:[WIKI('Paper'),WIKI('Paper'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),null],cat:'build'},
  {name:'Loom',img:'Loom',grid:[WIKI('String'),WIKI('String'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,null,null,null],cat:'build'},
  {name:'Stonecutter',img:'Stonecutter',grid:[null,null,null,null,WIKI('Iron_Ingot'),null,WIKI('Stone'),WIKI('Stone'),WIKI('Stone')],cat:'build'},
  {name:'Lectern',img:'Lectern',grid:[WIKI('Oak_Slab'),WIKI('Oak_Slab'),WIKI('Oak_Slab'),null,WIKI('Bookshelf'),null,null,WIKI('Oak_Planks'),null],cat:'build'},
  {name:'Ender Chest',img:'Ender_Chest',grid:[WIKI('Obsidian'),WIKI('Obsidian'),WIKI('Obsidian'),WIKI('Obsidian'),WIKI('Eye_of_Ender'),WIKI('Obsidian'),WIKI('Obsidian'),WIKI('Obsidian'),WIKI('Obsidian')],cat:'build'},
  {name:'Shulker Box',img:'Shulker_Box',grid:[null,WIKI('Shulker_Shell'),null,null,WIKI('Chest'),null,null,WIKI('Shulker_Shell'),null],cat:'build'},
  {name:'Respawn Anchor',img:'Respawn_Anchor',grid:[WIKI('Crying_Obsidian'),WIKI('Crying_Obsidian'),WIKI('Crying_Obsidian'),WIKI('Glowstone'),WIKI('Glowstone'),WIKI('Glowstone'),WIKI('Crying_Obsidian'),WIKI('Crying_Obsidian'),WIKI('Crying_Obsidian')],cat:'build'},
  {name:'Lodestone',img:'Lodestone',grid:[WIKI('Chiseled_Stone_Bricks'),WIKI('Chiseled_Stone_Bricks'),WIKI('Chiseled_Stone_Bricks'),WIKI('Chiseled_Stone_Bricks'),WIKI('Netherite_Ingot'),WIKI('Chiseled_Stone_Bricks'),WIKI('Chiseled_Stone_Bricks'),WIKI('Chiseled_Stone_Bricks'),WIKI('Chiseled_Stone_Bricks')],cat:'build'},
  {name:'Scaffolding',img:'Scaffolding',grid:[WIKI('Bamboo'),WIKI('String'),WIKI('Bamboo'),WIKI('Bamboo'),null,WIKI('Bamboo'),WIKI('Bamboo'),null,WIKI('Bamboo')],count:6,cat:'build'},
  {name:'Oak Door',img:'Oak_Door',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),null],count:3,cat:'build'},
  {name:'Iron Door',img:'Iron_Door',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null],count:3,cat:'build'},
  {name:'Oak Trapdoor',img:'Oak_Trapdoor',grid:[null,null,null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],count:2,cat:'build'},
  {name:'Iron Trapdoor',img:'Iron_Trapdoor',grid:[null,null,null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null],cat:'build'},
  {name:'Oak Fence',img:'Oak_Fence',grid:[null,null,null,WIKI('Oak_Planks'),WIKI('Stick'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Stick'),WIKI('Oak_Planks')],count:3,cat:'build'},
  {name:'Nether Brick Fence',img:'Nether_Brick_Fence',grid:[null,null,null,WIKI('Nether_Bricks'),WIKI('Nether_Brick'),WIKI('Nether_Bricks'),WIKI('Nether_Bricks'),WIKI('Nether_Brick'),WIKI('Nether_Bricks')],count:6,cat:'build'},
  {name:'Oak Fence Gate',img:'Oak_Fence_Gate',grid:[null,null,null,WIKI('Stick'),WIKI('Oak_Planks'),WIKI('Stick'),WIKI('Stick'),WIKI('Oak_Planks'),WIKI('Stick')],cat:'build'},
  {name:'Glass Pane',img:'Glass_Pane',grid:[null,null,null,WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Glass')],count:16,cat:'build'},
  {name:'Iron Bars',img:'Iron_Bars',grid:[null,null,null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot')],count:16,cat:'build'},
  {name:'Oak Slab',img:'Oak_Slab',grid:[null,null,null,null,null,null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],count:6,cat:'build'},
  {name:'Oak Stairs',img:'Oak_Stairs',grid:[WIKI('Oak_Planks'),null,null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],count:4,cat:'build'},
  {name:'Stone Bricks',img:'Stone_Bricks',grid:[null,null,null,WIKI('Stone'),WIKI('Stone'),null,WIKI('Stone'),WIKI('Stone'),null],count:4,cat:'build'},
  {name:'Nether Bricks Block',img:'Nether_Bricks',grid:[null,null,null,WIKI('Nether_Brick'),WIKI('Nether_Brick'),null,WIKI('Nether_Brick'),WIKI('Nether_Brick'),null],cat:'build'},
  // Redstone
  {name:'Redstone Torch',img:'Redstone_Torch',grid:[null,WIKI('Redstone_Dust'),null,null,WIKI('Stick'),null,null,null,null],cat:'redstone'},
  {name:'Soul Torch',img:'Soul_Torch',grid:[null,WIKI('Coal'),null,null,WIKI('Stick'),null,null,WIKI('Soul_Sand'),null],count:4,cat:'redstone'},
  {name:'Lever',img:'Lever',grid:[null,WIKI('Stick'),null,null,WIKI('Cobblestone'),null,null,null,null],cat:'redstone'},
  {name:'Stone Button',img:'Stone_Button',grid:[null,null,null,null,WIKI('Stone'),null,null,null,null],cat:'redstone'},
  {name:'Oak Button',img:'Oak_Button',grid:[null,null,null,null,WIKI('Oak_Planks'),null,null,null,null],cat:'redstone'},
  {name:'Stone Pressure Plate',img:'Stone_Pressure_Plate',grid:[null,null,null,WIKI('Stone'),WIKI('Stone'),null,null,null,null],cat:'redstone'},
  {name:'Oak Pressure Plate',img:'Oak_Pressure_Plate',grid:[null,null,null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),null,null,null,null],cat:'redstone'},
  {name:'Redstone Repeater',img:'Redstone_Repeater',grid:[WIKI('Redstone_Torch'),WIKI('Redstone_Dust'),WIKI('Redstone_Torch'),WIKI('Stone'),WIKI('Stone'),WIKI('Stone'),null,null,null],cat:'redstone'},
  {name:'Redstone Comparator',img:'Redstone_Comparator',grid:[null,WIKI('Redstone_Torch'),null,WIKI('Redstone_Torch'),WIKI('Nether_Quartz'),WIKI('Redstone_Torch'),WIKI('Stone'),WIKI('Stone'),WIKI('Stone')],cat:'redstone'},
  {name:'Redstone Lamp',img:'Redstone_Lamp',grid:[null,WIKI('Redstone_Dust'),null,WIKI('Redstone_Dust'),WIKI('Glowstone'),WIKI('Redstone_Dust'),null,WIKI('Redstone_Dust'),null],cat:'redstone'},
  {name:'Daylight Detector',img:'Daylight_Detector',grid:[WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Nether_Quartz'),WIKI('Nether_Quartz'),WIKI('Nether_Quartz'),WIKI('Oak_Slab'),WIKI('Oak_Slab'),WIKI('Oak_Slab')],cat:'redstone'},
  {name:'Tripwire Hook',img:'Tripwire_Hook',grid:[null,WIKI('Iron_Ingot'),null,null,WIKI('Stick'),null,null,WIKI('Oak_Planks'),null],count:2,cat:'redstone'},
  {name:'Note Block',img:'Note_Block',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Redstone_Dust'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],cat:'redstone'},
  {name:'Jukebox',img:'Jukebox',grid:[WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Diamond'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],cat:'redstone'},
  {name:'Target Block',img:'Target',grid:[null,WIKI('Redstone_Dust'),null,WIKI('Redstone_Dust'),WIKI('Hay_Bale'),WIKI('Redstone_Dust'),null,WIKI('Redstone_Dust'),null],cat:'redstone'},
  // Transportation
  {name:'Rail',img:'Rail',grid:[WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Stick'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot')],count:16,cat:'misc'},
  {name:'Powered Rail',img:'Powered_Rail',grid:[WIKI('Gold_Ingot'),null,WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Stick'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Redstone_Dust'),WIKI('Gold_Ingot')],count:6,cat:'misc'},
  {name:'Detector Rail',img:'Detector_Rail',grid:[WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Stone_Pressure_Plate'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Redstone_Dust'),WIKI('Iron_Ingot')],count:6,cat:'misc'},
  {name:'Activator Rail',img:'Activator_Rail',grid:[WIKI('Iron_Ingot'),WIKI('Stick'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Redstone_Torch'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Stick'),WIKI('Iron_Ingot')],count:6,cat:'misc'},
  {name:'Minecart',img:'Minecart',grid:[null,null,null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot')],cat:'misc'},
  {name:'Chest Minecart',img:'Chest_Minecart',grid:[null,null,null,null,WIKI('Chest'),null,null,WIKI('Minecart'),null],cat:'misc'},
  {name:'Hopper Minecart',img:'Hopper_Minecart',grid:[null,null,null,null,WIKI('Hopper'),null,null,WIKI('Minecart'),null],cat:'misc'},
  {name:'TNT Minecart',img:'TNT_Minecart',grid:[null,null,null,null,WIKI('TNT'),null,null,WIKI('Minecart'),null],cat:'misc'},
  {name:'Oak Boat',img:'Oak_Boat',grid:[null,null,null,WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks'),WIKI('Oak_Planks')],cat:'misc'},
  // Misc/Utility
  {name:'Torch',img:'Torch',grid:[null,WIKI('Coal'),null,null,WIKI('Stick'),null,null,null,null],count:4,cat:'misc'},
  {name:'Ladder',img:'Ladder',grid:[WIKI('Stick'),null,WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),null,WIKI('Stick')],count:3,cat:'misc'},
  {name:'Paper',img:'Paper',grid:[null,null,null,WIKI('Sugar_Cane'),WIKI('Sugar_Cane'),WIKI('Sugar_Cane'),null,null,null],count:3,cat:'misc'},
  {name:'Bowl',img:'Bowl',grid:[WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),null,WIKI('Oak_Planks'),null,null,null,null],count:4,cat:'misc'},
  {name:'Book',img:'Book',grid:[null,null,null,WIKI('Paper'),WIKI('Paper'),WIKI('Paper'),WIKI('Leather'),null,null],cat:'misc'},
  {name:'Book and Quill',img:'Book_and_Quill',grid:[null,null,null,WIKI('Book'),WIKI('Feather'),WIKI('Ink_Sac'),null,null,null],cat:'misc'},
  {name:'Map',img:'Map',grid:[WIKI('Paper'),WIKI('Paper'),WIKI('Paper'),WIKI('Paper'),WIKI('Compass'),WIKI('Paper'),WIKI('Paper'),WIKI('Paper'),WIKI('Paper')],cat:'misc'},
  {name:'Bucket',img:'Bucket',grid:[null,null,null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null,WIKI('Iron_Ingot'),null],cat:'misc'},
  {name:'Item Frame',img:'Item_Frame',grid:[WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),WIKI('Leather'),WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),WIKI('Stick')],cat:'misc'},
  {name:'Glow Item Frame',img:'Glow_Item_Frame',grid:[null,null,null,null,WIKI('Item_Frame'),WIKI('Glow_Ink_Sac'),null,null,null],cat:'misc'},
  {name:'Painting',img:'Painting',grid:[WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),WIKI('White_Wool'),WIKI('Stick'),WIKI('Stick'),WIKI('Stick'),WIKI('Stick')],cat:'misc'},
  {name:'Flower Pot',img:'Flower_Pot',grid:[null,null,null,WIKI('Brick'),null,WIKI('Brick'),null,WIKI('Brick'),null],cat:'misc'},
  {name:'Lead',img:'Lead',grid:[WIKI('String'),WIKI('String'),null,WIKI('String'),WIKI('Slimeball'),null,null,null,WIKI('String')],count:2,cat:'misc'},
  {name:'Eye of Ender',img:'Eye_of_Ender',grid:[null,null,null,null,WIKI('Ender_Pearl'),WIKI('Blaze_Powder'),null,null,null],cat:'misc'},
  {name:'End Crystal',img:'End_Crystal',grid:[WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Glass'),WIKI('Eye_of_Ender'),WIKI('Glass'),WIKI('Glass'),WIKI('Ghast_Tear'),WIKI('Glass')],cat:'misc'},
  {name:'Bundle',img:'Bundle',grid:[WIKI('String'),null,WIKI('String'),WIKI('Leather'),null,WIKI('Leather'),WIKI('Leather'),WIKI('Leather'),WIKI('Leather')],cat:'misc',tags:'1.21'},
  {name:'Netherite Ingot',img:'Netherite_Ingot',grid:[WIKI('Netherite_Scrap'),WIKI('Netherite_Scrap'),WIKI('Gold_Ingot'),WIKI('Netherite_Scrap'),WIKI('Netherite_Scrap'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),null],cat:'misc',tags:'shapeless ancient debris'},
  // Blocks
  {name:'Iron Block',img:'Iron_Block',grid:[WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot'),WIKI('Iron_Ingot')],cat:'misc'},
  {name:'Gold Block',img:'Gold_Block',grid:[WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot'),WIKI('Gold_Ingot')],cat:'misc'},
  {name:'Diamond Block',img:'Diamond_Block',grid:[WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond'),WIKI('Diamond')],cat:'misc'},
  {name:'Emerald Block',img:'Emerald_Block',grid:[WIKI('Emerald'),WIKI('Emerald'),WIKI('Emerald'),WIKI('Emerald'),WIKI('Emerald'),WIKI('Emerald'),WIKI('Emerald'),WIKI('Emerald'),WIKI('Emerald')],cat:'misc'},
  {name:'Netherite Block',img:'Netherite_Block',grid:[WIKI('Netherite_Ingot'),WIKI('Netherite_Ingot'),WIKI('Netherite_Ingot'),WIKI('Netherite_Ingot'),WIKI('Netherite_Ingot'),WIKI('Netherite_Ingot'),WIKI('Netherite_Ingot'),WIKI('Netherite_Ingot'),WIKI('Netherite_Ingot')],cat:'misc'},
  {name:'Redstone Block',img:'Block_of_Redstone',grid:[WIKI('Redstone_Dust'),WIKI('Redstone_Dust'),WIKI('Redstone_Dust'),WIKI('Redstone_Dust'),WIKI('Redstone_Dust'),WIKI('Redstone_Dust'),WIKI('Redstone_Dust'),WIKI('Redstone_Dust'),WIKI('Redstone_Dust')],cat:'misc'},
  {name:'Lapis Block',img:'Lapis_Lazuli_Block',grid:[WIKI('Lapis_Lazuli'),WIKI('Lapis_Lazuli'),WIKI('Lapis_Lazuli'),WIKI('Lapis_Lazuli'),WIKI('Lapis_Lazuli'),WIKI('Lapis_Lazuli'),WIKI('Lapis_Lazuli'),WIKI('Lapis_Lazuli'),WIKI('Lapis_Lazuli')],cat:'misc'},
  {name:'Coal Block',img:'Coal_Block',grid:[WIKI('Coal'),WIKI('Coal'),WIKI('Coal'),WIKI('Coal'),WIKI('Coal'),WIKI('Coal'),WIKI('Coal'),WIKI('Coal'),WIKI('Coal')],cat:'misc'},
  {name:'Glowstone',img:'Glowstone',grid:[null,null,null,WIKI('Glowstone_Dust'),WIKI('Glowstone_Dust'),null,WIKI('Glowstone_Dust'),WIKI('Glowstone_Dust'),null],cat:'misc'},
  {name:'Hay Bale',img:'Hay_Bale',grid:[WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat'),WIKI('Wheat')],cat:'misc'},
];

// ── Mob database ────
interface MCMob { name: string; img: string; hp: number; atk: number; armor: number; xp: number; spawn: string; drops: string[]; tips: string[]; type: string; }
const MOBS: MCMob[] = [
  // Hostile
  {name:'Zombie',img:MWIKI('Zombie.png'),hp:20,atk:3,armor:2,xp:5,spawn:'Overworld, light level 0',drops:['Rotten Flesh','Iron Ingot (rare)','Carrot/Potato (rare)'],tips:['Burns in sunlight','Breaks wooden doors on Hard difficulty','Smite enchantment deals bonus damage','Baby zombies are faster and do not burn'],type:'hostile'},
  {name:'Husk',img:MWIKI('Husk.png'),hp:20,atk:3,armor:2,xp:5,spawn:'Desert biome, light level 0',drops:['Rotten Flesh','Iron Ingot (rare)'],tips:['Does NOT burn in sunlight','Applies Hunger effect on hit','Converts to Zombie when submerged in water','Dangerous in deserts — always daytime threat'],type:'hostile'},
  {name:'Skeleton',img:MWIKI('Skeleton.png'),hp:20,atk:2,armor:0,xp:5,spawn:'Overworld, light level 0',drops:['Bone','Arrow','Bow (rare)'],tips:['Raise shield to block arrows','Burns in sunlight','Circle while approaching to dodge shots','Spiders can spawn as Skeleton Jockeys'],type:'hostile'},
  {name:'Stray',img:MWIKI('Stray.png'),hp:20,atk:2,armor:0,xp:5,spawn:'Frozen/Snowy biomes, light level 0',drops:['Bone','Arrow of Slowness','Tipped Arrow'],tips:['Arrows apply Slowness IV for 30s','Does NOT burn in sunlight','Spawns only in cold/snowy biomes','Looting III increases Tipped Arrow drops'],type:'hostile'},
  {name:'Bogged',img:MWIKI('Bogged.png'),hp:16,atk:2,armor:0,xp:5,spawn:'Swamp, Mangrove Swamp; Trial Spawner (1.21)',drops:['Bone','Poisonous Potato','Brown Mushroom','Red Mushroom'],tips:['Added in 1.21 — slower fire rate than Skeleton','Arrows apply Poison effect','Wears mushrooms on its head','Found in Trial Chambers via spawners'],type:'hostile'},
  {name:'Creeper',img:MWIKI('Creeper.png'),hp:20,atk:49,armor:0,xp:5,spawn:'Overworld, light level 0',drops:['Gunpowder','Music Disc (killed by Skeleton arrow)'],tips:['1.5s fuse — knockback resets it','Cats scare Creepers away','Charged Creepers (lightning) deal 2× explosion damage','Flint & Steel ignites on your terms'],type:'hostile'},
  {name:'Spider',img:MWIKI('Spider.png'),hp:16,atk:2,armor:0,xp:5,spawn:'Overworld (neutral in daylight)',drops:['String','Spider Eye'],tips:['Neutral during daytime unless attacked','Climbs walls — keep ceilings closed','Status effect on Hard (Poison, Regen, Speed, Invis)','2-wide gap needed to stop them'],type:'neutral'},
  {name:'Cave Spider',img:MWIKI('Cave_Spider.png'),hp:12,atk:2,armor:0,xp:5,spawn:'Abandoned Mineshafts (spawner)',drops:['String','Spider Eye'],tips:['Poisons on Normal and Hard mode','Fits through 1×½ block gaps','Only found in mineshaft spawners','Destroy spawner with pickaxe to stop them'],type:'hostile'},
  {name:'Enderman',img:MWIKI('Enderman.png'),hp:40,atk:7,armor:0,xp:5,spawn:'All dimensions, light level 0',drops:['Ender Pearl (0–1)'],tips:['Do not look at their face — neutral otherwise','Water and rain deal continuous damage','Pumpkin helmet stops all aggro','Teleports away from projectiles and water'],type:'neutral'},
  {name:'Endermite',img:MWIKI('Endermite.png'),hp:8,atk:2,armor:0,xp:3,spawn:'Ender Pearl throw (5% chance)',drops:['—'],tips:['Disappears in 2 minutes if not name-tagged','Endermen are hostile to all Endermites','Trap a named Endermite to lure Endermen into farms','Bane of Arthropods deals bonus damage'],type:'hostile'},
  {name:'Silverfish',img:MWIKI('Silverfish.png'),hp:8,atk:1,armor:0,xp:5,spawn:'Strongholds, Infested Blocks',drops:['—'],tips:['Hides inside Infested Stone — spawns when broken','Attacking calls nearby Silverfish','Bane of Arthropods enchantment kills them fast','Found in stronghold End Portal room'],type:'hostile'},
  {name:'Witch',img:MWIKI('Witch.png'),hp:26,atk:0,armor:0,xp:5,spawn:'Swamp Hut, anywhere at night',drops:['Potion','Sugar','Spider Eye','Glowstone Dust'],tips:['Throws Harming, Poison, and Slowness potions','Drinks Fire Resistance and Healing to survive','Use bow from outside her throw range','Lightning near Villager creates a Witch'],type:'hostile'},
  {name:'Phantom',img:MWIKI('Phantom.png'),hp:20,atk:6,armor:0,xp:5,spawn:'Overworld, after 3+ days without sleep',drops:['Phantom Membrane (0–1)'],tips:['Sleep in a bed to prevent spawning','Cats scare Phantoms away','Swoops in a dive-bomb attack pattern','Membranes repair Elytra with an Anvil'],type:'hostile'},
  {name:'Pillager',img:MWIKI('Pillager.png'),hp:24,atk:4,armor:0,xp:5,spawn:'Pillager Outpost, Patrols, Raids',drops:['Arrow','Crossbow (rare)'],tips:['Killing a Captain gives Bad Omen effect','Bad Omen triggers Raid when entering a village','Shield blocks all crossbow bolts','Illager Banner from Captain'],type:'hostile'},
  {name:'Vindicator',img:MWIKI('Vindicator.png'),hp:24,atk:13,armor:0,xp:5,spawn:'Woodland Mansion, Raids',drops:['Iron Axe (rare)','Emerald (Raid)'],tips:['Highest single-hit melee damage of any Illager','Axes bypass shields for 5s on a direct hit','Named "Johnny" attacks ALL mobs including neutrals','Sprint away — they move slowly'],type:'hostile'},
  {name:'Evoker',img:MWIKI('Evoker.png'),hp:24,atk:6,armor:0,xp:10,spawn:'Woodland Mansion, Raids',drops:['Totem of Undying','Emerald (Raid)'],tips:['Summons Vexes and fang attacks from ground','Jump when fang rings appear on the ground','Totem of Undying auto-triggers death prevention','Highest priority kill in any Raid'],type:'hostile'},
  {name:'Vex',img:MWIKI('Vex.png'),hp:14,atk:5,armor:0,xp:3,spawn:'Summoned by Evoker',drops:['Iron Sword (rare)'],tips:['Phases through walls and solid blocks','Kill the Evoker first to stop more spawning','AOE/sweeping attacks hit all nearby','Cannot be stopped by shields'],type:'hostile'},
  {name:'Ravager',img:MWIKI('Ravager.png'),hp:100,atk:12,armor:0,xp:20,spawn:'Raids (Wave 3+)',drops:['Saddle'],tips:['Destroys crops and leaves on contact','Stunned briefly when shield-blocked','Can carry Pillager, Evoker, or Vindicator riders','High HP — prioritize in Raids'],type:'hostile'},
  {name:'Blaze',img:MWIKI('Blaze.png'),hp:20,atk:6,armor:2,xp:10,spawn:'Nether Fortress',drops:['Blaze Rod (0–2)'],tips:['Snowballs deal 3 damage each','Immune to fire and lava','Shoots 3 fireballs per burst','Blaze Rods needed to brew all potions'],type:'hostile'},
  {name:'Ghast',img:MWIKI('Ghast.png'),hp:10,atk:17,armor:0,xp:5,spawn:'Nether (open spaces)',drops:['Gunpowder','Ghast Tear'],tips:['Deflect fireball with any weapon hit or arrow','Only 10 HP — one deflected fireball kills it','Hitbox is 4×4 blocks — bigger than visible','Ghast Tears brew Potions of Regeneration'],type:'hostile'},
  {name:'Magma Cube',img:MWIKI('Magma_Cube.png'),hp:16,atk:6,armor:6,xp:4,spawn:'Nether, especially Basalt Deltas',drops:['Magma Cream (0–1)'],tips:['Splits into smaller cubes on death','Immune to fire and lava','Large cubes have 6 armor — use Smite','Magma Cream brews Fire Resistance potions'],type:'hostile'},
  {name:'Wither Skeleton',img:MWIKI('Wither_Skeleton.png'),hp:20,atk:5,armor:0,xp:5,spawn:'Nether Fortress',drops:['Coal','Bone','Wither Skull (2.5%)'],tips:['Applies Wither effect — like reverse regeneration','Milk instantly clears Wither effect','Need 3 skulls to summon the Wither boss','Looting III greatly improves skull drop rate'],type:'hostile'},
  {name:'Zombified Piglin',img:MWIKI('Zombified_Piglin.png'),hp:20,atk:5,armor:2,xp:5,spawn:'Nether (all biomes), Pig struck by lightning',drops:['Rotten Flesh','Gold Nugget','Gold Ingot (rare)'],tips:['Neutral unless attacked — all nearby aggro together','Aggro lasts 20–27s','Good XP and gold source with a good trap','Never attack in a group setting'],type:'neutral'},
  {name:'Piglin',img:MWIKI('Piglin.png'),hp:16,atk:5,armor:0,xp:5,spawn:'Nether: Crimson Forest, Bastion',drops:['Gold Ingot','Barter loot'],tips:['Wear at least 1 piece of gold armor to stay neutral','Throw Gold Ingots to barter for items','Converts to Zombified Piglin in Overworld in 15s','Never opens Ender Chests — they fear them'],type:'neutral'},
  {name:'Piglin Brute',img:MWIKI('Piglin_Brute.png'),hp:50,atk:7,armor:0,xp:20,spawn:'Bastion Remnants',drops:['Gold Axe (rare)'],tips:['Always hostile — gold armor does NOT help','Guards Bastion treasures aggressively','50 HP and 7 damage — very dangerous','Run or use a Nether Portal to escape'],type:'hostile'},
  {name:'Hoglin',img:MWIKI('Hoglin.png'),hp:40,atk:5,armor:0,xp:5,spawn:'Crimson Forest, Bastion',drops:['Porkchop (2–4)','Leather (0–1)'],tips:['Warped Fungi repels Hoglins','Breed with Crimson Fungi','Converts to Zoglin in Overworld or End','High knockback attack — stay on high ground'],type:'hostile'},
  {name:'Zoglin',img:MWIKI('Zoglin.png'),hp:40,atk:5,armor:0,xp:5,spawn:'Overworld/End (converted from Hoglin)',drops:['Rotten Flesh'],tips:['Always hostile — cannot be calmed','Attacks other mobs including Zombified Piglins','Result of bringing Hoglin out of Nether','No way to breed or tame'],type:'hostile'},
  {name:'Guardian',img:MWIKI('Guardian.png'),hp:30,atk:6,armor:0,xp:10,spawn:'Ocean Monument',drops:['Prismarine Shard','Prismarine Crystal','Raw Fish'],tips:['Laser builds damage over 2s — move to interrupt it','Spines retract while swimming — safe melee window','Mining Fatigue from Elder Guardian persists nearby','Axolotls attack Guardians — bring a bucket'],type:'hostile'},
  {name:'Elder Guardian',img:MWIKI('Elder_Guardian.png'),hp:80,atk:8,armor:8,xp:10,spawn:'Ocean Monument (only 3 per monument)',drops:['Wet Sponge','Prismarine Shard','Prismarine Crystal'],tips:['Inflicts Mining Fatigue III — drink Milk to remove','Only 3 per monument — defeat all to stop fatigue','Dry Wet Sponge in Furnace to get usable Sponge','8 armor points — use Smite or Power bow'],type:'boss'},
  {name:'Shulker',img:MWIKI('Shulker.png'),hp:30,atk:4,armor:0,xp:5,spawn:'End Cities',drops:['Shulker Shell (0–1)'],tips:['2 Shells + 1 Chest = Shulker Box (portable storage)','Homing projectile inflicts Levitation for 10s','Closes shell to deflect projectiles','Teleports when low HP to avoid death'],type:'hostile'},
  {name:'Warden',img:MWIKI('Warden.png'),hp:500,atk:30,armor:0,xp:5,spawn:'Deep Dark, summoned by Sculk Shrieker',drops:['Sculk Catalyst'],tips:['Detects vibration, smell, and direct touch — not sight','Sneak everywhere in the Deep Dark','3 Shrieker alerts = Warden spawns','Swift Sneak III leggings from Ancient City chests'],type:'hostile'},
  {name:'Slime',img:MWIKI('Slime.png'),hp:16,atk:3,armor:0,xp:4,spawn:'Slime Chunks (Y≤40), Swamp biome at night',drops:['Slimeball (from small slimes)'],tips:['Splits into smaller cubes on death','Only small slimes deal damage','Slime chunks fixed per seed — use chunk finder','Slimeballs needed for Sticky Pistons and Leads'],type:'hostile'},
  {name:'Breeze',img:MWIKI('Breeze.png'),hp:30,atk:1,armor:0,xp:10,spawn:'Trial Chambers via Trial Spawner (1.21)',drops:['Breeze Rod'],tips:['Added in 1.21 — shoots Wind Charges','Wind Charges knock back and activate redstone','Deflect Wind Charges back with a weapon attack','Breeze Rods craft the Mace weapon'],type:'hostile'},
  // Neutral
  {name:'Wolf',img:MWIKI('Wolf.png'),hp:8,atk:4,armor:0,xp:1,spawn:'Forest, Taiga, Snowy Taiga',drops:['—'],tips:['Tame with Bones — 33% chance per bone','Tamed Wolf has 20 HP and fights for you','Collar color changed with any dye','Wolf Armor (1.21) crafted from Armadillo Scutes'],type:'neutral'},
  {name:'Bee',img:MWIKI('Bee.png'),hp:10,atk:2,armor:0,xp:1,spawn:'Flower Forest, Meadow, near Bee Nests',drops:['—'],tips:['Sting applies Poison — bee dies after stinging','Use Smoke (Campfire under nest) before harvesting','Honey Bottles fill hunger and remove Poison','Breed with any flower to grow population'],type:'neutral'},
  {name:'Polar Bear',img:MWIKI('Polar_Bear.png'),hp:30,atk:5,armor:0,xp:1,spawn:'Frozen Ocean, Ice Plains, Snowy Tundra',drops:['Raw Cod','Raw Salmon'],tips:['Attacks if you approach bear cubs','Without cubs — fully passive','Keep 10+ blocks from cubs','High knockback on attack'],type:'neutral'},
  {name:'Llama',img:MWIKI('Llama.png'),hp:15,atk:1,armor:0,xp:1,spawn:'Savanna Plateau, Windswept Hills',drops:['Leather'],tips:['Up to 15 chest slots depending on Strength stat','Leads form a caravan of up to 10 Llamas','Trader Llamas travel with Wandering Trader','Spit damages players and mobs that attack them'],type:'neutral'},
  {name:'Panda',img:MWIKI('Panda.png'),hp:20,atk:2,armor:0,xp:1,spawn:'Jungle biome',drops:['Bamboo','Slimeball (sneeze)'],tips:['7 personality traits (lazy, playful, worried, aggressive, weak, brown, normal)','Breed with Bamboo — needs 8 bamboo within 5 blocks','Sneezing baby Pandas occasionally drop Slimeballs','Worried Pandas hide their faces during thunderstorms'],type:'neutral'},
  {name:'Dolphin',img:MWIKI('Dolphin.png'),hp:10,atk:2,armor:0,xp:0,spawn:'Non-frozen ocean biomes',drops:['Raw Cod'],tips:['Dolphin\'s Grace buff when swimming nearby','Leads to nearest Ocean Ruin or Shipwreck if fed fish','Needs both air and water — dies if only one','Cannot be tamed or bred'],type:'neutral'},
  {name:'Goat',img:MWIKI('Goat.png'),hp:10,atk:2,armor:0,xp:1,spawn:'Jagged Peaks, Frozen Peaks, Stony Peaks',drops:['Goat Horn (from ramming solid blocks)'],tips:['Rams players — sends them flying long distances','Screaming Goat (2% spawn) rams more frequently','Ram into an immovable block to drop Goat Horn','Milk with a Bucket for regular milk'],type:'neutral'},
  {name:'Strider',img:MWIKI('Strider.png'),hp:20,atk:0,armor:0,xp:1,spawn:'Nether, lava seas',drops:['String'],tips:['Only rideable lava-walking mob','Saddle + Warped Fungus on a Stick to ride and steer','Shivers and slows when not on lava — give a Saddle','Baby Striders can ride on adult Striders'],type:'neutral'},
  // Passive
  {name:'Pig',img:MWIKI('Pig.png'),hp:10,atk:0,armor:0,xp:1,spawn:'Overworld, grassy areas',drops:['Porkchop (1–3)'],tips:['Breed with Carrot, Beetroot, or Potato','Saddle + Carrot on a Stick to ride and steer','Lightning strike converts Pig into Zombified Piglin','Best early-game raw food drop'],type:'passive'},
  {name:'Cow',img:MWIKI('Cow.png'),hp:10,atk:0,armor:0,xp:1,spawn:'Overworld, grassy areas',drops:['Beef (1–3)','Leather (0–2)'],tips:['Right-click with Bucket to get Milk','Breed with Wheat','Milk clears all status effects instantly','Leather needed for books and early armor'],type:'passive'},
  {name:'Sheep',img:MWIKI('Sheep.png'),hp:8,atk:0,armor:0,xp:1,spawn:'Overworld, grassy areas',drops:['Mutton (1–2)','Wool'],tips:['Shear with Shears for 1–3 wool without killing','Breed with Wheat','Dye a sheep before shearing for colored wool','Wool regrows by eating grass'],type:'passive'},
  {name:'Chicken',img:MWIKI('Chicken.png'),hp:4,atk:0,armor:0,xp:1,spawn:'Overworld, grassy areas',drops:['Raw Chicken','Feather (0–2)','Egg (every 5–10 min)'],tips:['Throw Eggs to potentially spawn chicks (1/8)','Immune to fall damage — glides slowly','Breed with any Seeds','Easiest early auto-farm for Eggs'],type:'passive'},
  {name:'Rabbit',img:MWIKI('Rabbit.png'),hp:3,atk:0,armor:0,xp:1,spawn:'Desert, Snowy biomes, Meadow, Flower Forest',drops:['Raw Rabbit','Rabbit Hide (0–1)','Rabbit\'s Foot (10%)'],tips:['Rabbit\'s Foot brews Potion of Leaping','4 Rabbit Hides craft 1 Leather','Breed with Dandelion, Golden Carrot, or Carrots','The Killer Bunny variant is always hostile'],type:'passive'},
  {name:'Mooshroom',img:MWIKI('Red_Mooshroom.png'),hp:10,atk:0,armor:0,xp:1,spawn:'Mushroom Fields biome (rare)',drops:['Beef (1–3)','Leather','Mushroom (if sheared)'],tips:['Bowl + right-click gives infinite Mushroom Stew','Shear for 5 mushrooms — converts to normal Cow','Lightning creates rare Brown Mooshroom','Feed a flower then milk with Bowl for Suspicious Stew'],type:'passive'},
  {name:'Horse',img:MWIKI('Horse.png'),hp:15,atk:0,armor:0,xp:1,spawn:'Plains, Savanna',drops:['Leather (0–2)'],tips:['Tame by repeatedly riding until hearts appear','Horse Armor has no durability — lasts forever','Breed with Golden Apple or Golden Carrot','Speed, jump, and HP vary randomly per horse'],type:'passive'},
  {name:'Donkey',img:MWIKI('Donkey.png'),hp:15,atk:0,armor:0,xp:1,spawn:'Plains, Savanna',drops:['Leather'],tips:['Attach Chest for 15 inventory slots','Tame same as Horse','Horse + Donkey breeding = Mule','Cannot wear Horse Armor'],type:'passive'},
  {name:'Mule',img:MWIKI('Mule.png'),hp:15,atk:0,armor:0,xp:1,spawn:'Bred: Horse + Donkey only',drops:['Leather'],tips:['Carries Chest (15 slots) like Donkey','Cannot breed Mule + Mule','Slightly faster than Donkey on average','Best mount for transporting items'],type:'passive'},
  {name:'Cat',img:MWIKI('Cat.png'),hp:10,atk:3,armor:0,xp:1,spawn:'Villages, Swamp Huts (Black)',drops:['String (0–2)'],tips:['Scares Creepers and Phantoms within 16 blocks','Tame with Raw Cod or Raw Salmon','Sit/stand toggle with right-click','Tamed Cats bring gifts in the morning'],type:'passive'},
  {name:'Ocelot',img:MWIKI('Ocelot.png'),hp:10,atk:0,armor:0,xp:1,spawn:'Jungle biome',drops:['—'],tips:['Feed Raw Fish while sneaking to gain trust (not tame)','Trusted Ocelot scares Creepers and Phantoms','Cannot be fully tamed — stays wild','Sneak and stay still while feeding'],type:'passive'},
  {name:'Parrot',img:MWIKI('Parrot.png'),hp:6,atk:0,armor:0,xp:3,spawn:'Jungle biome',drops:['Feather (1–2)'],tips:['Tame with any Seeds (Wheat, Melon, Pumpkin, Beetroot)','Mimics nearby mob sounds as warning','Dances near a Jukebox playing a disc','Sits on shoulder — jump or take damage to remove'],type:'passive'},
  {name:'Fox',img:MWIKI('Fox.png'),hp:10,atk:2,armor:0,xp:1,spawn:'Taiga, Snowy Taiga, Grove',drops:['Item it is holding'],tips:['Breed two Foxes — baby trusts you automatically','Wild Foxes flee from players','Picks up and carries items in its mouth','Active at night — sleeps during day'],type:'passive'},
  {name:'Turtle',img:MWIKI('Turtle.png'),hp:30,atk:0,armor:0,xp:1,spawn:'Beach biome',drops:['Seagrass','Scute (when baby grows up)'],tips:['5 Scutes craft a Turtle Shell (Water Breathing helmet)','Protect nests — eggs break if walked on','Eggs hatch 3–5 days faster at night','Baby Turtles are extremely fast in water'],type:'passive'},
  {name:'Axolotl',img:MWIKI('Axolotl.png'),hp:14,atk:2,armor:0,xp:3,spawn:'Lush Caves (underground water)',drops:['—'],tips:['Attacks Drowned, Guardians, and fish mobs','Plays dead when hurt, then slowly regenerates','Carry in a Bucket — bring to Ocean Monument','Blue variant: 1-in-1200 chance, extremely rare'],type:'passive'},
  {name:'Squid',img:MWIKI('Squid.png'),hp:10,atk:0,armor:0,xp:1,spawn:'Oceans and rivers',drops:['Ink Sac (1–3)'],tips:['Ink Sacs dye items black','Squirts ink cloud when fleeing','Passive — always runs from players','Used in Book & Quill crafting'],type:'passive'},
  {name:'Glow Squid',img:MWIKI('Glow_Squid.png'),hp:10,atk:0,armor:0,xp:1,spawn:'Underground water, deep oceans (Y≤30)',drops:['Glow Ink Sac (1–3)'],tips:['Glow Ink Sacs make glowing text on Signs','Craft Glow Item Frame: Item Frame + Glow Ink Sac','Emits glow particles but gives no actual light','Found in underwater caves and ocean floors'],type:'passive'},
  {name:'Bat',img:MWIKI('Bat.png'),hp:6,atk:0,armor:0,xp:0,spawn:'Caves, Y≤63, low light',drops:['—'],tips:['Purely atmospheric — no drops or utility','Hangs upside down when at rest','Active during Halloween event (Oct 20–Nov 3)','Indicates nearby caves when heard'],type:'passive'},
  {name:'Allay',img:MWIKI('Allay.png'),hp:20,atk:0,armor:0,xp:3,spawn:'Pillager Outpost cages, Woodland Mansion',drops:['—'],tips:['Give it an item — it collects matching items nearby','Dances near Jukebox, duplicates near Note Block','Allay + Allay + Amethyst Shard = 2 Allays','Added in 1.19 The Wild Update'],type:'passive'},
  {name:'Frog',img:MWIKI('Frog.png'),hp:10,atk:0,armor:0,xp:1,spawn:'Swamp, Mangrove Swamp',drops:['—'],tips:['3 variants: Temperate (brown), Cold (green), Warm (white)','Eats small Slimes and small Magma Cubes → drops Froglight','Lays Frog Eggs in water — hatches into Tadpoles','Froglight type depends on frog variant'],type:'passive'},
  {name:'Tadpole',img:MWIKI('Tadpole.png'),hp:6,atk:0,armor:0,xp:1,spawn:'Hatches from Frog Eggs',drops:['—'],tips:['Grows into a Frog — variant depends on biome temperature','Carry in a Bucket to transport','Feed Slimeball to speed up growth','Very fragile — only 3 hearts'],type:'passive'},
  {name:'Camel',img:MWIKI('Camel.png'),hp:32,atk:0,armor:0,xp:1,spawn:'Desert Villages',drops:['—'],tips:['Two players can ride simultaneously (front + back)','Dash ability lets it leap over 1–2 block gaps','Sits down randomly — takes 5s to stand back up','Added in 1.20 Trails & Tales'],type:'passive'},
  {name:'Sniffer',img:MWIKI('Sniffer.png'),hp:14,atk:0,armor:0,xp:3,spawn:'Hatched from Sniffer Egg (Ocean Ruins)',drops:['—'],tips:['Digs up ancient Torchflower and Pitcher Plant seeds','Largest passive mob in the game','Eggs found in Warm Ocean Ruin suspicious sand','Added in 1.20 Trails & Tales'],type:'passive'},
  {name:'Armadillo',img:MWIKI('Armadillo.png'),hp:12,atk:0,armor:0,xp:1,spawn:'Savanna, Savanna Plateau, Badlands',drops:['Armadillo Scute'],tips:['Scutes craft Wolf Armor to protect tamed wolves','Rolls into a ball when scared by a sprint or undead','Breed with Spider Eyes','Added in 1.21 Tricky Trials'],type:'passive'},
  {name:'Snow Golem',img:MWIKI('Snow_Golem.png'),hp:4,atk:0,armor:0,xp:0,spawn:'Built by player: 2 Snow Blocks + Carved Pumpkin (top)',drops:['Snowball (0–15)'],tips:['Throws snowballs at hostile mobs (no damage, knockback)','Melts in hot biomes or rain — use Fire Resistance','Leaves snow trail in cold biomes (good for snow farms)','Shear the pumpkin off to reveal its face'],type:'passive'},
  {name:'Villager',img:MWIKI('Villager.png'),hp:20,atk:0,armor:0,xp:0,spawn:'Villages',drops:['—'],tips:['10 professions each linked to a job site block','Level up by trading to unlock better offers','Cure Zombie Villager for permanent trade discounts','Ring bell to summon all villagers indoors'],type:'passive'},
  {name:'Wandering Trader',img:MWIKI('Wandering_Trader.png'),hp:20,atk:0,armor:0,xp:0,spawn:'Random location every 2–3 in-game days',drops:['Leads (from Llamas)'],tips:['Sells rare plants, dyes, and exotic blocks','Trades do not reset — re-kill and wait for new trader','Arrives with 2 Trader Llamas','Despawns after 40 min if no trades made'],type:'passive'},
  // Bosses
  {name:'Ender Dragon',img:MWIKI('Ender_Dragon.png'),hp:200,atk:6,armor:0,xp:12000,spawn:'The End (auto-spawns)',drops:['Dragon Egg (first kill only)','Dragon\'s Breath','12,000 XP'],tips:['Destroy all End Crystals on obsidian pillars first','Cannot be damaged while a Crystal is healing it','Perched phase: attack the head for max damage','Dragon\'s Breath bottled for Lingering Potions'],type:'boss'},
  {name:'Wither',img:MWIKI('Wither.png'),hp:300,atk:8,armor:4,xp:50,spawn:'Built: T-shape of Soul Sand + 3 Wither Skulls on top',drops:['Nether Star'],tips:['Immune to fire, lava, and drowning','Summon underground or in the End to contain blast radius','At half HP shields against projectiles — use melee + Smite','Nether Star crafts the Beacon block'],type:'boss'},
  {name:'Iron Golem',img:MWIKI('Iron_Golem.png'),hp:100,atk:21,armor:0,xp:0,spawn:'Villages (automatic), player-built',drops:['Iron Ingot (3–5)','Poppy'],tips:['Build: T of 4 Iron Blocks + Carved Pumpkin on top','Protects all villagers from hostile mobs','Cracks at low HP — repair with Iron Ingots','Player-built Golems are always neutral to the player'],type:'neutral'},
];

// ── Tips database ────
interface MCTip { text: string; cat: string; }
const TIPS: MCTip[] = [
  // Mining
  {cat:'mine',text:'<strong>Best Y-level for Diamonds:</strong> Y = -58 (1.18+). Strip mine at this level for maximum diamond ore exposure.'},
  {cat:'mine',text:'<strong>Ancient Debris:</strong> Found at Y = 8–22 in the Nether (peak at Y=15). Use TNT or Beds to blast it out — Ancient Debris is explosion-immune but surrounding blocks are not.'},
  {cat:'mine',text:'<strong>Branch Mining:</strong> Dig a main tunnel, then branch off every 3 blocks to maximize ore coverage while minimizing blocks mined.'},
  {cat:'mine',text:'<strong>Fortune III vs Silk Touch:</strong> Fortune III on Diamond/Emerald/Gold ore gives up to 4× drops. Silk Touch mines the block itself for later use or moving.'},
  {cat:'mine',text:'<strong>Lava Lakes Underground:</strong> Common at Y = -55 in 1.18+. Always carry a Fire Resistance potion or Water Bucket when mining deep.'},
  {cat:'mine',text:'<strong>Emeralds:</strong> Spawn only in Mountain biomes (1.18+). Trade with Villagers for renewable Emeralds instead of mining.'},
  {cat:'mine',text:'<strong>Copper Ore:</strong> Most abundant at Y = 48. Fortune III increases Copper ingot yield from Raw Copper.'},
  {cat:'mine',text:'<strong>Deepslate Ores:</strong> Every ore type spawns in Deepslate form below Y = 0. Same drops but harder to break — use Efficiency V pickaxe.'},
  {cat:'mine',text:'<strong>Ore Distribution (1.21):</strong> Iron peaks at Y=16 and Y=232. Coal peaks at Y=96. Gold peaks at Y=-16. Lapis peaks at Y=0. Redstone peaks at Y=-58.'},
  {cat:'mine',text:'<strong>Nether Mining:</strong> Gold Ore spawns at all Y in the Nether. Nether Quartz and Nether Gold Ore are everywhere — use Fortune III picks.'},
  {cat:'mine',text:'<strong>TNT Mining:</strong> Place TNT every 4 blocks in a tunnel for fast strip mining. Fortune applies to blocks broken by the explosion.'},
  {cat:'mine',text:'<strong>Aqua Affinity:</strong> Helmet enchantment that removes the underwater mining penalty — full speed block breaking while submerged.'},
  {cat:'mine',text:'<strong>Haste Beacon:</strong> Set a Beacon to Haste II to mine Deepslate nearly as fast as Cobblestone. Essential for ancient debris hunts.'},
  {cat:'mine',text:'<strong>Magnetite Rule:</strong> Diamonds are often found next to lava (lava fills voids at Diamond level). Be careful but look near lava pools.'},
  {cat:'mine',text:'<strong>Beds in the Nether:</strong> Place a Bed and activate it in the Nether — it explodes with a larger blast than TNT. Perfect for Ancient Debris.'},
  // Combat
  {cat:'combat',text:'<strong>Critical Hits:</strong> Attack while falling from a jump apex to deal 150% damage. The star particles confirm a crit.'},
  {cat:'combat',text:'<strong>Shield Blocking:</strong> Right-click to raise your shield — blocks projectiles and 100% of melee. Axes bypass it for 5s on a direct hit.'},
  {cat:'combat',text:'<strong>Sweeping Edge III:</strong> Adds sweeping AOE damage to left-click attacks. Best enchant for clearing groups of mobs quickly.'},
  {cat:'combat',text:'<strong>Strength II + Sharpness V:</strong> This combo one-shots nearly every common mob. Brew Strength from Blaze Powder + Awkward Potion.'},
  {cat:'combat',text:'<strong>Water vs Endermen:</strong> Place Water source blocks to lock Endermen in place — they teleport away but keep returning into the water.'},
  {cat:'combat',text:'<strong>Looting III:</strong> Increases rare drops (Wither Skulls, Ender Pearls, Blaze Rods). Top-priority sword enchantment for grinding sessions.'},
  {cat:'combat',text:'<strong>Smite V:</strong> Deals +22.5 bonus damage to undead mobs (Zombies, Skeletons, Wither). Stacks with Strength and Crits.'},
  {cat:'combat',text:'<strong>Bane of Arthropods V:</strong> Same bonus as Smite but for Spiders, Silverfish, Endermites, Bees. Also applies Slowness IV.'},
  {cat:'combat',text:'<strong>Wither Boss:</strong> Summon underground in a long 3×1 tunnel. It cannot fit through 1-block gaps. Smite V + Strength II + a Beacon = very fast kill.'},
  {cat:'combat',text:'<strong>Ender Dragon:</strong> Destroy all End Crystals first, then attack the head while it is perched on the fountain for max damage.'},
  {cat:'combat',text:'<strong>Totem of Undying:</strong> Hold in off-hand — automatically triggers on death. Grants Absorption IV + Regeneration II for 45s. Always carry one.'},
  {cat:'combat',text:'<strong>Fire Aspect II:</strong> Sets mobs on fire, dealing bonus fire damage and automatically cooking meat drops. Pairs well with Looting III.'},
  {cat:'combat',text:'<strong>Knockback II:</strong> Pushes mobs far back — creates safe distance for sword users. Combine with a shield for maximum control.'},
  {cat:'combat',text:'<strong>Respiration III + Aqua Affinity:</strong> For Ocean Monument runs — extend water breathing to 4.5 min and mine at full speed underwater.'},
  {cat:'combat',text:'<strong>Power V Bow:</strong> Deals ~25 damage on a fully drawn shot (12.5 hearts). Add Punch II for knockback and Flame for fire damage.'},
  {cat:'combat',text:'<strong>Crossbow + Piercing IV:</strong> Arrow pierces through up to 5 mobs in a line. Multishot fires 3 arrows in a spread for crowd control.'},
  {cat:'combat',text:'<strong>Mace (1.21):</strong> New weapon crafted from Heavy Core + Breeze Rod. Deals massive bonus damage based on fall height — dive-bomb for 1-shots.'},
  // Farming
  {cat:'farm',text:'<strong>Crop Growth Light:</strong> Crops need light level ≥9. Torches directly above each crop row speeds growth in underground farms.'},
  {cat:'farm',text:'<strong>Hydrated Farmland:</strong> Farmland within 4 blocks (horizontal) of a Water source is hydrated — crops grow 25% faster on it.'},
  {cat:'farm',text:'<strong>Bone Meal:</strong> Instantly grows crops and many plants. Composters convert most plant items into Bone Meal after 7 uses.'},
  {cat:'farm',text:'<strong>Villager Curing:</strong> Cure a Zombie Villager (Weakness Splash Potion + Golden Apple) to get permanent 1-Emerald trade discounts at that villager.'},
  {cat:'farm',text:'<strong>Iron Golem Farm:</strong> 10 Villagers + beds + job sites + killing platform = 30+ Iron Ingots per hour on Java Edition.'},
  {cat:'farm',text:'<strong>Mob Farm Light Levels:</strong> Mobs only spawn on opaque blocks at light level 0 (1.18+). Build spawn platforms in the sky for high output.'},
  {cat:'farm',text:'<strong>Bamboo Fuel:</strong> Two Bamboo smelts 0.25 items each — but a Bamboo Block smelts 9 items. Compress bamboo for efficient furnace fuel.'},
  {cat:'farm',text:'<strong>Kelp XP Smelting:</strong> Smelt Kelp into Dried Kelp to dry 200 items per Kelp Block fuel. Cheap high-volume XP source.'},
  {cat:'farm',text:'<strong>Drowned Farm:</strong> Convert a river into a drowned farm by funneling water into a killing chamber — best source of Tridents and Copper.'},
  {cat:'farm',text:'<strong>Guardian Farm:</strong> Drain an Ocean Monument and build a Guardian spawner on the platform — one of the highest XP rates in the game.'},
  {cat:'farm',text:'<strong>Gold Farm (Nether):</strong> Build a 20×20 gold farm above a Nether roof at Y=256. Zombified Piglins spawn on transparent blocks and fall into lava.'},
  {cat:'farm',text:'<strong>Wither Skeleton Farm:</strong> Build a farm inside a Nether Fortress corridor — cats/dogs in boats scare Wither Skeletons into a kill zone.'},
  {cat:'farm',text:'<strong>Pumpkin/Melon Farm:</strong> Plant seeds on farmland with empty dirt or farmland on the sides — stems automatically grow fruit onto adjacent blocks.'},
  {cat:'farm',text:'<strong>Bee Farm:</strong> Move a Bee Nest with Silk Touch + Campfire underneath. Build a 9×9 flower field with beehives for automatic Honey and Honeycomb.'},
  {cat:'farm',text:'<strong>Chicken Egg Farm:</strong> Funnel eggs from chickens into a Dispenser loaded with eggs. Auto-spawns chicks that grow and are killed by lava for XP.'},
  {cat:'farm',text:'<strong>AFK Fish Farm:</strong> A fishing rod over a 1-block water source with a tripwire and note block auto-reels in treasure — books, enchanted rods, saddles.'},
  // Building
  {cat:'build',text:'<strong>Odd-Width Rule:</strong> Odd-width structures (7×7 > 6×6) have a natural center point — makes planning doors, windows, and towers easier.'},
  {cat:'build',text:'<strong>Add Depth to Walls:</strong> Vary wall depth with pillars, inset windows, and slabs/stairs. Flat single-block walls look unfinished.'},
  {cat:'build',text:'<strong>Roof Detailing:</strong> Add stair blocks along the ridge and corners of roofs. Mix slabs for thin sections and full blocks for peaks.'},
  {cat:'build',text:'<strong>Terraforming:</strong> Blend builds with the landscape — extend nearby hills, add rivers, and clear tree clusters to create clearings.'},
  {cat:'build',text:'<strong>Hidden Lighting:</strong> Place Glowstone or Sea Lanterns under Trapdoors, Carpet, or Slabs to light areas without visible light blocks.'},
  {cat:'build',text:'<strong>3-Block Palette Rule:</strong> Limit each build to 3–4 block types. Use one primary, one trim, and one accent (e.g. Oak Planks + Stone Brick + Dark Oak).'},
  {cat:'build',text:'<strong>Depth with Slabs:</strong> Half-slabs on the bottom half of a wall section create a recessed look. Combine with stairs for molding profiles.'},
  {cat:'build',text:'<strong>Glass Pane vs Block:</strong> Glass Panes connect to adjacent solid blocks, creating thin window frames. Glass Blocks are standalone and look cleaner for large windows.'},
  {cat:'build',text:'<strong>Interior Furniture:</strong> Crafting Tables serve as counters, Stairs as chairs, Item Frames as pictures, Barrels or Chests as dressers. Use banners for curtains.'},
  {cat:'build',text:'<strong>Megabase Planning:</strong> Mark corners with dirt or signs before committing to stone or expensive materials. Plan the footprint first.'},
  {cat:'build',text:'<strong>Diagonal Builds:</strong> Use the 1:1 diagonal step method for angled walls — 1 block forward, 1 block right, repeat for a smooth 45° line.'},
  {cat:'build',text:'<strong>Pillars and Columns:</strong> Place a pillar block, then attach stairs facing outward on two sides at the top and bottom for a classical column look.'},
  {cat:'build',text:'<strong>Hanging Chains:</strong> Chains added in 1.16 hang vertically or horizontally and look great as suspension bridges, lantern hangers, or dungeon decor.'},
  {cat:'build',text:'<strong>Copper Aging:</strong> Copper blocks oxidize to green over time (4 stages). Wax them with Honeycomb at any stage to permanently lock the color.'},
  {cat:'build',text:'<strong>Tuff Bricks (1.21):</strong> New stone family — Tuff Bricks, Tuff Brick Stairs, Slabs, Walls. Excellent for castle and medieval builds with a dark-stone look.'},
  // Survival
  {cat:'surv',text:'<strong>Day 1 Checklist:</strong> Get wood → stone tools → furnace → gather food → mine coal/iron → make shelter → sleep before first night.'},
  {cat:'surv',text:'<strong>Best Early Food:</strong> Cooked Porkchop or Steak restores 8 hunger + high saturation. Bread from Wheat is the easiest crop to mass-produce early.'},
  {cat:'surv',text:'<strong>Nether Portal (no mining):</strong> Lure water and lava into a mold shape — pour Lava first into 3×2 wells, then Water on top. Obsidian forms instantly.'},
  {cat:'surv',text:'<strong>Dragon Progression:</strong> Nether Fortress → Blaze Rods → Ender Pearls → Eyes of Ender → Stronghold → End Portal → Dragon.'},
  {cat:'surv',text:'<strong>Elytra:</strong> Found in End City Treasure Rooms after defeating the Dragon. Enchant with Unbreaking III and Mending. Fireworks Rockets power flight.'},
  {cat:'surv',text:'<strong>Beds in the End:</strong> Beds EXPLODE when activated outside the Overworld. Use them at range to destroy End Crystals on obsidian pillars.'},
  {cat:'surv',text:'<strong>Feather Falling IV:</strong> Single most important boot enchant — reduces fall damage by 48%. Combine with Depth Strider III for water mobility.'},
  {cat:'surv',text:'<strong>Coordinates Always On:</strong> Press F3 (Java) to show XYZ coordinates. Note your base coordinates on a Sign or book immediately.'},
  {cat:'surv',text:'<strong>Respawn Anchor:</strong> Craft from Crying Obsidian + Glowstone. Set your respawn point in the Nether — charge with Glowstone Blocks (up to 4 uses).'},
  {cat:'surv',text:'<strong>Golden Apple vs Enchanted Apple:</strong> Regular Golden Apple (Gold Ingots) gives Absorption I for 2 min — use to cure Zombie Villagers. Enchanted (Gold Blocks) gives Absorption IV + Regen II.'},
  {cat:'surv',text:'<strong>Ender Chest:</strong> Craft from 8 Obsidian + Eye of Ender. Contents are shared across ALL Ender Chests in the world — personal cross-world storage.'},
  {cat:'surv',text:'<strong>Nether Travel:</strong> 1 block traveled in the Nether = 8 blocks in the Overworld. Build Nether highways to connect distant bases or monuments.'},
  {cat:'surv',text:'<strong>Swift Sneak III:</strong> Legendary leggings enchant found only in Ancient City chests. Lets you sprint-speed sneak — essential for the Deep Dark.'},
  {cat:'surv',text:'<strong>Trident:</strong> Dropped by Drowned — rare (15% with Looting III). Enchant with Riptide III for launchers in rain or water, or Channeling for lightning strikes.'},
  {cat:'surv',text:'<strong>Lodestone:</strong> Crafted from Netherite Ingot + Chiseled Stone Bricks. Compasses point to a Lodestone anywhere — place one in your base.'},
  // Redstone
  {cat:'red',text:'<strong>Repeater Signal Lock:</strong> A Repeater powered from the side locks at its current output state — the foundation of RS NOR latches and memory cells.'},
  {cat:'red',text:'<strong>Comparator Container Level:</strong> Outputs 0–15 based on container fullness. Full = 15, empty = 0. Use to trigger doors when chests fill up.'},
  {cat:'red',text:'<strong>Observer Block:</strong> Fires a 1-tick pulse when the block it faces changes state (block placed, grown, door opened). Core of automatic crop farms.'},
  {cat:'red',text:'<strong>Slime/Honey Blocks:</strong> Slime Blocks stick to adjacent blocks and pull them when pushed by a Piston — the basis of all flying machine designs.'},
  {cat:'red',text:'<strong>BUD (Block Update Detector):</strong> An Observer facing an Observer creates a brief loop. Surround with Droppers/Pistons triggered by block updates.'},
  {cat:'red',text:'<strong>Item Sorter:</strong> Hoppers + locked Comparators + named items in Hoppers filter specific items into designated chests. One of the most useful builds.'},
  {cat:'red',text:'<strong>T Flip-Flop:</strong> Two Repeaters feeding back into each other creates a toggle — one button press ON, next press OFF. Used for all toggle doors.'},
  {cat:'red',text:'<strong>Hopper Clock:</strong> Two Hoppers facing each other with one item — the Comparator output toggles as the item transfers. Adjust speed with more items.'},
  {cat:'red',text:'<strong>Dropper vs Dispenser:</strong> Droppers move items one block or into containers. Dispensers activate items (shoot arrows, ignite TNT, fill buckets).'},
  {cat:'red',text:'<strong>Piston Door Timing:</strong> Sticky Pistons need a 1-tick delay (Repeater set to 1) to open cleanly. Without it, the piston grabs back the block it just pushed.'},
  {cat:'red',text:'<strong>Redstone Dust Strength:</strong> Signal weakens by 1 per block traveled. Use Repeaters every 15 blocks to boost signal back to full strength (15).'},
  {cat:'red',text:'<strong>Daylight Sensor:</strong> Outputs power during daytime (or nighttime with right-click toggle). Automate street lights, day-triggered doors, and crop irrigation.'},
  {cat:'red',text:'<strong>Sculk Sensor (1.17):</strong> Detects vibrations (footsteps, blocks breaking, projectiles) within 8 blocks. Pair with a Calibrated Sensor to filter specific event types.'},
  {cat:'red',text:'<strong>Target Block:</strong> Outputs a Redstone signal when hit by a projectile — signal strength = accuracy of the shot. Used in archery minigames and traps.'},
  {cat:'red',text:'<strong>Note Block Tuning:</strong> Right-click a Note Block up to 24 times to cycle through all 25 pitches. The block underneath changes the instrument sound.'},
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
  const sessionBar  = document.getElementById('ai-session-bar')!;
  const newSessBtn  = document.getElementById('ai-new-session') as HTMLButtonElement;
  const refreshBtn  = document.getElementById('ai-refresh-chat') as HTMLButtonElement;
  const webBadge    = document.getElementById('ai-search-web-badge')!;

  document.querySelectorAll<HTMLButtonElement>('.guide-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.guide-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.dataset.tab || 'recipes';
      searchEl.value = '';
      if (activeTab === 'chat') {
        searchBar.style.display = 'none';
        chatInputEl.style.display = 'flex';
        sessionBar.style.display = 'flex';
      } else {
        searchBar.style.display = 'block';
        chatInputEl.style.display = 'none';
        sessionBar.style.display = 'none';
      }
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
    const label = name || url.split('Invicon_')[1]?.replace('.png','').replace(/_/g,' ') || '';
    const short = label.split(' ').map((w: string) => w[0]).join('').slice(0,3).toUpperCase();
    const tip = label ? `<span class="rc-tip">${escHtml(label)}</span>` : '';
    return `<div class="recipe-cell">${tip}<img src="${url}" alt="${escHtml(label)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><span class="rc-fallback" title="${escHtml(label)}">${escHtml(short)}</span></div>`;
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
      return `<span class="ingredient"><img src="${url}" loading="lazy" alt="" onerror="this.style.display='none'">${escHtml(n!)}</span>`;
    }).join('');
    contentEl.innerHTML = `
      <button id="guide-back" class="guide-back-btn">${icon('left')}${t('crafting')}</button>
      <h2 class="recipe-title">${t('recipe_for')} ${escHtml(r.name)}</h2>
      <div class="recipe-layout">
        <figure class="recipe-part">
          <div class="recipe-grid">${cells}</div>
          <figcaption>${t('ingredients')}</figcaption>
        </figure>
        <span class="recipe-arrow">${icon('right')}</span>
        <figure class="recipe-part">
          <div class="recipe-cell recipe-result">${itemCell(WIKI(r.img), r.name)}${r.count && r.count > 1 ? `<span class="recipe-count">×${r.count}</span>` : ''}</div>
          <figcaption>${escHtml(r.name)}</figcaption>
        </figure>
      </div>
      <div class="section-title" style="margin-top:20px;">${t('ingredients')}</div>
      <div class="ingredients">${ingredients}</div>`;
    document.getElementById('guide-back')!.addEventListener('click', () => renderRecipes(searchEl.value.toLowerCase().trim()));
  }

  function renderRecipes(q: string) {
    const filtered = RECIPES.filter(r =>
      !q || r.name.toLowerCase().includes(q) || (r.tags || '').includes(q) || r.cat.includes(q)
    );
    if (!filtered.length) { contentEl.innerHTML = listMsg(`No recipes match "${escHtml(q)}".`); return; }
    const frag = document.createDocumentFragment();
    filtered.forEach(r => {
      const card = document.createElement('div');
      card.className = 'recipe-card';
      const initials = r.name.split(' ').map((w:string)=>w[0]).join('').slice(0,3).toUpperCase();
      card.innerHTML = `<div class="recipe-card-icon" data-initials="${initials}"><img src="${WIKI(r.img)}" loading="lazy" alt="" onerror="this.remove()"></div><div class="item-row-text"><div class="item-row-name">${escHtml(r.name)}</div><div class="item-row-meta">${r.cat}</div></div>${icon('right')}`;
      card.addEventListener('click', () => showRecipeDetail(r));
      frag.appendChild(card);
    });
    contentEl.innerHTML = '';
    contentEl.appendChild(frag);
  }

  // ── Mobs tab ────
  function statBar(val: number, max: number, color: string): string {
    const pct = Math.min(100, Math.round((val / max) * 100));
    return `<div class="stat-bar"><div class="stat-fill ${color}" style="width:${pct}%"></div></div>`;
  }

  function renderMobs(q: string) {
    const filtered = MOBS.filter(m => !q || m.name.toLowerCase().includes(q) || m.spawn.toLowerCase().includes(q) || m.type.includes(q));
    if (!filtered.length) { contentEl.innerHTML = listMsg('No mobs match that search.'); return; }
    const frag = document.createDocumentFragment();
    filtered.forEach(m => {
      const card = document.createElement('div');
      card.className = 'mob-card';
      card.innerHTML = `
        <img class="mob-img" src="${m.img}" loading="lazy" alt="" onerror="this.style.visibility='hidden'">
        <div class="mob-body">
          <div class="mob-head">
            <span class="mob-name">${escHtml(m.name)}</span>
            <span class="mob-type" data-type="${m.type}">${t('type_'+m.type.slice(0,4))}</span>
          </div>
          <div class="mob-stats">
            <div><span>${t('hp')} ${m.hp}</span>${statBar(m.hp, 500, 'hp')}</div>
            <div><span>${t('atk')} ${m.atk}</span>${statBar(m.atk, 40, 'atk')}</div>
            <div><span>${t('armor')} ${m.armor}</span>${statBar(m.armor, 20, 'armor')}</div>
            <div><span>${t('xp')} ${m.xp}</span>${statBar(m.xp, 50, 'xp')}</div>
          </div>
          <dl class="mob-facts">
            <dt>${t('spawn')}</dt><dd>${escHtml(m.spawn)}</dd>
            <dt>${t('drops')}</dt><dd>${m.drops.map(d => escHtml(d)).join(', ')}</dd>
          </dl>
          ${m.tips.length ? `<ul class="mob-tips">${m.tips.map(tip => `<li>${escHtml(tip)}</li>`).join('')}</ul>` : ''}
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
    catBar.className = 'cat-bar';
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
    if (!filtered.length) { contentEl.insertAdjacentHTML('beforeend', listMsg('No tips match that search.')); return; }
    const frag = document.createDocumentFragment();
    filtered.forEach(tip => {
      const card = document.createElement('div');
      card.className = 'tip-card';
      card.innerHTML = tip.text;
      frag.appendChild(card);
    });
    contentEl.appendChild(frag);
  }

  // ── AI Chat — multi-session ────
  interface AiSession { id: string; name: string; history: { role: string; content: string }[]; }
  const sessions: AiSession[] = [{ id: 's1', name: 'Chat 1', history: [] }];
  let activeSessId = 's1';
  let chatBusy = false;
  let sessCounter = 1;

  function currentSess(): AiSession { return sessions.find(s => s.id === activeSessId)!; }

  function renderSessionTabs() {
    // Remove all tab buttons (keep the + button)
    sessionBar.querySelectorAll('.ai-stab').forEach(el => el.remove());
    sessions.forEach(sess => {
      const tab = document.createElement('button');
      tab.className = 'ai-stab' + (sess.id === activeSessId ? ' active' : '');
      tab.innerHTML = `<span class="ai-stab-name">${sess.name}</span>` +
        (sessions.length > 1 ? `<span class="ai-stab-x" data-del="${sess.id}" title="Close chat">${icon('x')}</span>` : '');
      tab.addEventListener('click', e => {
        const del = (e.target as HTMLElement).closest<HTMLElement>('[data-del]')?.dataset.del;
        if (del) { deleteSession(del); return; }
        switchSession(sess.id);
      });
      sessionBar.insertBefore(tab, newSessBtn);
    });
  }

  function switchSession(id: string) {
    activeSessId = id;
    renderSessionTabs();
    contentEl.innerHTML = '';
    const sess = currentSess();
    if (sess.history.length === 0) {
      addBubble('Ask me anything about Minecraft — crafting, commands, biomes, mobs, strategies, or Voxel Client features!', false);
    } else {
      // Replay messages
      for (let i = 0; i < sess.history.length; i++) {
        addBubble(sess.history[i].content, sess.history[i].role === 'user');
      }
    }
  }

  function deleteSession(id: string) {
    const idx = sessions.findIndex(s => s.id === id);
    if (idx === -1) return;
    sessions.splice(idx, 1);
    if (sessions.length === 0) { sessCounter++; sessions.push({ id: `s${sessCounter}`, name: `Chat ${sessCounter}`, history: [] }); }
    if (activeSessId === id) activeSessId = sessions[Math.min(idx, sessions.length - 1)].id;
    switchSession(activeSessId);
  }

  newSessBtn.addEventListener('click', () => {
    sessCounter++;
    const id = `s${sessCounter}`;
    sessions.push({ id, name: `Chat ${sessCounter}`, history: [] });
    activeSessId = id;
    switchSession(id);
  });

  refreshBtn.addEventListener('click', () => {
    currentSess().history = [];
    contentEl.innerHTML = '';
    addBubble('Ask me anything about Minecraft — crafting, commands, biomes, mobs, strategies, or Voxel Client features!', false);
  });

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

  async function fetchWebContext(q: string): Promise<string> {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(url);
      const json = await res.json();
      const snippet = json.AbstractText || json.Answer || '';
      if (snippet && snippet.length > 20) {
        webBadge.classList.add('on');
        webBadge.style.display = 'flex';
        setTimeout(() => { webBadge.classList.remove('on'); webBadge.style.display = 'none'; }, 4000);
        return `[Web context: ${snippet}]\n\n`;
      }
    } catch { /* ignore */ }
    return '';
  }

  async function sendChat(q: string) {
    if (chatBusy || !q.trim()) return;
    chatBusy = true; aiSendBtn.disabled = true;
    addBubble(q, true);
    const sess = currentSess();
    sess.history.push({ role: 'user', content: q });
    if (sess.history.length > 30) sess.history.splice(0, 2);
    const typing = document.createElement('div');
    typing.className = 'ai-typing'; typing.textContent = '…';
    contentEl.appendChild(typing);
    contentEl.scrollTop = contentEl.scrollHeight;
    try {
      const res = await (window as any).ai.chat(sess.history);
      typing.remove();
      if (!res.ok) throw new Error(res.error);
      sess.history.push({ role: 'assistant', content: res.text });
      addBubble(res.text, false);
    } catch {
      typing.remove();
      addBubble('Sorry, something went wrong. Try again.', false);
    }
    chatBusy = false; aiSendBtn.disabled = false;
    aiInputEl.focus();
  }

  function renderChat() {
    if (sessions.length === 1 && sessions[0].history.length === 0) {
      contentEl.innerHTML = '';
      addBubble('Ask me anything about Minecraft — crafting, commands, biomes, mobs, strategies, or Voxel Client features!', false);
    }
    renderSessionTabs();
  }

  aiSendBtn.addEventListener('click', () => { const q = aiInputEl.value.trim(); if (q) { aiInputEl.value = ''; sendChat(q); } });
  aiInputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const q = aiInputEl.value.trim(); if (q) { aiInputEl.value = ''; sendChat(q); } } });

  updateTabLabels();
  renderRecipes('');
}




// ── Quick join ─────────────────────────────────────────────────────────────────
// A bar on the Play page: type any server address, or pick one of the servers
// running in Minecraft Server Control Center on this PC, and the game starts
// straight into it.
let pendingServer: string | null = null;

interface PanelServer {
  id: string; name: string; software: string; mcVersion: string; status: string;
  address: string; port: number; onlineMode: boolean; players: number; maxPlayers: number; java: boolean;
}
interface PanelServers { available: boolean; panelRunning: boolean; servers: PanelServer[] }

const qjAddress  = document.getElementById('qj-address') as HTMLInputElement;
const qjJoin     = document.getElementById('qj-join') as HTMLButtonElement;
const qjServers  = document.getElementById('qj-servers')!;
const qjDatalist = document.getElementById('qj-datalist')!;
const QJ_RECENT_KEY = 'voxel_recent_servers';
let panelServers: PanelServer[] = [];

function qjRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(QJ_RECENT_KEY) || '[]'); } catch { return []; }
}
function qjRemember(addr: string) {
  const list = [addr, ...qjRecent().filter((a) => a !== addr)].slice(0, 12);
  try { localStorage.setItem(QJ_RECENT_KEY, JSON.stringify(list)); } catch {}
  qjRenderDatalist();
}
function qjRenderDatalist() {
  qjDatalist.replaceChildren(...qjRecent().map((a) => Object.assign(document.createElement('option'), { value: a })));
}

/** "play.example.net" → "play.example.net:25565"; returns null if it isn't an address. */
function qjNormalize(raw: string): string | null {
  const s = raw.trim().replace(/^minecraft:\/\//i, '');
  const m = /^(\[[0-9a-f:]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(s);
  if (!m) return null;
  const port = m[2] ? parseInt(m[2], 10) : 25565;
  if (port < 1 || port > 65535) return null;
  return `${m[1]}:${port}`;
}

function qjSelectVersion(v: string) {
  if (!Array.from(mcVersion.options).some((o) => o.value === v)) mcVersion.add(new Option(v, v), 0);
  mcVersion.value = v;
  mcVersion.dispatchEvent(new Event('change'));
}

function qjJoinServer(address: string, s?: PanelServer) {
  if (running) { setStatus('Minecraft is already running — close it first', 'yellow'); return; }
  if (s) {
    if (s.onlineMode && offlineToggle.checked) {
      setStatus(`${s.name} only lets in Microsoft accounts — turn Offline Mode off, or turn off online-mode for it in Server Control Center`, 'red');
      return;
    }
    if (s.software === 'forge' || s.software === 'neoforge') addLog(`${s.name} runs ${s.software}: you need the same mods on this client to join.`, 'warn');
    qjSelectVersion(s.mcVersion);
  }
  pendingServer = address;
  qjRemember(address);
  mcPlayBtn.click();
}

function qjRenderServers(d: PanelServers) {
  panelServers = d.servers.filter((s) => s.java);
  if (!d.available) { qjServers.replaceChildren(); return; }
  const label = Object.assign(document.createElement('span'), { className: 'qj-label', textContent: 'Your servers' });
  if (!panelServers.length) {
    qjServers.replaceChildren(label, Object.assign(document.createElement('span'), { className: 'qj-hint', textContent: 'No Java servers in Server Control Center yet' }));
    return;
  }
  const chips = panelServers.map((s) => {
    const chip = document.createElement('div');
    chip.className = `qj-chip ${s.status === 'online' ? 'online' : s.status === 'starting' ? 'starting' : ''}`;
    const dot = Object.assign(document.createElement('span'), { className: 'qj-dot' });
    const name = Object.assign(document.createElement('span'), { textContent: s.name });
    const meta = Object.assign(document.createElement('span'), {
      className: 'qj-meta',
      textContent: s.status === 'online' ? `${s.mcVersion} · ${s.players}/${s.maxPlayers}` : `${s.mcVersion} · ${d.panelRunning ? s.status : 'panel closed'}`,
    });
    const btn = Object.assign(document.createElement('button'), { textContent: 'Join' });
    const addr = `${s.address}:${s.port}`;
    btn.disabled = s.status !== 'online';
    btn.title = s.status === 'online' ? `Start Minecraft ${s.mcVersion} and join ${addr}` : 'Start this server in Server Control Center first';
    btn.addEventListener('click', () => qjJoinServer(addr, s));
    chip.append(dot, name, meta, btn);
    chip.title = `${s.software} ${s.mcVersion} on ${addr}${s.onlineMode ? '' : ' (offline-mode: any username can join)'}`;
    return chip;
  });
  qjServers.replaceChildren(label, ...chips);
}

qjJoin.addEventListener('click', () => {
  const addr = qjNormalize(qjAddress.value);
  if (!addr) { setStatus('That is not a server address — try something like play.example.net or localhost:25566', 'red'); qjAddress.focus(); return; }
  const s = panelServers.find((p) => `${p.address}:${p.port}` === addr || (p.port === Number(addr.split(':').pop()) && /^(localhost|127\.0\.0\.1)$/.test(addr.split(':')[0])));
  qjJoinServer(addr, s);
});
qjAddress.addEventListener('keydown', (e) => { if (e.key === 'Enter') qjJoin.click(); });
qjRenderDatalist();

const msccBridge = (window as any).mscc;
if (msccBridge) {
  msccBridge.servers().then(qjRenderServers).catch(() => {});
  msccBridge.onServers(qjRenderServers);
}

// Server Control Center started the game (its Minecraft tab): show it as running here too.
mc?.onRemoteLaunch?.((i: { version: string; server?: string; username?: string }) => {
  running = true;
  mcPlayBtn.disabled = true;
  mcPlayBtn.classList.add('running');
  mcPlayLabel.textContent = 'Launching…';
  mcForceQuitBtn.style.display = 'inline-flex';
  setStatus(`Server Control Center is starting Minecraft ${i.version}${i.server ? ` on ${i.server}` : ''}${i.username ? ` as ${i.username}` : ''}…`, 'yellow');
});
