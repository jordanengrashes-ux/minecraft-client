import { app, BrowserWindow, ipcMain, net } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('minecraft-launcher-core');

let loginWin: BrowserWindow | null = null;
let gameWin:  BrowserWindow | null = null;
let mcAuthToken: any = null;

const DEV = !app.isPackaged;
const AUTH_CACHE = path.join(app.getPath('userData'), 'mc-auth.json');

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
function isTokenStale(token: any): boolean {
  if (!token?.cached_at) return true;
  return Date.now() - token.cached_at > 20 * 60 * 60 * 1000; // 20 hours
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
    client_token: uhs,
    uuid: profile.id,
    name: profile.name,
    user_properties: '{}',
    meta: { type: 'msa' },
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
}

// ── IPC: login / game window ──────────────────────────────────────────────────
ipcMain.on('login-success', (_e, userData) => {
  createGameWindow();
  loginWin?.close(); loginWin = null;
  gameWin?.webContents.once('did-finish-load', () => {
    gameWin?.webContents.send('user-data', userData);
    // Tell launcher if MC auth is already cached
    if (mcAuthToken) gameWin?.webContents.send('mc-already-authed', mcAuthToken.name);
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
  if (!mcAuthToken) return { ok: false, error: 'Not authenticated with Microsoft' };

  // Refresh token if stale (> 20 h) so server joins don't fail auth
  if (isTokenStale(mcAuthToken)) {
    try {
      gameWin?.webContents.send('mc-log', '[Launcher] Token expired — re-authenticating…');
      const code  = await openMicrosoftAuthWindow();
      const token = await authenticateWithMinecraft(code);
      mcAuthToken = token;
      saveCachedAuth(token);
      gameWin?.webContents.send('mc-already-authed', token.name);
    } catch (err: any) {
      return { ok: false, error: `Token refresh failed: ${err.message}` };
    }
  }

  try {
    const mcRoot = path.join(app.getPath('userData'), '.minecraft');
    const launcher = new Client();
    // Strip internal fields MCLC doesn't understand
    const { cached_at: _, ...auth } = mcAuthToken as any;
    launcher.launch({
      authorization: auth,
      root: mcRoot,
      version: { number: opts.version || '1.21.4', type: 'release' },
      memory:  { max: `${opts.maxMem || 4}G`, min: '512M' },
    });
    // Send every line so the renderer can detect crash causes
    launcher.on('data',     (d: string)  => gameWin?.webContents.send('mc-log',      d));
    launcher.on('progress', (e: any)     => gameWin?.webContents.send('mc-progress', e));
    launcher.on('close',    (c: number)  => gameWin?.webContents.send('mc-closed',   c));
    launcher.on('error',    (e: Error)   => gameWin?.webContents.send('mc-error',    e.message));
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

// ── IPC: crash report reader ──────────────────────────────────────────────────
ipcMain.handle('mc-crash-report', async () => {
  try {
    const crashDir = path.join(app.getPath('userData'), '.minecraft', 'crash-reports');
    if (!fs.existsSync(crashDir)) return { ok: false, error: 'No crash reports found' };
    const files = fs.readdirSync(crashDir)
      .filter(f => f.endsWith('.txt'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(crashDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return { ok: false, error: 'No crash reports found' };
    const content = fs.readFileSync(path.join(crashDir, files[0].name), 'utf-8');
    return { ok: true, name: files[0].name, content: content.slice(0, 8000) };
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

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadCachedAuth();
  createLoginWindow();
  if (!DEV) setupAutoUpdater();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!loginWin && !gameWin) createLoginWindow(); });
