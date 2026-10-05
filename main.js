const { app, BrowserWindow, ipcMain, dialog, shell, net, nativeImage } = require('electron');
const { pathToFileURL, fileURLToPath } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const https = require('https');
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
    // Background image, picked from local storage (stored as a file:// URL —
    // the old remote-URL input is gone). backgroundTheming derives the app's
    // colors from that image, matugen-style.
    backgroundFile: '',
    backgroundEnabled: true,
    backgroundTheming: true,
    backgroundBlur: 24,
    backgroundParallax: true,
    customTheme: null,
    downloadQuality: 'best',
    // 'never' | 'watched' | '5h' | '10h' | '12h' | '24h' | '2d' | '4d' | '7d'
    autoDelete: 'never',
    discordRpc: { enabled: false, showParticipants: true, showGithubButton: true },
    // Extras easter eggs: a master switch plus per-feature
    // overrides. Master off wins regardless of the individual flags, and
    // any flag left unset means the feature is on.
    easterEggs: { enabled: true, openingSound: true, quotes: true, shiggy: true },
    // Home-screen mascot: a set id (a build/mascots subfolder paired with
    // the same-named build/sounds folder — 'lilith', 'mayushi', …) or
    // 'cookie' (the original spinner).
    mascotStyle: 'lilith',
    // Last greeting sound played, so each launch picks a different one.
    lastOpeningSound: '',
    // Room-code chip style: 'plain' (text pill) or 'girls' (pixel girls
    // holding digit signs, one per code digit).
    roomCodeStyle: 'plain'
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

// The greeting sound plays the moment the app opens — before any click — so
// Chromium's autoplay blocker has to be explicitly waved through.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

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
// Quotes — same plain-JSON-file pattern as the emotes above, so they
// stay trivially hand-editable (and out of the main config):
//   [{ "text": "…", "by": "rui" }, …]
// The renderer keeps its own built-in fallback; this file, when present,
// replaces that list entirely. Lives in the project's build/ folder (and in
// the packaged asar's resources dir once built) instead of userData, so it
// ships and versions with the app. Any quotes file from the old userData
// location is migrated over on first run so nothing hand-edited is lost.
// ---------------------------------------------------------------------------
const QUOTES_PATH = path.join(__dirname, 'build', 'onigiri-quotes.json');
const LEGACY_QUOTES_PATH = path.join(app.getPath('userData'), 'onigiri-quotes.json');
(function migrateQuotesFile() {
  try {
    if (fs.existsSync(LEGACY_QUOTES_PATH) && !fs.existsSync(QUOTES_PATH)) {
      fs.mkdirSync(path.dirname(QUOTES_PATH), { recursive: true });
      fs.copyFileSync(LEGACY_QUOTES_PATH, QUOTES_PATH);
    }
  } catch { /* migration is best-effort; seeding below still covers us */ }
})();

function loadQuotes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(QUOTES_PATH, 'utf-8'));
    if (Array.isArray(parsed)) {
      return parsed.filter((q) => q && typeof q.text === 'string' && q.text.trim());
    }
  } catch { /* first run, or the file was deleted — nothing to load */ }
  return null;
}

// Seed the file with the built-in quotes on first run so there's
// always a document to edit — this is exactly why the quotes live in a
// hand-editable file at all.
function seedQuotesFile() {
  const seed = [
    { by: 'rui', text: 'one day i will crush bush with my big and heavy trust' },
    { by: 'rui', text: 'my motivation to do pushups is to give the strongest plaps' },
    { by: 'rui', text: 'just keep my desire, dont know where you will cum' },
    { by: 'rui', text: 'the lich and the witch, and the audacity of this bitch' },
    { by: 'rui', text: 'i mistakenly deleted hall of fame' },
    { by: 'rui', text: 'oh nyo, it COMES HERE' },
    { by: 'fal', text: 'i guess nier took my virginity for my first aaa game' },
    { by: 'fal', text: 'apparently women have taste buds down there, hence the flavoured condoms' },
    { by: 'fal', text: 'time to bust all over my room!' },
    { by: 'fal', text: "never thought i'd see kaiki feeding her meat" },
    { by: 'fal', text: 'integration is hard, but im harder' },
    { by: 'light', text: 'im hard' },
    { by: 'light', text: 'im back ely gave me her milk' },
    { by: 'light', text: 'so i ate a shit ton of garlic and spices and shit to fight cold so i nutted 13 times' },
    { by: 'light', text: 'i like dark stuff' },
    { by: 'light', text: 'incest is wincest' }
  ];
  try {
    fs.mkdirSync(path.dirname(QUOTES_PATH), { recursive: true });
    fs.writeFileSync(QUOTES_PATH, JSON.stringify(seed, null, 2));
  } catch { /* unwritable userData — quotes just stay built-in */ }
  return seed;
}

function currentQuotes() {
  return loadQuotes() || seedQuotesFile();
}

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
  startAutoDeleteSweep();
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

// Room codes are 6 digits (000000-999999), shown as plain text in the
// top-bar chip. 1M codes is plenty for friend groups; hostRoom retries on
// the (vanishingly rare) chance of landing on a code that already has a
// live room.
function randomRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += Math.floor(Math.random() * 10);
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
  const attempt = (triesLeft) => {
    const code = randomRoomCode();
    return subscribeToRoom(code, username).then(() => {
      return { code };
    }).catch((err) => {
      // Supabase rejects a second channel with the same name, which is how a
      // taken code shows up — pick another one instead of failing the host.
      if (triesLeft > 0 && /duplicate|exists/i.test(err && err.message)) return attempt(triesLeft - 1);
      throw err;
    });
  };
  return attempt(3);
}

function joinRoom(code, username) {
  stopEverything();
  role = 'client';
  currentUsername = username;
  sawInitialPresenceSync = false;
  return subscribeToRoom(code.trim().toUpperCase(), username).then(async () => {
    // Room-existence check: Supabase happily subscribes us to a channel
    // nobody ever created, which used to let anyone type a random code and
    // sit in an "empty room" as its (only) member. Rooms only exist while
    // someone is in them, so after the first presence sync, "nobody else
    // here" means the room was never real — bail out instead.
    const deadline = Date.now() + 5000;
    while (!sawInitialPresenceSync && channel && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!channel) throw new Error('Left the room.');
    const others = Object.values(channel.presenceState()).flat()
      .filter((p) => p.username !== username);
    if (!others.length) {
      stopEverything(); // unsubscribe — never leave a phantom session open
      throw new Error('Room not found — double-check the code with your host.');
    }
  });
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
  // Room's over — nothing in flight is worth bandwidth anymore (includes
  // playlist downloads kicked off by a host who then left).
  for (const url of [...activeDownloads.keys()]) cancelDownload(url);
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
// Quality selector → yt-dlp format selectors. Height caps fall back to the
// best available stream when the cap isn't offered (e.g. site maxes at 480p).
const DOWNLOAD_QUALITY_FORMATS = {
  best: 'bv*+ba/b',
  1080: 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
  720: 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
  480: 'bv*[height<=480]+ba/b[height<=480]/bv*+ba/b',
  360: 'bv*[height<=360]+ba/b[height<=360]/bv*+ba/b',
};

// Bundled-first binary resolution: a packaged app ships yt-dlp/ffmpeg
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

// ffprobe ships alongside ffmpeg in every distribution channel this app
// supports (winget/pip/bundled), so probing subtitles is always available
// wherever downloads already work.
function resolveFfprobe() {
  return bundledBin(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe', 'ffprobe') || 'ffprobe';
}

// --- health probes (shared by the first-run checklist and `health:check`) ---
function probeBinary(cmd, versionArg) {
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

// Latest yt-dlp release version from GitHub — lets the setup check flag an
// outdated binary (yellow dot) even though it still works. yt-dlp releases
// constantly and sites change under it, so stale versions rot quickly.
async function latestYtDlpVersion() {
  try {
    const res = await net.fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      headers: { 'User-Agent': 'onigiri-app', 'Accept': 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return String((await res.json()).tag_name || '').replace(/^v/i, '') || null;
  } catch {
    return null;
  }
}

// url -> { promise, controller }. Two yt-dlps writing one .part file breaks,
// so one download per URL; the controller carries the process handle and the
// destination paths it announced, so a canceled download's partial files can
// be cleaned up afterwards.
// ---------------------------------------------------------------------------
// Upload — hosts push a video file to litterbox.catbox.moe so the room can
// queue the returned link like any other. The API (see
// https://litterbox.catbox.moe/tools.php) is a single multipart POST:
//   reqtype=fileupload, time=1h|12h|24h|72h, fileToUpload=<file>
// Onigiri always uses time=12h per the product decision, uploads are
// anonymous (no account/userhash), and litterbox enforces a 1 GiB cap that
// we pre-check so users get a friendly error instead of a wasted upload.
// The response body is just the direct link to the uploaded file.
// ---------------------------------------------------------------------------
const LITTERBOX_UPLOAD_URL = 'https://litterbox.catbox.moe/resources/internals/api.php';
const LITTERBOX_EXPIRY = '12h';
const LITTERBOX_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
const UPLOAD_NAME_LENGTH = 6;

// a-z0-9 anonymous name, exactly 6 characters — kept short because long
// file names make the eventual download filename unwieldy.
function randomUploadName() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < UPLOAD_NAME_LENGTH; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function uploadVideoFile(filePath) {
  let stat;
  try { stat = await fs.promises.stat(filePath); } catch {
    throw new Error('Could not read that file.');
  }
  if (stat.size > LITTERBOX_MAX_BYTES) {
    throw new Error(`That file is ${(stat.size / (1024 * 1024 * 1024)).toFixed(2)} GiB — litterbox only accepts files up to 1 GiB.`);
  }
  if (stat.size === 0) throw new Error('That file is empty.');

  // Multipart body assembled by hand (no extra dependency): boundary, the two
  // text fields, then the file as the final part. Sent through Node's https
  // module — Electron's net loader rejected this shape twice (net.fetch can't
  // stream a file body: litterbox saw no fields and answered 412; net.request
  // refuses a manual Content-Length: ERR_INVALID_ARGUMENT). Node https gives
  // us a real file stream with backpressure and an exact Content-Length.
  const promise = new Promise((resolve, reject) => {
    const boundary = `----onigiri${crypto.randomBytes(12).toString('hex')}`;
    const fileName = randomUploadName();
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="reqtype"\r\n\r\nfileupload\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="time"\r\n\r\n${LITTERBOX_EXPIRY}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="fileToUpload"; filename="${fileName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
      'utf-8'
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');

    let sentBytes = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(err);
    };
    const stream = fs.createReadStream(filePath, { highWaterMark: 512 * 1024 });
    const request = https.request(LITTERBOX_UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        // litterbox rejects requests without a User-Agent header.
        'User-Agent': 'onigiri-app',
        'Content-Length': head.length + stat.size + tail.length,
      },
      timeout: 30 * 60 * 1000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        stream.destroy();
        const text = body.trim();
        if (res.statusCode !== 200) {
          reject(new Error(`Litterbox returned ${res.statusCode}${text ? `: ${text.slice(0, 200)}` : ''}`));
        } else if (!/^https?:\/\/\S+$/i.test(text)) {
          reject(new Error(`Litterbox replied unexpectedly: ${text.slice(0, 200)}`));
        } else {
          resolve(text);
        }
      });
    });
    request.on('timeout', () => fail(new Error('Upload timed out — litterbox took too long to answer.')));
    request.on('error', fail);
    stream.on('error', fail);

    // Backpressure: pause the file read whenever the socket buffer fills.
    request.on('drain', () => stream.resume());

    request.write(head);
    stream.on('data', (chunk) => {
      sentBytes += chunk.length;
      send('upload:progress', {
        filePath,
        percent: Math.min(99, (sentBytes / (stat.size + head.length + tail.length)) * 100),
      });
      if (!request.write(chunk)) stream.pause();
    });
    stream.on('end', () => request.end(tail));
  });

  activeUploads.set(filePath, { promise });
  try {
    return await promise;
  } finally {
    activeUploads.delete(filePath);
  }
}

// filePath -> in-flight upload, so double-clicks reuse the same request.
const activeUploads = new Map();

// ---------------------------------------------------------------------------
// Auto-delete — downloaded videos can be removed either right after the room
// finishes watching them or after a fixed age (5h → 7d, user-chosen in
// Settings → Downloads). Every finished download is recorded (by URL and by
// file path) with its finishedAt timestamp in a small JSON next to the
// config; the periodic sweep deletes anything older than the chosen window,
// and a 'watch:done' IPC (player ended) triggers immediate deletion when
// autoDelete === 'watched'. Timestamps are kept even for files that get
// deleted, so changing the setting later still applies sensibly.
// ---------------------------------------------------------------------------
const AUTO_DELETE_CHOICES = { '5h': 5 * 3600e3, '10h': 10 * 3600e3, '12h': 12 * 3600e3, '24h': 24 * 3600e3, '2d': 2 * 86400e3, '4d': 4 * 86400e3, '7d': 7 * 86400e3 };
const DOWNLOAD_HISTORY_PATH = path.join(app.getPath('userData'), 'onigiri-downloads.json');
const AUTO_DELETE_SWEEP_MS = 60 * 1000;

function loadDownloadHistory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DOWNLOAD_HISTORY_PATH, 'utf-8'));
    if (parsed && typeof parsed === 'object') {
      return { finishedAtByUrl: parsed.finishedAtByUrl || {}, pathsByUrl: parsed.pathsByUrl || {} };
    }
  } catch { /* first run or corrupt file — start fresh */ }
  return { finishedAtByUrl: {}, pathsByUrl: {} };
}

let downloadHistory = null;
let autoDeleteSweepTimer = null;

function recordDownloadFinished(url, filePath) {
  if (!url || !filePath) return;
  if (!downloadHistory) downloadHistory = loadDownloadHistory();
  downloadHistory.pathsByUrl[url] = filePath;
  try { fs.writeFileSync(DOWNLOAD_HISTORY_PATH, JSON.stringify(downloadHistory, null, 2)); } catch { /* non-fatal */ }
}

function recordWatchFinished(url) {
  if (!url) return;
  if (!downloadHistory) downloadHistory = loadDownloadHistory();
  downloadHistory.finishedAtByUrl[url] = Date.now();
  try { fs.writeFileSync(DOWNLOAD_HISTORY_PATH, JSON.stringify(downloadHistory, null, 2)); } catch { /* non-fatal */ }
}

function deleteRecordedFile(url) {
  const target = downloadHistory?.pathsByUrl?.[url];
  if (!target) return false;
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch { return false; } // locked on Windows etc. — the sweep retries
  delete downloadHistory.pathsByUrl[url];
  try { fs.writeFileSync(DOWNLOAD_HISTORY_PATH, JSON.stringify(downloadHistory, null, 2)); } catch { /* non-fatal */ }
  return true;
}

function sweepAutoDelete() {
  if (!downloadHistory) downloadHistory = loadDownloadHistory();
  const window = AUTO_DELETE_CHOICES[config.autoDelete];
  if (!window) return;
  const now = Date.now();
  for (const [url, ts] of Object.entries(downloadHistory.finishedAtByUrl)) {
    if (now - ts >= window) {
      deleteRecordedFile(url);
      delete downloadHistory.finishedAtByUrl[url];
    }
  }
  try { fs.writeFileSync(DOWNLOAD_HISTORY_PATH, JSON.stringify(downloadHistory, null, 2)); } catch { /* non-fatal */ }
}

function startAutoDeleteSweep() {
  if (autoDeleteSweepTimer) return;
  downloadHistory = loadDownloadHistory();
  autoDeleteSweepTimer = setInterval(sweepAutoDelete, AUTO_DELETE_SWEEP_MS);
}

// url -> { promise, controller }. Two yt-dlps writing one .part file breaks,
// so one download per URL; the controller carries the process handle and the
// destination paths yt-dlp announced, so a canceled download's partial files
// can be cleaned up afterwards.
const activeDownloads = new Map();

function downloadVideo(url) {
  const existing = activeDownloads.get(url);
  if (existing) return existing.promise;
  const controller = { canceled: false, proc: null, destinations: new Set() };
  const job = runDownload(url, controller).finally(() => activeDownloads.delete(url));
  activeDownloads.set(url, { promise: job, controller });
  return job;
}

function cancelDownload(url) {
  const active = activeDownloads.get(url);
  if (!active) return;
  active.controller.canceled = true;
  if (active.controller.proc) {
    try { active.controller.proc.kill(); } catch { /* already dead */ }
  }
  // If the process already exited, its close handler ran before the canceled
  // flag was set — clean up here instead.
  if (active.controller.proc && active.controller.proc.exitCode !== null) {
    cleanupPartialFiles(active.controller);
  }
}

// yt-dlp leaves `<target>.part` (and per-format `.fNNN.mp4.part`) files behind
// when killed. It announces each destination on stdout before writing it, so
// we remember them and can delete the orphans when a download is canceled.
function cleanupPartialFiles(controller) {
  for (const dest of controller.destinations || []) {
    for (const candidate of [dest, `${dest}.part`]) {
      try { if (fs.existsSync(candidate)) fs.unlinkSync(candidate); } catch { /* locked or gone — fine */ }
    }
  }
}

function runDownload(url, controller) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(config.downloadDir, { recursive: true });
    const outTemplate = path.join(config.downloadDir, '%(title).150B [%(id)s].%(ext)s');
    const args = [
      url,
      // Ignore ~/.config/yt-dlp/config etc. — users' personal configs (e.g.
      // youtube player_client overrides) would otherwise break app downloads.
      '--ignore-config',
      '-f', DOWNLOAD_QUALITY_FORMATS[config.downloadQuality] || DOWNLOAD_QUALITY_FORMATS.best,
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
    ];
    const ffmpeg = resolveFfmpeg();
    if (ffmpeg !== 'ffmpeg') args.splice(1, 0, '--ffmpeg-location', ffmpeg);
    const proc = spawn(resolveYtDlp(), args);
    controller.proc = proc;
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
        // Remember every file yt-dlp says it's writing, so a canceled
        // download's partials can be deleted (see cleanupPartialFiles).
        const destMatch = trimmed.match(/^\[download\]\s+Destination:\s+(.+)/)
          || trimmed.match(/^\[Merger\]\s+Merging formats into "(.+)"/);
        if (destMatch) controller.destinations.add(destMatch[1].trim());
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
      if (controller.canceled) {
        cleanupPartialFiles(controller);
        reject(new Error('Download canceled'));
        return;
      }
      if (code === 0 && finalPath) {
        send('video:progress', { percent: 100, url });
        recordDownloadFinished(url, finalPath);
        resolve(finalPath);
      } else if (code === 0) {
        reject(new Error('yt-dlp finished but no output file path was captured.'));
      } else {
        const lastErr = stderr.trim().split('\n').pop() || `yt-dlp exited with code ${code}`;
        reject(new Error(lastErr));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => config);

// Powers the first-run checklist / Settings → Downloads → “Run setup check”.
// Kept to yt-dlp + ffmpeg only — the app downloads whatever users paste and
// endorses no particular source. An installed-but-outdated yt-dlp still gets
// a yellow dot: it works, but sites change under old versions fast.
ipcMain.handle('health:check', async () => {
  const [ytdlpInfo, ffmpegInfo, latestYtdlp] = await Promise.all([
    probeBinary(resolveYtDlp(), '--version'),
    probeBinary(resolveFfmpeg(), '-version'),
    latestYtDlpVersion(),
  ]);
  const ffmpegOk = ffmpegInfo.ok || /ffmpeg/i.test(ffmpegInfo.detail);
  const ytdlpOutdated = ytdlpInfo.ok && latestYtdlp && isNewerVersion(latestYtdlp, ytdlpInfo.version);
  return {
    items: [
      {
        id: 'ytdlp',
        label: 'yt-dlp',
        ok: ytdlpInfo.ok,
        warn: ytdlpOutdated,
        detail: ytdlpOutdated
          ? `${ytdlpInfo.version} — outdated, latest is ${latestYtdlp}. Old versions break as sites change; update it.`
          : ytdlpInfo.detail,
        fix: !ytdlpInfo.ok
          ? 'Install yt-dlp (see README) — the setup.exe / AppImage bundles it automatically.'
          : ytdlpOutdated
            ? 'Update yt-dlp: `yt-dlp -U`, winget, or pip install -U yt-dlp (see README).'
            : null,
      },
      { id: 'ffmpeg', label: 'ffmpeg', ok: ffmpegOk, detail: ffmpegInfo.detail, fix: ffmpegOk ? null : 'Install ffmpeg — needed to merge video/audio streams into one file.' },
    ],
    allOk: ytdlpInfo.ok && ffmpegOk,
  };
});

ipcMain.handle('config:set', (_e, partial) => {
  config = { ...config, ...partial };
  saveConfig(config);
  return config;
});

// Extras easter-egg assets. The renderer can't read the packed
// asar (build/mascots, build/sounds ship inside it), so it asks for the
// listings and file:// URLs over IPC.
//
// A mascot SET is a character: a build/mascots/<id>/ folder of images paired
// with a build/sounds/<id>/ folder of that character's voice lines (the
// pairing is what makes the opening greeting feel spoken by the mascot).
// Future sets only need matching folders — no code change. The flat
// build/mascots/closet dir is a legacy sticker pile, not a character; it's
// still served (mapped to id 'closet', no sound) but is deliberately left
// out of the picker.
ipcMain.handle('eggs:get-assets', () => {
  const mascotsRoot = path.join(__dirname, 'build', 'mascots');
  const soundsRoot = path.join(__dirname, 'build', 'sounds');
  let sets = {};
  let closet = [];
  try {
    for (const entry of fs.readdirSync(mascotsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'closet') continue;
      const id = entry.name;
      let images = [];
      try {
        images = fs.readdirSync(path.join(mascotsRoot, id))
          .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
          .sort()
          .map((f) => pathToFileURL(path.join(mascotsRoot, id, f)).href);
      } catch {}
      if (!images.length) continue;
      let sounds = [];
      try {
        sounds = fs.readdirSync(path.join(soundsRoot, id))
          .filter((f) => /\.(ogg|oga|mp3|wav)$/i.test(f))
          .sort()
          .map((f) => pathToFileURL(path.join(soundsRoot, id, f)).href);
      } catch {} // a set without sounds still shows its mascot
      sets[id] = { images, sounds };
    }
  } catch {}
  try {
    closet = fs.readdirSync(path.join(mascotsRoot, 'closet'))
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .sort()
      .map((f) => pathToFileURL(path.join(mascotsRoot, 'closet', f)).href);
  } catch {}
  return { sets, closet };
});

// Built-in wallpaper collections (Settings → Extras → Wallpapers). Two
// categories — fal and rui — read from build/wallpapers/<category>/ so
// images (and video clips — the renderer plays them as looping muted
// backgrounds) can be dropped in without touching any code. The renderer
// can't list the asar itself, so this returns file:// URLs, same story as
// the egg mascots above.
ipcMain.handle('wallpapers:get', () => {
  const root = path.join(__dirname, 'build', 'wallpapers');
  const collections = {};
  for (const cat of ['fal', 'rui']) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(root, cat))
        .filter((f) => /\.(png|jpe?g|webp|gif|avif|bmp|mp4|m4v|webm|mov|ogv|mkv)$/i.test(f))
        .sort()
        .map((f) => pathToFileURL(path.join(root, cat, f)).href);
    } catch {} // missing folder → empty collection
    collections[cat] = files;
  }
  return collections;
});

// Room-code chip assets (build/digits/digit-0..9.png), same packing story
// as the egg mascots: the renderer can't read the asar itself. The 'girls'
// chip style draws one digit png per code character — the digit pngs ARE
// the girls (pixel girls holding signboards). The closet mascots aren't
// part of the chip; the closet dir is only read for the egg mascots above
// (lilith/ holds her Load1/2/3 frames, not stickers).
ipcMain.handle('digits:get-assets', () => {
  const digitsDir = path.join(__dirname, 'build', 'digits');
  const digits = {};
  try {
    for (let d = 0; d <= 9; d++) {
      const file = path.join(digitsDir, `digit-${d}.png`);
      if (fs.existsSync(file)) digits[d] = pathToFileURL(file).href;
    }
  } catch {}
  return { digits };
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

ipcMain.handle('quotes:get', () => currentQuotes());

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

// Background image/video picker: native dialog → absolute path. The renderer
// stores it as a file:// URL (same shape the old remote-URL input produced,
// so CSS <url()> semantics are unchanged).
ipcMain.handle('background:choose', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    // Backgrounds are usually wallpaper-style images (now also video clips),
    // so start the picker in the OS Pictures folder instead of wherever it
    // landed last time.
    defaultPath: app.getPath('pictures'),
    filters: [{ name: 'Images & videos', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'mp4', 'm4v', 'webm', 'mov', 'ogv', 'mkv'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }; 
  return { ok: true, path: result.filePaths[0], url: pathToFileURL(result.filePaths[0]).href };
});

// Palette extraction, matugen-style: the background image becomes the app's
// theme. Uses Electron's bundled nativeImage (sharp's fixed deps can't load
// inside the asar), scaling to a small buffer and histogramming the pixels.
ipcMain.handle('background:palette', async (_e, imageUrl) => {
  try {
    if (typeof imageUrl !== 'string' || !imageUrl.startsWith('file://')) {
      throw new Error('Background image must be a local file.');
    }
    let img = nativeImage.createFromPath(fileURLToPath(imageUrl));
    if (img.isEmpty()) throw new Error('Could not read that image.');
    // Animated gifs keep only the first frame here — fine for a palette.
    const size = img.getSize();
    const maxSide = Math.max(size.width, size.height) || 1;
    if (maxSide > 220) {
      const scale = 220 / maxSide;
      img = img.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale))
      });
    }
    const w = img.getSize().width, h = img.getSize().height;
    const buf = img.getBitmap(); // BGRA on every platform Electron ships
    const bins = new Map(); // 5-bit-per-channel quantization → [count, r, g, b]
    for (let i = 0; i < w * h * 4; i += 4) {
      const a = buf[i + 3];
      if (a < 125) continue;
      const b = buf[i], g = buf[i + 1], r = buf[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bin = bins.get(key);
      if (bin) { bin[0]++; bin[1] += r; bin[2] += g; bin[3] += b; }
      else bins.set(key, [1, r, g, b]);
    }
    const colors = [...bins.values()]
      .map(([n, r, g, b]) => {
        const rr = r / n, gg = g / n, bb = b / n;
        const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
        const chroma = max - min;
        // Yellow hues read far brighter than they feel — same tone-mapping
        // idea matugen applies to its chroma weights.
        const luma = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        const weight = n * (0.05 + chroma / 255) / (0.25 + luma / 255);
        return { hex: '#' + [rr, gg, bb].map((c) => Math.round(c).toString(16).padStart(2, '0')).join(''), weight };
      })
      .sort((x, y) => y.weight - x.weight);
    if (!colors.length) throw new Error('Image has no visible pixels.');
    const accent = colors[0].hex;
    const distinct = colors.filter((c) => c.hex !== accent).slice(0, 2).map((c) => c.hex);
    return { ok: true, accent, secondary: distinct[0] || accent, tertiary: distinct[1] || distinct[0] || accent };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

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

// Cancels the in-flight yt-dlp for this URL (if any) and deletes whatever
// partial file it left behind. Used when the user swaps in a local file
// instead of waiting for the download to finish.
ipcMain.handle('video:cancel-download', (_e, { url }) => {
  cancelDownload(url);
  return { ok: true };
});

// Open-file picker for "play a video I already have" — path stays local.
ipcMain.handle('video:choose-local', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'flv', 'ts', 'ogv'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// Upload the picked file to litterbox (12h expiry, 6-char name, 1 GiB cap).
ipcMain.handle('video:upload', async (_e, { filePath }) => {
  if (typeof filePath !== 'string' || !filePath) throw new Error('No file chosen.');
  if (activeUploads.has(filePath)) return activeUploads.get(filePath).promise;
  return uploadVideoFile(filePath);
});

// The player's current source URL, for auto-delete bookkeeping.
const watchState = { currentUrl: null };

// ---------------------------------------------------------------------------
// Captions — yt-dlp merges embedded subtitle tracks into the mp4/mkv it
// downloads, so most files already carry captions. Chromium can't render
// embedded tracks by itself, but ffmpeg converts them to WebVTT on demand;
// the player feeds that through a <track> element. ffmpeg must be present
// for this to work (same dependency downloads already have).
// ---------------------------------------------------------------------------

// ffprobe lists embedded subtitle streams as JSON; empty list = no captions.
function probeSubtitleTracks(filePath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveFfprobe(), [
        '-v', 'error',
        '-select_streams', 's',
        '-show_entries', 'stream=index:stream_tags=language',
        '-of', 'json',
        filePath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve([]);
    }
    let out = '';
    let settled = false;
    const done = (tracks) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tracks);
    };
    const timer = setTimeout(() => { try { child.kill(); } catch {} done([]); }, 8000);
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', () => done([]));
    child.on('close', () => {
      try {
        const streams = JSON.parse(out).streams || [];
        done(streams.map((s) => ({
          streamIndex: s.index,
          lang: (s.tags && s.tags.language ? String(s.tags.language) : '').trim(),
        })));
      } catch {
        done([]);
      }
    });
  });
}

// Track list for the caption picker; empty array = the UI hides the button.
ipcMain.handle('video:subtitle-tracks', async (_e, { filePath }) => {
  if (typeof filePath !== 'string' || !filePath) return [];
  const tracks = await probeSubtitleTracks(filePath);
  return tracks.map((t, i) => ({
    id: `s${t.streamIndex}`,
    label: t.lang || `Track ${i + 1}`,
    lang: t.lang || undefined,
    index: i,
  }));
});

// Extract the chosen track as WebVTT (ffmpeg's native subtitle converter)
// and return the raw VTT text — the renderer wraps it in a blob URL for its
// <track> element, since Chromium can refuse file:// subtitle loads. Cached
// per file+track in memory so re-enabling captions is instant.
const subtitleTextCache = new Map(); // "filePath|trackId" -> VTT text

ipcMain.handle('video:extract-subtitle', async (_e, { filePath, trackId }) => {
  if (typeof filePath !== 'string' || typeof trackId !== 'string') throw new Error('Bad caption request.');
  const key = `${filePath}|${trackId}`;
  const cached = subtitleTextCache.get(key);
  if (cached) return cached;

  const streamIndex = parseInt(trackId.replace(/^s/, ''), 10);
  if (!Number.isFinite(streamIndex)) throw new Error('Unknown subtitle track.');
  const outPath = path.join(os.tmpdir(), 'onigiri-captions', `${crypto.randomBytes(8).toString('hex')}.vtt`);

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolveFfmpeg(), [
        '-y', '-v', 'error',
        '-i', filePath,
        '-map', `0:${streamIndex}`,
        '-c:s', 'webvtt',
        outPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new Error(`Could not start ffmpeg (${err.message}).`));
    }
    let errText = '';
    child.stderr.on('data', (c) => { errText += c; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('Caption extraction timed out.')); }, 20000);
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`ffmpeg failed: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(outPath)) resolve();
      else reject(new Error(errText.trim().split('\n').pop() || `ffmpeg exited with code ${code}`));
    });
  });

  let text;
  try {
    text = fs.readFileSync(outPath, 'utf-8');
  } finally {
    try { fs.unlinkSync(outPath); } catch { /* temp file cleanup is best-effort */ }
  }
  subtitleTextCache.set(key, text);
  return text;
});

// Playback bookkeeping for auto-delete: 'start' remembers which URL the
// player is currently on, 'done' fires when that video ends (ended event).
ipcMain.handle('watch:start', (_e, { url }) => {
  watchState.currentUrl = url || null;
  return { ok: true };
});

ipcMain.handle('watch:done', (_e, { url }) => {
  const finishedUrl = url || watchState.currentUrl;
  watchState.currentUrl = null;
  if (finishedUrl) {
    recordWatchFinished(finishedUrl);
    if (config.autoDelete === 'watched') {
      const deleted = deleteRecordedFile(finishedUrl);
      if (deleted) send('net:system', { text: 'Video deleted (auto-delete after watching)' });
    }
  }
  return { ok: true };
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
