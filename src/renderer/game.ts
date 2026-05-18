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

// ── Auto-updater UI ────────────────────────────────────────────────────────────
const updater = (window as any).updater;
if (updater) {
  const banner       = document.getElementById('update-banner')!;
  const updateText   = document.getElementById('update-text')!;
  const progressWrap2= document.getElementById('update-progress-wrap')!;
  const progressBar2 = document.getElementById('update-progress-bar')!;
  const installBtn   = document.getElementById('update-install-btn')!;

  updater.onAvailable((ver: string) => {
    banner.style.display = 'flex';
    updateText.textContent = `⬇ Update v${ver} downloading…`;
    progressWrap2.style.display = 'block';
  });

  updater.onProgress((pct: number) => {
    progressBar2.style.width = `${pct}%`;
    updateText.textContent = `⬇ Downloading update… ${pct}%`;
  });

  updater.onDownloaded(() => {
    progressWrap2.style.display = 'none';
    updateText.textContent = '✅ Update ready — restart to apply';
    installBtn.style.display = 'inline-block';
  });

  installBtn.addEventListener('click', () => updater.install());
}
