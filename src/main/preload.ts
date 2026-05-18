import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electron', {
  loginSuccess: (userData: object) => ipcRenderer.send('login-success', userData),
  onUserData:   (cb: (data: any) => void) => ipcRenderer.on('user-data', (_e, d) => cb(d)),
  close:        () => ipcRenderer.send('win-close'),
  minimize:     () => ipcRenderer.send('win-minimize'),
  maximize:     () => ipcRenderer.send('win-maximize'),
});

contextBridge.exposeInMainWorld('mc', {
  connect:      (host: string, port: number, username: string) =>
                  ipcRenderer.invoke('mc-connect', { host, port, username }),
  disconnect:   () => ipcRenderer.send('mc-disconnect'),
  chat:         (message: string) => ipcRenderer.send('mc-chat', message),
  onChat:       (cb: (msg: string) => void) => ipcRenderer.on('mc-chat', (_e, m) => cb(m)),
  onLogin:      (cb: (data: any) => void) => ipcRenderer.on('mc-login', (_e, d) => cb(d)),
  onKicked:     (cb: (reason: string) => void) => ipcRenderer.on('mc-kicked', (_e, r) => cb(r)),
  onError:      (cb: (err: string) => void) => ipcRenderer.on('mc-error', (_e, e) => cb(e)),
  onEnd:        (cb: (reason: string) => void) => ipcRenderer.on('mc-end', (_e, r) => cb(r)),
  onDeviceCode: (cb: (data: { userCode: string; verificationUri: string }) => void) =>
                  ipcRenderer.on('mc-device-code', (_e, d) => cb(d)),
});
