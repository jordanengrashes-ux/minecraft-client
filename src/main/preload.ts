import { contextBridge, ipcRenderer, clipboard } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  loginSuccess: (userData: object) => ipcRenderer.send('login-success', userData),
  onUserData:   (cb: (data: any) => void) => ipcRenderer.on('user-data', (_e, d) => cb(d)),
  close:        () => ipcRenderer.send('win-close'),
  minimize:     () => ipcRenderer.send('win-minimize'),
  maximize:     () => ipcRenderer.send('win-maximize'),
  copyText:     (text: string) => clipboard.writeText(text),
});

contextBridge.exposeInMainWorld('updater', {
  onChecking:    (cb: () => void)             => ipcRenderer.on('update-checking',      () => cb()),
  onAvailable:   (cb: (ver: string) => void)  => ipcRenderer.on('update-available',     (_e, v) => cb(v)),
  onNotAvailable:(cb: () => void)             => ipcRenderer.on('update-not-available', () => cb()),
  onProgress:    (cb: (pct: number) => void)  => ipcRenderer.on('update-progress',      (_e, p) => cb(p)),
  onDownloaded:  (cb: () => void)             => ipcRenderer.on('update-downloaded',    () => cb()),
  onError:       (cb: (msg: string) => void)  => ipcRenderer.on('update-error',         (_e, m) => cb(m)),
  install:       () => ipcRenderer.send('install-update'),
  check:         () => ipcRenderer.send('check-for-updates'),
});

contextBridge.exposeInMainWorld('server', {
  start:      (opts: any)    => ipcRenderer.invoke('server-start',       opts),
  pickWorld:  ()             => ipcRenderer.invoke('server-pick-world'),
  stop:       ()             => ipcRenderer.invoke('server-stop'),
  command:    (cmd: string)  => ipcRenderer.invoke('server-command',     cmd),
  openFolder: (ver: string)  => ipcRenderer.invoke('server-open-folder', ver),
  setAutoStart:  (on: boolean) => ipcRenderer.invoke('server-set-autostart', on),
  getAutoStart:  ()            => ipcRenderer.invoke('server-get-autostart'),
  onLog:         (cb: (l: string) => void)             => ipcRenderer.on('server-log',          (_e, l)    => cb(l)),
  onReady:       (cb: (port: number) => void)          => ipcRenderer.on('server-ready',        (_e, p)    => cb(p)),
  onClosed:      (cb: (info: any) => void)             => ipcRenderer.on('server-closed',       (_e, info) => cb(info)),
  onPlayerJoin:  (cb: (name: string) => void)          => ipcRenderer.on('server-player-join',  (_e, n)    => cb(n)),
  onPlayerCount: (cb: (cur: number, max: number) => void) => ipcRenderer.on('server-player-count', (_e, c, m) => cb(c, m)),
});

contextBridge.exposeInMainWorld('overlay', {
  getMods:  () => ipcRenderer.invoke('overlay-get-mods'),
  saveMods: (data: any) => ipcRenderer.invoke('overlay-save-mods', data),
  close:    () => ipcRenderer.send('overlay-close'),
});

contextBridge.exposeInMainWorld('files', {
  listWorlds:       () => ipcRenderer.invoke('mc-list-worlds'),
  installWorld:     (p: string) => ipcRenderer.invoke('mc-install-world', p),
  listSchematics:   () => ipcRenderer.invoke('mc-list-schematics'),
  installSchematic: (p: string) => ipcRenderer.invoke('mc-install-schematic', p),
  openFolder:       (type: string) => ipcRenderer.invoke('mc-open-folder', type),
});

contextBridge.exposeInMainWorld('cosmetics', {
  installMod: () => ipcRenderer.invoke('cosmetics-install-mod'),
  getUuid:    () => ipcRenderer.invoke('mc-get-uuid'),
});

contextBridge.exposeInMainWorld('mc', {
  auth:            () => ipcRenderer.invoke('mc-auth'),
  reauth:          () => ipcRenderer.invoke('mc-reauth'),
  launch:          (opts: { version: string; maxMem: number; javaVersion?: number }) => ipcRenderer.invoke('mc-launch', opts),
  launchOffline:   (opts: { version: string; maxMem: number; username: string; javaVersion?: number }) => ipcRenderer.invoke('mc-launch-offline', opts),
  uploadSkin:      (opts: { base64: string; variant: 'classic' | 'slim' }) => ipcRenderer.invoke('mc-upload-skin', opts),
  kill:            () => ipcRenderer.invoke('mc-kill'),
  repair:          () => ipcRenderer.invoke('mc-repair'),
  installFabric:   (opts: { mcVersion: string }) => ipcRenderer.invoke('mc-install-fabric', opts),
  crashReport:     () => ipcRenderer.invoke('mc-crash-report'),
  launchBedrock:   () => ipcRenderer.invoke('mc-launch-bedrock'),
  installMod:      (opts: { url: string; filename: string })  => ipcRenderer.invoke('mc-install-mod',  opts),
  removeMod:       (opts: { filename: string })               => ipcRenderer.invoke('mc-remove-mod',   opts),
  toggleMod:       (opts: { filename: string; enable: boolean }) => ipcRenderer.invoke('mc-toggle-mod', opts),
  listMods:        ()                                         => ipcRenderer.invoke('mc-list-mods'),
  installBg:             (opts: { images: string[] })               => ipcRenderer.invoke('mc-install-bg',  opts),
  listScreenshots:       () => ipcRenderer.invoke('mc-list-screenshots'),
  openScreenshot:        (p: string) => ipcRenderer.invoke('mc-open-screenshot', p),
  showScreenshotsFolder: () => ipcRenderer.invoke('mc-show-screenshots-folder'),
  listResourcePacks:     () => ipcRenderer.invoke('mc-list-resourcepacks'),
  installResourcePack:   (opts: { url: string; filename: string }) => ipcRenderer.invoke('mc-install-resourcepack', opts),
  removeResourcePack:    (opts: { filename: string }) => ipcRenderer.invoke('mc-remove-resourcepack', opts),
  onAlreadyAuthed: (cb: (name: string) => void) => ipcRenderer.on('mc-already-authed', (_e, n) => cb(n)),
  onLog:           (cb: (line: string) => void) => ipcRenderer.on('mc-log',      (_e, l) => cb(l)),
  onProgress:      (cb: (e: any) => void)       => ipcRenderer.on('mc-progress', (_e, e) => cb(e)),
  onClosed:        (cb: (code: number) => void) => ipcRenderer.on('mc-closed',   (_e, c) => cb(c)),
  onError:         (cb: (msg: string) => void)  => ipcRenderer.on('mc-error',    (_e, m) => cb(m)),
});
