const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
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
    backgroundBlur: 24,
    backgroundParallax: true,
    customTheme: null
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
  if (process.platform !== 'darwin') app.quit();
});

function send(channelName, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channelName, payload);
  }
}

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
function downloadVideo(url) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(config.downloadDir, { recursive: true });
    const outTemplate = path.join(config.downloadDir, '%(title).150B [%(id)s].%(ext)s');
    const args = [
      url,
      '-f', 'bv*+ba/b',
      '--merge-output-format', 'mp4',
      '--restrict-filenames',
      '--no-playlist',
      '--newline',
      '--no-color',
      '-o', outTemplate,
      '--print', 'after_move:filepath'
    ];
    const proc = spawn('yt-dlp', args);
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
          send('video:progress', { percent: parseFloat(percentMatch[1]) });
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
        send('video:progress', { percent: 100 });
        resolve(finalPath);
      } else if (code === 0) {
        reject(new Error('yt-dlp finished but no output file path was captured.'));
      } else {
        reject(new Error(stderr.trim().split('\n').pop() || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => config);

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
    return { ok: true, code };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('room:join', async (_e, { code, username }) => {
  try {
    await joinRoom(code, username);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('room:leave', () => {
  stopEverything();
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

ipcMain.handle('shell:open-path', (_e, target) => {
  shell.showItemInFolder(target);
});
