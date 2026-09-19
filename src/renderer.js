// ---------------------------------------------------------------------------
// Onigiri renderer — UI glue, playback sync, queue, chat, typing indicator,
// emote autocomplete. window.onigiri.* is exposed by preload.js.
// ---------------------------------------------------------------------------

const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.0.3/assets/72x72/';
const emojiUrl = (code) => `${TWEMOJI_BASE}${code}.png`;

// Built-in emotes get short shortcode-style names so they work with the
// same :name: autocomplete as custom ones.
const BUILTIN_EMOTES = [
  { name: 'grin', url: emojiUrl('1f600') },
  { name: 'joy', url: emojiUrl('1f602') },
  { name: 'heart_eyes', url: emojiUrl('1f60d') },
  { name: 'cool', url: emojiUrl('1f60e') },
  { name: 'sob', url: emojiUrl('1f62d') },
  { name: 'angry', url: emojiUrl('1f621') },
  { name: 'thinking', url: emojiUrl('1f914') },
  { name: 'scream', url: emojiUrl('1f631') },
  { name: 'party', url: emojiUrl('1f973') },
  { name: 'sleeping', url: emojiUrl('1f634') },
  { name: 'upside_down', url: emojiUrl('1f643') },
  { name: 'skull', url: emojiUrl('1f480') },
  { name: 'thumbsup', url: emojiUrl('1f44d') },
  { name: 'thumbsdown', url: emojiUrl('1f44e') },
  { name: 'eyes', url: emojiUrl('1f440') },
  { name: 'wave', url: emojiUrl('1f44b') },
  { name: 'handshake', url: emojiUrl('1f91d') },
  { name: 'heart', url: emojiUrl('2764-fe0f') },
  { name: 'fire', url: emojiUrl('1f525') },
  { name: 'sparkles', url: emojiUrl('2728') },
  { name: 'tada', url: emojiUrl('1f389') },
  { name: '100', url: emojiUrl('1f4af') },
  { name: 'onigiri', url: emojiUrl('1f359') },
  { name: 'popcorn', url: emojiUrl('1f37f') },
  { name: 'clapper', url: emojiUrl('1f3ac') },
  { name: 'alarm', url: emojiUrl('23f0') },
  { name: 'play', url: emojiUrl('25b6-fe0f') },
  { name: 'pause', url: emojiUrl('23f8-fe0f') }
];

// A chat message renders as an inline image (not text) whenever its text is
// nothing but a bare image URL. This is what makes custom emotes work for
// *everyone* in the room, not just the person who added it locally — the
// receiving side never needs to know the emote's name, just that the whole
// message is an image link.
const IMAGE_URL_RE = /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i;
const looksLikeImageUrl = (text) => IMAGE_URL_RE.test(text.trim());

let config = null;
let customEmotes = [];
let role = null; // 'host' | 'client'
let username = '';
let suppressPlayerEvents = false;
let currentVideoUrl = null;
let downloadingUrl = null;
let roomQueue = [];
let roomQueueIndex = -1;
let typingUsers = new Set();
let typingStopTimer = null;

// emoji tray keyboard navigation state (Ctrl+E to open, Tab to cycle)
let trayOpen = false;
let trayButtons = [];
let traySelectedIndex = 0;

const $ = (sel) => document.querySelector(sel);
const allEmotes = () => [...BUILTIN_EMOTES, ...customEmotes];

// ---------------------------------------------------------------------- init
(async function init() {
  config = await window.onigiri.getConfig();
  customEmotes = await window.onigiri.getEmotes();
  $('#host-username').value = config.username;
  $('#join-username').value = config.username;

  buildEmojiTray();
  wireSetup();
  wireRoom();
  wireChat();
  wireSettings();
  wireNetworkEvents();
  refreshConfigNotice();
})();

function refreshConfigNotice() {
  const notice = $('#setup-config-notice');
  notice.hidden = !!(config.supabaseUrl && config.supabaseKey);
}

function toast(msg) {
  const el = $('#snackbar');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3500);
}

// ------------------------------------------------------------------- setup
function wireSetup() {
  $('#host-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    username = $('#host-username').value.trim() || 'host';
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    await window.onigiri.setConfig({ username });
    const res = await window.onigiri.hostRoom(username);
    submitBtn.disabled = false;
    if (!res.ok) { toast(`Couldn't create room: ${res.error}`); return; }
    role = 'host';
    enterRoom();
    setRoomChip(`Room code: ${res.code}`, res.code);
    toast(`Room created — share the code "${res.code}" with your friends`);
  });

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    username = $('#join-username').value.trim() || 'guest';
    const code = $('#join-code').value.trim().toUpperCase();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    await window.onigiri.setConfig({ username });
    const res = await window.onigiri.joinRoom(code, username);
    submitBtn.disabled = false;
    if (!res.ok) { toast(`Couldn't join: ${res.error}`); return; }
    role = 'client';
    enterRoom();
    setRoomChip(`In room: ${code}`, code);
    await window.onigiri.requestSync();
  });
}

function enterRoom() {
  $('#setup-view').hidden = true;
  $('#room-view').hidden = false;
  $('#leave-room-btn').hidden = false;
  $('.top-bar').hidden = false;
  $('#setup-settings-btn').hidden = true;
  maybeShowChatHint();
  refreshBarVisibility();
}

function setRoomChip(text, code) {
  const chip = $('#room-chip');
  chip.textContent = text;
  chip.hidden = false;
  chip.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('Room code copied');
    } catch {
      toast(`Room code: ${code}`);
    }
  };
}

async function leaveRoom() {
  await window.onigiri.leaveRoom();
  role = null;
  currentVideoUrl = null;
  downloadingUrl = null;
  roomQueue = [];
  roomQueueIndex = -1;
  typingUsers = new Set();

  const video = $('#player');
  video.pause();
  video.removeAttribute('src');
  video.load();

  fadeTimers.forEach((t) => clearTimeout(t));
  fadeTimers.clear();
  $('#chat-log').innerHTML = '';
  closeChatInput();
  $('#queue-panel').hidden = true;
  $('#room-chip').hidden = true;
  $('#participants-dock').hidden = true;
  $('#leave-room-btn').hidden = true;
  $('#room-view').hidden = true;
  $('#setup-view').hidden = false;
  $('.top-bar').hidden = true;
  $('#setup-settings-btn').hidden = false;

  renderQueueList();
  refreshBarVisibility();
  toast('Left the room');
}

// -------------------------------------------------------------- chat hint
function maybeShowChatHint() {
  if (config.hasSeenChatHint) return;
  $('#chat-hint').hidden = false;
  setTimeout(dismissChatHint, 4000);
}

async function dismissChatHint() {
  const hint = $('#chat-hint');
  if (hint.hidden) return;
  hint.hidden = true;
  if (!config.hasSeenChatHint) {
    config = await window.onigiri.setConfig({ hasSeenChatHint: true });
  }
}

// -------------------------------------------------------------------- room
let lastMouseY = -1;

function refreshBarVisibility(mouseY) {
  if (typeof mouseY === 'number') lastMouseY = mouseY;
  const topBar = document.querySelector('.top-bar');
  const bottomBar = $('#bottom-bar');

  if ($('#room-view').hidden) {
    topBar.classList.remove('collapsed');
    bottomBar.classList.remove('collapsed');
    return;
  }

  const video = $('#player');
  const paused = video.paused;
  const queueOpen = !$('#queue-panel').hidden;
  const showTop = paused || lastMouseY < 90;
  const showBottom = paused || queueOpen || lastMouseY > window.innerHeight - 260;

  topBar.classList.toggle('collapsed', !showTop);
  bottomBar.classList.toggle('collapsed', !showBottom);
}

function wireRoom() {
  const video = $('#player');

  video.addEventListener('play', () => { if (!suppressPlayerEvents) window.onigiri.sendPlayerEvent('play', video.currentTime); refreshBarVisibility(); });
  video.addEventListener('pause', () => { if (!suppressPlayerEvents) window.onigiri.sendPlayerEvent('pause', video.currentTime); refreshBarVisibility(); });
  video.addEventListener('seeked', () => { if (!suppressPlayerEvents) window.onigiri.sendPlayerEvent('seek', video.currentTime); });
  document.addEventListener('mousemove', (e) => refreshBarVisibility(e.clientY));

  $('#leave-room-btn').addEventListener('click', leaveRoom);

  $('#add-queue-btn').addEventListener('click', async () => {
    const input = $('#video-url');
    const url = input.value.trim();
    if (!url) return;
    await window.onigiri.queueAdd(url);
    input.value = '';
  });
  $('#video-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#add-queue-btn').click(); }
  });

  $('#queue-toggle-btn').addEventListener('click', () => {
    const panel = $('#queue-panel');
    panel.hidden = !panel.hidden;
    $('#queue-toggle-btn').setAttribute('aria-expanded', String(!panel.hidden));
    refreshBarVisibility();
  });

  window.onigiri.onVideoProgress(({ percent }) => {
    $('#progress-row').hidden = false;
    $('#progress-fill').style.width = `${percent}%`;
    $('#progress-label').textContent = `${Math.round(percent)}%`;
  });

  function updateEmptyState() {
    $('#video-empty').style.display = video.getAttribute('src') ? 'none' : 'flex';
  }
  video.addEventListener('loadeddata', updateEmptyState);
  updateEmptyState();
}

// -------------------------------------------------------------------- queue
function renderQueueList() {
  const list = $('#queue-list');
  const empty = $('#queue-empty');
  $('#queue-count').textContent = String(roomQueue.length);

  list.innerHTML = '';
  if (roomQueue.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  roomQueue.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'queue-item' + (idx === roomQueueIndex ? ' is-current' : '');

    const index = document.createElement('span');
    index.className = 'queue-item-index';
    index.textContent = String(idx + 1);

    const url = document.createElement('span');
    url.className = 'queue-item-url';
    url.textContent = item.url;
    url.title = item.url;

    const badge = document.createElement('span');
    badge.className = 'queue-item-badge';
    if (item.url === downloadingUrl) badge.textContent = 'Downloading…';
    else if (idx === roomQueueIndex) badge.textContent = 'Now playing';

    const actions = document.createElement('div');
    actions.className = 'queue-item-actions';

    if (idx !== roomQueueIndex) {
      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.title = 'Play now';
      playBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7Z"/></svg>';
      playBtn.addEventListener('click', () => window.onigiri.queuePlay(item.id));
      actions.appendChild(playBtn);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.title = 'Remove';
    removeBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6Zm2-9h8v9H8ZM15.5 4l-1-1h-5l-1 1H5v2h14V4Z"/></svg>';
    removeBtn.addEventListener('click', () => window.onigiri.queueRemove(item.id));
    actions.appendChild(removeBtn);

    row.appendChild(index);
    row.appendChild(url);
    row.appendChild(badge);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

// Downloads whichever queue item is now "current" if it's not already the
// loaded video, then resolves once that's settled — callers can chain a
// seek/play-state application after it (see onSync below).
async function applyQueueState(queue, queueIndex) {
  roomQueue = Array.isArray(queue) ? queue : [];
  roomQueueIndex = typeof queueIndex === 'number' ? queueIndex : -1;
  renderQueueList();

  const current = roomQueue[roomQueueIndex];
  if (current && current.url !== currentVideoUrl) {
    currentVideoUrl = current.url;
    $('#video-url').value = '';
    await loadVideo(current.url);
  } else if (!current) {
    currentVideoUrl = null;
  }
}

async function loadVideo(url) {
  if (!url) return;
  downloadingUrl = url;
  renderQueueList();
  $('#add-queue-btn').disabled = true;
  $('#progress-row').hidden = false;
  $('#progress-fill').style.width = '0%';
  $('#progress-label').textContent = '0%';
  toast('Downloading video…');
  try {
    const { filePath } = await window.onigiri.downloadVideo(url);
    setLocalVideo(filePath);
    toast('Video ready');
  } catch (err) {
    toast(`Download failed: ${err.message}`);
  } finally {
    downloadingUrl = null;
    renderQueueList();
    $('#add-queue-btn').disabled = false;
    setTimeout(() => { $('#progress-row').hidden = true; }, 1200);
  }
}

function toFileUrl(filePath) {
  let p = filePath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p; // windows drive letters -> /C:/...
  return 'file://' + encodeURI(p).replace(/#/g, '%23');
}

function setLocalVideo(filePath) {
  const video = $('#player');
  suppressPlayerEvents = true;
  video.src = toFileUrl(filePath);
  video.load();
  setTimeout(() => { suppressPlayerEvents = false; }, 300);
  $('#video-empty').style.display = 'none';
}

// -------------------------------------------------------------- networking
function wireNetworkEvents() {
  const video = $('#player');

  window.onigiri.onRemotePlayerEvent((msg) => {
    suppressPlayerEvents = true;
    if (msg.action === 'play') {
      if (Math.abs(video.currentTime - msg.time) > 0.75) video.currentTime = msg.time;
      video.play().catch(() => {});
    } else if (msg.action === 'pause') {
      video.pause();
      if (Math.abs(video.currentTime - msg.time) > 0.75) video.currentTime = msg.time;
    } else if (msg.action === 'seek') {
      video.currentTime = msg.time;
    }
    setTimeout(() => { suppressPlayerEvents = false; }, 150);
  });

  window.onigiri.onQueue(({ queue, queueIndex }) => {
    applyQueueState(queue, queueIndex);
  });

  window.onigiri.onSync(async ({ time, isPlaying, queue, queueIndex }) => {
    if (queue) await applyQueueState(queue, queueIndex);
    suppressPlayerEvents = true;
    if (typeof time === 'number') video.currentTime = time;
    if (isPlaying) video.play().catch(() => {}); else video.pause();
    setTimeout(() => { suppressPlayerEvents = false; }, 150);
  });

  window.onigiri.onChat((msg) => { appendChat(msg); clearTyping(msg.username); });
  window.onigiri.onSystem((msg) => appendSystem(msg.text));
  window.onigiri.onPeers(({ participants }) => renderParticipants(participants || []));
  window.onigiri.onNetError(({ message }) => toast(message));

  window.onigiri.onTyping(({ username: who }) => {
    if (who === username) return;
    typingUsers.add(who);
    renderTypingIndicator();
  });
  window.onigiri.onTypingStop(({ username: who }) => clearTyping(who));
}

function nameColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 60%, 55%)`;
}

function renderParticipants(participants) {
  const dock = $('#participants-dock');
  dock.innerHTML = '';
  dock.hidden = participants.length === 0;
  participants.forEach(({ username: name, avatarUrl }) => {
    const pill = document.createElement('div');
    pill.className = 'participant-pill';
    if (avatarUrl && looksLikeImageUrl(avatarUrl)) {
      const img = document.createElement('img');
      img.className = 'participant-avatar';
      img.src = avatarUrl;
      img.alt = '';
      pill.appendChild(img);
    } else {
      const dot = document.createElement('span');
      dot.className = 'participant-dot';
      dot.style.background = nameColor(name);
      pill.appendChild(dot);
    }
    pill.appendChild(document.createTextNode(name));
    dock.appendChild(pill);
  });
}

function clearTyping(who) {
  typingUsers.delete(who);
  renderTypingIndicator();
}

function renderTypingIndicator() {
  const el = $('#typing-indicator');
  if (typingUsers.size === 0) { el.hidden = true; return; }
  const names = [...typingUsers];
  el.textContent = names.length === 1 ? `${names[0]} is typing…` : `${names.join(', ')} are typing…`;
  el.hidden = false;
}

// ------------------------------------------------------------- chat fading
// Ambient chat lines fade out a while after they're shown, so old messages
// don't linger over the video. Pressing Enter to chat reveals the full
// history again immediately; closing chat resumes the fade timers.
const CHAT_FADE_MS = 8000;
const fadeTimers = new Map();

function scheduleFade(row) {
  if ($('#chat-dock').classList.contains('active')) return;
  const t = setTimeout(() => row.classList.add('faded'), CHAT_FADE_MS);
  fadeTimers.set(row, t);
}

function clearAllFades() {
  fadeTimers.forEach((t) => clearTimeout(t));
  fadeTimers.clear();
  $('#chat-log').querySelectorAll('.chat-line.faded').forEach((el) => el.classList.remove('faded'));
}

function rescheduleAllFades() {
  $('#chat-log').querySelectorAll('.chat-line').forEach((row) => scheduleFade(row));
}

function appendChat({ username: user, text, self }) {
  const log = $('#chat-log');
  const row = document.createElement('div');
  row.className = 'chat-line';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = `${self ? 'you' : user}:`;
  name.style.color = nameColor(self ? username : user);
  row.appendChild(name);
  if (looksLikeImageUrl(text)) {
    const img = document.createElement('img');
    img.src = text;
    img.className = 'chat-emoji-img';
    img.alt = 'emote';
    row.appendChild(img);
  } else {
    row.appendChild(document.createTextNode(text));
  }
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  trimChatLog();
  scheduleFade(row);
}

function appendSystem(text) {
  const log = $('#chat-log');
  const row = document.createElement('div');
  row.className = 'chat-line system';
  row.textContent = text;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  trimChatLog();
  scheduleFade(row);
}

function trimChatLog() {
  const log = $('#chat-log');
  while (log.children.length > 200) {
    const first = log.firstChild;
    fadeTimers.delete(first);
    log.removeChild(first);
  }
}

// -------------------------------------------------------------- chat input
function openChatInput() {
  $('#chat-dock').classList.add('active');
  $('#chat-form').hidden = false;
  $('#chat-input').focus();
  dismissChatHint();
  clearAllFades();
}
function closeChatInput() {
  $('#chat-dock').classList.remove('active');
  $('#chat-form').hidden = true;
  $('#chat-input').blur();
  closeEmojiTray();
  rescheduleAllFades();
}

function wireChat() {
  document.addEventListener('keydown', (e) => {
    if ($('#room-view').hidden) return; // no room open yet

    if (e.ctrlKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      toggleEmojiTray();
      return;
    }

    if (trayOpen) {
      if (e.key === 'Tab') {
        e.preventDefault();
        traySelectedIndex = (traySelectedIndex + 1) % trayButtons.length;
        highlightTraySelection();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        trayButtons[traySelectedIndex]?.click();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeEmojiTray();
        return;
      }
    }

    const tag = document.activeElement.tagName;
    const typingInField = tag === 'INPUT' || tag === 'TEXTAREA';
    const formHidden = $('#chat-form').hidden;

    if (e.key === 'Enter' && formHidden && !typingInField) {
      e.preventDefault();
      openChatInput();
    } else if (e.key === 'Escape' && !formHidden) {
      closeChatInput();
    }
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text) return;
    window.onigiri.sendChat(username, text);
    input.value = '';
    clearTimeout(typingStopTimer);
    window.onigiri.sendTypingStop(username);
  });

  $('#chat-input').addEventListener('input', () => {
    window.onigiri.sendTyping(username);
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(() => window.onigiri.sendTypingStop(username), 2500);
  });

  $('#emoji-toggle').addEventListener('click', () => toggleEmojiTray());
}

// ------------------------------------------------------------- emoji tray nav
function toggleEmojiTray() {
  if (trayOpen) { closeEmojiTray(); return; }
  if ($('#chat-form').hidden) openChatInput();
  openEmojiTray();
}

function openEmojiTray() {
  const tray = $('#emoji-tray');
  tray.hidden = false;
  trayOpen = true;
  trayButtons = Array.from(tray.querySelectorAll('button'));
  traySelectedIndex = 0;
  highlightTraySelection();
}

function closeEmojiTray() {
  $('#emoji-tray').hidden = true;
  trayButtons.forEach((b) => b.classList.remove('is-selected'));
  trayOpen = false;
  trayButtons = [];
}

function highlightTraySelection() {
  trayButtons.forEach((b, i) => b.classList.toggle('is-selected', i === traySelectedIndex));
  trayButtons[traySelectedIndex]?.scrollIntoView({ block: 'nearest' });
}

// ----------------------------------------------------------------- emoji tray
function buildEmojiTray() {
  const tray = $('#emoji-tray');
  tray.innerHTML = '';

  if (customEmotes.length) {
    customEmotes.forEach((e) => tray.appendChild(makeEmojiButton(e)));
    const divider = document.createElement('hr');
    divider.className = 'emoji-tray-divider';
    tray.appendChild(divider);
  }

  BUILTIN_EMOTES.forEach((e) => tray.appendChild(makeEmojiButton(e)));
}

function makeEmojiButton({ name, url }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = `:${name}:`;
  const img = document.createElement('img');
  img.src = url;
  img.alt = name;
  btn.appendChild(img);
  btn.addEventListener('click', () => {
    window.onigiri.sendChat(username, url);
    closeEmojiTray();
  });
  return btn;
}

function renderCustomEmojiList() {
  const list = $('#custom-emoji-list');
  list.innerHTML = '';
  customEmotes.forEach((e) => {
    const chip = document.createElement('span');
    chip.className = 'custom-emoji-chip';
    const img = document.createElement('img');
    img.src = e.url;
    img.alt = e.name;
    const label = document.createElement('span');
    label.textContent = `:${e.name}:`;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove :${e.name}:`;
    removeBtn.addEventListener('click', async () => {
      customEmotes = await window.onigiri.removeEmote(e.name);
      renderCustomEmojiList();
      buildEmojiTray();
    });
    chip.appendChild(img);
    chip.appendChild(label);
    chip.appendChild(removeBtn);
    list.appendChild(chip);
  });
}

// --------------------------------------------------------------- settings
function closeSettings() {
  $('#settings-dialog').hidden = true;
}

async function openSettings() {
  config = await window.onigiri.getConfig();
  customEmotes = await window.onigiri.getEmotes();
  $('#setting-avatar-url').value = config.avatarUrl;
  $('#setting-dir').value = config.downloadDir;
  $('#setting-webhook').value = config.webhookUrl;
  $('#setting-supabase-url').value = config.supabaseUrl;
  $('#setting-supabase-key').value = config.supabaseKey;
  const path = await window.onigiri.getEmotesPath();
  $('#emotes-file-path').textContent = path;
  renderCustomEmojiList();
  $('#settings-dialog').hidden = false;
}

function wireSettings() {
  $('#settings-btn').addEventListener('click', openSettings);
  $('#setup-settings-btn').addEventListener('click', openSettings);

  // Cancel, Escape, and clicking outside the dialog box must always work,
  // no matter what Browse/Save are doing — none of them wait on anything.
  $('#settings-cancel').addEventListener('click', closeSettings);
  $('#settings-dialog').addEventListener('click', (e) => {
    if (e.target.id === 'settings-dialog') closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#settings-dialog').hidden) closeSettings();
  });

  $('#browse-dir-btn').addEventListener('click', async () => {
    const btn = $('#browse-dir-btn');
    btn.disabled = true;
    try {
      const dir = await window.onigiri.chooseDownloadDir();
      if (dir) $('#setting-dir').value = dir;
    } catch (err) {
      toast(err.message || "Couldn't open the file picker — type the path in manually instead.");
    } finally {
      btn.disabled = false;
    }
  });

  $('#add-custom-emoji-btn').addEventListener('click', async () => {
    const nameInput = $('#custom-emoji-name');
    const urlInput = $('#custom-emoji-url');
    try {
      customEmotes = await window.onigiri.addEmote(nameInput.value, urlInput.value);
      nameInput.value = '';
      urlInput.value = '';
      renderCustomEmojiList();
      buildEmojiTray();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#reload-emotes-btn').addEventListener('click', async () => {
    customEmotes = await window.onigiri.reloadEmotes();
    renderCustomEmojiList();
    buildEmojiTray();
    toast('Reloaded emotes from file');
  });

  $('#settings-save').addEventListener('click', async () => {
    const btn = $('#settings-save');
    btn.disabled = true;
    try {
      await window.onigiri.setConfig({
        avatarUrl: $('#setting-avatar-url').value.trim(),
        downloadDir: $('#setting-dir').value.trim(),
        webhookUrl: $('#setting-webhook').value.trim(),
        supabaseUrl: $('#setting-supabase-url').value.trim(),
        supabaseKey: $('#setting-supabase-key').value.trim()
      });
      config = await window.onigiri.getConfig();
      refreshConfigNotice();
      closeSettings();
      toast('Settings saved');
    } catch (err) {
      toast(`Couldn't save settings: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  $('#setup-notice-settings-link').addEventListener('click', openSettings);
}
