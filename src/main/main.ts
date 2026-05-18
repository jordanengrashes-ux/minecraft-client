import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('minecraft-launcher-core');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Auth } = require('msmc');

let loginWin: BrowserWindow | null = null;
let gameWin:  BrowserWindow | null = null;
let mcAuthToken: any = null;

const DEV = !app.isPackaged;

function createLoginWindow() {
  loginWin = new BrowserWindow({
    width: 480, height: 600,
    resizable: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (DEV) {
    loginWin.loadURL('http://localhost:5173/login.html');
  } else {
    loginWin.loadFile(path.join(__dirname, '../dist/login.html'));
  }
}

function createGameWindow() {
  gameWin = new BrowserWindow({
    width: 1100, height: 680,
    minWidth: 800, minHeight: 500,
    backgroundColor: '#0d1117',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (DEV) {
    gameWin.loadURL('http://localhost:5173/game.html');
    gameWin.webContents.openDevTools({ mode: 'detach' });
  } else {
    gameWin.loadFile(path.join(__dirname, '../dist/game.html'));
  }

  gameWin.on('closed', () => { gameWin = null; app.quit(); });
}

// ── IPC: login succeeded → open launcher ─────────────────────────────────────
ipcMain.on('login-success', (_e, userData) => {
  createGameWindow();
  loginWin?.close();
  loginWin = null;
  gameWin?.webContents.once('did-finish-load', () => {
    gameWin?.webContents.send('user-data', userData);
  });
});

// ── IPC: Microsoft / Minecraft auth ──────────────────────────────────────────
ipcMain.handle('mc-auth', async () => {
  try {
    const auth = new Auth('select_account');
    const xbox = await auth.launch('electron');
    const mc   = await xbox.getMinecraft();
    mcAuthToken = mc.mclc();
    return { ok: true, username: mc.profile.name };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: launch Minecraft ──────────────────────────────────────────────────────
ipcMain.handle('mc-launch', async (_e, opts: { version: string; maxMem: number }) => {
  if (!mcAuthToken) return { ok: false, error: 'Not authenticated with Microsoft' };

  try {
    const launcher = new Client();
    const rootPath = path.join(app.getPath('userData'), '.minecraft');

    launcher.launch({
      authorization: mcAuthToken,
      root: rootPath,
      version: {
        number: opts.version || '1.21.4',
        type: 'release',
      },
      memory: {
        max: `${opts.maxMem || 4}G`,
        min: '2G',
      },
    });

    launcher.on('data',     (data: string)  => gameWin?.webContents.send('mc-log',      data));
    launcher.on('progress', (e: any)        => gameWin?.webContents.send('mc-progress', e));
    launcher.on('close',    (code: number)  => gameWin?.webContents.send('mc-closed',   code));
    launcher.on('error',    (err: Error)    => gameWin?.webContents.send('mc-error',    err.message));

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: window controls ──────────────────────────────────────────────────────
ipcMain.on('win-close',    () => { BrowserWindow.getFocusedWindow()?.close(); });
ipcMain.on('win-minimize', () => { BrowserWindow.getFocusedWindow()?.minimize(); });
ipcMain.on('win-maximize', () => {
  const w = BrowserWindow.getFocusedWindow();
  if (w?.isMaximized()) w.unmaximize(); else w?.maximize();
});

// ── Auto-updater ──────────────────────────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    gameWin?.webContents.send('update-available', info.version);
  });
  autoUpdater.on('download-progress', (p) => {
    gameWin?.webContents.send('update-progress', Math.round(p.percent));
  });
  autoUpdater.on('update-downloaded', () => {
    gameWin?.webContents.send('update-downloaded');
  });
  autoUpdater.on('error', () => { /* ignore update errors silently */ });

  autoUpdater.checkForUpdates().catch(() => {});
}

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

app.whenReady().then(() => {
  createLoginWindow();
  if (!DEV) setupAutoUpdater();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!loginWin && !gameWin) createLoginWindow(); });
