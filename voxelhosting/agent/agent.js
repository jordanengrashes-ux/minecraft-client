#!/usr/bin/env node
// VoxelHosting Agent — runs on your own PC and does the real work: downloads
// server jars, launches `java`, streams console output, and applies files/
// config changes requested from the web dashboard. Log in with the SAME
// account (email/password) you use on the dashboard — it only ever touches
// servers that belong to that account.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const { spawn } = require('child_process');

const { initializeApp } = require('firebase/app');
const {
  initializeAuth, inMemoryPersistence, signInWithEmailAndPassword,
} = require('firebase/auth');
const {
  getFirestore, collection, query, where, onSnapshot, doc, setDoc,
} = require('firebase/firestore');
const {
  getDatabase, ref, push, onChildAdded, set, get, remove,
} = require('firebase/database');
const {
  getStorage, ref: sRef, getBytes,
} = require('firebase/storage');

const firebaseConfig = {
  apiKey: "AIzaSyDiiPTWvpdDBkeazQRz79MSp_RfcDlarOs",
  authDomain: "tank-d367c.firebaseapp.com",
  databaseURL: "https://tank-d367c-default-rtdb.firebaseio.com",
  projectId: "tank-d367c",
  storageBucket: "tank-d367c.firebasestorage.app",
  messagingSenderId: "479668253104",
  appId: "1:479668253104:web:c8e2a735e2b8da111be675",
};

const app = initializeApp(firebaseConfig);
// initializeAuth (not getAuth) with an explicit persistence — in plain Node,
// getAuth() probes for IndexedDB (browser-only) to pick a persistence layer
// and that probe can hang instead of failing fast.
const auth = initializeAuth(app, { persistence: inMemoryPersistence });
const db = getFirestore(app);
const rtdb = getDatabase(app);
const storage = getStorage(app);

const DATA_DIR = path.join(__dirname, 'servers');

const FOLDER_MAP = {
  plugins: 'plugins',
  mods: 'mods',
  world: 'world-uploads', // uploaded world zips; extract manually into the server dir
  datapacks: 'datapacks',
  resourcepacks: 'resourcepacks',
};

const running = new Map(); // serverId -> { proc, dir }

// One shared interface for the whole CLI session — creating a new
// readline.createInterface() per question can swallow buffered input meant
// for the next prompt (e.g. when stdin is piped), leaving later prompts
// hanging forever with no input left to read.
let _rl = null;
function getRl() {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
function ask(question) {
  return new Promise(resolve => getRl().question(question, resolve));
}

function askHidden(question) {
  // Plain prompt (no masking) — this is a local CLI tool, not a shared terminal.
  return ask(question);
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlinkSync(destPath);
        return download(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) { reject(new Error(`Download failed: HTTP ${res.statusCode}`)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'voxelhosting-agent' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function resolveJarUrl(type, version) {
  if (type === 'Paper') {
    const builds = await fetchJson(`https://api.papermc.io/v2/projects/paper/versions/${version}/builds`);
    const build = builds.builds[builds.builds.length - 1];
    const jarName = build.downloads.application.name;
    return `https://api.papermc.io/v2/projects/paper/versions/${version}/builds/${build.build}/downloads/${jarName}`;
  }
  // Vanilla (also used as fallback for Spigot/Fabric until those are wired up)
  const manifest = await fetchJson('https://launchermeta.mojang.com/mc/game/version_manifest.json');
  const entry = manifest.versions.find(v => v.id === version);
  if (!entry) throw new Error(`Unknown Minecraft version "${version}"`);
  const meta = await fetchJson(entry.url);
  return meta.downloads.server.url;
}

function serverDir(serverId) {
  const dir = path.join(DATA_DIR, serverId);
  for (const sub of new Set(Object.values(FOLDER_MAP))) {
    if (sub !== '.') fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

async function setStatus(serverId, status) {
  await set(ref(rtdb, `vhServers/${serverId}/status`), status).catch(() => {});
  await setDoc(doc(db, 'vhServers', serverId), { status }, { merge: true }).catch(() => {});
}

async function log(serverId, text) {
  await push(ref(rtdb, `vhServers/${serverId}/log`), { text, ts: Date.now() }).catch(() => {});
}

function writeServerProperties(dir, cfg) {
  const props = [
    `server-port=${cfg.port || 25565}`,
    `max-players=${cfg.maxPlayers || 20}`,
    `motd=${cfg.motd || 'A VoxelHosting Server'}`,
    `gamemode=${cfg.gamemode || 'survival'}`,
    'difficulty=easy',
    'pvp=true',
    'online-mode=true',
    'spawn-protection=0',
    'view-distance=10',
    'white-list=false',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'server.properties'), props);
}

async function pushConfigToRtdb(serverId, file, content) {
  await set(ref(rtdb, `vhServers/${serverId}/configs/${file.replace('.', '_')}`), content).catch(() => {});
}

async function initServer(serverId, cfg) {
  const dir = serverDir(serverId);
  writeServerProperties(dir, cfg);
  await pushConfigToRtdb(serverId, 'server.properties', fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'));
  await log(serverId, `[Agent] Server folder created for "${cfg.name}". Files are ready in the Files tab.`);
  for (const folder of Object.keys(FOLDER_MAP)) await listFiles(serverId, folder);
}

async function startServer(serverId, cfg) {
  if (running.has(serverId)) { await log(serverId, '[Agent] Server is already running.'); return; }
  const dir = serverDir(serverId);
  const jarPath = path.join(dir, 'server.jar');

  await setStatus(serverId, 'starting');
  try {
    if (!fs.existsSync(jarPath)) {
      await log(serverId, `[Agent] Downloading ${cfg.type} ${cfg.version} server jar…`);
      const url = await resolveJarUrl(cfg.type, cfg.version);
      await download(url, jarPath);
      await log(serverId, '[Agent] Download complete.');
    }
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
    writeServerProperties(dir, cfg);

    const ram = cfg.ram || '2G';
    const proc = spawn('java', [`-Xmx${ram}`, `-Xms${ram}`, '-jar', 'server.jar', 'nogui'], { cwd: dir });
    running.set(serverId, { proc, dir });

    proc.stdout.on('data', chunk => {
      const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        log(serverId, line);
        if (/Done \(/.test(line)) setStatus(serverId, 'online');
      }
    });
    proc.stderr.on('data', chunk => log(serverId, `[ERROR] ${chunk.toString().trim()}`));
    proc.on('exit', code => {
      running.delete(serverId);
      log(serverId, `[Agent] Server process exited (code ${code}).`);
      setStatus(serverId, 'offline');
    });
  } catch (e) {
    await log(serverId, `[Agent] Failed to start: ${e.message}`);
    await setStatus(serverId, 'offline');
  }
}

async function stopServer(serverId) {
  const entry = running.get(serverId);
  if (!entry) { await setStatus(serverId, 'offline'); return; }
  entry.proc.stdin.write('stop\n');
  setTimeout(() => { if (running.has(serverId)) entry.proc.kill(); }, 20000);
}

function sendCommand(serverId, text) {
  const entry = running.get(serverId);
  if (!entry) { log(serverId, '[Agent] Server is not running.'); return; }
  entry.proc.stdin.write(text + '\n');
  log(serverId, `> ${text}`);
}

async function listFiles(serverId, folder) {
  const dir = path.join(serverDir(serverId), FOLDER_MAP[folder] || folder);
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(name => fs.statSync(path.join(dir, name)).isFile())
      .map(name => ({ name, size: fs.statSync(path.join(dir, name)).size }));
  } catch {}
  await set(ref(rtdb, `vhServers/${serverId}/files/${folder}`), files).catch(() => {});
}

async function downloadFile(serverId, folder, filename, storagePath) {
  const dir = path.join(serverDir(serverId), FOLDER_MAP[folder] || folder);
  fs.mkdirSync(dir, { recursive: true });
  const bytes = await getBytes(sRef(storage, storagePath));
  fs.writeFileSync(path.join(dir, filename), Buffer.from(bytes));
  await log(serverId, `[Agent] Downloaded ${filename} into ${folder}.`);
  await listFiles(serverId, folder);
}

async function deleteFile(serverId, folder, filename) {
  const dir = path.join(serverDir(serverId), FOLDER_MAP[folder] || folder);
  try { fs.unlinkSync(path.join(dir, filename)); } catch {}
  await log(serverId, `[Agent] Deleted ${filename} from ${folder}.`);
  await listFiles(serverId, folder);
}

async function writeConfig(serverId, file, content) {
  const dir = serverDir(serverId);
  fs.writeFileSync(path.join(dir, file), content);
  await pushConfigToRtdb(serverId, file, content);
  await log(serverId, `[Agent] Wrote ${file}.`);
}

async function readConfig(serverId, file, cfg) {
  const dir = serverDir(serverId);
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath) && file === 'server.properties') writeServerProperties(dir, cfg);
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  await pushConfigToRtdb(serverId, file, content);
}

function watchServerCommands(serverId, cfgRef) {
  const cmdRef = ref(rtdb, `vhServers/${serverId}/cmd`);
  onChildAdded(cmdRef, async snap => {
    const { action, ...extra } = snap.val() || {};
    remove(ref(rtdb, `vhServers/${serverId}/cmd/${snap.key}`)).catch(() => {});
    switch (action) {
      case 'init': await initServer(serverId, cfgRef()); break;
      case 'start': await startServer(serverId, cfgRef()); break;
      case 'stop': await stopServer(serverId); break;
      case 'command': sendCommand(serverId, extra.text); break;
      case 'list-files': await listFiles(serverId, extra.folder); break;
      case 'download-file': await downloadFile(serverId, extra.folder, extra.filename, extra.storagePath); break;
      case 'delete-file': await deleteFile(serverId, extra.folder, extra.filename); break;
      case 'write-config': await writeConfig(serverId, extra.file, extra.content); break;
      case 'read-config': await readConfig(serverId, extra.file, cfgRef()); break;
    }
  });
}

const SESSION_FILE = path.join(__dirname, '.session.json');

async function login() {
  if (process.argv.includes('--logout')) {
    try { fs.unlinkSync(SESSION_FILE); } catch {}
    console.log('Saved login cleared.');
  }

  let email, password;
  const cached = fs.existsSync(SESSION_FILE) ? JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) : null;
  if (cached) {
    console.log(`Using saved login for ${cached.email}… (run "node agent.js --logout" to forget it)`);
    email = cached.email; password = cached.password;
  } else {
    email = await ask('Dashboard email: ');
    password = await askHidden('Password: ');
  }

  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out reaching Firebase — check your internet connection or firewall.')), 15000));
    const { user } = await Promise.race([signInWithEmailAndPassword(auth, email, password), timeout]);
    if (!cached) {
      const remember = (await ask('Save login on this PC so you don\'t have to enter it again? (y/n): ')).trim().toLowerCase();
      if (remember === 'y' || remember === 'yes') {
        fs.writeFileSync(SESSION_FILE, JSON.stringify({ email, password }), { mode: 0o600 });
        console.log('Saved. Next time, just run the agent and it will log in automatically.');
      }
    }
    return user;
  } catch (e) {
    if (cached) { try { fs.unlinkSync(SESSION_FILE); } catch {} }
    console.error('Login failed:', e.message);
    console.error('Note: Google-only accounts need an email/password set (Firebase console → Authentication) before the agent can log in.');
    process.exit(1);
  }
}

async function main() {
  console.log('VoxelHosting Agent — connects your dashboard to a real Minecraft server on this PC.\n');
  const user = await login();
  console.log(`Logged in as ${user.email}. Watching your servers…\n`);

  const watched = new Set();
  const configs = new Map();

  const q = query(collection(db, 'vhServers'), where('uid', '==', user.uid));
  onSnapshot(q, snap => {
    snap.docs.forEach(d => {
      configs.set(d.id, { id: d.id, ...d.data() });
      if (!watched.has(d.id)) {
        watched.add(d.id);
        watchServerCommands(d.id, () => configs.get(d.id));
        console.log(`Watching server: ${d.data().name} (${d.id})`);
      }
    });
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down — stopping any running servers…');
    for (const [serverId] of running) await stopServer(serverId);
    setTimeout(() => process.exit(0), 500);
  });
}

main();
