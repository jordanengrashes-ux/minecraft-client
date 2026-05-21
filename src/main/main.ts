import { app, BrowserWindow, ipcMain, net, shell, globalShortcut, screen } from 'electron';
import { autoUpdater } from 'electron-updater';
import { execSync, spawnSync, spawn, ChildProcess } from 'child_process';
import https from 'https';
import path from 'path';
import fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('minecraft-launcher-core');

let loginWin:   BrowserWindow | null = null;
let gameWin:    BrowserWindow | null = null;
let overlayWin: BrowserWindow | null = null;
let mcAuthToken: any = null;
let serverProcess: ChildProcess | null = null;
let mcProcess: ChildProcess | null = null;
let javaReadyPromise: Promise<string> | null = null;

const DEV = !app.isPackaged;
const AUTH_CACHE      = path.join(app.getPath('userData'), 'mc-auth.json');
const JAVA_PATH_CACHE = path.join(app.getPath('userData'), 'java-path.json');

function loadCachedJavaPath(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(JAVA_PATH_CACHE, 'utf-8'));
    if (data?.path && fs.existsSync(data.path)) return data.path as string;
  } catch {}
  return null;
}
function saveCachedJavaPath(javaPath: string) {
  try { fs.writeFileSync(JAVA_PATH_CACHE, JSON.stringify({ path: javaPath })); } catch {}
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

async function ensureJava21(log: (msg: string) => void): Promise<string> {
  // Fast path: previously resolved path saved to disk
  const diskCached = loadCachedJavaPath();
  if (diskCached) {
    const v = getJavaMajorVersion(diskCached);
    if (v >= 21) { log(`[Launcher] Java ${v} ready`); return diskCached; }
  }

  // 0. Bundled Java 21 — shipped inside the installer, trust it unconditionally
  const bundledDir = path.join(process.resourcesPath, 'java21');
  const bundled = findJavawInDir(bundledDir);
  if (bundled) {
    log(`[Launcher] Using bundled Java 21 at ${bundled}`);
    saveCachedJavaPath(bundled);
    return bundled;
  }
  log(`[Launcher] Bundled Java not found at ${bundledDir} — checking fallbacks`);

  const java21Dir = path.join(app.getPath('userData'), 'java21');

  // 1. Our own cached download — verify it's actually 21+
  const cached = findJavawInDir(java21Dir);
  if (cached) {
    const v = getJavaMajorVersion(cached);
    if (v >= 21) { log(`[Launcher] Java 21 ready (cached)`); saveCachedJavaPath(cached); return cached; }
    log(`[Launcher] Cached Java is v${v} — clearing and re-downloading…`);
    try { fs.rmSync(java21Dir, { recursive: true, force: true }); } catch {}
  }

  // 2. Official Minecraft launcher's Java 21 (java-runtime-delta is always Java 21) — verify version
  const mcJava21 = path.join(app.getPath('appData'), '.minecraft', 'runtime', 'java-runtime-delta', 'windows-x64', 'java-runtime-delta', 'bin', 'javaw.exe');
  if (fs.existsSync(mcJava21)) {
    const v2 = getJavaMajorVersion(mcJava21);
    if (v2 >= 21) { log(`[Launcher] Using Minecraft launcher Java ${v2}`); saveCachedJavaPath(mcJava21); return mcJava21; }
    log(`[Launcher] java-runtime-delta is v${v2} — skipping`);
  }

  // 3. System Java — use java.exe for version check (javaw.exe is silent/windowless)
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
    log(`[Launcher] Found Java ${v || '?'} at ${c}`);
    if (v >= 21) { log(`[Launcher] Using system Java ${v}`); saveCachedJavaPath(c); return c; }
  }

  // 4. Download Java 21 from Adoptium (one-time ~85MB)
  log('[Launcher] No Java 21 found — downloading from Adoptium (~85MB)…');

  const info = await fetchJson('https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse');
  const pkg = info[0]?.binary?.package;
  if (!pkg?.link) throw new Error('Could not get Java 21 download URL from Adoptium');

  const zipPath = path.join(app.getPath('temp'), 'voxel-java21.zip');
  const sizeMB = Math.round((pkg.size || 0) / 1024 / 1024);
  log(`[Launcher] Downloading Java 21 JRE (${sizeMB}MB) — this only happens once…`);

  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    let downloaded = 0;
    let lastPct = -1;

    function doGet(url: string) {
      https.get(url, { headers: { 'User-Agent': 'VoxelClient' } }, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          res.resume(); // drain redirect body so socket is released
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
            log(`[Launcher] Downloading Java 21… ${pct}%`);
            gameWin?.webContents.send('mc-status', { msg: `Downloading Java 21… ${pct}%`, color: 'yellow' });
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
  if (dlSize < 10 * 1024 * 1024) throw new Error(`Java 21 download too small (${dlSize} bytes) — try again`);

  log('[Launcher] Extracting Java 21…');
  gameWin?.webContents.send('mc-status', { msg: 'Extracting Java 21…', color: 'yellow' });
  // Always wipe the target dir before extracting — removes any stale partial state
  try { if (fs.existsSync(java21Dir)) fs.rmSync(java21Dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(java21Dir, { recursive: true });
  try {
    execSync(`powershell -NoProfile -command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${java21Dir}' -Force"`, { timeout: 120000 });
  } catch (extractErr: any) {
    throw new Error(`Java 21 extraction failed: ${extractErr.message}`);
  }

  const javaw = findJavawInDir(java21Dir);
  if (!javaw) throw new Error('Java 21 extracted but javaw.exe not found');
  const finalVer = getJavaMajorVersion(javaw);
  log(`[Launcher] Java ${finalVer} installed at ${javaw}`);
  gameWin?.webContents.send('mc-status', { msg: 'Java 21 ready', color: 'green' });
  saveCachedJavaPath(javaw);
  return javaw;
}

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
      parent: gameWin ?? undefined,
      modal: true,
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
  const profile = await fetchJson('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}` },
  });

  return {
    access_token: mc.access_token,
    client_token: mc.access_token,
    uuid: profile.id,
    name: profile.name,
    user_properties: {},
    meta: { type: 'msa', demo: false },
  };
}

// ── Windows ───────────────────────────────────────────────────────────────────
function createLoginWindow() {
  loginWin = new BrowserWindow({
    width: 480, height: 600,
    resizable: false, frame: false, titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
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
  gameWin.on('closed', () => { gameWin = null; app.quit(); });
  gameWin.webContents.once('did-finish-load', () => { if (!DEV) setupAutoUpdater(); });
}

// ── IPC: login / game window ──────────────────────────────────────────────────
ipcMain.on('login-success', (_e, userData) => {
  createGameWindow();
  loginWin?.close(); loginWin = null;
  gameWin?.webContents.once('did-finish-load', () => {
    gameWin?.webContents.send('user-data', userData);
    if (mcAuthToken) gameWin?.webContents.send('mc-already-authed', mcAuthToken.name);
    // Start Java resolution immediately so it's ready when the user clicks Play
    javaReadyPromise = ensureJava21((msg) => gameWin?.webContents.send('mc-log', msg));
    javaReadyPromise.catch(() => { javaReadyPromise = null; });
  });
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
    return { ok: false, error: err.message };
  }
});

// ── IPC: launch Minecraft ─────────────────────────────────────────────────────
ipcMain.handle('mc-launch', async (_e, opts: { version: string; maxMem: number }) => {
  // Start Java resolution immediately in parallel with any auth work
  const javaPromise = javaReadyPromise ?? ensureJava21((msg) => gameWin?.webContents.send('mc-log', msg));

  // If no cached token, or token is stale, run the auth flow inline
  const tokenAge = Date.now() - (mcAuthToken?.cached_at ?? 0);
  const needsAuth = !mcAuthToken || tokenAge > 30 * 60 * 1000;
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
        return { ok: false, error: 'Microsoft sign-in cancelled or failed — use Offline Mode to play without an account.' };
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
    if (detectedVer < 21) {
      throw new Error(`Java at ${javaPath} is version ${detectedVer || 'unknown'} — need 21. Delete %APPDATA%\\VoxelClient\\java21 and relaunch to re-download.`);
    }
    gameWin?.webContents.send('mc-log', `[Launcher] version: ${opts.version || '1.21.4'}, mem: ${opts.maxMem || 4}G, user: ${auth.name}`);

    // Re-apply resource pack enable so it survives Minecraft resetting options.txt
    const packDir = path.join(mcRoot, 'resourcepacks', 'VoxelClient');
    if (fs.existsSync(packDir)) enableVoxelResourcePack(mcRoot);

    // Auto-install cosmetics mod if bundled
    try {
      const modsDir = path.join(mcRoot, 'mods');
      const cosmeticsSrc = app.isPackaged
        ? path.join(process.resourcesPath, 'mods', 'voxel-cosmetics.jar')
        : path.join(__dirname, '../../resources/mods/voxel-cosmetics.jar');
      if (fs.existsSync(cosmeticsSrc)) {
        if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
        fs.copyFileSync(cosmeticsSrc, path.join(modsDir, 'voxel-cosmetics.jar'));
        gameWin?.webContents.send('mc-log', '[Launcher] Cosmetics mod installed');
      }
    } catch {}

    const isFabric = (opts.version || '').startsWith('fabric-loader-');
    const mcVer    = isFabric ? opts.version.replace(/^fabric-loader-[\d.]+-/, '') : (opts.version || '1.21.4');

    mcProcess = launcher.launch({
      authorization: auth,
      root: mcRoot,
      version: { number: mcVer, type: 'release', ...(isFabric ? { custom: opts.version } : {}) },
      memory:  { max: `${opts.maxMem || 4}G`, min: '512M' },
      javaPath,
      overrides: { maxSockets: 64 },
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
ipcMain.handle('mc-launch-offline', async (_e, opts: { version: string; maxMem: number; username: string }) => {
  try {
    const mcRoot   = path.join(app.getPath('userData'), '.minecraft');
    const launcher = new Client();
    const javaPath = await (javaReadyPromise ?? ensureJava21((msg) => gameWin?.webContents.send('mc-log', msg)));
    const detectedVer = getJavaMajorVersion(javaPath);
    if (detectedVer < 21) throw new Error(`Java ${detectedVer} found but 21 required`);

    // Offline UUID — matches vanilla OfflinePlayer UUID derivation
    const { createHash } = await import('crypto');
    const hash = createHash('md5').update(`OfflinePlayer:${opts.username}`).digest();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const h = hash.toString('hex');
    const uuid = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;

    gameWin?.webContents.send('mc-log', `[Launcher] Offline mode — user: ${opts.username}, uuid: ${uuid}`);
    const isFabricOff = (opts.version || '').startsWith('fabric-loader-');
    const mcVerOff    = isFabricOff ? opts.version.replace(/^fabric-loader-[\d.]+-/, '') : (opts.version || '1.21.4');

    mcProcess = launcher.launch({
      authorization: { access_token: 'offline', client_token: 'offline', uuid, name: opts.username, user_properties: '{}', meta: { type: 'mojang', demo: false } },
      root: mcRoot,
      version: { number: mcVerOff, type: 'release', ...(isFabricOff ? { custom: opts.version } : {}) },
      memory:  { max: `${opts.maxMem || 4}G`, min: '512M' },
      javaPath,
      overrides: { maxSockets: 64 },
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
ipcMain.handle('mc-get-uuid', () => {
  // Return the Minecraft UUID (no dashes) from the cached auth token
  if (!mcAuthToken?.uuid) return null;
  return (mcAuthToken.uuid as string).replace(/-/g, '');
});

ipcMain.handle('cosmetics-install-mod', async () => {
  try {
    const mcRoot  = path.join(app.getPath('userData'), '.minecraft');
    const modsDir = path.join(mcRoot, 'mods');
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

// ── IPC: server hosting ───────────────────────────────────────────────────────
ipcMain.handle('server-start', async (_e, opts: { version: string; maxMem: number; name: string }) => {
  if (serverProcess) return { ok: false, error: 'Server is already running' };
  try {
    const serverDir = path.join(app.getPath('userData'), 'mc-server', opts.version);
    const jarPath   = path.join(serverDir, 'server.jar');
    fs.mkdirSync(serverDir, { recursive: true });

    // Download server.jar if not cached
    if (!fs.existsSync(jarPath)) {
      gameWin?.webContents.send('server-log', '[Host] Fetching version info…');
      const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const entry    = (manifest.versions as any[]).find(v => v.id === opts.version);
      if (!entry) throw new Error(`Version ${opts.version} not in manifest`);
      const info     = await fetchJson(entry.url);
      const dl       = info.downloads?.server;
      if (!dl?.url) throw new Error('No server JAR available for this version (try 1.17+)');
      gameWin?.webContents.send('server-log', `[Host] Downloading server.jar (${Math.round(dl.size / 1024 / 1024)}MB)…`);
      let lastPct = -1;
      await downloadFileTo(dl.url, jarPath, pct => {
        if (pct !== lastPct && pct % 10 === 0) {
          lastPct = pct;
          gameWin?.webContents.send('server-log', `[Host] Downloading… ${pct}%`);
        }
      });
      gameWin?.webContents.send('server-log', '[Host] Download complete');
    }

    // Always accept EULA
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');

    // Write server.properties — online-mode=false avoids Mojang auth socket errors
    const propsPath = path.join(serverDir, 'server.properties');
    if (!fs.existsSync(propsPath)) {
      fs.writeFileSync(propsPath, [
        'online-mode=false',
        'server-port=25565',
        'server-ip=',
        'max-players=20',
        'view-distance=10',
        'motd=Voxel Client Server',
      ].join('\n') + '\n');
    } else {
      // Patch online-mode in existing properties without clobbering other settings
      let props = fs.readFileSync(propsPath, 'utf-8');
      if (/^online-mode=/m.test(props)) {
        props = props.replace(/^online-mode=.*/m, 'online-mode=false');
      } else {
        props = 'online-mode=false\n' + props;
      }
      fs.writeFileSync(propsPath, props);
    }

    // Resolve Java the same way as game launch (bundled → cache → system → download)
    // Use java.exe not javaw.exe — server needs stdout
    const javawPath = await ensureJava21((msg) => gameWin?.webContents.send('server-log', msg));
    const javaExe   = javawPath.replace(/javaw(\.exe)?$/i, 'java$1');

    gameWin?.webContents.send('server-log', `[Host] Starting Minecraft ${opts.version}…`);
    serverProcess = spawn(javaExe, [
      `-Xmx${opts.maxMem}G`, '-Xms512M', '-jar', 'server.jar', '--nogui',
    ], { cwd: serverDir, stdio: ['pipe', 'pipe', 'pipe'] });

    serverProcess.stdout?.on('data', (d: Buffer) => gameWin?.webContents.send('server-log', d.toString()));
    serverProcess.stderr?.on('data', (d: Buffer) => gameWin?.webContents.send('server-log', d.toString()));
    serverProcess.on('close', (code: number) => {
      serverProcess = null;
      gameWin?.webContents.send('server-closed', code ?? 0);
    });

    return { ok: true };
  } catch (err: any) {
    serverProcess = null;
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('server-stop', async () => {
  if (!serverProcess) return { ok: false, error: 'Not running' };
  serverProcess.stdin?.write('stop\n');
  // Force-kill after 15s if it hasn't exited
  setTimeout(() => { try { serverProcess?.kill(); } catch {} }, 15000);
  return { ok: true };
});

ipcMain.handle('server-command', async (_e, cmd: string) => {
  if (!serverProcess?.stdin) return { ok: false, error: 'Server not running' };
  serverProcess.stdin.write(cmd + '\n');
  return { ok: true };
});

// ── IPC: mod install / remove ─────────────────────────────────────────────────
ipcMain.handle('mc-install-mod', async (_e, opts: { url: string; filename: string }) => {
  try {
    const modsDir = path.join(app.getPath('userData'), '.minecraft', 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    await downloadFileTo(opts.url, path.join(modsDir, opts.filename));
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mc-list-mods', async () => {
  const modsDir = path.join(app.getPath('userData'), '.minecraft', 'mods');
  try {
    return fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((f: string) => f.endsWith('.jar')) : [];
  } catch { return []; }
});

ipcMain.handle('mc-remove-mod', async (_e, opts: { filename: string }) => {
  try {
    const dest = path.join(app.getPath('userData'), '.minecraft', 'mods', opts.filename);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── Resource pack enable helper ───────────────────────────────────────────────
function enableVoxelResourcePack(mcRoot: string) {
  const optPath = path.join(mcRoot, 'options.txt');
  let txt = fs.existsSync(optPath) ? fs.readFileSync(optPath, 'utf-8') : '';
  if (txt.includes('resourcePacks:')) {
    txt = txt.replace(/resourcePacks:\[([^\]]*)\]/, (_m, inner) => {
      const items = (inner as string).split(',').filter(s => s && !s.includes('VoxelClient'));
      items.unshift('"file/VoxelClient"');
      return `resourcePacks:[${items.join(',')}]`;
    });
  } else {
    txt += (txt.endsWith('\n') || txt === '' ? '' : '\n') + 'resourcePacks:["file/VoxelClient"]\n';
  }
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
      pack: { pack_format: 999, supported_formats: { min_inclusive: 1, max_inclusive: 9999 }, description: 'Voxel Client Theme' }
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
ipcMain.handle('mc-install-fabric', async (_e, opts: { mcVersion: string }) => {
  try {
    const mcRoot = path.join(app.getPath('userData'), '.minecraft');
    const loaders = await fetchJson('https://meta.fabricmc.net/v2/versions/loader');
    const loader  = (loaders as any[]).find((l: any) => l.stable) ?? loaders[0];
    if (!loader) throw new Error('No Fabric loader found');
    const loaderVer = loader.version as string;

    const fabricId   = `fabric-loader-${loaderVer}-${opts.mcVersion}`;
    const versionDir = path.join(mcRoot, 'versions', fabricId);
    const profilePath = path.join(versionDir, `${fabricId}.json`);

    // Always reinstall if the saved profile is missing the merged vanilla fields
    const needsInstall = !fs.existsSync(profilePath) ||
      !JSON.parse(fs.readFileSync(profilePath, 'utf8')).downloads;

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

      // Merge: vanilla base + Fabric mainClass + combined libraries + combined arguments
      const merged = {
        ...vanilla,
        id: fabricId,
        mainClass: fabricProfile.mainClass,
        libraries: [...(vanilla.libraries ?? []), ...(fabricProfile.libraries ?? [])],
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

// ── IPC: window controls ──────────────────────────────────────────────────────
ipcMain.on('win-close',    () => BrowserWindow.getFocusedWindow()?.close());
ipcMain.on('win-minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
ipcMain.on('win-maximize', () => { const w = BrowserWindow.getFocusedWindow(); if (w?.isMaximized()) w.unmaximize(); else w?.maximize(); });

// ── Auto-updater ──────────────────────────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.autoDownload    = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update',  () => gameWin?.webContents.send('update-checking'));
  autoUpdater.on('update-not-available', () => gameWin?.webContents.send('update-not-available'));
  autoUpdater.on('update-available',   info => gameWin?.webContents.send('update-available',  info.version));
  autoUpdater.on('download-progress',     p => gameWin?.webContents.send('update-progress',   Math.round(p.percent)));
  autoUpdater.on('update-downloaded',     () => gameWin?.webContents.send('update-downloaded'));
  autoUpdater.on('error',               () => {});

  autoUpdater.checkForUpdates().catch(() => {});
}

ipcMain.on('install-update',    () => autoUpdater.quitAndInstall(false, true));
ipcMain.on('check-for-updates', () => { autoUpdater.checkForUpdates().catch(() => {}); });

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
  loadCachedAuth();
  createLoginWindow();
  globalShortcut.register('Shift+F9', toggleOverlay);
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!loginWin && !gameWin) createLoginWindow(); });
