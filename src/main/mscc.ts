// Link with Minecraft Server Control Center, a desktop panel that runs
// Minecraft servers on this PC.
//  - The panel writes the servers it manages to voxel-link.json; we read it
//    for the quick-join bar.
//  - We run a small control API on 127.0.0.1 so the panel can start the game
//    and join one of its servers. The port and a random token are written to
//    control.json in our user data folder, which only this Windows user can read.
import { app } from 'electron';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface PanelServer {
  id: string;
  name: string;
  software: string;
  mcVersion: string;
  status: string;
  address: string;
  port: number;
  onlineMode: boolean;
  players: number;
  maxPlayers: number;
  java: boolean;
}

export interface PanelServers {
  available: boolean;
  panelRunning: boolean;
  servers: PanelServer[];
}

export interface PanelLaunchRequest {
  version: string;
  server?: string;
  username?: string;
  offline?: boolean;
  maxMem?: number;
}

export interface ControlHandlers {
  launch: (req: PanelLaunchRequest) => Promise<{ ok: boolean; error?: string }>;
  status: () => { running: boolean; starting: boolean; pid?: number };
  kill: () => void;
  show: () => void;
}

const CONTROL_FILE = () => path.join(app.getPath('userData'), 'control.json');

function linkFile(): string {
  if (process.env.MSCC_LINK_FILE) return process.env.MSCC_LINK_FILE;
  return path.join(app.getPath('appData'), 'Minecraft Server Control Center', 'voxel-link.json');
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

export function readPanelServers(): PanelServers {
  try {
    const j = JSON.parse(fs.readFileSync(linkFile(), 'utf-8'));
    const panelRunning = pidAlive(Number(j.pid));
    const servers: PanelServer[] = (Array.isArray(j.servers) ? j.servers : []).map((s: PanelServer) => (panelRunning ? s : { ...s, status: 'offline', players: 0 }));
    return { available: true, panelRunning, servers };
  } catch {
    return { available: false, panelRunning: false, servers: [] };
  }
}

/** Calls onChange whenever the panel's server list (or its state) changes. */
export function watchPanelServers(onChange: (d: PanelServers) => void): void {
  let last = '';
  const tick = () => {
    const d = readPanelServers();
    const s = JSON.stringify(d);
    if (s !== last) {
      last = s;
      onChange(d);
    }
  };
  tick();
  setInterval(tick, 2000).unref();
}

export function startControlServer(h: ControlHandlers): void {
  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // Browsers can't send this header cross-origin without a CORS preflight,
    // which we never approve, so web pages can't drive this API.
    if (req.headers['x-voxel-token'] !== token) return send(403, { ok: false, error: 'Bad token' });
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', async () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        if (req.method === 'GET' && req.url === '/status') return send(200, { ok: true, version: app.getVersion(), ...h.status() });
        if (req.method === 'POST' && req.url === '/launch') {
          if (typeof body.version !== 'string' || !body.version) return send(400, { ok: false, error: 'version is required' });
          if (body.username !== undefined && !/^[A-Za-z0-9_]{3,16}$/.test(body.username)) return send(400, { ok: false, error: 'Usernames are 3-16 letters, numbers or _' });
          if (body.server !== undefined && !/^[A-Za-z0-9.\-[\]:]+$/.test(body.server)) return send(400, { ok: false, error: 'Bad server address' });
          return send(200, await h.launch(body));
        }
        if (req.method === 'POST' && req.url === '/kill') {
          h.kill();
          return send(200, { ok: true });
        }
        if (req.method === 'POST' && req.url === '/show') {
          h.show();
          return send(200, { ok: true });
        }
        send(404, { ok: false, error: 'Not found' });
      } catch (e: any) {
        send(500, { ok: false, error: String(e?.message ?? e) });
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    const info = { port, token, pid: process.pid, exePath: process.execPath, appPath: app.isPackaged ? null : app.getAppPath(), version: app.getVersion() };
    try {
      fs.writeFileSync(CONTROL_FILE(), JSON.stringify(info));
    } catch {}
  });
  app.on('will-quit', () => {
    try {
      const cur = JSON.parse(fs.readFileSync(CONTROL_FILE(), 'utf-8'));
      if (cur.pid === process.pid) fs.rmSync(CONTROL_FILE(), { force: true });
    } catch {}
  });
}

/** Java major version Minecraft needs (same rule as the Play page's "Auto"). */
export function javaForMc(version: string): number {
  const id = version.replace(/^fabric-loader-[\d.]+-/, '');
  const m = id.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const maj = parseInt(m[1]);
  if (maj !== 1) return 25;
  const min = parseInt(m[2]);
  const patch = m[3] ? parseInt(m[3]) : 0;
  if (min < 17) return 8;
  if (min < 21) return 17;
  if (min === 21 && patch <= 11) return 21;
  return 25;
}

/** Arguments that make Minecraft connect to a server as soon as it starts. */
export function quickPlayFor(version: string, server: string) {
  const id = version.replace(/^fabric-loader-[\d.]+-/, '');
  const m = id.match(/^(\d+)\.(\d+)/);
  // --quickPlayMultiplayer exists since 1.20; older versions use --server/--port
  const modern = !m || parseInt(m[1]) > 1 || parseInt(m[2]) >= 20;
  return { quickPlay: { type: modern ? 'multiplayer' : 'legacy', identifier: server } };
}
