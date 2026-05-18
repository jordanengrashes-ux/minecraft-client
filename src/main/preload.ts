import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  loginSuccess: (userData: object) => ipcRenderer.send('login-success', userData),
  onUserData:   (cb: (data: any) => void) => ipcRenderer.on('user-data', (_e, d) => cb(d)),
  close:        () => ipcRenderer.send('win-close'),
  minimize:     () => ipcRenderer.send('win-minimize'),
  maximize:     () => ipcRenderer.send('win-maximize'),
});

contextBridge.exposeInMainWorld('mc', {
  auth:       () => ipcRenderer.invoke('mc-auth'),
  launch:     (opts: { version: string; maxMem: number }) => ipcRenderer.invoke('mc-launch', opts),
  onLog:      (cb: (line: string) => void)   => ipcRenderer.on('mc-log',      (_e, l) => cb(l)),
  onProgress: (cb: (e: any) => void)         => ipcRenderer.on('mc-progress', (_e, e) => cb(e)),
  onClosed:   (cb: (code: number) => void)   => ipcRenderer.on('mc-closed',   (_e, c) => cb(c)),
  onError:    (cb: (msg: string) => void)    => ipcRenderer.on('mc-error',    (_e, m) => cb(m)),
});
