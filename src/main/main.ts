import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';

let loginWin: BrowserWindow | null = null;
let gameWin:  BrowserWindow | null = null;

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

  gameWin.on('closed', () => { gameWin = null; app.quit(); });
}

// IPC: login succeeded → open game window
ipcMain.on('login-success', (_e, userData) => {
  createGameWindow();
  loginWin?.close();
  loginWin = null;
  gameWin?.webContents.once('did-finish-load', () => {
    gameWin?.webContents.send('user-data', userData);
  });
});

// IPC: close / minimise title bar buttons
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
