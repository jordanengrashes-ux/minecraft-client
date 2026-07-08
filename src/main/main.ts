import { app, BrowserWindow, ipcMain, net, shell, globalShortcut, screen, powerSaveBlocker, dialog, session } from 'electron';
import { GEMINI_KEY, CF_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from './ai-key';
import { autoUpdater } from 'electron-updater';
import { execSync, spawnSync, spawn, ChildProcess } from 'child_process';
import https from 'https';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('minecraft-launcher-core');

let loginWin:   BrowserWindow | null = null;
let gameWin:    BrowserWindow | null = null;
let overlayWin: BrowserWindow | null = null;
let aiWin:      BrowserWindow | null = null;
let mcAuthToken: any = null;
let updateReady = false;
let serverProcess: ChildProcess | null = null;
let keepAwakeId: number | null = null;
let srvUserStopped = false;
let mcProcess: ChildProcess | null = null;
let javaReadyPromise: Promise<string> | null = null;

const DEV = !app.isPackaged;
const AUTH_CACHE            = path.join(app.getPath('userData'), 'mc-auth.json');
const JAVA_PATH_CACHE       = path.join(app.getPath('userData'), 'java-path.json');  // legacy Java 21 cache
const JAVA_PATHS_CACHE      = path.join(app.getPath('userData'), 'java-paths.json'); // multi-version cache
const FIREBASE_USER_CACHE   = path.join(app.getPath('userData'), 'firebase-user.json');

function loadJavaPathsDict(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(JAVA_PATHS_CACHE, 'utf-8')); } catch { return {}; }
}
function loadCachedJavaPath(major: number): string | null {
  const dict = loadJavaPathsDict();
  if (dict[String(major)] && fs.existsSync(dict[String(major)])) return dict[String(major)];
  if (major === 21) {
    try {
      const data = JSON.parse(fs.readFileSync(JAVA_PATH_CACHE, 'utf-8'));
      if (data?.path && fs.existsSync(data.path)) return data.path as string;
    } catch {}
  }
  return null;
}
function saveCachedJavaPath(major: number, javaPath: string) {
  const dict = loadJavaPathsDict();
  dict[String(major)] = javaPath;
  try { fs.writeFileSync(JAVA_PATHS_CACHE, JSON.stringify(dict)); } catch {}
}

// ── Java helpers ──────────────────────────────────────────────────────────────

// Read JAVA_VERSION from the 'release' file every proper JRE ships — no subprocess needed
function readJavaReleaseVersion(javaPath: string): number {
  try {
    // javaw.exe lives in <jre>/bin/ — release file is in <jre>/
    const jreRoot = path.dirname(path.dirname(javaPath));
    const content = fs.readFileSync(path.join(jreRoot, 'release'), 'utf-8');
    const m = content.match(/JAVA_VERSION="(\d+)(?:\.(\d+))?/);
    if (!m) return 0;
    const major = parseInt(m[1]);
    return major === 1 ? parseInt(m[2] || '0') : major;
  } catch { return 0; }
}

function getJavaMajorVersion(javaPath: string): number {
  // 1. Read the release file — no subprocess, always works on any packaged JRE
  const fromFile = readJavaReleaseVersion(javaPath);
  if (fromFile > 0) return fromFile;

  // 2. Fallback: run java -version (java.exe not javaw — javaw is windowless)
  try {
    const javaExe = javaPath.replace(/javaw(\.exe)?$/i, 'java$1');
    const r = spawnSync(javaExe, ['-version'], { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = out.match(/version "(\d+)(?:\.(\d+))?/);
    if (!m) return 0;
    const major = parseInt(m[1]);
    return major === 1 ? parseInt(m[2] || '0') : major;
  } catch { return 0; }
}

function findJavawInDir(dir: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
    for (const d of dirs) {
      const p = path.join(dir, d, 'bin', 'javaw.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// MC launcher ships its own JREs — check them before downloading
const MC_RUNTIME_MAP: Record<number, string[]> = {
  8:  ['java-runtime-legacy'],
  17: ['java-runtime-gamma', 'java-runtime-gamma-snapshot'],
  21: ['java-runtime-delta'],
  25: ['java-runtime-epsilon'],
};

async function ensureJava(major: number, log: (msg: string) => void): Promise<string> {
  // Fast path: previously resolved path saved to disk
  const diskCached = loadCachedJavaPath(major);
  if (diskCached) {
    const v = getJavaMajorVersion(diskCached);
    if (v === major || (major === 21 && v >= 21)) { log(`[Launcher] Java ${v} ready`); return diskCached; }
  }

  // 0. Bundled Java 21 (shipped inside installer)
  if (major === 21) {
    const bundledDir = path.join(process.resourcesPath, 'java21');
    const bundled = findJavawInDir(bundledDir);
    if (bundled) {
      log(`[Launcher] Using bundled Java 21 at ${bundled}`);
      saveCachedJavaPath(21, bundled);
      return bundled;
    }
    log(`[Launcher] Bundled Java not found at ${bundledDir} — checking fallbacks`);
  }

  const javaDir = path.join(app.getPath('userData'), `java${major}`);

  // 1. Our own cached download
  const cached = findJavawInDir(javaDir);
  if (cached) {
    const v = getJavaMajorVersion(cached);
    if (v === major || (major === 21 && v >= 21)) { log(`[Launcher] Java ${major} ready (cached)`); saveCachedJavaPath(major, cached); return cached; }
    log(`[Launcher] Cached Java is v${v} — clearing and re-downloading…`);
    try { fs.rmSync(javaDir, { recursive: true, force: true }); } catch {}
  }

  // 2. Minecraft launcher bundled runtimes
  for (const rtName of (MC_RUNTIME_MAP[major] || [])) {
    const rtPath = path.join(app.getPath('appData'), '.minecraft', 'runtime', rtName, 'windows-x64', rtName, 'bin', 'javaw.exe');
    if (fs.existsSync(rtPath)) {
      const v = getJavaMajorVersion(rtPath);
      if (v === major || (major === 21 && v >= 21)) {
        log(`[Launcher] Using Minecraft launcher Java ${v} (${rtName})`);
        saveCachedJavaPath(major, rtPath);
        return rtPath;
      }
    }
  }

  // 3. System Java
  const programFiles = [process.env.PROGRAMFILES || 'C:\\Program Files', process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'];
  const vendors = ['Eclipse Adoptium', 'Temurin', 'Microsoft', 'BellSoft', 'Amazon Corretto', 'Zulu', 'Java', 'OpenJDK'];
  const sysCandidates: string[] = [];
  if (process.env.JAVA_HOME) sysCandidates.push(path.join(process.env.JAVA_HOME, 'bin', 'javaw.exe'));
  for (const base of programFiles) {
    for (const v of vendors) {
      const found = findJavawInDir(path.join(base, v));
      if (found) sysCandidates.push(found);
    }
  }
  for (const c of sysCandidates) {
    const v = getJavaMajorVersion(c);
    if (v === major || (major === 21 && v >= 21)) { log(`[Launcher] Using system Java ${v}`); saveCachedJavaPath(major, c); return c; }
  }

  // 4. Download from Adoptium
  log(`[Launcher] No Java ${major} found — downloading from Adoptium…`);
  const info = await fetchJson(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`);
  const pkg = info[0]?.binary?.package;
  if (!pkg?.link) throw new Error(`Could not get Java ${major} download URL from Adoptium`);

  const zipPath = path.join(app.getPath('temp'), `voxel-java${major}.zip`);
  const sizeMB = Math.round((pkg.size || 0) / 1024 / 1024);
  log(`[Launcher] Downloading Java ${major} JRE (${sizeMB}MB) — this only happens once…`);

  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    let downloaded = 0;
    let lastPct = -1;

    function doGet(url: string) {
      https.get(url, { headers: { 'User-Agent': 'VoxelClient' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          res.resume();
          doGet(res.headers.location!);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`Download failed: HTTP ${res.statusCode}`)); return; }
        const total = parseInt(res.headers['content-length'] || String(pkg.size || 0));
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          const pct = total > 0 ? Math.round(downloaded / total * 100) : 0;
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct;
            log(`[Launcher] Downloading Java ${major}… ${pct}%`);
            gameWin?.webContents.send('mc-status', { msg: `Downloading Java ${major}… ${pct}%`, color: 'yellow' });
          }
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        res.on('error', reject);
      }).on('error', reject);
    }
    doGet(pkg.link);
  });

  const dlSize = fs.statSync(zipPath).size;
  log(`[Launcher] Download complete — ${Math.round(dlSize / 1024 / 1024)}MB received`);
  if (dlSize < 10 * 1024 * 1024) throw new Error(`Java ${major} download too small (${dlSize} bytes) — try again`);

  log(`[Launcher] Extracting Java ${major}…`);
  gameWin?.webContents.send('mc-status', { msg: `Extracting Java ${major}…`, color: 'yellow' });
  try { if (fs.existsSync(javaDir)) fs.rmSync(javaDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(javaDir, { recursive: true });
  try {
    execSync(`powershell -NoProfile -command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${javaDir}' -Force"`, { timeout: 120000 });
  } catch (extractErr: any) {
    throw new Error(`Java ${major} extraction failed: ${extractErr.message}`);
  }

  const javaw = findJavawInDir(javaDir);
  if (!javaw) throw new Error(`Java ${major} extracted but javaw.exe not found`);
  const finalVer = getJavaMajorVersion(javaw);
  log(`[Launcher] Java ${finalVer} installed at ${javaw}`);
  gameWin?.webContents.send('mc-status', { msg: `Java ${major} ready`, color: 'green' });
  saveCachedJavaPath(major, javaw);
  return javaw;
}

const ensureJava21 = (log: (msg: string) => void) => ensureJava(21, log);

// ── Token validation ──────────────────────────────────────────────────────────
async function validateToken(token: any): Promise<boolean> {
  try {
    const res = await (net.fetch as any)('https://api.minecraftservices.com/minecraft/profile', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Load cached MC auth token ─────────────────────────────────────────────────
function loadCachedAuth() {
  try {
    if (fs.existsSync(AUTH_CACHE)) {
      mcAuthToken = JSON.parse(fs.readFileSync(AUTH_CACHE, 'utf-8'));
    }
  } catch { mcAuthToken = null; }
}
function saveCachedAuth(token: any) {
  try { fs.writeFileSync(AUTH_CACHE, JSON.stringify({ ...token, cached_at: Date.now() }), 'utf-8'); } catch {}
}
function clearCachedAuth() {
  try { if (fs.existsSync(AUTH_CACHE)) fs.unlinkSync(AUTH_CACHE); } catch {}
  mcAuthToken = null;
}

// ── Microsoft → Xbox → XSTS → Minecraft auth chain ──────────────────────────
const MS_CLIENT_ID = '00000000402b5328';
const MS_REDIRECT  = 'https://login.live.com/oauth20_desktop.srf';

const GOOGLE_REDIRECT_PORT = 53215;
const GOOGLE_REDIRECT      = `http://127.0.0.1:${GOOGLE_REDIRECT_PORT}/callback`;

// Google blocks its OAuth consent screen inside Electron's embedded browser
// windows, so sign-in has to happen in the user's real default browser —
// we spin up a one-shot local HTTP server just to catch the redirect.
function openGoogleAuthInSystemBrowser(): Promise<string> {
  return new Promise((resolve, reject) => {
    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth` +
      `?client_id=${GOOGLE_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent('openid email profile')}` +
      `&prompt=select_account`;

    let settled = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', GOOGLE_REDIRECT);
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const code = url.searchParams.get('code');
      const err  = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="font-family:sans-serif;background:#0d0d0d;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><h2>Signed in — you can close this tab.</h2></body></html>');
      finish(code, err);
    });

    function finish(code: string | null, err: string | null) {
      if (settled) return;
      settled = true;
      server.close();
      if (code) resolve(code);
      else reject(new Error(err || 'Cancelled'));
    }

    server.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    server.listen(GOOGLE_REDIRECT_PORT, '127.0.0.1', () => {
      shell.openExternal(authUrl);
    });

    // Give up if nothing happens in 3 minutes
    setTimeout(() => finish(null, 'Timed out'), 3 * 60 * 1000);
  });
}

async function authenticateWithGoogle(code: string): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: GOOGLE_REDIRECT,
  });
  const json = await fetchJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!json.id_token) throw new Error('No ID token returned from Google');
  return { idToken: json.id_token };
}

function openMicrosoftAuthWindow(): Promise<string> {
  return new Promise((resolve, reject) => {
    const authUrl =
      `https://login.live.com/oauth20_authorize.srf` +
      `?client_id=${MS_CLIENT_ID}` +
      `&response_type=code` +
      `&scope=service::user.auth.xboxlive.com::MBI_SSL` +
      `&redirect_uri=${encodeURIComponent(MS_REDIRECT)}` +
      `&display=touch&locale=en`;

    const win = new BrowserWindow({
      width: 500, height: 660,
      title: 'Sign in with Microsoft',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    win.setMenuBarVisibility(false);
    win.loadURL(authUrl);

    let resolved = false;
    function done(codeOrErr: string, isErr = false) {
      if (resolved) return;
      resolved = true;
      try { if (!win.isDestroyed()) win.close(); } catch {}
      if (isErr) reject(new Error(codeOrErr));
      else resolve(codeOrErr);
    }

    function tryUrl(url: string) {
      if (!url.startsWith(MS_REDIRECT)) return;
      const p = new URL(url);
      const code = p.searchParams.get('code');
      const err  = p.searchParams.get('error_description') || p.searchParams.get('error');
      if (code) done(code);
      else done(err || 'Cancelled', true);
    }

    win.webContents.on('will-redirect',          (_e, url) => tryUrl(url));
    win.webContents.on('will-navigate',           (_e, url) => tryUrl(url));
    win.webContents.on('did-navigate',            (_e, url) => tryUrl(url));
    win.webContents.on('did-redirect-navigation', (_e, url) => tryUrl(url));
    win.on('closed', () => done('Window closed', true));
  });
}

async function fetchJson(url: string, init?: object): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (net.fetch as any)(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function authenticateWithMinecraft(code: string): Promise<any> {
  // 1. Exchange code → MS access token
  const msToken = await fetchJson('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID, code,
      grant_type: 'authorization_code',
      redirect_uri: MS_REDIRECT,
    }).toString(),
  });

  // 2. Xbox Live
  const xbl = await fetchJson('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: msToken.access_token },
      RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
    }),
  });

  // 3. XSTS
  const xsts = await fetchJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
    }),
  });

  const uhs = xsts.DisplayClaims.xui[0].uhs;

  // 4. Minecraft token
  const mc = await fetchJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }),
  });

  // 5. Profile
  const profileRes = await (net.fetch as any)('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}` },
  });
  if (profileRes.status === 404) throw new Error('This Microsoft account does not own Minecraft Java Edition.');
  if (!profileRes.ok) throw new Error(`Profile fetch failed: HTTP ${profileRes.status}`);
  const profile = await profileRes.json();
  if (!profile.id) throw new Error('This Microsoft account does not own Minecraft Java Edition.');

  return {
    access_token: mc.access_token,
    client_token: mc.access_token,
    uuid: profile.id,
    name: profile.name,
    user_properties: {},
    meta: { type: 'msa', demo: false },
  };
}

// ── Voxel SMP — external Paper server control ─────────────────────────────────
const VOXEL_SRV_DIR       = 'C:\\Users\\Jorda\\VoxelServer';
const VOXEL_SRV_BAT       = path.join(VOXEL_SRV_DIR, 'start.bat');
const VOXEL_SRV_AUTOSTART = path.join(app.getPath('userData'), 'voxel-srv-autostart.json');
let voxelSrvProcess: ReturnType<typeof spawn> | null = null;

function voxelSrvRunning(): boolean {
  if (voxelSrvProcess && !voxelSrvProcess.killed) return true;
  // Also check if port 25565 is already listening (started outside the app)
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      '(netstat -an | Select-String ":25565.*LISTENING").Count -gt 0'], { encoding: 'utf-8', timeout: 3000 });
    return (r.stdout || '').trim() === 'True';
  } catch { return false; }
}

ipcMain.handle('voxel-srv-status', () => ({ running: voxelSrvRunning() }));

ipcMain.handle('voxel-srv-start', async () => {
  if (voxelSrvRunning()) return { ok: false, error: 'Already running' };
  if (!fs.existsSync(VOXEL_SRV_BAT)) return { ok: false, error: `start.bat not found at ${VOXEL_SRV_BAT}` };
  try {
    voxelSrvProcess = spawn('cmd.exe', ['/c', VOXEL_SRV_BAT], {
      cwd: VOXEL_SRV_DIR, stdio: ['pipe', 'pipe', 'pipe'],
    });
    voxelSrvProcess.stdout?.on('data', (d: Buffer) => gameWin?.webContents.send('voxel-srv-log', d.toString()));
    voxelSrvProcess.stderr?.on('data', (d: Buffer) => gameWin?.webContents.send('voxel-srv-log', d.toString()));
    voxelSrvProcess.on('close', () => { voxelSrvProcess = null; gameWin?.webContents.send('voxel-srv-closed'); });
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err.message }; }
});

ipcMain.handle('voxel-srv-stop', async () => {
  if (voxelSrvProcess?.stdin) { voxelSrvProcess.stdin.write('stop\n'); }
  setTimeout(() => { try { voxelSrvProcess?.kill(); } catch {} voxelSrvProcess = null; }, 8000);
  return { ok: true };
});

ipcMain.handle('voxel-srv-autostart-get', () => {
  try { return JSON.parse(fs.readFileSync(VOXEL_SRV_AUTOSTART, 'utf-8')).enabled ?? false; } catch { return false; }
});
ipcMain.handle('voxel-srv-autostart-set', (_e, enabled: boolean) => {
  try { fs.writeFileSync(VOXEL_SRV_AUTOSTART, JSON.stringify({ enabled }), 'utf-8'); } catch {}
  // Also register/unregister the app itself to open at Windows login
  app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath('exe') });
  return { ok: true };
});

// ── Firebase user cache (reliable disk-based persistence for Electron) ────────
ipcMain.handle('save-firebase-user', (_e, data: { uid: string; name: string }) => {
  try { fs.writeFileSync(FIREBASE_USER_CACHE, JSON.stringify(data), 'utf-8'); return true; } catch { return false; }
});
ipcMain.handle('load-firebase-user', () => {
  try {
    if (fs.existsSync(FIREBASE_USER_CACHE)) return JSON.parse(fs.readFileSync(FIREBASE_USER_CACHE, 'utf-8'));
  } catch {}
  return null;
});
ipcMain.handle('clear-firebase-user', () => {
  try { if (fs.existsSync(FIREBASE_USER_CACHE)) fs.unlinkSync(FIREBASE_USER_CACHE); } catch {}
});

// ── Windows ───────────────────────────────────────────────────────────────────
function createLoginWindow() {
  loginWin = new BrowserWindow({
    width: 480, height: 600,
    resizable: false, frame: false, titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  // Allow Firebase Google auth popup (signInWithPopup needs window.open)
  loginWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('firebaseapp.com') || url.includes('accounts.google.com') || url.includes('googleapis.com')) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 500, height: 660, frame: true,
        // contextIsolation:false so window.opener.postMessage works from the popup
        webPreferences: { nodeIntegration: false, contextIsolation: false },
      }};
    }
    return { action: 'deny' };
  });
  // Strip "Electron/x.x.x" from UA — Google blocks embedded-browser sign-in otherwise
  loginWin.webContents.on('did-create-window', (win) => {
    win.webContents.userAgent = win.webContents.userAgent.replace(/ Electron\/[\d.]+/, '');
  });
  if (DEV) loginWin.loadURL('http://localhost:5173/login.html');
  else loginWin.loadFile(path.join(__dirname, '../dist/login.html'));
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  overlayWin = new BrowserWindow({
    width: 330, height: 540,
    x: Math.round(width / 2 - 165),
    y: Math.round(height / 2 - 270),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  if (DEV) overlayWin.loadURL('http://localhost:5173/overlay.html');
  else overlayWin.loadFile(path.join(__dirname, '../dist/overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
}

function toggleOverlay() {
  if (!overlayWin) { createOverlayWindow(); return; }
  if (overlayWin.isVisible()) overlayWin.hide();
  else { overlayWin.show(); overlayWin.focus(); }
}

function createGameWindow() {
  gameWin = new BrowserWindow({
    width: 1100, height: 680, minWidth: 800, minHeight: 500,
    backgroundColor: '#0d1117', titleBarStyle: 'hidden',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  if (DEV) {
    gameWin.loadURL('http://localhost:5173/game.html');
    gameWin.webContents.openDevTools({ mode: 'detach' });
  } else {
    gameWin.loadFile(path.join(__dirname, '../dist/game.html'));
  }
  gameWin.on('closed', () => {
    gameWin = null;
    if (loggingOut) {
      loggingOut = false;
      return;
    }
    if (updateReady) {
      updateReady = false;
      try { autoUpdater.quitAndInstall(true, true); } catch { app.quit(); }
    } else {
      app.quit();
    }
  });
  gameWin.webContents.once('did-finish-load', () => { if (!DEV) setupAutoUpdater(); });
}

// ── IPC: login / game window ──────────────────────────────────────────────────
ipcMain.on('login-success', (_e, userData) => {
  createGameWindow();
  loginWin?.close(); loginWin = null;
  gameWin?.webContents.once('did-finish-load', () => {
    gameWin?.webContents.send('user-data', userData);
    if (mcAuthToken) gameWin?.webContents.send('mc-already-authed', mcAuthToken.name);
    // Pre-warm Java 21 and Java 25 so they're ready when the user clicks Play
    javaReadyPromise = ensureJava21((msg) => gameWin?.webContents.send('mc-log', msg));
    javaReadyPromise.catch(() => { javaReadyPromise = null; });
    ensureJava(25, (msg) => gameWin?.webContents.send('mc-log', msg)).catch(() => {});
  });
});

let loggingOut = false;
ipcMain.on('logout', () => {
  try { if (fs.existsSync(FIREBASE_USER_CACHE)) fs.unlinkSync(FIREBASE_USER_CACHE); } catch {}
  loggingOut = true;
  gameWin?.close();
  createLoginWindow();
});

// ── IPC: Google sign-in (system browser, since Google blocks embedded auth) ───
ipcMain.handle('google-auth', async () => {
  try {
    const code = await openGoogleAuthInSystemBrowser();
    const { idToken } = await authenticateWithGoogle(code);
    return { ok: true, idToken };
  } catch (e: any) {
    return { ok: false, error: e.message || String(e) };
  }
});

// ── IPC: Minecraft auth ───────────────────────────────────────────────────────
ipcMain.handle('mc-auth', async () => {
  // Return cached token if valid
  if (mcAuthToken?.name) return { ok: true, username: mcAuthToken.name, cached: true };
  try {
    const code  = await openMicrosoftAuthWindow();
    const token = await authenticateWithMinecraft(code);
    mcAuthToken = token;
    saveCachedAuth(token);
    return { ok: true, username: token.name };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mc-reauth', async () => {
  clearCachedAuth();
  try {
    const code  = await openMicrosoftAuthWindow();
    const token = await authenticateWithMinecraft(code);
    mcAuthToken = token;
    saveCachedAuth(token);
    return { ok: true, username: token.name };
  } catch (err: any) {
    console.error('[Auth] reauth failed:', err.message);
    gameWin?.webContents.send('mc-log', `[Auth] Login failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// ── IPC: launch Minecraft ─────────────────────────────────────────────────────
const FORGEWRAPPER_OVERRIDE = {
  baseUrl: 'https://github.com/ZekerZhayard/ForgeWrapper/releases/download/',
  version: '1.5.1',
  sh1: '90104e9aaa8fbedf6c3d1f6d0b90cabce080b5a9',
  size: 29892,
};

// Builds the version/forge/mcPath portion of launcher.launch() options shared
// between online and offline launch — Fabric uses a pre-merged custom version
// json, Forge/NeoForge use MCLC's built-in ForgeWrapper support.
function buildLoaderLaunchOptions(mcRoot: string, version: string, forgePath?: string) {
  const isFabric = (version || '').startsWith('fabric-loader-');
  if (isFabric) {
    const mcVer = version.replace(/^fabric-loader-[\d.]+-/, '');
    // Point Fabric at this version's own mods folder instead of the game
    // directory's shared mods/ — vanilla Fabric has no per-version mod
    // isolation otherwise, which is exactly how incompatible mods from a
    // different version kept ending up on the classpath together.
    const versionModsDir = modsDirFor(mcVer);
    fs.mkdirSync(versionModsDir, { recursive: true });
    return {
      version: { number: mcVer, type: 'release' as const, custom: version },
      customArgs: [`-Dfabric.modsFolder=${versionModsDir}`],
    };
  }
  if (forgePath) {
    return {
      version: { number: version || '1.21.4', type: 'release' as const },
      forge: forgePath,
      mcPath: path.join(mcRoot, 'versions', version, `${version}.jar`),
      overridesExtra: { fw: FORGEWRAPPER_OVERRIDE },
    };
  }
  return { version: { number: version || '1.21.4', type: 'release' as const } };
}

ipcMain.handle('mc-launch', async (_e, opts: { version: string; maxMem: number; javaVersion?: number; vsync?: boolean; shaderpack?: string; forgePath?: string }) => {
  const requestedJava = opts.javaVersion || 21;
  const javaPromise = (requestedJava === 21 && javaReadyPromise)
    ? javaReadyPromise
    : ensureJava(requestedJava, (msg) => gameWin?.webContents.send('mc-log', msg));

  // If no cached token, or token is stale, run the auth flow inline
  const tokenAge = Date.now() - (mcAuthToken?.cached_at ?? 0);
  const needsAuth = !mcAuthToken || tokenAge > 4 * 60 * 60 * 1000; // re-validate every 4h, not 30min
  if (needsAuth) {
    const tokenOk = mcAuthToken ? await validateToken(mcAuthToken) : false;
    if (!tokenOk) {
      try {
        gameWin?.webContents.send('mc-log', mcAuthToken
          ? '[Launcher] Session expired — re-authenticating…'
          : '[Launcher] Sign in with Microsoft to play online…');
        const code  = await openMicrosoftAuthWindow();
        const token = await authenticateWithMinecraft(code);
        mcAuthToken = token;
        saveCachedAuth(token);
        gameWin?.webContents.send('mc-already-authed', token.name);
      } catch (err: any) {
        const msg = err.message || String(err);
        const isCancel = msg.includes('Window closed') || msg.includes('Cancelled') || msg.includes('cancel');
        return { ok: false, error: isCancel
          ? 'Microsoft sign-in was cancelled. Use Offline Mode to play without an account.'
          : `Microsoft auth failed: ${msg}` };
      }
    }
  }

  try {
    const mcRoot   = path.join(app.getPath('userData'), '.minecraft');
    const launcher = new Client();
    const { cached_at: _, ...auth } = mcAuthToken as any;
    const javaPath = await javaPromise;
    const detectedVer = getJavaMajorVersion(javaPath);
    gameWin?.webContents.send('mc-log', `[Launcher] Java path: ${javaPath}`);
    gameWin?.webContents.send('mc-log', `[Launcher] Java version detected: ${detectedVer || 'UNKNOWN'}`);
    if (detectedVer !== requestedJava && !(requestedJava === 21 && detectedVer >= 21)) {
      throw new Error(`Java ${detectedVer || 'unknown'} found but Java ${requestedJava} is required for this version. Try restarting VoxelClient — it will download the correct Java automatically.`);
    }
    gameWin?.webContents.send('mc-log', `[Launcher] version: ${opts.version || '1.21.4'}, mem: ${opts.maxMem || 4}G, Java ${detectedVer}, user: ${auth.name}`);

    // Re-apply resource pack enable and disable background blur
    const packDir = path.join(mcRoot, 'resourcepacks', 'VoxelClient');
    if (fs.existsSync(packDir)) enableVoxelResourcePack(mcRoot);
    setOptionsKey(mcRoot, 'backgroundBlur', '0');
    setOptionsKey(mcRoot, 'enableVsync', opts.vsync !== false ? 'true' : 'false');
    applyShaderPack(mcRoot, opts.shaderpack || '');

    // Auto-install cosmetics mod if bundled — into this version's own mods folder
    try {
      const modsDir = modsDirFor((opts.version || '').replace(/^fabric-loader-[\d.]+-/, ''));
      const cosmeticsSrc = app.isPackaged
        ? path.join(process.resourcesPath, 'mods', 'voxel-cosmetics.jar')
        : path.join(__dirname, '../../resources/mods/voxel-cosmetics.jar');
      if (fs.existsSync(cosmeticsSrc)) {
        if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
        fs.copyFileSync(cosmeticsSrc, path.join(modsDir, 'voxel-cosmetics.jar'));
        gameWin?.webContents.send('mc-log', '[Launcher] Cosmetics mod installed');
      }
    } catch {}

    // Auto-install bundled shader packs (only on first run — preserves user settings)
    try {
      const shaderSrcDir = app.isPackaged
        ? path.join(process.resourcesPath, 'shaderpacks')
        : path.join(__dirname, '../../resources/shaderpacks');
      if (fs.existsSync(shaderSrcDir)) {
        const shaderDestDir = path.join(mcRoot, 'shaderpacks');
        if (!fs.existsSync(shaderDestDir)) fs.mkdirSync(shaderDestDir, { recursive: true });
        for (const packName of fs.readdirSync(shaderSrcDir)) {
          const dest = path.join(shaderDestDir, packName);
          if (!fs.existsSync(dest)) {
            fs.cpSync(path.join(shaderSrcDir, packName), dest, { recursive: true });
            gameWin?.webContents.send('mc-log', `[Launcher] Shader pack installed: ${packName}`);
          }
        }
      }
    } catch {}

    const { version, forge, mcPath, overridesExtra, customArgs } = buildLoaderLaunchOptions(mcRoot, opts.version, opts.forgePath);

    mcProcess = launcher.launch({
      authorization: auth,
      root: mcRoot,
      version,
      ...(forge ? { forge, mcPath } : {}),
      ...(customArgs ? { customArgs } : {}),
      memory:  { max: `${opts.maxMem || 4}G`, min: '512M' },
      javaPath,
      overrides: { maxSockets: 64, checkHash: false, ...overridesExtra },
    });
    launcher.on('data',     (d: string)  => gameWin?.webContents.send('mc-log',      d));
    launcher.on('progress', (e: any)     => gameWin?.webContents.send('mc-progress', e));
    launcher.on('close',    (c: number)  => { mcProcess = null; gameWin?.webContents.send('mc-closed',   c); });
    launcher.on('error',    (e: Error)   => { mcProcess = null; gameWin?.webContents.send('mc-error',    e.message); });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: offline launch ───────────────────────────────────────────────────────
ipcMain.handle('mc-launch-offline', async (_e, opts: { version: string; maxMem: number; username: string; javaVersion?: number; vsync?: boolean; shaderpack?: string; forgePath?: string }) => {
  const requestedJava = opts.javaVersion || 21;
  try {
    const mcRoot   = path.join(app.getPath('userData'), '.minecraft');
    const launcher = new Client();
    const javaPath = await ((requestedJava === 21 && javaReadyPromise)
      ? javaReadyPromise
      : ensureJava(requestedJava, (msg) => gameWin?.webContents.send('mc-log', msg)));
    const detectedVer = getJavaMajorVersion(javaPath);
    if (detectedVer !== requestedJava && !(requestedJava === 21 && detectedVer >= 21))
      throw new Error(`Java ${detectedVer} found but Java ${requestedJava} was requested`);

    // Offline UUID — matches vanilla OfflinePlayer UUID derivation
    const { createHash } = await import('crypto');
    const hash = createHash('md5').update(`OfflinePlayer:${opts.username}`).digest();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const h = hash.toString('hex');
    const uuid = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;

    gameWin?.webContents.send('mc-log', `[Launcher] Offline mode — user: ${opts.username}, uuid: ${uuid}`);
    setOptionsKey(mcRoot, 'backgroundBlur', '0');
    setOptionsKey(mcRoot, 'enableVsync', opts.vsync !== false ? 'true' : 'false');
    applyShaderPack(mcRoot, opts.shaderpack || '');

    // Auto-install bundled shader packs (only on first run — preserves user settings)
    try {
      const shaderSrcDir = app.isPackaged
        ? path.join(process.resourcesPath, 'shaderpacks')
        : path.join(__dirname, '../../resources/shaderpacks');
      if (fs.existsSync(shaderSrcDir)) {
        const shaderDestDir = path.join(mcRoot, 'shaderpacks');
        if (!fs.existsSync(shaderDestDir)) fs.mkdirSync(shaderDestDir, { recursive: true });
        for (const packName of fs.readdirSync(shaderSrcDir)) {
          const dest = path.join(shaderDestDir, packName);
          if (!fs.existsSync(dest)) {
            fs.cpSync(path.join(shaderSrcDir, packName), dest, { recursive: true });
            gameWin?.webContents.send('mc-log', `[Launcher] Shader pack installed: ${packName}`);
          }
        }
      }
    } catch {}

    const { version, forge, mcPath, overridesExtra, customArgs } = buildLoaderLaunchOptions(mcRoot, opts.version, opts.forgePath);

    mcProcess = launcher.launch({
      authorization: { access_token: 'offline', client_token: 'offline', uuid, name: opts.username, user_properties: '{}', meta: { type: 'mojang', demo: false } },
      root: mcRoot,
      version,
      ...(forge ? { forge, mcPath } : {}),
      ...(customArgs ? { customArgs } : {}),
      memory:  { max: `${opts.maxMem || 4}G`, min: '512M' },
      javaPath,
      overrides: { maxSockets: 64, checkHash: false, ...overridesExtra },
    });
    launcher.on('data',     (d: string) => gameWin?.webContents.send('mc-log',      d));
    launcher.on('progress', (e: any)    => gameWin?.webContents.send('mc-progress', e));
    launcher.on('close',    (c: number) => { mcProcess = null; gameWin?.webContents.send('mc-closed',   c); });
    launcher.on('error',    (e: Error)  => { mcProcess = null; gameWin?.webContents.send('mc-error',    e.message); });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: force-kill MC ────────────────────────────────────────────────────────
ipcMain.handle('mc-kill', () => {
  if (mcProcess?.pid) {
    try { execSync(`taskkill /F /PID ${mcProcess.pid} /T`, { stdio: 'ignore' }); } catch {}
    mcProcess = null;
    return;
  }
  // Fallback: kill any java process (covers cases where process ref was lost)
  try { execSync('taskkill /F /IM java.exe /T',  { stdio: 'ignore' }); } catch {}
  try { execSync('taskkill /F /IM javaw.exe /T', { stdio: 'ignore' }); } catch {}
});

// ── IPC: cosmetics ────────────────────────────────────────────────────────────
ipcMain.handle('mc-get-uuid', async () => {
  if (!mcAuthToken) return null;
  // UUID stored directly in token
  if (mcAuthToken.uuid) return (mcAuthToken.uuid as string).replace(/-/g, '');
  // Fallback: fetch profile using access_token and cache the uuid
  if (mcAuthToken.access_token) {
    try {
      const profile = await fetchJson('https://api.minecraftservices.com/minecraft/profile', {
        headers: { Authorization: `Bearer ${mcAuthToken.access_token}` },
      });
      if (profile?.id) {
        mcAuthToken.uuid = profile.id;
        mcAuthToken.name = mcAuthToken.name || profile.name;
        saveCachedAuth(mcAuthToken);
        return (profile.id as string).replace(/-/g, '');
      }
    } catch {}
  }
  return null;
});

ipcMain.handle('cosmetics-install-mod', async (_e, opts: { mcVersion: string }) => {
  try {
    const modsDir = modsDirFor(opts.mcVersion);
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
    const src = app.isPackaged
      ? path.join(process.resourcesPath, 'mods', 'voxel-cosmetics.jar')
      : path.join(__dirname, '../../resources/mods/voxel-cosmetics.jar');
    if (!fs.existsSync(src)) return { ok: false, error: 'Mod JAR not found — build the fabric-mod project first' };
    fs.copyFileSync(src, path.join(modsDir, 'voxel-cosmetics.jar'));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: repair (delete cached game files) ────────────────────────────────────
ipcMain.handle('mc-repair', async () => {
  try {
    const mcRoot = path.join(app.getPath('userData'), '.minecraft');
    fs.rmSync(mcRoot, { recursive: true, force: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: crash report + log reader ───────────────────────────────────────────
ipcMain.handle('mc-crash-report', async () => {
  const mcRoot = path.join(app.getPath('userData'), '.minecraft');
  const results: string[] = [];

  // Read latest.log
  try {
    const logPath = path.join(mcRoot, 'logs', 'latest.log');
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n');
      // Last 100 lines of the log
      results.push('=== latest.log (last 100 lines) ===');
      results.push(...lines.slice(-100));
    }
  } catch {}

  // Read newest crash report
  try {
    const crashDir = path.join(mcRoot, 'crash-reports');
    if (fs.existsSync(crashDir)) {
      const files = fs.readdirSync(crashDir)
        .filter(f => f.endsWith('.txt'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(crashDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length) {
        const content = fs.readFileSync(path.join(crashDir, files[0].name), 'utf-8');
        results.push(`=== crash-reports/${files[0].name} ===`);
        results.push(...content.split('\n').slice(0, 80));
      }
    }
  } catch {}

  if (!results.length) return { ok: false, error: 'No log files found in ' + mcRoot };
  return { ok: true, name: 'logs', content: results.join('\n') };
});

// ── IPC: Bedrock Edition launch ───────────────────────────────────────────────
ipcMain.handle('mc-launch-bedrock', async () => {
  try {
    const bedrockDir = path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.MinecraftUWP_8wekyb3d8bbwe');
    const installed = fs.existsSync(bedrockDir);
    if (installed) {
      await shell.openExternal('minecraft:');
      return { ok: true };
    } else {
      await shell.openExternal('ms-windows-store://pdp/?ProductId=9NBLGGH2JHXJ');
      return { ok: false, notInstalled: true };
    }
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

function bedrockComMojangDir(): string {
  return path.join(process.env.LOCALAPPDATA || '', 'Packages', 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', 'LocalState', 'games', 'com.mojang');
}

// ── IPC: Bedrock addon install/list/remove (toggle-style, like Java mods) ─────
// Bedrock has no single "enabled mods" list like Fabric — install/uninstall
// here means the pack's files exist under com.mojang, available to enable
// per-world from Bedrock's own UI (there's no supported way to do per-world
// activation externally).
ipcMain.handle('mc-install-bedrock-pack', async (_e, opts: { url: string; name: string }) => {
  try {
    const comMojang = bedrockComMojangDir();
    if (!fs.existsSync(comMojang)) throw new Error('Bedrock Edition is not installed');

    const tmpDir = path.join(app.getPath('temp'), 'voxel-bedrock-packs');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `dl-${Date.now()}.zip`);
    await downloadFileTo(opts.url, tmpFile);
    const buf = fs.readFileSync(tmpFile);
    try { fs.unlinkSync(tmpFile); } catch {}

    const stagingDir = path.join(tmpDir, `staging-${Date.now()}`);
    extractZipAll(buf, stagingDir);

    // manifest.json is usually at the archive root, sometimes one folder in
    function findManifestDir(dir: string, depth = 0): string | null {
      if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
      if (depth >= 2) return null;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const found = findManifestDir(path.join(dir, entry.name), depth + 1);
          if (found) return found;
        }
      }
      return null;
    }
    const packRoot = findManifestDir(stagingDir);
    if (!packRoot) { fs.rmSync(stagingDir, { recursive: true, force: true }); throw new Error('No manifest.json found in this pack'); }

    const manifest = JSON.parse(fs.readFileSync(path.join(packRoot, 'manifest.json'), 'utf-8'));
    const isBehavior = (manifest.modules || []).some((m: any) => m.type === 'data');
    const packType = isBehavior ? 'behavior_packs' : 'resource_packs';
    const packId = (manifest.header?.uuid || opts.name).replace(/[^a-zA-Z0-9_-]/g, '_');
    const destDir = path.join(comMojang, packType, packId);

    fs.rmSync(destDir, { recursive: true, force: true });
    copyDirRecursive(packRoot, destDir);
    fs.rmSync(stagingDir, { recursive: true, force: true });

    return { ok: true, packId, packType, name: manifest.header?.name || opts.name };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mc-list-bedrock-packs', async () => {
  const comMojang = bedrockComMojangDir();
  const packs: { packId: string; packType: string; name: string }[] = [];
  try {
    for (const packType of ['resource_packs', 'behavior_packs']) {
      const dir = path.join(comMojang, packType);
      if (!fs.existsSync(dir)) continue;
      for (const packId of fs.readdirSync(dir)) {
        const manifestPath = path.join(dir, packId, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          packs.push({ packId, packType, name: manifest.header?.name || packId });
        } catch {}
      }
    }
    return { ok: true, packs };
  } catch (err: any) {
    return { ok: false, error: err.message, packs };
  }
});

ipcMain.handle('mc-remove-bedrock-pack', async (_e, opts: { packId: string; packType: string }) => {
  try {
    fs.rmSync(path.join(bedrockComMojangDir(), opts.packType, opts.packId), { recursive: true, force: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: skin upload ──────────────────────────────────────────────────────────
ipcMain.handle('mc-upload-skin', async (_e, opts: { base64: string; variant: 'classic' | 'slim' }) => {
  if (!mcAuthToken?.access_token) return { ok: false, error: 'Not authenticated' };
  try {
    const buf = Buffer.from(opts.base64, 'base64');
    const boundary = '----VoxelBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="variant"\r\n\r\n${opts.variant}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skin.png"\r\nContent-Type: image/png\r\n\r\n`),
      buf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await (net.fetch as any)('https://api.minecraftservices.com/minecraft/profile/skins', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${mcAuthToken.access_token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── Helper: stream download to disk ──────────────────────────────────────────
// Minimal ZIP extractor — reads a single named entry from a .zip / .mrpack
function extractFromZip(buf: Buffer, target: string): Promise<Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return Promise.reject(new Error('Not a valid ZIP file'));
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize   = buf.readUInt32LE(eocd + 12);
  let pos = cdOffset;
  while (pos < cdOffset + cdSize) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method     = buf.readUInt16LE(pos + 10);
    const compSize   = buf.readUInt32LE(pos + 20);
    const fnLen      = buf.readUInt16LE(pos + 28);
    const extraLen   = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lhOffset   = buf.readUInt32LE(pos + 42);
    const name       = buf.slice(pos + 46, pos + 46 + fnLen).toString('utf-8');
    if (name === target) {
      const lhFnLen    = buf.readUInt16LE(lhOffset + 26);
      const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
      const dataStart  = lhOffset + 30 + lhFnLen + lhExtraLen;
      const compressed = buf.slice(dataStart, dataStart + compSize);
      if (method === 0) return Promise.resolve(Buffer.from(compressed));
      if (method === 8) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const zlibMod = require('zlib');
        return new Promise((res, rej) =>
          zlibMod.inflateRaw(compressed, (err: Error | null, r: Buffer) => err ? rej(err) : res(r))
        );
      }
      return Promise.reject(new Error(`Unsupported ZIP compression: ${method}`));
    }
    pos += 46 + fnLen + extraLen + commentLen;
  }
  return Promise.reject(new Error(`'${target}' not found in archive`));
}

// Full ZIP extraction (all entries) — used for Bedrock .mcpack/.mcaddon
// installs, which need the whole pack directory, not just one file.
function extractZipAll(buf: Buffer, destDir: string): void {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP file');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize   = buf.readUInt32LE(eocd + 12);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zlibMod = require('zlib');
  let pos = cdOffset;
  while (pos < cdOffset + cdSize) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method     = buf.readUInt16LE(pos + 10);
    const compSize   = buf.readUInt32LE(pos + 20);
    const fnLen      = buf.readUInt16LE(pos + 28);
    const extraLen   = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const lhOffset   = buf.readUInt32LE(pos + 42);
    const name       = buf.slice(pos + 46, pos + 46 + fnLen).toString('utf-8');

    if (!name.endsWith('/') && !name.includes('..')) {
      const lhFnLen    = buf.readUInt16LE(lhOffset + 26);
      const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
      const dataStart  = lhOffset + 30 + lhFnLen + lhExtraLen;
      const compressed = buf.slice(dataStart, dataStart + compSize);
      const data = method === 0 ? compressed
        : method === 8 ? zlibMod.inflateRawSync(compressed)
        : null;
      if (data) {
        const outPath = path.join(destDir, name);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, data);
      }
    }
    pos += 46 + fnLen + extraLen + commentLen;
  }
}

function downloadFileTo(url: string, dest: string, onPct?: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let downloaded = 0;
    function doGet(u: string) {
      https.get(u, { headers: { 'User-Agent': 'VoxelClient' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          res.resume(); doGet(res.headers.location!); return;
        }
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        const total = parseInt(res.headers['content-length'] || '0');
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          if (onPct && total > 0) onPct(Math.round(downloaded / total * 100));
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        res.on('error', reject);
      }).on('error', reject);
    }
    doGet(url);
  });
}

function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyDirRecursive(s, d) : fs.copyFileSync(s, d);
  }
}

ipcMain.handle('server-pick-world', async () => {
  const result = await dialog.showOpenDialog(gameWin!, {
    title: 'Select Minecraft World Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Returns the Java major version required to run a given Minecraft version
function javaForMcVersion(id: string): number {
  const m = id.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const maj = parseInt(m[1]);
  if (maj !== 1) return 25;                           // year-based (26.x …) → Java 25
  const min = parseInt(m[2]);
  const patch = m[3] ? parseInt(m[3]) : 0;
  if (min < 17) return 8;
  if (min < 21) return 17;
  if (min === 21 && patch <= 11) return 21;
  return 25;                                          // 1.21.12+ → Java 25
}

// Try PaperMC API for a server JAR download URL
async function getPaperJarUrl(version: string): Promise<{ url: string; size: number } | null> {
  try {
    const data = await fetchJson(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds`);
    const builds: any[] = data.builds ?? [];
    if (!builds.length) return null;
    const latest  = builds[builds.length - 1];
    const dlName  = latest.downloads?.application?.name as string | undefined;
    if (!dlName) return null;
    return {
      url:  `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${latest.build}/downloads/${dlName}`,
      size: latest.downloads?.application?.size ?? 0,
    };
  } catch { return null; }
}

// ── IPC: server hosting ───────────────────────────────────────────────────────
ipcMain.handle('server-start', async (_e, opts: { version: string; maxMem: number; minMem?: number; name: string; port?: number; maxPlayers?: number; motd?: string; seed?: string; worldPath?: string; javaVersion?: number; }) => {
  if (serverProcess) return { ok: false, error: 'Server is already running' };
  try {
    const serverDir = path.join(app.getPath('userData'), 'mc-server', opts.version);
    const jarPath   = path.join(serverDir, 'server.jar');
    fs.mkdirSync(serverDir, { recursive: true });

    // Download server.jar if not cached
    if (!fs.existsSync(jarPath)) {
      gameWin?.webContents.send('server-log', '[Host] Fetching version info…');

      let dlUrl  = '';
      let dlSize = 0;

      // 1. Try Mojang manifest (vanilla)
      try {
        const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
        const entry    = (manifest.versions as any[]).find((v: any) => v.id === opts.version);
        if (entry) {
          const info = await fetchJson(entry.url);
          dlUrl  = info.downloads?.server?.url  ?? '';
          dlSize = info.downloads?.server?.size ?? 0;
        }
      } catch {}

      // 2. Fall back to PaperMC (handles year-based versions and versions missing from Mojang manifest)
      if (!dlUrl) {
        gameWin?.webContents.send('server-log', '[Host] Not in Mojang manifest — trying PaperMC…');
        const paper = await getPaperJarUrl(opts.version);
        if (paper) { dlUrl = paper.url; dlSize = paper.size; gameWin?.webContents.send('server-log', '[Host] Found on PaperMC ✓'); }
      }

      if (!dlUrl) throw new Error(`No server JAR found for ${opts.version}. Check the version name and try again.`);

      const sizeMB = dlSize > 0 ? ` (${Math.round(dlSize / 1024 / 1024)}MB)` : '';
      gameWin?.webContents.send('server-log', `[Host] Downloading server.jar${sizeMB}…`);
      let lastPct = -1;
      await downloadFileTo(dlUrl, jarPath, pct => {
        if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; gameWin?.webContents.send('server-log', `[Host] Downloading… ${pct}%`); }
      });
      gameWin?.webContents.send('server-log', '[Host] Download complete');
    }

    // Always accept EULA
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');

    // Import world folder — always overwrite so the user's chosen save is used
    const worldDestDir = path.join(serverDir, 'world');
    if (opts.worldPath) {
      gameWin?.webContents.send('server-log', '[Host] Importing world — this may take a moment…');
      if (fs.existsSync(worldDestDir)) fs.rmSync(worldDestDir, { recursive: true, force: true });
      copyDirRecursive(opts.worldPath, worldDestDir);
      gameWin?.webContents.send('server-log', '[Host] World imported');
    }

    // Write server.properties — online-mode=false avoids Mojang auth socket errors
    const propsPath = path.join(serverDir, 'server.properties');
    // Patch server.properties — write defaults on first run, then patch specific keys each start
    const patchProps: Record<string, string> = {
      'online-mode':              'false',
      'server-port':              String(opts.port        ?? 25565),
      'server-ip':                '',
      'max-players':              String(opts.maxPlayers  ?? 20),
      'view-distance':            '10',
      'motd':                     opts.motd               || 'Voxel Client Server',
      'pause-when-empty-seconds': '0',
      'spawn-protection':         '32',
      'enforce-secure-profile':   'false',
    };
    if (opts.seed) patchProps['level-seed'] = opts.seed;
    let propsContent = fs.existsSync(propsPath) ? fs.readFileSync(propsPath, 'utf-8') : '';
    for (const [k, v] of Object.entries(patchProps)) {
      const re = new RegExp(`^${k}=.*`, 'm');
      propsContent = re.test(propsContent) ? propsContent.replace(re, `${k}=${v}`) : `${k}=${v}\n` + propsContent;
    }
    fs.writeFileSync(propsPath, propsContent || Object.entries(patchProps).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');

    // Resolve Java the same way as game launch (bundled → cache → system → download)
    // Use java.exe not javaw.exe — server needs stdout
    const srvJava = opts.javaVersion ?? javaForMcVersion(opts.version);
    const javawPath = await ensureJava(srvJava, (msg) => gameWin?.webContents.send('server-log', msg));
    const javaExe   = javawPath.replace(/javaw(\.exe)?$/i, 'java$1');

    const port    = opts.port ?? 25565;
    const minMemM = (opts.minMem ?? 512);

    // Open Windows Firewall for this port so clients can connect (best-effort, no UAC required for local rules)
    try {
      spawnSync('netsh', [
        'advfirewall', 'firewall', 'add', 'rule',
        `name=VoxelClientServer_${port}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`,
      ], { windowsHide: true });
    } catch {}

    gameWin?.webContents.send('server-log', `[Host] Starting Minecraft ${opts.version} on port ${port}…`);
    serverProcess = spawn(javaExe, [
      `-Xmx${opts.maxMem}G`, `-Xms${minMemM}M`, '-jar', 'server.jar', '--nogui',
    ], { cwd: serverDir, stdio: ['pipe', 'pipe', 'pipe'] });

    // Keep system awake while server runs
    srvUserStopped = false;
    if (keepAwakeId === null) keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');

    let serverReady = false;
    const handleOut = (d: Buffer) => {
      const text = d.toString();
      gameWin?.webContents.send('server-log', text);
      // Detect server fully started
      if (!serverReady && (text.includes(' Done (') || text.includes('! Done'))) {
        serverReady = true;
        gameWin?.webContents.send('server-ready', port);
      }
      // Player join → restore window + notify renderer + starter kit
      const joinM = text.match(/(\w+) joined the game/);
      if (joinM) {
        if (gameWin?.isMinimized()) gameWin.restore();
        gameWin?.show();
        const player = joinM[1];
        gameWin?.webContents.send('server-player-join', player);

        // First-join starter kit: 16 steak, stone tools, leather armor
        const kitsPath = path.join(serverDir, 'kits-given.json');
        let kitsGiven: string[] = [];
        try { kitsGiven = JSON.parse(fs.readFileSync(kitsPath, 'utf-8')); } catch {}
        if (!kitsGiven.includes(player)) {
          kitsGiven.push(player);
          try { fs.writeFileSync(kitsPath, JSON.stringify(kitsGiven)); } catch {}
          setTimeout(() => {
            if (!serverProcess?.stdin) return;
            const give = (item: string, n: number) =>
              serverProcess!.stdin!.write(`give ${player} ${item} ${n}\n`);
            give('minecraft:cooked_beef',        16);
            give('minecraft:stone_sword',         1);
            give('minecraft:stone_pickaxe',       1);
            give('minecraft:stone_axe',           1);
            give('minecraft:stone_shovel',        1);
            give('minecraft:leather_helmet',      1);
            give('minecraft:leather_chestplate',  1);
            give('minecraft:leather_leggings',    1);
            give('minecraft:leather_boots',       1);
            gameWin?.webContents.send('server-log', `[Host] Starter kit sent to ${player}\n`);
          }, 2500);
        }
      }
      // Player count from /list response
      const cntM = text.match(/There are (\d+) of a max(?: of)? (\d+) players/);
      if (cntM) gameWin?.webContents.send('server-player-count', parseInt(cntM[1]), parseInt(cntM[2]));
    };
    serverProcess.stdout?.on('data', handleOut);
    serverProcess.stderr?.on('data', (d: Buffer) => gameWin?.webContents.send('server-log', d.toString()));
    serverProcess.on('close', (code: number) => {
      if (keepAwakeId !== null) { powerSaveBlocker.stop(keepAwakeId); keepAwakeId = null; }
      serverProcess = null;
      gameWin?.webContents.send('server-closed', { code: code ?? 0, userStopped: srvUserStopped });
      srvUserStopped = false;
    });

    return { ok: true };
  } catch (err: any) {
    serverProcess = null;
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server-set-autostart', (_e, enabled: boolean) => {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath('exe') });
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err.message }; }
});

ipcMain.handle('server-get-autostart', () => {
  try { return { ok: true, enabled: app.getLoginItemSettings().openAtLogin }; }
  catch { return { ok: true, enabled: false }; }
});

ipcMain.handle('server-stop', async () => {
  if (!serverProcess) return { ok: false, error: 'Not running' };
  srvUserStopped = true;
  serverProcess.stdin?.write('stop\n');
  setTimeout(() => { try { serverProcess?.kill(); } catch {} }, 15000);
  return { ok: true };
});

ipcMain.handle('server-command', async (_e, cmd: string) => {
  if (!serverProcess?.stdin) return { ok: false, error: 'Server not running' };
  serverProcess.stdin.write(cmd + '\n');
  return { ok: true };
});

ipcMain.handle('server-open-folder', async (_e, version: string) => {
  const dir = path.join(app.getPath('userData'), 'mc-server', version || 'default');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
  return { ok: true };
});

// ── IPC: mod install / remove ─────────────────────────────────────────────────
// Each Minecraft version gets its own mods folder — vanilla Fabric has no
// concept of per-version mod isolation in a single shared mods/ directory,
// which is exactly why version-incompatible mods kept accumulating and
// crashing launches. Fabric Loader's own fabric.modsFolder system property
// (set at launch time, see buildLoaderLaunchOptions) points it at whichever
// version-scoped folder matches what's actually being launched.
function modsDirFor(mcVersion: string): string {
  const safe = (mcVersion || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(app.getPath('userData'), '.minecraft', 'mods-by-version', safe);
}

ipcMain.handle('mc-install-mod', async (_e, opts: { url: string; filename: string; mcVersion: string }) => {
  try {
    const modsDir = modsDirFor(opts.mcVersion);
    fs.mkdirSync(modsDir, { recursive: true });
    await downloadFileTo(opts.url, path.join(modsDir, opts.filename));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mc-list-mods', async (_e, opts: { mcVersion: string }) => {
  const modsDir = modsDirFor(opts.mcVersion);
  const disabledDir = path.join(modsDir, '.disabled');
  try {
    const active   = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((f: string) => f.endsWith('.jar')) : [];
    // Disabled mods live in a subfolder, not deleted — they must still count
    // as "on disk" or the renderer's disk-sync wipes them from its saved
    // installed-mods list on every launch.
    const disabled = fs.existsSync(disabledDir) ? fs.readdirSync(disabledDir).filter((f: string) => f.endsWith('.jar')) : [];
    return [...active, ...disabled];
  } catch { return []; }
});

ipcMain.handle('mc-remove-mod', async (_e, opts: { filename: string; mcVersion: string }) => {
  try {
    const modsDir = modsDirFor(opts.mcVersion);
    const dest = path.join(modsDir, opts.filename);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    const disabledDest = path.join(modsDir, '.disabled', opts.filename);
    if (fs.existsSync(disabledDest)) fs.unlinkSync(disabledDest);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mc-toggle-mod', async (_e, opts: { filename: string; enable: boolean; mcVersion: string }) => {
  try {
    const modsDir     = modsDirFor(opts.mcVersion);
    const disabledDir = path.join(modsDir, '.disabled');
    if (!fs.existsSync(disabledDir)) fs.mkdirSync(disabledDir, { recursive: true });
    const src = opts.enable ? path.join(disabledDir, opts.filename) : path.join(modsDir, opts.filename);
    const dst = opts.enable ? path.join(modsDir, opts.filename)     : path.join(disabledDir, opts.filename);
    if (fs.existsSync(src)) fs.renameSync(src, dst);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mc-install-modpack', async (_e: any, opts: { projectId: string }) => {
  const send = (data: object) => gameWin?.webContents.send('mc-modpack-progress', data);
  try {
    send({ phase: 'fetching' });
    const versions = await fetchJson(`https://api.modrinth.com/v2/project/${opts.projectId}/version?limit=5`);
    if (!Array.isArray(versions) || !versions.length) throw new Error('No versions found');

    const mrpackFile = (versions[0].files as any[]).find((f: any) => f.filename?.endsWith('.mrpack'));
    if (!mrpackFile) throw new Error('No .mrpack file in latest release');

    const tmpPath = path.join(os.tmpdir(), `voxel-modpack-${opts.projectId}.mrpack`);
    send({ phase: 'downloading', pct: 0 });
    await downloadFileTo(mrpackFile.url, tmpPath, pct => send({ phase: 'downloading', pct }));

    const zipBuf = fs.readFileSync(tmpPath);
    const indexBuf = await extractFromZip(zipBuf, 'modrinth.index.json');
    const index = JSON.parse(indexBuf.toString('utf-8'));
    try { fs.unlinkSync(tmpPath); } catch {}

    const modFiles: any[] = (index.files || []).filter((f: any) =>
      Array.isArray(f.downloads) && f.downloads.length && typeof f.path === 'string' && f.path.startsWith('mods/')
    );
    const packMcVersion = (index.dependencies?.minecraft ?? '') as string;
    const modsDir = modsDirFor(packMcVersion);
    fs.mkdirSync(modsDir, { recursive: true });
    const installed: string[] = [];
    for (let i = 0; i < modFiles.length; i++) {
      const f = modFiles[i];
      const filename = path.basename(f.path);
      send({ phase: 'mods', current: i + 1, total: modFiles.length });
      try {
        await downloadFileTo(f.downloads[0], path.join(modsDir, filename));
        installed.push(filename);
      } catch {}
    }
    return {
      ok: true,
      filenames: installed,
      mcVersion: packMcVersion,
      fabricVersion: (index.dependencies?.['fabric-loader'] ?? '') as string,
      versionId: versions[0].id as string,
    };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── CurseForge mod search ──────────────────────────────────────────────────────
const CF_BASE = 'https://api.curseforge.com/v1';
const cfHeaders = () => ({ 'x-api-key': CF_API_KEY, 'Content-Type': 'application/json' });

ipcMain.handle('cf-search', async (_e, opts: { query: string; mcVersion: string }) => {
  if (!CF_API_KEY) return { ok: false, error: 'No CurseForge API key configured' };
  try {
    const params = new URLSearchParams({
      gameId: '432',           // Minecraft
      classId: '6',            // Mods only — without this, modpacks/resource packs/
                                // worlds show up mixed in and get force-installed as
                                // if they were a single mod jar when toggled on
      searchFilter: opts.query,
      modLoaderType: '4',      // Fabric
      gameVersion: opts.mcVersion || '1.21.4',
      pageSize: '20',
      sortField: opts.query ? '2' : '6', // relevance : totalDownloads
      sortOrder: 'desc',
    });
    const res = await fetch(`${CF_BASE}/mods/search?${params}`, { headers: cfHeaders() });
    if (!res.ok) throw new Error(`CurseForge API error ${res.status}`);
    const data: any = await res.json();
    return { ok: true, data: data.data ?? [] };
  } catch (err: any) { return { ok: false, error: err.message }; }
});

ipcMain.handle('cf-get-download-url', async (_e, opts: { modId: number; mcVersion: string }) => {
  if (!CF_API_KEY) return { ok: false, error: 'No CurseForge API key configured' };
  try {
    const params = new URLSearchParams({
      gameVersion: opts.mcVersion || '1.21.4',
      modLoaderType: '4',
      pageSize: '5',
    });
    const res = await fetch(`${CF_BASE}/mods/${opts.modId}/files?${params}`, { headers: cfHeaders() });
    if (!res.ok) throw new Error(`CurseForge API error ${res.status}`);
    const data: any = await res.json();
    const files: any[] = data.data ?? [];
    if (!files.length) throw new Error('No files found for this Minecraft version');
    const file = files[0];
    // Build CDN URL from file ID
    const id = file.id as number;
    const url = file.downloadUrl || `https://mediafiles.forgecdn.net/files/${Math.floor(id/1000)}/${id%1000}/${encodeURIComponent(file.fileName)}`;
    return { ok: true, url, filename: file.fileName, fileId: id };
  } catch (err: any) { return { ok: false, error: err.message }; }
});

// Checks each installed CurseForge mod against the given Minecraft version and
// reports: up to date, an available update, or incompatible (no file exists
// for that version/loader at all — the caller disables the mod in that case).
ipcMain.handle('cf-check-updates', async (_e, mods: { modId: number; fileId: number }[], mcVersion: string) => {
  if (!CF_API_KEY) return { ok: false, error: 'No CurseForge API key configured' };

  async function checkOne(m: { modId: number; fileId: number }) {
    try {
      const params = new URLSearchParams({ gameVersion: mcVersion || '1.21.4', modLoaderType: '4', pageSize: '5' });
      const res = await fetch(`${CF_BASE}/mods/${m.modId}/files?${params}`, { headers: cfHeaders() });
      if (res.status === 429) return { modId: m.modId, checkFailed: true, error: 'Rate limited' };
      if (!res.ok) return { modId: m.modId, checkFailed: true, error: `CurseForge API error ${res.status}` };
      const data: any = await res.json();
      const files: any[] = data.data ?? [];
      // An empty result confirms no file exists for this version/loader —
      // genuinely incompatible, as opposed to a network/rate-limit failure.
      if (!files.length) return { modId: m.modId, compatible: false };
      const latest = files[0];
      const id = latest.id as number;
      const url = latest.downloadUrl || `https://mediafiles.forgecdn.net/files/${Math.floor(id/1000)}/${id%1000}/${encodeURIComponent(latest.fileName)}`;
      return {
        modId: m.modId, compatible: true,
        upToDate: id === m.fileId,
        fileId: id, filename: latest.fileName, url,
      };
    } catch (err: any) {
      return { modId: m.modId, checkFailed: true, error: err.message };
    }
  }

  // Batch with a small concurrency limit instead of firing everything at
  // once — CurseForge rate-limits bursts, which previously got misread as
  // "no compatible file exists" and disabled mods that were actually fine.
  const results: any[] = [];
  const BATCH_SIZE = 5;
  for (let i = 0; i < mods.length; i += BATCH_SIZE) {
    const batch = mods.slice(i, i + BATCH_SIZE);
    results.push(...await Promise.all(batch.map(checkOne)));
  }
  return { ok: true, results };
});

// ── options.txt helpers ───────────────────────────────────────────────────────
function setOptionsKey(mcRoot: string, key: string, value: string) {
  const optPath = path.join(mcRoot, 'options.txt');
  let txt = fs.existsSync(optPath) ? fs.readFileSync(optPath, 'utf-8') : '';
  const re = new RegExp(`^${key}:.*`, 'm');
  if (re.test(txt)) {
    txt = txt.replace(re, `${key}:${value}`);
  } else {
    txt += (txt.endsWith('\n') || txt === '' ? '' : '\n') + `${key}:${value}\n`;
  }
  try { fs.writeFileSync(optPath, txt, 'utf-8'); } catch {}
}

function applyShaderPack(mcRoot: string, packName: string) {
  try {
    const irisDir = path.join(mcRoot, 'config');
    if (!fs.existsSync(irisDir)) fs.mkdirSync(irisDir, { recursive: true });
    const irisProps = path.join(irisDir, 'iris.properties');
    let content = fs.existsSync(irisProps) ? fs.readFileSync(irisProps, 'utf-8') : '';
    function setProp(txt: string, key: string, val: string): string {
      const re = new RegExp(`^${key}=.*`, 'm');
      if (re.test(txt)) return txt.replace(re, `${key}=${val}`);
      return txt + (txt.endsWith('\n') || txt === '' ? '' : '\n') + `${key}=${val}\n`;
    }
    if (packName) {
      content = setProp(content, 'shaderPack', packName);
      content = setProp(content, 'enableShaders', 'true');
    } else {
      content = setProp(content, 'enableShaders', 'false');
    }
    fs.writeFileSync(irisProps, content, 'utf-8');
  } catch {}
}

function enableVoxelResourcePack(mcRoot: string) {
  const optPath = path.join(mcRoot, 'options.txt');
  let txt = fs.existsSync(optPath) ? fs.readFileSync(optPath, 'utf-8') : '';

  function addToPackList(key: string, t: string): string {
    const re = new RegExp(`${key}:\\[([^\\]]*)\\]`);
    if (re.test(t)) {
      return t.replace(re, (_m, inner) => {
        const items = (inner as string).split(',').filter(s => s && !s.includes('VoxelClient'));
        items.unshift('"file/VoxelClient"');
        return `${key}:[${items.join(',')}]`;
      });
    }
    return t + (t.endsWith('\n') || t === '' ? '' : '\n') + `${key}:["file/VoxelClient"]\n`;
  }

  txt = addToPackList('resourcePacks', txt);
  txt = addToPackList('incompatibleResourcePacks', txt);
  try { fs.writeFileSync(optPath, txt, 'utf-8'); } catch {}
}

// ── IPC: in-game background resource pack ─────────────────────────────────────
ipcMain.handle('mc-install-bg', async (_e, opts: { images: string[] }) => {
  try {
    const mcRoot  = path.join(app.getPath('userData'), '.minecraft');
    const packDir = path.join(mcRoot, 'resourcepacks', 'VoxelClient');
    const texDir  = path.join(packDir, 'assets', 'minecraft', 'textures', 'gui', 'title', 'background');
    fs.mkdirSync(texDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.mcmeta'), JSON.stringify({
      pack: { pack_format: 15, supported_formats: { min_inclusive: 1, max_inclusive: 9999 }, description: 'Voxel Client Theme' }
    }));
    for (let i = 0; i < 6 && i < opts.images.length; i++) {
      fs.writeFileSync(path.join(texDir, `panorama_${i}.png`), Buffer.from(opts.images[i], 'base64'));
    }
    // Enable in options.txt — create the file if it doesn't exist yet
    enableVoxelResourcePack(mcRoot);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: Fabric loader install ────────────────────────────────────────────────
// A profile from before the library-dedup fix can have the same artifact
// (e.g. ASM) listed at two different versions, which crashes at launch with
// "duplicate ASM classes found on classpath" — such a profile must not be
// treated as a valid cached install, or it'll never get regenerated.
function isValidFabricProfile(profilePath: string): boolean {
  if (!fs.existsSync(profilePath)) return false;
  try {
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    if (!profile.downloads) return false;
    const seen = new Set<string>();
    for (const lib of profile.libraries ?? []) {
      let key: string | null = null;
      if (typeof lib?.name === 'string') {
        const parts = lib.name.split(':');
        key = `${parts[0]}:${parts[1]}:${parts[3] ?? ''}`;
      }
      if (key) { if (seen.has(key)) return false; seen.add(key); }
    }
    return true;
  } catch { return false; }
}

ipcMain.handle('mc-install-fabric', async (_e, opts: { mcVersion: string }) => {
  try {
    const mcRoot = path.join(app.getPath('userData'), '.minecraft');

    // Skip the network round-trip entirely if a valid Fabric install for
    // this MC version already exists — every launch used to pay for a
    // "what's the latest loader" request even when nothing needed to
    // change, adding real latency before the JVM could even start.
    const versionsDir = path.join(mcRoot, 'versions');
    const existingId = fs.existsSync(versionsDir)
      ? fs.readdirSync(versionsDir).find(d =>
          d.startsWith('fabric-loader-') && d.endsWith(`-${opts.mcVersion}`) &&
          isValidFabricProfile(path.join(versionsDir, d, `${d}.json`)))
      : undefined;
    if (existingId) {
      gameWin?.webContents.send('mc-log', `[Fabric] ${existingId} already installed`);
      const loaderVersion = existingId.replace(/^fabric-loader-/, '').replace(new RegExp(`-${opts.mcVersion}$`), '');
      return { ok: true, fabricVersion: existingId, loaderVersion };
    }

    const loaders = await fetchJson('https://meta.fabricmc.net/v2/versions/loader');
    const loader  = (loaders as any[]).find((l: any) => l.stable) ?? loaders[0];
    if (!loader) throw new Error('No Fabric loader found');
    const loaderVer = loader.version as string;

    const fabricId   = `fabric-loader-${loaderVer}-${opts.mcVersion}`;
    const versionDir = path.join(mcRoot, 'versions', fabricId);
    const profilePath = path.join(versionDir, `${fabricId}.json`);

    // Always reinstall if the saved profile is missing the merged vanilla
    // fields or has a duplicate-artifact conflict from before the dedup fix.
    const needsInstall = !isValidFabricProfile(profilePath);

    if (needsInstall) {
      gameWin?.webContents.send('mc-log', `[Fabric] Installing ${fabricId}…`);

      // Fabric profile (has mainClass, Fabric libraries, inheritsFrom)
      const fabricProfile = await fetchJson(
        `https://meta.fabricmc.net/v2/versions/loader/${opts.mcVersion}/${loaderVer}/profile/json`
      ) as any;

      // Vanilla MC manifest → get the specific version JSON (has downloads, assetIndex, vanilla libs)
      const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json') as any;
      const entry = manifest.versions?.find((v: any) => v.id === opts.mcVersion);
      if (!entry) throw new Error(`Vanilla ${opts.mcVersion} not in Mojang manifest`);
      const vanilla = await fetchJson(entry.url) as any;

      // Vanilla and Fabric can both declare the same library at different
      // versions (e.g. vanilla ships an older ASM than Fabric Loader needs)
      // — a plain concatenation puts both jars on the classpath at once,
      // which crashes with "duplicate ASM classes found on classpath".
      // Dedupe by groupId:artifactId:classifier, keeping Fabric's version on
      // conflict since it's appended after vanilla's and Fabric needs its own.
      // The classifier must be part of the key — otherwise platform-native
      // variants of the same artifact (e.g. com.mojang:jtracy's plain jar vs
      // its natives-windows/linux/macos jars) collapse into a single entry,
      // silently dropping the base jar with the actual Java classes and
      // causing a NoClassDefFoundError at runtime.
      function dedupeLibraries(libs: any[]): any[] {
        const byArtifact = new Map<string, any>();
        for (const lib of libs) {
          let key = lib?.name;
          if (typeof lib?.name === 'string') {
            const parts = lib.name.split(':');
            key = `${parts[0]}:${parts[1]}:${parts[3] ?? ''}`;
          }
          byArtifact.set(key, lib);
        }
        return Array.from(byArtifact.values());
      }

      // Merge: vanilla base + Fabric mainClass + deduped libraries + combined arguments
      const merged = {
        ...vanilla,
        id: fabricId,
        mainClass: fabricProfile.mainClass,
        libraries: dedupeLibraries([...(vanilla.libraries ?? []), ...(fabricProfile.libraries ?? [])]),
        arguments: {
          game: [...(vanilla.arguments?.game ?? []), ...(fabricProfile.arguments?.game ?? [])],
          jvm:  [...(vanilla.arguments?.jvm  ?? []), ...(fabricProfile.arguments?.jvm  ?? [])],
        },
      };

      fs.mkdirSync(versionDir, { recursive: true });
      fs.writeFileSync(profilePath, JSON.stringify(merged));
      gameWin?.webContents.send('mc-log', `[Fabric] Installed ${fabricId}`);
    } else {
      gameWin?.webContents.send('mc-log', `[Fabric] ${fabricId} already installed`);
    }

    return { ok: true, fabricVersion: fabricId, loaderVersion: loaderVer };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── Forge / NeoForge install ───────────────────────────────────────────────────
// minecraft-launcher-core has built-in modern-Forge support: give it the path
// to the official installer jar via `forge`, and it downloads a small
// "ForgeWrapper" helper and does the whole install at launch time. NeoForge
// kept the same installer format specifically for third-party launcher
// compatibility, so the same mechanism works for it too. We just need to
// resolve the right version and download its installer jar.
ipcMain.handle('mc-install-forge', async (_e, opts: { mcVersion: string }) => {
  try {
    const promotions = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json') as any;
    const promos = promotions.promos ?? {};
    const forgeVer = promos[`${opts.mcVersion}-recommended`] || promos[`${opts.mcVersion}-latest`];
    if (!forgeVer) throw new Error(`No Forge build available for Minecraft ${opts.mcVersion}`);
    const fullVer = `${opts.mcVersion}-${forgeVer}`;

    const tmpDir = path.join(app.getPath('temp'), 'voxel-loader-installers');
    fs.mkdirSync(tmpDir, { recursive: true });
    const installerPath = path.join(tmpDir, `forge-${fullVer}-installer.jar`);
    if (!fs.existsSync(installerPath)) {
      gameWin?.webContents.send('mc-log', `[Forge] Downloading installer for ${fullVer}…`);
      const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`;
      await downloadFileTo(installerUrl, installerPath, (p) => gameWin?.webContents.send('mc-progress', { type: 'forge-download', percent: p }));
    }

    return { ok: true, installerPath, mcVersion: opts.mcVersion, loaderVersion: forgeVer };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mc-install-neoforge', async (_e, opts: { mcVersion: string }) => {
  try {
    // NeoForge versions are numbered like "<minor>.<patch>.<build>" (e.g. 1.21.1 → 21.1.x)
    const m = opts.mcVersion.match(/^1\.(\d+)(?:\.(\d+))?$/);
    if (!m) throw new Error(`NeoForge doesn't support Minecraft ${opts.mcVersion}`);
    const prefix = `${m[1]}.${m[2] || '0'}.`;

    const xml = await new Promise<string>((resolve, reject) => {
      https.get('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', res => {
        let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data)); res.on('error', reject);
      }).on('error', reject);
    });
    const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m2 => m2[1]).filter(v => v.startsWith(prefix));
    if (!versions.length) throw new Error(`No NeoForge build available for Minecraft ${opts.mcVersion}`);
    const neoVer = versions[versions.length - 1];

    const tmpDir = path.join(app.getPath('temp'), 'voxel-loader-installers');
    fs.mkdirSync(tmpDir, { recursive: true });
    const installerPath = path.join(tmpDir, `neoforge-${neoVer}-installer.jar`);
    if (!fs.existsSync(installerPath)) {
      gameWin?.webContents.send('mc-log', `[NeoForge] Downloading installer for ${neoVer}…`);
      const installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoVer}/neoforge-${neoVer}-installer.jar`;
      await downloadFileTo(installerUrl, installerPath, (p) => gameWin?.webContents.send('mc-progress', { type: 'neoforge-download', percent: p }));
    }

    return { ok: true, installerPath, mcVersion: opts.mcVersion, loaderVersion: neoVer };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: screenshots ──────────────────────────────────────────────────────────
ipcMain.handle('mc-list-screenshots', async () => {
  const dir = path.join(app.getPath('userData'), '.minecraft', 'screenshots');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f: string) => /\.(png|jpg|jpeg)$/i.test(f))
      .map((f: string) => {
        const p = path.join(dir, f);
        const stat = fs.statSync(p);
        return { name: f, path: p, mtime: stat.mtimeMs, sizeKb: Math.round(stat.size / 1024) };
      })
      .sort((a: any, b: any) => b.mtime - a.mtime);
  } catch { return []; }
});

ipcMain.handle('mc-open-screenshot', async (_e, filePath: string) => {
  try { await shell.openPath(filePath); return { ok: true }; }
  catch (err: any) { return { ok: false, error: err.message }; }
});

ipcMain.handle('mc-show-screenshots-folder', async () => {
  const dir = path.join(app.getPath('userData'), '.minecraft', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

// ── IPC: resource packs ───────────────────────────────────────────────────────
ipcMain.handle('mc-list-resourcepacks', async () => {
  const dir = path.join(app.getPath('userData'), '.minecraft', 'resourcepacks');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f: string) => f.endsWith('.zip'));
  } catch { return []; }
});

ipcMain.handle('mc-install-resourcepack', async (_e, opts: { url: string; filename: string }) => {
  try {
    const dir = path.join(app.getPath('userData'), '.minecraft', 'resourcepacks');
    fs.mkdirSync(dir, { recursive: true });
    await downloadFileTo(opts.url, path.join(dir, opts.filename));
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err.message }; }
});

ipcMain.handle('mc-remove-resourcepack', async (_e, opts: { filename: string }) => {
  try {
    const fp = path.join(app.getPath('userData'), '.minecraft', 'resourcepacks', opts.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err.message }; }
});

ipcMain.handle('mc-list-shaderpacks', async () => {
  const dir = path.join(app.getPath('userData'), '.minecraft', 'shaderpacks');
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f: string) => f.endsWith('.zip'));
  } catch { return []; }
});

ipcMain.handle('mc-install-shaderpack', async (_e, opts: { url: string; filename: string }) => {
  try {
    const dir = path.join(app.getPath('userData'), '.minecraft', 'shaderpacks');
    fs.mkdirSync(dir, { recursive: true });
    await downloadFileTo(opts.url, path.join(dir, opts.filename));
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err.message }; }
});

ipcMain.handle('mc-remove-shaderpack', async (_e, opts: { filename: string }) => {
  try {
    const fp = path.join(app.getPath('userData'), '.minecraft', 'shaderpacks', opts.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err.message }; }
});

// ── IPC: file manager (worlds, schematics) ────────────────────────────────────
const mcRoot = () => path.join(app.getPath('userData'), '.minecraft');

ipcMain.handle('mc-list-worlds', async () => {
  const dir = path.join(mcRoot(), 'saves');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f: string) => fs.statSync(path.join(dir, f)).isDirectory());
});

ipcMain.handle('mc-saves-dir', () => path.join(mcRoot(), 'saves'));

ipcMain.handle('mc-install-world', async (_e, filePath: string) => {
  try {
    const savesDir = path.join(mcRoot(), 'saves');
    fs.mkdirSync(savesDir, { recursive: true });
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.zip') {
      execSync(`powershell -Command "Expand-Archive -LiteralPath '${filePath}' -DestinationPath '${savesDir}' -Force"`, { timeout: 30000 });
    } else {
      const dest = path.join(savesDir, path.basename(filePath));
      if (fs.statSync(filePath).isDirectory()) {
        fs.cpSync(filePath, dest, { recursive: true });
      } else {
        fs.copyFileSync(filePath, dest);
      }
    }
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err.message }; }
});

ipcMain.handle('mc-list-schematics', async () => {
  const dir = path.join(mcRoot(), 'schematics');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f: string) =>
    ['.schematic', '.litematic', '.schem', '.nbt'].includes(path.extname(f).toLowerCase())
  );
});

ipcMain.handle('mc-install-schematic', async (_e, filePath: string) => {
  try {
    const dir = path.join(mcRoot(), 'schematics');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(filePath, path.join(dir, path.basename(filePath)));
    return { ok: true };
  } catch (err: any) { return { ok: false, error: err.message }; }
});

ipcMain.handle('mc-open-folder', async (_e, type: string) => {
  const dirs: Record<string, string> = {
    saves:        path.join(mcRoot(), 'saves'),
    schematics:   path.join(mcRoot(), 'schematics'),
    mods:         path.join(mcRoot(), 'mods'),
    screenshots:  path.join(mcRoot(), 'screenshots'),
    resourcepacks:path.join(mcRoot(), 'resourcepacks'),
    root:         mcRoot(),
  };
  const dir = dirs[type] || mcRoot();
  fs.mkdirSync(dir, { recursive: true });
  shell.openPath(dir);
});

ipcMain.handle('download-avengers-mod', async () => {
  const src  = 'C:\\Users\\Jorda\\Documents\\GitHub\\avengers-mod';
  const dest = path.join(os.homedir(), 'Downloads', 'avengers-mod-source.zip');
  try {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    execSync(
      `powershell -Command "Compress-Archive -Path '${src}' -DestinationPath '${dest}'"`,
      { timeout: 30000 }
    );
    shell.showItemInFolder(dest);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

// ── IPC: window controls ──────────────────────────────────────────────────────
ipcMain.on('win-close',    () => BrowserWindow.getFocusedWindow()?.close());
ipcMain.on('win-minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
ipcMain.on('win-relaunch', () => { app.relaunch(); app.quit(); });
ipcMain.on('win-maximize', () => { const w = BrowserWindow.getFocusedWindow(); if (w?.isMaximized()) w.unmaximize(); else w?.maximize(); });
ipcMain.on('open-external', (_e, url: string) => { shell.openExternal(url).catch(() => {}); });

// ── Auto-updater ──────────────────────────────────────────────────────────────
const UPDATE_ACK_FILE = path.join(app.getPath('userData'), 'update-ack.json');

function getAckedVersion(): string {
  try { return JSON.parse(fs.readFileSync(UPDATE_ACK_FILE, 'utf-8')).version ?? ''; } catch { return ''; }
}
function setAckedVersion(v: string) {
  try { fs.writeFileSync(UPDATE_ACK_FILE, JSON.stringify({ version: v })); } catch {}
}

function setupAutoUpdater() {
  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update',  () => gameWin?.webContents.send('update-checking'));
  autoUpdater.on('update-not-available', () => gameWin?.webContents.send('update-not-available'));
  autoUpdater.on('update-available',   info => gameWin?.webContents.send('update-available',  info.version));
  autoUpdater.on('download-progress',     p => gameWin?.webContents.send('update-progress',   Math.round(p.percent)));
  autoUpdater.on('update-downloaded',   (info: { version: string }) => {
    if (info.version === app.getVersion()) { return; }
    setAckedVersion(info.version);
    updateReady = true;
    gameWin?.webContents.send('update-downloaded');
    // Auto-install after 10s if Minecraft isn't running.
    // Reset updateReady BEFORE calling quitAndInstall so the gameWin 'closed'
    // handler doesn't trigger a second quitAndInstall call (which would throw and
    // fall through to app.quit() without installing).
    setTimeout(() => {
      if (updateReady && !mcProcess) {
        updateReady = false;
        try { autoUpdater.quitAndInstall(true, true); } catch { app.quit(); }
      }
    }, 10000);
  });
  autoUpdater.on('error', err => {
    console.error('[updater] error:', err?.message);
    gameWin?.webContents.send('update-error', err?.message ?? 'Unknown error');
  });

  autoUpdater.checkForUpdates().catch(() => {});
}

ipcMain.on('install-update',    () => autoUpdater.quitAndInstall(true, true));
ipcMain.on('check-for-updates', () => { autoUpdater.checkForUpdates().catch(() => {}); });

// ── AI Assistant ───────────────────────────────────────────────────────────────

const AI_SYSTEM = `You are an expert AI assistant built into Voxel Client, a Minecraft launcher app.

EXPERTISE:
- Minecraft Java & Bedrock: crafting recipes (write them as 3x3 grids), commands, enchantments, biomes, mobs, farms, redstone, building, progression, all versions through 1.21
- Voxel Client features: installing mods via Modrinth, Fabric/Forge, server hosting, voice chat, cosmetics, skins, friends, the Minecraft Guide panel

RESPONSE STYLE:
- Be conversational and friendly but efficient — no filler phrases like "Great question!" or "Certainly!"
- Use **bold** for item names and key terms
- Use bullet lists for multiple points, numbered lists for steps
- For crafting grids write them as a 3-row table: [row1] / [row2] / [row3]
- Give specific numbers (Y-levels, damage values, percentages) when known
- If asked about something outside Minecraft/Voxel Client, politely redirect

REMEMBER across the conversation: the user's previous questions, items they asked about, and context they provided. Build on prior messages rather than starting fresh each time.`;

ipcMain.handle('open-ai-window', () => {
  if (aiWin && !aiWin.isDestroyed()) { aiWin.focus(); return; }
  aiWin = new BrowserWindow({
    width: 480, height: 600,
    minWidth: 360, minHeight: 400,
    title: 'AI Chat — Voxel Client',
    backgroundColor: '#0a0a0a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  if (DEV) aiWin.loadURL('http://localhost:5173/ai-chat.html');
  else aiWin.loadFile(path.join(__dirname, '../dist/ai-chat.html'));
  aiWin.on('closed', () => { aiWin = null; });
});

// Free OpenRouter models get rate-limited often since their capacity is shared
// across every anonymous user — fall through this list until one responds.
const AI_FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'openai/gpt-oss-20b:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
];

function callOpenRouter(model: string, messages: { role: string; content: string }[]): Promise<any> {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: AI_SYSTEM }, ...messages],
    max_tokens: 1024,
    temperature: 0.65,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      timeout: 20000,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GEMINI_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

ipcMain.handle('ai-chat', async (_e, messages: { role: string; content: string }[]) => {
  if (!GEMINI_KEY) return { ok: false, error: 'AI not available in this build' };
  let lastError = 'No response from AI';
  for (const model of AI_FALLBACK_MODELS) {
    try {
      const json = await callOpenRouter(model, messages);
      if (json.error) {
        // Any error (rate-limited, deprecated model, bad request, etc.) —
        // move on to the next fallback model rather than giving up entirely.
        lastError = json.error.message ?? String(json.error);
        continue;
      }
      const text = json.choices?.[0]?.message?.content ?? '';
      if (text) return { ok: true, text };
      lastError = 'No response from AI';
    } catch (err: any) {
      lastError = err.message;
    }
  }
  return { ok: false, error: lastError };
});

// ── IPC: overlay mod state (reads/writes game window's localStorage) ──────────
ipcMain.handle('overlay-get-mods', async () => {
  if (!gameWin) return {};
  try {
    return await gameWin.webContents.executeJavaScript(
      'JSON.parse(localStorage.getItem("voxel_installed_mods") || "{}")'
    );
  } catch { return {}; }
});

ipcMain.handle('overlay-save-mods', async (_e, data: any) => {
  if (!gameWin) return;
  try {
    await gameWin.webContents.executeJavaScript(
      `localStorage.setItem("voxel_installed_mods", ${JSON.stringify(JSON.stringify(data))})`
    );
  } catch {}
});

ipcMain.on('overlay-close', () => { overlayWin?.hide(); });

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc: any, permission: string, callback: (granted: boolean) => void) => {
    callback(permission === 'media' || permission === 'microphone' || permission === 'notifications');
  });
  session.defaultSession.setPermissionCheckHandler((_wc: any, permission: string) => {
    return permission === 'media' || permission === 'microphone' || permission === 'notifications';
  });
  loadCachedAuth();
  createLoginWindow();
  globalShortcut.register('Shift+F9', toggleOverlay);
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!loginWin && !gameWin) createLoginWindow(); });
