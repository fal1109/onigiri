const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

// supabase-js's Realtime client needs a WebSocket implementation when run
// outside a browser (i.e. here, in Electron's Node main process).
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = require('ws');
}

// ---------------------------------------------------------------------------
// Config (persisted as plain JSON in the app's userData folder)
// ---------------------------------------------------------------------------
const CONFIG_PATH = path.join(app.getPath('userData'), 'onigiri-config.json');

function defaultConfig() {
  return {
    username: os.userInfo().username || 'guest',
    downloadDir: path.join(app.getPath('videos'), 'onigiri'),
    webhookUrl: '',
    supabaseUrl: '',
    supabaseKey: '',
    hasSeenChatHint: false,
    avatarUrl: '',
    themeMode: 'dark',
    colorScheme: 'salmon',
    backgroundUrl: '',
    backgroundEnabled: true,
    backgroundBlur: 24,
    backgroundParallax: true,
    customTheme: null,
    downloadQuality: 'best',
    discordRpc: { enabled: false, showParticipants: true, showGithubButton: true }
  };
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return { ...defaultConfig(), ...JSON.parse(raw) };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ---------------------------------------------------------------------------
// Emotes — kept in their own plain JSON file (not the main config) so
// they're easy to hand-edit, back up, or share separately:
//   [{ "name": "mycustomone", "url": "https://…" }, …]
// ---------------------------------------------------------------------------
const EMOTES_PATH = path.join(app.getPath('userData'), 'onigiri-emotes.json');

function loadEmotes() {
  try {
    const raw = fs.readFileSync(EMOTES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  // One-time migration from the old config-embedded list, if present.
  if (Array.isArray(config.customEmojis) && config.customEmojis.length) {
    saveEmotes(config.customEmojis);
    return config.customEmojis;
  }
  return [];
}

function saveEmotes(list) {
  fs.mkdirSync(path.dirname(EMOTES_PATH), { recursive: true });
  fs.writeFileSync(EMOTES_PATH, JSON.stringify(list, null, 2));
}

let emotes = loadEmotes();

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#141311',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  fs.mkdirSync(config.downloadDir, { recursive: true });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopEverything();
  clearDiscordRpc();
  if (process.platform !== 'darwin') app.quit();
});

function send(channelName, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channelName, payload);
  }
}

// ---------------------------------------------------------------------------
// Discord Rich Presence — optional, off by default. Shows "Watching Onigiri"
// with the room code, participant count, and (optionally) a GitHub button.
// ---------------------------------------------------------------------------
let rpcClient = null;
let rpcStartedAt = null;
let rpcParticipants = 0;
let activeRoomCode = null;

// Create a Discord Application at discord.com/developers, enable Rich Presence
// and put its Application ID here. Upload build/icon.png as the "onigiri"
// asset on that app's Rich Presence page so the art shows up.
const RPC_CLIENT_ID = '1552320003640918189';

const RPC_GITHUB_URL = 'https://github.com/fal1109/onigiri';

async function updateDiscordRpc() {
  const rpc = config.discordRpc || {};
  if (!rpc.enabled) return;
  if (!rpcClient) {
    try {
      const { Client } = require('discord-rpc');
      rpcClient = new Client({ transport: 'ipc' });
      rpcClient.on('error', () => { /* Discord not running — stay quiet */ });
      await rpcClient.login({ clientId: RPC_CLIENT_ID }).catch(() => { rpcClient = null; });
    } catch {
      rpcClient = null;
      return;
    }
  }
  if (!rpcClient) return;
  if (!rpcStartedAt) rpcStartedAt = Date.now();
  const inRoom = Boolean(activeRoomCode);
  const buttons = rpc.showGithubButton ? [{ label: 'GitHub', url: RPC_GITHUB_URL }] : undefined;
  try {
    await rpcClient.setActivity({
      // Deliberately no room code here — Discord presence is visible to
      // anyone who can see the user's status, and rooms join by code.
      details: inRoom ? 'Watching together' : 'Idle in the lobby',
      state: inRoom && rpc.showParticipants ? `${rpcParticipants} participant${rpcParticipants === 1 ? '' : 's'}` : undefined,
      startTimestamp: rpcStartedAt,
      largeImageKey: 'onigiri',
      largeImageText: 'Onigiri — watch together',
      smallImageKey: 'onigiri',
      instance: false,
      buttons,
    });
  } catch { /* presence is best-effort */ }
}

function clearDiscordRpc() {
  rpcStartedAt = null;
  rpcParticipants = 0;
  if (rpcClient) {
    rpcClient.clearActivity().catch(() => {});
  }
}

app.on('before-quit', () => {
  if (rpcClient) { try { rpcClient.destroy(); } catch { /* ignore */ } rpcClient = null; }
});

// ---------------------------------------------------------------------------
// Networking — a room is a Supabase Realtime channel named after a short
// room code. Nobody's IP or port is ever shared: everyone (host and guests
// alike) makes an outbound connection to Supabase, which relays broadcast
// messages between them. Only timestamps / play-state / chat / the queue
// travel this way — the video file itself is never sent, each side
// downloads its own local copy from the same source link.
//
// The room's video state is a queue: [{ id, url }], plus a queueIndex
// pointing at the item currently "loaded". Adding/removing/jumping in the
// queue is what drives which video everyone downloads and watches — there's
// no separate single-video concept anymore.
// ---------------------------------------------------------------------------
let supabaseClient = null;
let channel = null;
let role = null;              // 'host' | 'client' — who CREATED vs JOINED; no longer used for permissions
let currentUsername = '';
let sawInitialPresenceSync = false;
let roomState = { isPlaying: false, time: 0, queue: [], queueIndex: -1, djUsernames: [] };

// Host succession: the room's creator is the host for as long as they're
// present. If they disconnect, whoever's been connected longest becomes
// host in their place — computed identically by every peer from the same
// presence data, so there's no election/coordination needed. The instant
// the original host reconnects, they reclaim it (their username still
// takes priority over anyone standing in).
let originalHostUsername = null;
let amIHost = false;

function computeActiveHost(presenceState) {
  const entries = Object.values(presenceState).flat();
  if (originalHostUsername && entries.some((e) => e.username === originalHostUsername)) {
    return originalHostUsername;
  }
  let earliest = null;
  for (const e of entries) {
    if (!earliest || (e.joinedAt ?? Infinity) < (earliest.joinedAt ?? Infinity)) earliest = e;
  }
  return earliest ? earliest.username : null;
}

function pushPeers(ch) {
  const state = ch.presenceState();
  const participants = Object.values(state).flat().map((p) => ({ username: p.username, avatarUrl: p.avatarUrl || null }));
  const activeHost = computeActiveHost(state);
  amIHost = activeHost === currentUsername;
  rpcParticipants = participants.length;
  updateDiscordRpc();
  send('net:peers', { participants, activeHost, amIHost });
}

function getSupabaseClient() {
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error('Add your Supabase project URL and anon key in Settings first.');
  }
  if (!supabaseClient || supabaseClient.__url !== config.supabaseUrl || supabaseClient.__key !== config.supabaseKey) {
    supabaseClient = createClient(config.supabaseUrl, config.supabaseKey);
    supabaseClient.__url = config.supabaseUrl;
    supabaseClient.__key = config.supabaseKey;
  }
  return supabaseClient;
}

function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous-looking characters
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function handleBroadcast(type, payload) {
  switch (type) {
    case 'player': {
      // main.js's own bookkeeping (used to answer sync-requests) only
      // accepts events that match what WE believe is the current queue
      // item. But relaying to the renderer is unconditional — the renderer
      // has its own ground-truth check against the video it has actually
      // loaded (currentItemId), which is the only thing that can't lag
      // behind a fast-moving queue the way this roomState mirror can.
      const localCurrent = roomState.queue[roomState.queueIndex];
      const localItemId = localCurrent ? localCurrent.id : null;
      if (payload.queueItemId === localItemId) {
        roomState.isPlaying = payload.action === 'play' ? true : payload.action === 'pause' ? false : roomState.isPlaying;
        roomState.time = payload.time;
      }
      send('net:remote-player-event', payload);
      break;
    }
    case 'queue-update':
      roomState.queue = payload.queue;
      roomState.queueIndex = payload.queueIndex;
      send('net:queue', payload);
      break;
    case 'chat':
      send('net:chat', payload);
      if (amIHost) postToDiscord(payload.username, payload.text);
      break;
    case 'typing':
      send('net:typing', payload);
      break;
    case 'typing-stop':
      send('net:typing-stop', payload);
      break;
    case 'dj-update':
      roomState.djUsernames = payload.djUsernames;
      send('net:dj', payload);
      break;
    default:
      break;
  }
}

function subscribeToRoom(code, username) {
  return new Promise((resolve, reject) => {
    let sb;
    try { sb = getSupabaseClient(); } catch (err) { reject(err); return; }

    const ch = sb.channel(`onigiri-room-${code}`, {
      config: {
        broadcast: { self: false },
        presence: { key: `${username}-${Math.random().toString(36).slice(2, 8)}` }
      }
    });

    ch.on('broadcast', { event: 'player' }, ({ payload }) => handleBroadcast('player', payload));
    ch.on('broadcast', { event: 'queue-update' }, ({ payload }) => handleBroadcast('queue-update', payload));
    ch.on('broadcast', { event: 'chat' }, ({ payload }) => handleBroadcast('chat', payload));
    ch.on('broadcast', { event: 'typing' }, ({ payload }) => handleBroadcast('typing', payload));
    ch.on('broadcast', { event: 'typing-stop' }, ({ payload }) => handleBroadcast('typing-stop', payload));
    ch.on('broadcast', { event: 'dj-update' }, ({ payload }) => handleBroadcast('dj-update', payload));

    // Any currently-connected peer can answer a sync-request with its own
    // local mirror of the room state — no single point of failure if the
    // original host has since left.
    ch.on('broadcast', { event: 'sync-request' }, () => {
      ch.send({
        type: 'broadcast', event: 'sync-response',
        payload: {
          time: roomState.time, isPlaying: roomState.isPlaying, queue: roomState.queue,
          queueIndex: roomState.queueIndex, djUsernames: roomState.djUsernames,
          originalHostUsername
        }
      });
    });
    ch.on('broadcast', { event: 'sync-response' }, ({ payload }) => {
      // Learn who the room's true original host is from whoever answers —
      // needed so a joiner's own host computation (which happens the
      // instant presence syncs, likely before this response arrives) is
      // correct from then on rather than staying stuck on "nobody special".
      if (payload.originalHostUsername && !originalHostUsername) {
        originalHostUsername = payload.originalHostUsername;
        pushPeers(ch);
      }
      send('net:sync', payload);
    });

    ch.on('presence', { event: 'sync' }, () => {
      pushPeers(ch);
      sawInitialPresenceSync = true;
    });
    ch.on('presence', { event: 'join' }, ({ newPresences }) => {
      if (!sawInitialPresenceSync) return;
      newPresences.forEach((p) => {
        if (p.username !== username) send('net:system', { text: `${p.username} joined the room` });
      });
    });
    ch.on('presence', { event: 'leave' }, ({ leftPresences }) => {
      leftPresences.forEach((p) => send('net:system', { text: `${p.username} left the room` }));
    });

    ch.subscribe(async (status, err) => {
      if (status === 'SUBSCRIBED') {
        await ch.track({ username, avatarUrl: config.avatarUrl || null, joinedAt: Date.now() });
        resolve();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        reject(new Error((err && err.message) || 'Could not connect to Supabase Realtime — check your URL and anon key.'));
      } else if (status === 'CLOSED') {
        send('net:system', { text: 'Disconnected from the room' });
      }
    });

    channel = ch;
  });
}

function hostRoom(username) {
  stopEverything();
  role = 'host';
  originalHostUsername = username;
  currentUsername = username;
  sawInitialPresenceSync = false;
  const code = randomRoomCode();
  return subscribeToRoom(code, username).then(() => ({ code }));
}

function joinRoom(code, username) {
  stopEverything();
  role = 'client';
  currentUsername = username;
  sawInitialPresenceSync = false;
  return subscribeToRoom(code.trim().toUpperCase(), username);
}

function broadcastEvent(event, payload) {
  if (!channel) return;
  channel.send({ type: 'broadcast', event, payload });
}

function sendPlayerEvent(action, time, itemId) {
  roomState.isPlaying = action === 'play' ? true : action === 'pause' ? false : roomState.isPlaying;
  roomState.time = time;
  broadcastEvent('player', { action, time, ts: Date.now(), queueItemId: itemId });
}

function broadcastQueue() {
  const payload = { queue: roomState.queue, queueIndex: roomState.queueIndex };
  broadcastEvent('queue-update', payload);
  send('net:queue', payload); // local echo — broadcast has self:false
}

function queueAdd(url) {
  const item = { id: crypto.randomUUID(), url };
  roomState.queue.push(item);
  if (roomState.queueIndex === -1) roomState.queueIndex = 0;
  broadcastQueue();
}

function queueRemove(id) {
  const idx = roomState.queue.findIndex((i) => i.id === id);
  if (idx === -1) return;
  roomState.queue.splice(idx, 1);
  if (idx < roomState.queueIndex) {
    roomState.queueIndex -= 1;
  } else if (idx === roomState.queueIndex && roomState.queueIndex >= roomState.queue.length) {
    roomState.queueIndex = roomState.queue.length - 1;
  }
  broadcastQueue();
}

function queuePlay(id) {
  const idx = roomState.queue.findIndex((i) => i.id === id);
  if (idx === -1) return;
  roomState.queueIndex = idx;
  roomState.isPlaying = false;
  roomState.time = 0;
  broadcastQueue();
}

function queueNext() {
  if (roomState.queueIndex < roomState.queue.length - 1) {
    roomState.queueIndex += 1;
    roomState.isPlaying = false;
    roomState.time = 0;
    broadcastQueue();
  }
}

function sendChat(username, text) {
  const payload = { username, text, ts: Date.now() };
  broadcastEvent('chat', payload);
  if (amIHost) postToDiscord(username, text);
}

function sendTyping(username) { broadcastEvent('typing', { username }); }
function sendTypingStop(username) { broadcastEvent('typing-stop', { username }); }

// Only the host may grant/revoke DJ (playback-control) status. Silently
// no-ops for anyone else — the IPC handler below is the actual enforcement
// point, this is just the shared implementation.
function toggleDj(targetUsername) {
  if (!amIHost) return;
  const idx = roomState.djUsernames.indexOf(targetUsername);
  if (idx === -1) roomState.djUsernames.push(targetUsername);
  else roomState.djUsernames.splice(idx, 1);
  const payload = { djUsernames: roomState.djUsernames };
  broadcastEvent('dj-update', payload);
  send('net:dj', payload);
}

function requestSync() {
  broadcastEvent('sync-request', {});
}

function stopEverything() {
  if (channel) {
    try { channel.unsubscribe(); } catch {}
    if (supabaseClient) { try { supabaseClient.removeChannel(channel); } catch {} }
    channel = null;
  }
  role = null;
  originalHostUsername = null;
  amIHost = false;
  roomState = { isPlaying: false, time: 0, queue: [], queueIndex: -1, djUsernames: [] };
}

// ---------------------------------------------------------------------------
// Discord webhook
// ---------------------------------------------------------------------------
async function postToDiscord(username, text) {
  if (!config.webhookUrl) return;
  try {
    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: `Onigiri · ${username}`,
        content: text
      })
    });
  } catch (err) {
    send('net:error', { message: `Discord webhook failed: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// Video download via yt-dlp
// ---------------------------------------------------------------------------
const CHROMIUM_UA_BROWSERS = new Set(['brave', 'chrome', 'chromium', 'edge', 'opera', 'vivaldi', 'whale']);

// Quality selector → yt-dlp format selectors. Height caps fall back to the
// best available stream when the cap isn't offered (e.g. site maxes at 480p).
const DOWNLOAD_QUALITY_FORMATS = {
  best: 'bv*+ba/b',
  1080: 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
  720: 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
  480: 'bv*[height<=480]+ba/b[height<=480]/bv*+ba/b',
  360: 'bv*[height<=360]+ba/b[height<=360]/bv*+ba/b',
};
// Firefox forks (Floorp, Zen, LibreWolf, …) aren't known to yt-dlp by name,
// but their cookies are plain Firefox cookies: users point cookiesFromBrowser
// at the profile dir instead, e.g. "firefox:~/.floorp/xxxx.default".
const FIREFOX_FAMILY_BROWSERS = new Set(['firefox', 'floorp', 'zen', 'librewolf', 'waterfox']);

// Build the exact user-agent a browser presents. Cloudflare pins cf_clearance
// cookies to the UA that earned them, so this must match version AND platform.
function browserUserAgent(kind, major) {
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : 'X11; Linux x86_64';
  if (kind === 'firefox') {
    const mac = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10.15' : platform;
    return `Mozilla/5.0 (${mac}; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`;
  }
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// Best-effort: find the browser's major version by running its --version.
const BROWSER_BIN_ALIASES = {
  zen: ['zen', 'zen-browser'],
  librewolf: ['librewolf', 'librewolf-bin'],
};

function browserMajorVersion(browserName) {
  for (const bin of BROWSER_BIN_ALIASES[browserName] || [browserName]) {
    try {
      const version = execFileSync(bin, ['--version'], { timeout: 5000 }).toString().trim();
      const match = version.match(/(\d+)(?:\.\d+)*/);
      if (match) return match[1];
    } catch { /* not on PATH — try the next candidate */ }
  }
  return null;
}

// Bundled-first binary resolution: a packaged app ships yt-dlp/ffmpeg/plugins
// inside its resources dir; a dev checkout falls back to whatever is on PATH.
// This is what lets the setup.exe/AppImage be self-contained.
function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function bundledBin(bundledName, pathName) {
  const dir = path.join(resourcesDir(), 'bin', process.platform);
  for (const name of [bundledName, pathName]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveYtDlp() {
  return bundledBin(process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp', 'yt-dlp') || 'yt-dlp';
}

function resolveFfmpeg() {
  return bundledBin(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', 'ffmpeg') || 'ffmpeg';
}

function bundledPluginDirs() {
  const dir = path.join(resourcesDir(), 'plugins');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name));
}

// --- health probes (shared by the first-run checklist and `health:check`) ---
function probeBinary(name, cmd, versionArg, minFeatures) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [versionArg], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve({ ok: false, detail: 'not found' });
    }
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, detail: 'timed out' }); }, 10000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, detail: 'not found' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const first = out.split('\n')[0].trim();
      resolve({ ok: code === 0, version: first, detail: code === 0 ? first : 'not found' });
    });
  });
}

function probeImpersonation(cmd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['--list-impersonate-targets'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, detail: 'timed out — yt-dlp too old' }); }, 10000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, detail: 'not found' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && /Chrome/i.test(out), detail: code === 0 ? 'curl_cffi targets available' : 'missing — install official yt-dlp or curl_cffi' });
    });
  });
}

function probePlugins() {
  return new Promise((resolve) => {
    const cmd = resolveYtDlp();
    // NOTE: this yt-dlp's --list-extractors omits plugin extractors, so probe
    // via the verbose debug line instead, which names every loaded plugin.
    const args = ['-v', '--simulate', 'probe://plugins'];
    for (const d of bundledPluginDirs()) args.push('--plugin-dirs', d);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, detail: 'timed out' }); }, 15000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, detail: 'yt-dlp not found' }); });
    child.on('close', () => {
      clearTimeout(timer);
      const names = (out.match(/Extractor Plugins: (.*)/) || [])[1] || '';
      const found = ['AnimepaheIE', 'HiAnimeIE'].filter((n) => names.includes(n));
      resolve({
        ok: found.length === 2,
        found,
        detail: found.length === 2 ? `Plugin supported — ${found.join(', ')}`
          : found.length === 1 ? `Plugin supported — only ${found.join(', ')} loaded`
          : 'No plugins installed',
      });
    });
  });
}

function probeCookies(cmd) {
  return new Promise((resolve) => {
    if (!config.cookiesFromBrowser) {
      return resolve({ ok: false, detail: 'not configured — set it under Settings → Downloads' });
    }
    const child = spawn(cmd, ['--simulate', '--cookies-from-browser', config.cookiesFromBrowser, 'https://example.com/'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, detail: 'timed out' }); }, 20000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, detail: 'yt-dlp not found' }); });
    child.on('close', () => {
      clearTimeout(timer);
      const m = out.match(/Extracted (\d+) cookies/);
      if (m && Number(m[1]) > 0) resolve({ ok: true, detail: `${m[1]} cookies from ${config.cookiesFromBrowser}` });
      else if (/Extracted 0 cookies/.test(out)) resolve({ ok: false, detail: `could not decrypt ${config.cookiesFromBrowser}'s cookies (Linux: try a "+gnomekeyring" suffix)` });
      else if (/could not find/i.test(out)) resolve({ ok: false, detail: `browser "${config.cookiesFromBrowser}" not found` });
      else if (/firefox cookies database/i.test(out)) resolve({ ok: false, detail: 'no Firefox cookies at that location — Firefox forks (Floorp, Zen, …) need the full profile path, e.g. firefox:~/.floorp/xxxx.default-default' });
      else resolve({ ok: false, detail: 'cookie extraction failed' });
    });
  });
}

const activeDownloads = new Map(); // url -> in-flight promise (yt-dlp breaks on two processes writing one .part file)

function downloadVideo(url) {
  if (activeDownloads.has(url)) return activeDownloads.get(url);
  const job = runDownload(url).finally(() => activeDownloads.delete(url));
  activeDownloads.set(url, job);
  return job;
}

function runDownload(url) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(config.downloadDir, { recursive: true });
    const outTemplate = path.join(config.downloadDir, '%(title).150B [%(id)s].%(ext)s');
    const args = [
      url,
      // Ignore ~/.config/yt-dlp/config etc. — users' personal configs (e.g.
      // youtube player_client overrides) would otherwise break app downloads.
      '--ignore-config',
      '-f', DOWNLOAD_QUALITY_FORMATS[config.downloadQuality] || DOWNLOAD_QUALITY_FORMATS.best,
      '--impersonate', 'chrome',
      // HLS streams must go through yt-dlp's native downloader: ffmpeg can't
      // do Chrome TLS impersonation or carry cf_clearance cookies, so the CDN
      // 403s its segment requests ("ffmpeg exited with code 8").
      '--hls-prefer-native',
      // Space out page requests a little — the embed host rate-limits bursts,
      // which otherwise shows up as a confusing "Requested format is not available".
      '--sleep-requests', '1',
      '--merge-output-format', 'mp4',
      '--restrict-filenames',
      '--no-playlist',
      '--newline',
      '--no-color',
      '-o', outTemplate,
      // --print implies quiet mode, which would suppress all [download] progress
      // lines (bar stuck at 0%) — --progress turns them back on.
      '--progress',
      '--print', 'after_move:filepath'
    ];    // Some CDNs only serve video to a session that already visited the page in
    // a browser — pass that browser's cookies when the user configured one.
    if (config.cookiesFromBrowser) {
      args.splice(1, 0, '--cookies-from-browser', config.cookiesFromBrowser);
      // Cloudflare pins cf_clearance cookies to the exact user-agent that earned
      // them, so reuse the cookie browser's UA. Chromium UAs only vary by major
      // version; Firefox-family forks masquerade as their upstream version.
      const browserName = config.cookiesFromBrowser.split('+')[0].split(':')[0].toLowerCase();
      const kind = CHROMIUM_UA_BROWSERS.has(browserName) ? 'chromium'
        : FIREFOX_FAMILY_BROWSERS.has(browserName) ? 'firefox' : null;
      if (kind) {
        try {
          const major = browserMajorVersion(browserName);
          if (major) args.splice(1, 0, '--user-agent', browserUserAgent(kind, major));
        } catch { /* browser not on PATH — yt-dlp will just use its default UA */ }
      }
    }
    for (const d of bundledPluginDirs()) args.splice(1, 0, '--plugin-dirs', d);
    const ffmpeg = resolveFfmpeg();
    if (ffmpeg !== 'ffmpeg') args.splice(1, 0, '--ffmpeg-location', ffmpeg);
    const proc = spawn(resolveYtDlp(), args);
    let finalPath = '';
    let stderr = '';
    let stdoutBuffer = '';
    const ANSI_RE = /\x1b\[[0-9;]*m/g;

    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop();

      for (const raw of lines) {
        const trimmed = raw.replace(ANSI_RE, '').trim();
        if (!trimmed) continue;
        const percentMatch = trimmed.match(/\[download\]\s+([\d.]+)%/);
        if (percentMatch) {
          // Tagged with the URL so the renderer can tell concurrent downloads
          // apart (queue-while-downloading means two yt-dlps can run at once).
          send('video:progress', { percent: parseFloat(percentMatch[1]), url });
        }
        if ((trimmed.includes('/') || trimmed.includes('\\')) && !trimmed.startsWith('[')) {
          finalPath = trimmed;
        }
        send('video:log', { line: trimmed });
      }
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Could not start yt-dlp. Is it installed and on your PATH? (${err.message})`));
    });

    proc.on('close', (code) => {
      if (stdoutBuffer.trim()) {
        const trimmed = stdoutBuffer.trim();
        if ((trimmed.includes('/') || trimmed.includes('\\')) && !trimmed.startsWith('[')) finalPath = trimmed;
      }
      if (code === 0 && finalPath) {
        send('video:progress', { percent: 100, url });
        resolve(finalPath);
      } else if (code === 0) {
        reject(new Error('yt-dlp finished but no output file path was captured.'));
      } else {
        const lastErr = stderr.trim().split('\n').pop() || `yt-dlp exited with code ${code}`;
        // Direct CDN links (e.g. animepahe's vault-*.uwucdn.top mp4s) carry a
        // short-lived signed token that expires within minutes — a 403 there
        // almost always means the link died, not that the app is broken.
        if (/HTTP Error 403|Forbidden/i.test(lastErr) && /uwucdn|vault-|\?file=/.test(url)) {
          reject(new Error('This download link has expired or was rejected by the CDN. '
            + 'Copy a fresh one right before downloading, or better, paste the animepahe watch-page URL instead.'));
        } else {
          reject(new Error(lastErr));
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => config);

// Powers the first-run checklist / Settings → Downloads → “Run setup check”.
ipcMain.handle('health:check', async () => {
  const ytdlp = resolveYtDlp();
  const [ytdlpInfo, ffmpegInfo, impersonation, plugins, cookies] = await Promise.all([
    probeBinary('yt-dlp', ytdlp, '--version'),
    probeBinary('ffmpeg', resolveFfmpeg(), '-version'),
    probeImpersonation(ytdlp),
    probePlugins(),
    probeCookies(ytdlp),
  ]);
  const ffmpegOk = ffmpegInfo.ok || /ffmpeg/i.test(ffmpegInfo.detail);
  return {
    items: [
      { id: 'ytdlp', label: 'yt-dlp', ok: ytdlpInfo.ok, detail: ytdlpInfo.detail, fix: ytdlpInfo.ok ? null : 'Install yt-dlp (see README) — the setup.exe / AppImage bundles it automatically.' },
      { id: 'ffmpeg', label: 'ffmpeg', ok: ffmpegOk, detail: ffmpegInfo.detail, fix: ffmpegOk ? null : 'Install ffmpeg — needed to merge video/audio streams into one file.' },
      { id: 'impersonate', label: 'Browser impersonation (Cloudflare bypass)', ok: impersonation.ok, detail: impersonation.detail, fix: impersonation.ok ? null : 'Use the official yt-dlp binary, or pip install curl_cffi.' },
      { id: 'plugins', label: 'Site plugins', ok: plugins.ok, detail: plugins.detail, fix: plugins.ok ? null : 'Run the setup script in the otaku folder of the repository.' },
      { id: 'cookies', label: 'Browser cookies', ok: cookies.ok, detail: cookies.detail, fix: cookies.ok ? null : 'Settings → Downloads → set your cookie browser (e.g. brave, chrome). Visit the site once in that browser first so it earns the Cloudflare clearance.' },
    ],
    allOk: ytdlpInfo.ok && ffmpegOk && impersonation.ok && plugins.ok && cookies.ok,
  };
});

ipcMain.handle('config:set', (_e, partial) => {
  config = { ...config, ...partial };
  saveConfig(config);
  return config;
});

ipcMain.handle('emotes:get', () => emotes);

ipcMain.handle('emotes:add', (_e, { name, url }) => {
  const cleanName = (name || '').trim().toLowerCase().replace(/^:+|:+$/g, '');
  const cleanUrl = (url || '').trim();
  if (!cleanName || !/^[a-z0-9_]+$/.test(cleanName)) {
    throw new Error('Emote names can only use letters, numbers, and underscores.');
  }
  if (!/^https?:\/\/\S+$/.test(cleanUrl)) {
    throw new Error('That link needs to start with http:// or https://');
  }
  if (emotes.some((e) => e.name === cleanName)) {
    throw new Error(`:${cleanName}: already exists.`);
  }
  emotes.push({ name: cleanName, url: cleanUrl });
  saveEmotes(emotes);
  return emotes;
});

ipcMain.handle('emotes:remove', (_e, { name }) => {
  emotes = emotes.filter((e) => e.name !== name);
  saveEmotes(emotes);
  return emotes;
});

ipcMain.handle('emotes:reload', () => {
  emotes = loadEmotes();
  return emotes;
});

ipcMain.handle('emotes:path', () => EMOTES_PATH);

ipcMain.handle('dialog:choose-dir', async () => {
  // No BrowserWindow passed as parent on purpose: passing one makes the
  // native dialog OS-modal to the app window, so if the desktop's file
  // portal (xdg-desktop-portal) hangs — which happens on some Wayland
  // compositors — the whole app freezes along with it.
  const dialogPromise = dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(
      "The system file picker didn't respond. Type the folder path in manually, " +
      "or see the README's Hyprland/portal troubleshooting note."
    )), 15000);
  });
  const result = await Promise.race([dialogPromise, timeoutPromise]);
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

const THEME_KEYS = [
  '--md-primary', '--md-on-primary', '--md-primary-container', '--md-on-primary-container',
  '--md-secondary', '--md-on-secondary', '--md-tertiary', '--md-on-tertiary'
];
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

ipcMain.handle('theme:import', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Theme JSON', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };

  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf-8');
    const parsed = JSON.parse(raw);
    const theme = {};
    for (const key of THEME_KEYS) {
      if (typeof parsed[key] === 'string' && HEX_RE.test(parsed[key])) theme[key] = parsed[key];
    }
    if (Object.keys(theme).length === 0) {
      throw new Error(`No recognized color keys found. Expected hex values for keys like "${THEME_KEYS[0]}".`);
    }
    return { ok: true, theme };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('room:host', async (_e, { username }) => {
  try {
    const { code } = await hostRoom(username);
    activeRoomCode = code;
    updateDiscordRpc();
    return { ok: true, code };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('room:join', async (_e, { code, username }) => {
  try {
    await joinRoom(code, username);
    activeRoomCode = code;
    updateDiscordRpc();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('room:leave', () => {
  stopEverything();
  activeRoomCode = null;
  clearDiscordRpc();
  return { ok: true };
});

ipcMain.handle('room:role', () => role);

ipcMain.handle('video:download', async (_e, { url }) => {
  const filePath = await downloadVideo(url);
  return { filePath };
});

ipcMain.handle('player:event', (_e, { action, time, itemId }) => {
  sendPlayerEvent(action, time, itemId);
  return { ok: true };
});

ipcMain.handle('queue:add', (_e, { url }) => { queueAdd(url); return { ok: true }; });
ipcMain.handle('queue:remove', (_e, { id }) => { queueRemove(id); return { ok: true }; });
ipcMain.handle('queue:play', (_e, { id }) => { queuePlay(id); return { ok: true }; });
ipcMain.handle('queue:next', () => { queueNext(); return { ok: true }; });

ipcMain.handle('chat:send', (_e, { username, text }) => {
  sendChat(username, text);
  send('net:chat', { username, text, ts: Date.now(), self: true });
  return { ok: true };
});

ipcMain.handle('chat:typing', (_e, { username }) => { sendTyping(username); return { ok: true }; });
ipcMain.handle('dj:toggle', (_e, { username }) => {
  if (!amIHost) throw new Error('Only the host can change DJ permissions.');
  toggleDj(username);
  return { ok: true };
});
ipcMain.handle('chat:typing-stop', (_e, { username }) => { sendTypingStop(username); return { ok: true }; });

ipcMain.handle('sync:request', () => {
  requestSync();
  return { ok: true };
});

// --- App version + update check against GitHub releases -------------------
// Compares the running version (package.json) with the latest published
// release tag. Versions are compared numerically per segment, so "1.4" vs
// "1.10" and a tag written without the leading "v" both behave correctly.
function parseVersion(v) {
  return String(v).replace(/^v/i, '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('app:check-updates', async () => {
  const repo = 'fal1109/onigiri';
  try {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { 'User-Agent': 'onigiri-app', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      return { ok: true, latest: null, message: 'No published releases yet — cut one from the GitHub Releases page.' };
    }
    if (!res.ok) return { ok: false, error: `GitHub returned ${res.status}` };
    const rel = await res.json();
    const current = app.getVersion();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    return {
      ok: true,
      current,
      latest,
      updateAvailable: isNewerVersion(latest, current),
      releaseUrl: rel.html_url,
    };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
});

ipcMain.handle('shell:open-path', (_e, target) => {
  shell.showItemInFolder(target);
});

ipcMain.handle('shell:open-external', (_e, url) => {
  // Only https/http — never let a renderer ask the OS to open arbitrary schemes.
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});
