// Launcher logic — no Three.js, just UI wiring for Minecraft launch

const mc = (window as any).mc;

// ── Mod definitions ────────────────────────────────────────────────────────────
const MODS = [
  {
    id: 'sodium',
    name: 'Sodium',
    desc: 'Massive FPS boost — replaces the vanilla renderer. Most popular performance mod.',
    icon: '⚡',
    tags: [{ label: 'Performance', cls: 'perf' }],
    version: '0.5.11',
    defaultOn: true,
  },
  {
    id: 'iris',
    name: 'Iris Shaders',
    desc: 'Adds shader support compatible with Sodium. Run OptiFine shaders without OptiFine.',
    icon: '🌅',
    tags: [{ label: 'Visual', cls: 'visual' }, { label: 'Shaders', cls: 'visual' }],
    version: '1.7.5',
    defaultOn: false,
  },
  {
    id: 'lithium',
    name: 'Lithium',
    desc: 'Optimises game physics, mob AI, and block ticking. Works great alongside Sodium.',
    icon: '🪨',
    tags: [{ label: 'Performance', cls: 'perf' }],
    version: '0.12.7',
    defaultOn: true,
  },
  {
    id: 'fabric-api',
    name: 'Fabric API',
    desc: 'Required by most Fabric mods. Provides core hooks and utilities.',
    icon: '📦',
    tags: [{ label: 'Utility', cls: 'util' }],
    version: '0.97.8',
    defaultOn: true,
  },
  {
    id: 'ferritecore',
    name: 'FerriteCore',
    desc: 'Reduces memory usage significantly — useful if you have less than 8 GB RAM.',
    icon: '🧲',
    tags: [{ label: 'Performance', cls: 'perf' }],
    version: '6.0.3',
    defaultOn: false,
  },
  {
    id: 'modmenu',
    name: 'Mod Menu',
    desc: 'Adds a mods button to the in-game pause menu so you can see what\'s installed.',
    icon: '📋',
    tags: [{ label: 'Utility', cls: 'util' }],
    version: '11.0.3',
    defaultOn: true,
  },
  {
    id: 'entityculling',
    name: 'Entity Culling',
    desc: 'Skips rendering entities and block entities that are not visible to you.',
    icon: '👁',
    tags: [{ label: 'Performance', cls: 'perf' }],
    version: '1.7.2',
    defaultOn: true,
  },
  {
    id: 'betterf3',
    name: 'BetterF3',
    desc: 'Makes the F3 debug screen colourful, readable, and customisable.',
    icon: '🔢',
    tags: [{ label: 'Utility', cls: 'util' }],
    version: '7.0.2',
    defaultOn: false,
  },
  {
    id: 'replaymod',
    name: 'ReplayMod',
    desc: 'Record and replay your gameplay. Great for content creators.',
    icon: '🎬',
    tags: [{ label: 'Utility', cls: 'util' }],
    version: '2.6.15',
    defaultOn: false,
  },
  {
    id: 'minimap',
    name: 'Xaero\'s Minimap',
    desc: 'Adds a minimap to the corner of your screen with waypoints.',
    icon: '🗺️',
    tags: [{ label: 'Utility', cls: 'util' }],
    version: '24.5.0',
    defaultOn: false,
  },
] as const;

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

  mc.onLog((line: string) => {
    // Only show meaningful log lines
    if (line.includes('ERROR') || line.includes('WARN')) {
      addLog(line.trim(), line.includes('ERROR') ? 'error' : 'warn');
    } else if (
      line.includes('Logging in') || line.includes('Setting user') ||
      line.includes('Preparing level') || line.includes('Done') ||
      line.includes('Joining') || line.includes('LWJGL') ||
      line.includes('Minecraft') || line.includes('main/')
    ) {
      addLog(line.trim());
    }

    // Detect game fully started
    if (line.includes('[Render thread/INFO]') && line.includes('Backend library')) {
      setStatus('Minecraft is running', 'green');
      setProgress(null);
      mcPlayBtn.textContent = '🟢  Running';
    }
  });

  mc.onClosed((code: number) => {
    addLog(`Minecraft exited with code ${code}`);
    setStatus(code === 0 ? 'Minecraft closed' : `Minecraft crashed (code ${code})`, code === 0 ? '' : 'red');
    resetPlay();
  });

  mc.onError((msg: string) => {
    addLog(`Error: ${msg}`, 'error');
    setStatus(`Error: ${msg}`, 'red');
    resetPlay();
  });
}

setStatus('Ready — login with Microsoft to play');

// ── Nav switching ─────────────────────────────────────────────────────────────
const contentEl     = document.getElementById('content')!;
const modsPanelEl   = document.getElementById('mods-panel')!;
const settingsPanelEl = document.getElementById('settings-panel')!;
const navPlay       = document.getElementById('nav-play')!;
const navMods       = document.getElementById('nav-mods')!;
const navSettings   = document.getElementById('nav-settings')!;

function showPlay() {
  contentEl.style.display      = 'flex';
  modsPanelEl.style.display    = 'none';
  settingsPanelEl.style.display= 'none';
  navPlay.classList.add('active');
  navMods.classList.remove('active');
  navSettings.classList.remove('active');
}
function showMods() {
  contentEl.style.display      = 'none';
  modsPanelEl.style.display    = 'flex';
  settingsPanelEl.style.display= 'none';
  navPlay.classList.remove('active');
  navMods.classList.add('active');
  navSettings.classList.remove('active');
}
function showSettings() {
  contentEl.style.display      = 'none';
  modsPanelEl.style.display    = 'none';
  settingsPanelEl.style.display= 'flex';
  navPlay.classList.remove('active');
  navMods.classList.remove('active');
  navSettings.classList.add('active');
}
navPlay.addEventListener('click', showPlay);
navMods.addEventListener('click', showMods);
navSettings.addEventListener('click', showSettings);

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

// ── Build mods list ────────────────────────────────────────────────────────────
const enabledMods = new Set<string>(MODS.filter(m => m.defaultOn).map(m => m.id));
const modsList = document.getElementById('mods-list')!;

function renderMods() {
  modsList.innerHTML = '';
  for (const mod of MODS) {
    const on = enabledMods.has(mod.id);
    const card = document.createElement('div');
    card.className = 'mod-card' + (on ? ' enabled' : '');
    card.innerHTML = `
      <div class="mod-icon">${mod.icon}</div>
      <div class="mod-info">
        <div class="mod-name">${mod.name}</div>
        <div class="mod-desc">${mod.desc}</div>
        <div class="mod-tags">
          ${mod.tags.map(t => `<span class="mod-tag ${t.cls}">${t.label}</span>`).join('')}
        </div>
      </div>
      <div class="mod-right">
        <span class="mod-version">v${mod.version}</span>
        <label class="toggle">
          <input type="checkbox" data-mod="${mod.id}" ${on ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>
    `;
    card.querySelector('input')!.addEventListener('change', (e) => {
      const checked = (e.target as HTMLInputElement).checked;
      if (checked) enabledMods.add(mod.id); else enabledMods.delete(mod.id);
      card.className = 'mod-card' + (checked ? ' enabled' : '');
    });
    modsList.appendChild(card);
  }
}

renderMods();

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
