import { contextBridge, ipcRenderer, clipboard } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  loginSuccess:       (userData: object) => ipcRenderer.send('login-success', userData),
  logout:             () => ipcRenderer.send('logout'),
  onUserData:         (cb: (data: any) => void) => ipcRenderer.on('user-data', (_e, d) => cb(d)),
  close:              () => ipcRenderer.send('win-close'),
  minimize:           () => ipcRenderer.send('win-minimize'),
  relaunch:           () => ipcRenderer.send('win-relaunch'),
  maximize:           () => ipcRenderer.send('win-maximize'),
  copyText:           (text: string) => clipboard.writeText(text),
  openExternal:       (url: string)  => ipcRenderer.send('open-external', url),
  saveFirebaseUser:   (data: object) => ipcRenderer.invoke('save-firebase-user', data),
  loadFirebaseUser:   ()             => ipcRenderer.invoke('load-firebase-user'),
  clearFirebaseUser:  ()             => ipcRenderer.invoke('clear-firebase-user'),
  googleAuth:         ()             => ipcRenderer.invoke('google-auth'),
});

contextBridge.exposeInMainWorld('voxelSrv', {
  status:        ()               => ipcRenderer.invoke('voxel-srv-status'),
  start:         ()               => ipcRenderer.invoke('voxel-srv-start'),
  stop:          ()               => ipcRenderer.invoke('voxel-srv-stop'),
  autostartGet:  ()               => ipcRenderer.invoke('voxel-srv-autostart-get'),
  autostartSet:  (e: boolean)     => ipcRenderer.invoke('voxel-srv-autostart-set', e),
  onLog:         (cb: (s: string) => void) => ipcRenderer.on('voxel-srv-log',    (_e, s) => cb(s)),
  onClosed:      (cb: () => void)          => ipcRenderer.on('voxel-srv-closed', () => cb()),
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
  downloadAvengers: () => ipcRenderer.invoke('download-avengers-mod'),
  listWorlds:       () => ipcRenderer.invoke('mc-list-worlds'),
  savesDir:         () => ipcRenderer.invoke('mc-saves-dir'),
  installWorld:     (p: string) => ipcRenderer.invoke('mc-install-world', p),
  listSchematics:   () => ipcRenderer.invoke('mc-list-schematics'),
  installSchematic: (p: string) => ipcRenderer.invoke('mc-install-schematic', p),
  openFolder:       (type: string) => ipcRenderer.invoke('mc-open-folder', type),
});

contextBridge.exposeInMainWorld('ai', {
  chat:   (messages: { role: string; content: string }[]) => ipcRenderer.invoke('ai-chat', messages),
  setKey: (key: string) => ipcRenderer.invoke('ai-set-key', key),
  getKey: ()            => ipcRenderer.invoke('ai-get-key'),
});

contextBridge.exposeInMainWorld('curseforge', {
  search:      (opts: { query: string; mcVersion: string }) => ipcRenderer.invoke('cf-search', opts),
  getDownload: (opts: { modId: number; mcVersion: string }) => ipcRenderer.invoke('cf-get-download-url', opts),
  checkUpdates:(mods: { modId: number; fileId: number }[], mcVersion: string) => ipcRenderer.invoke('cf-check-updates', mods, mcVersion),
});

contextBridge.exposeInMainWorld('cosmetics', {
  installMod: () => ipcRenderer.invoke('cosmetics-install-mod'),
  getUuid:    () => ipcRenderer.invoke('mc-get-uuid'),
});

contextBridge.exposeInMainWorld('mc', {
  auth:            () => ipcRenderer.invoke('mc-auth'),
  reauth:          () => ipcRenderer.invoke('mc-reauth'),
  launch:          (opts: { version: string; maxMem: number; javaVersion?: number; forgePath?: string }) => ipcRenderer.invoke('mc-launch', opts),
  launchOffline:   (opts: { version: string; maxMem: number; username: string; javaVersion?: number; forgePath?: string }) => ipcRenderer.invoke('mc-launch-offline', opts),
  uploadSkin:      (opts: { base64: string; variant: 'classic' | 'slim' }) => ipcRenderer.invoke('mc-upload-skin', opts),
  kill:            () => ipcRenderer.invoke('mc-kill'),
  repair:          () => ipcRenderer.invoke('mc-repair'),
  installFabric:   (opts: { mcVersion: string }) => ipcRenderer.invoke('mc-install-fabric', opts),
  installForge:    (opts: { mcVersion: string }) => ipcRenderer.invoke('mc-install-forge', opts),
  installNeoForge: (opts: { mcVersion: string }) => ipcRenderer.invoke('mc-install-neoforge', opts),
  crashReport:     () => ipcRenderer.invoke('mc-crash-report'),
  launchBedrock:   () => ipcRenderer.invoke('mc-launch-bedrock'),
  installBedrockPack: (opts: { url: string; name: string }) => ipcRenderer.invoke('mc-install-bedrock-pack', opts),
  listBedrockPacks:   () => ipcRenderer.invoke('mc-list-bedrock-packs'),
  removeBedrockPack:  (opts: { packId: string; packType: string }) => ipcRenderer.invoke('mc-remove-bedrock-pack', opts),
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
  installModpack:      (opts: { projectId: string }) => ipcRenderer.invoke('mc-install-modpack', opts),
  onModpackProgress:   (cb: (e: any) => void) => ipcRenderer.on('mc-modpack-progress', (_e, e) => cb(e)),
  openAiWindow:        () => ipcRenderer.invoke('open-ai-window'),
  onAlreadyAuthed: (cb: (name: string) => void) => ipcRenderer.on('mc-already-authed', (_e, n) => cb(n)),
  onLog:           (cb: (line: string) => void) => ipcRenderer.on('mc-log',      (_e, l) => cb(l)),
  onProgress:      (cb: (e: any) => void)       => ipcRenderer.on('mc-progress', (_e, e) => cb(e)),
  onClosed:        (cb: (code: number) => void) => ipcRenderer.on('mc-closed',   (_e, c) => cb(c)),
  onError:         (cb: (msg: string) => void)  => ipcRenderer.on('mc-error',    (_e, m) => cb(m)),
});
