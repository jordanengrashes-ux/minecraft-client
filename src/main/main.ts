import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mc = require('minecraft-protocol');

let loginWin: BrowserWindow | null = null;
let gameWin:  BrowserWindow | null = null;
let mcClient: any = null;

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
    loginWin.webContents.openDevTools({ mode: 'detach' });
  } else {
    loginWin.loadFile(path.join(__dirname, '../dist/login.html'));
  }
}

function createGameWindow() {
  gameWin = new BrowserWindow({
    width: 1280, height: 720,
    minWidth: 800, minHeight: 500,
    backgroundColor: '#87ceeb',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  gameWin.maximize();

  if (DEV) {
    gameWin.loadURL('http://localhost:5173/game.html');
  } else {
    gameWin.loadFile(path.join(__dirname, '../dist/game.html'));
  }

  gameWin.on('closed', () => {
    gameWin = null;
    if (mcClient) { try { mcClient.end('window closed'); } catch {} mcClient = null; }
    app.quit();
  });
}

// ── Flatten Minecraft chat JSON to plain text ─────────────────────────────────
function flattenChat(json: any): string {
  if (typeof json === 'string') return json;
  if (Array.isArray(json)) return json.map(flattenChat).join('');
  let text = json.text || '';
  if (json.translate) {
    const args = (json.with || []).map(flattenChat);
    text = json.translate.replace(/%s|%\d+\$s/g, () => args.shift() || '');
  }
  if (json.extra) text += json.extra.map(flattenChat).join('');
  return text;
}

function safeParseChat(raw: string): string {
  try { return flattenChat(JSON.parse(raw)); } catch { return raw; }
}

// ── Minecraft protocol IPC ────────────────────────────────────────────────────
ipcMain.handle('mc-connect', async (_e, opts: { host: string; port: number; username: string }) => {
  if (mcClient) {
    try { mcClient.end('reconnect'); } catch {}
    mcClient = null;
  }

  try {
    const clientOpts: any = {
      host: opts.host,
      port: opts.port || 25565,
      username: opts.username,
      auth: 'microsoft',
      deviceCodeCallback: (data: any) => {
        gameWin?.webContents.send('mc-device-code', {
          userCode: data.user_code,
          verificationUri: data.verification_uri,
        });
      },
    };

    mcClient = mc.createClient(clientOpts);

    // 1.18 and earlier chat
    mcClient.on('chat', (packet: any) => {
      gameWin?.webContents.send('mc-chat', safeParseChat(packet.message));
    });

    // 1.19+ system messages (server broadcasts, join/leave, death, etc.)
    mcClient.on('system_chat', (packet: any) => {
      gameWin?.webContents.send('mc-chat', safeParseChat(packet.content));
    });

    // 1.19+ player chat (actual player messages with signature)
    mcClient.on('player_chat', (packet: any) => {
      const body = packet.plainMessage ?? safeParseChat(packet.message ?? '');
      const sender = packet.networkName ? safeParseChat(packet.networkName) : opts.username;
      gameWin?.webContents.send('mc-chat', `<${sender}> ${body}`);
    });

    mcClient.on('login', (_packet: any) => {
      gameWin?.webContents.send('mc-login', { username: mcClient.username || opts.username });
    });

    mcClient.on('kick_disconnect', (packet: any) => {
      gameWin?.webContents.send('mc-kicked', safeParseChat(packet.reason));
      mcClient = null;
    });

    mcClient.on('error', (err: Error) => {
      gameWin?.webContents.send('mc-error', err.message);
      mcClient = null;
    });

    mcClient.on('end', (reason: string) => {
      gameWin?.webContents.send('mc-end', reason || 'disconnected');
      mcClient = null;
    });

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('mc-chat', (_e, message: string) => {
  if (!mcClient) return;
  try { mcClient.write('chat', { message }); } catch {}
});

ipcMain.on('mc-disconnect', () => {
  if (!mcClient) return;
  try { mcClient.end('Client disconnected'); } catch {}
  mcClient = null;
});

// ── IPC: login succeeded → open game window ───────────────────────────────────
ipcMain.on('login-success', (_e, userData) => {
  createGameWindow();
  loginWin?.close();
  loginWin = null;
  gameWin?.webContents.once('did-finish-load', () => {
    gameWin?.webContents.send('user-data', userData);
  });
});

// ── IPC: window controls ──────────────────────────────────────────────────────
ipcMain.on('win-close',    () => { BrowserWindow.getFocusedWindow()?.close(); });
ipcMain.on('win-minimize', () => { BrowserWindow.getFocusedWindow()?.minimize(); });
ipcMain.on('win-maximize', () => {
  const w = BrowserWindow.getFocusedWindow();
  if (w?.isMaximized()) w.unmaximize(); else w?.maximize();
});

app.whenReady().then(() => {
  createLoginWindow();
  if (!DEV) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!loginWin && !gameWin) createLoginWindow(); });
