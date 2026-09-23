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
let role = null; // 'host' | 'client' — who created vs joined the room; display-only now
let amIHost = false; // who ACTUALLY has host powers right now — can move to someone else if the creator disconnects
let seenFirstPeersUpdate = false;
let username = '';
let suppressPlayerEvents = false;
let currentVideoUrl = null;
let currentItemId = null; // id of the queue item ACTUALLY loaded in the player right now
let lastKnownSyncedTime = 0; // last room-authoritative time, used to snap back unauthorized seeks
let downloadingUrl = null;
let downloadError = null; // { itemId, url, message } — local to this client only
const predownloadedPaths = new Map(); // url -> local file path, ready to use instantly
const predownloadingUrls = new Set();
let roomQueue = [];
let roomQueueIndex = -1;
let typingUsers = new Set();
let typingStopTimer = null;
let djUsernames = [];
let lastParticipants = [];

// emoji tray keyboard navigation state (Ctrl+E to open, Tab to cycle)
let trayOpen = false;
let trayButtons = [];
let traySelectedIndex = 0;

const $ = (sel) => document.querySelector(sel);
const allEmotes = () => [...BUILTIN_EMOTES, ...customEmotes];
const hasControlPermission = () => amIHost || djUsernames.includes(username);

// ---------------------------------------------------------------------- init
(async function init() {
  config = await window.onigiri.getConfig();
  customEmotes = await window.onigiri.getEmotes();
  $('#host-username').value = config.username;
  $('#join-username').value = config.username;

  applyAppearance();
  buildEmojiTray();
  wireSetup();
  wireRoom();
  wireChat();
  wireSettings();
  wireAppearance();
  wireNetworkEvents();
  refreshConfigNotice();
})();

// ---- Theme generation: every theme is just a seed hex color. Surfaces,
// buttons, and everything else are all derived from it algorithmically, so
// picking a theme recolors the whole app — settings modal, top/bottom bars,
// main background — not just accent buttons like before.
function hexToHsl(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function buildThemeTokens(seedHex, mode) {
  const [hue, satPct, seedL] = hexToHsl(seedHex);
  const dark = mode !== 'light';
  const onSeed = seedL > 60 ? '#1A1A1A' : '#FFFFFF';

  let primary, onPrimary, primaryContainer, onPrimaryContainer;
  if (dark) {
    primary = seedHex;
    onPrimary = onSeed;
    primaryContainer = hslToHex(hue, Math.min(satPct, 55), Math.max(seedL - 22, 14));
    onPrimaryContainer = hslToHex(hue, Math.min(satPct, 40), Math.min(seedL + 35, 92));
  } else {
    primary = hslToHex(hue, Math.min(satPct, 65), Math.min(seedL, 42));
    onPrimary = '#FFFFFF';
    primaryContainer = hslToHex(hue, Math.min(satPct, 45), 88);
    onPrimaryContainer = hslToHex(hue, Math.min(satPct, 55), 20);
  }

  const secondary = hslToHex((hue + 20) % 360, Math.max(satPct * 0.4, 15), dark ? 78 : 35);
  const tertiary = hslToHex((hue + 300) % 360, Math.max(satPct * 0.5, 20), dark ? 75 : 38);

  // Low-saturation neutrals, tinted toward the seed hue — this is what
  // makes surfaces (bars, modals, the main background) shift with the
  // theme instead of staying a fixed gray regardless of which one is picked.
  const ns = 10;
  const surface = dark ? {
    '--nori': hslToHex(hue, ns, 6),
    '--md-surface': hslToHex(hue, ns, 8),
    '--md-surface-dim': hslToHex(hue, ns, 8),
    '--md-surface-bright': hslToHex(hue, ns, 22),
    '--md-surface-container-lowest': hslToHex(hue, ns, 6),
    '--md-surface-container-low': hslToHex(hue, ns, 11),
    '--md-surface-container': hslToHex(hue, ns, 13),
    '--md-surface-container-high': hslToHex(hue, ns, 17),
    '--md-surface-container-highest': hslToHex(hue, ns, 21),
    '--md-on-surface': hslToHex(hue, 12, 92),
    '--md-on-surface-variant': hslToHex(hue, 10, 80),
    '--md-outline': hslToHex(hue, 8, 58),
    '--md-outline-variant': hslToHex(hue, 10, 28)
  } : {
    '--nori': hslToHex(hue, ns, 14),
    '--md-surface': hslToHex(hue, ns, 97),
    '--md-surface-dim': hslToHex(hue, ns, 88),
    '--md-surface-bright': hslToHex(hue, ns, 97),
    '--md-surface-container-lowest': hslToHex(hue, ns, 100),
    '--md-surface-container-low': hslToHex(hue, ns, 95),
    '--md-surface-container': hslToHex(hue, ns, 93),
    '--md-surface-container-high': hslToHex(hue, ns, 91),
    '--md-surface-container-highest': hslToHex(hue, ns, 89),
    '--md-on-surface': hslToHex(hue, 14, 12),
    '--md-on-surface-variant': hslToHex(hue, 10, 32),
    '--md-outline': hslToHex(hue, 8, 48),
    '--md-outline-variant': hslToHex(hue, 10, 80)
  };

  return {
    '--md-primary': primary, '--md-on-primary': onPrimary,
    '--md-primary-container': primaryContainer, '--md-on-primary-container': onPrimaryContainer,
    '--md-secondary': secondary, '--md-on-secondary': dark ? '#2A2118' : '#FFFFFF',
    '--md-tertiary': tertiary, '--md-on-tertiary': dark ? '#231C00' : '#FFFFFF',
    ...surface
  };
}

const THEME_KEYS = [
  '--md-primary', '--md-on-primary', '--md-primary-container', '--md-on-primary-container',
  '--md-secondary', '--md-on-secondary', '--md-tertiary', '--md-on-tertiary',
  '--nori', '--md-surface', '--md-surface-dim', '--md-surface-bright',
  '--md-surface-container-lowest', '--md-surface-container-low', '--md-surface-container',
  '--md-surface-container-high', '--md-surface-container-highest',
  '--md-on-surface', '--md-on-surface-variant', '--md-outline', '--md-outline-variant'
];

// Preset themes are just a seed color each — recomputed through the same
// generator above, so they automatically produce sensible dark AND light
// variants rather than needing both hand-authored.
const PRESET_THEMES = {
  asuka: '#B3401F', // the app's original color, kept and just renamed
  lilith: '#873E47',
  sartre: '#FFEC65',
  fouco: '#83FCFF',
  kallen: '#F99FE3',
  green: '#AEFA87',
  morphean: '#465189',
  miku: '#37C0D1'
};

// config.customTheme is either: null (no theme, pure CSS defaults), a seed
// hex string (a preset — regenerated per current dark/light mode), or a
// full {--token: value} object (an imported theme JSON, fixed regardless
// of mode, since hand-authored files only cover accent tokens).
function applyCustomTheme(theme) {
  const root = document.documentElement;
  THEME_KEYS.forEach((k) => root.style.removeProperty(k));
  if (!theme) return;
  const tokens = typeof theme === 'string'
    ? buildThemeTokens(theme, config.themeMode === 'light' ? 'light' : 'dark')
    : theme;
  Object.entries(tokens).forEach(([k, v]) => { if (v) root.style.setProperty(k, v); });
}

function applyAppearance() {
  document.documentElement.dataset.theme = config.themeMode || 'dark';
  applyCustomTheme(config.customTheme);

  const bg = $('#setup-bg');
  const cookie = $('#setup-cookie');
  // cookie is an <svg> element — SVGElement doesn't reliably support the
  // .hidden IDL property the way HTMLElement does, so setting it directly
  // can silently no-op. setAttribute/removeAttribute always works.
  if (config.backgroundUrl) {
    bg.style.backgroundImage = `url("${config.backgroundUrl}")`;
    bg.style.filter = `blur(${config.backgroundBlur ?? 24}px)`;
    bg.hidden = false;
    cookie.setAttribute('hidden', '');
  } else {
    bg.hidden = true;
    cookie.removeAttribute('hidden');
  }
  setBackgroundTransform(0, 0);
}

// scale(1.1) keeps the blurred edges from ever showing the layer's own
// boundary; the translate is the parallax offset (0,0 when disabled/idle).
function setBackgroundTransform(x, y) {
  $('#setup-bg').style.transform = `scale(1.1) translate(${x}px, ${y}px)`;
}

function handleParallaxMouseMove(e) {
  if (!config.backgroundParallax || !config.backgroundUrl || $('#setup-view').hidden) return;
  const x = (e.clientX / window.innerWidth - 0.5) * 30;
  const y = (e.clientY / window.innerHeight - 0.5) * 30;
  setBackgroundTransform(x, y);
}

function refreshAppearanceButtons() {
  const mode = config.themeMode || 'dark';
  $('#theme-toggle').querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.themeValue === mode);
  });

  $('#scheme-swatches').querySelectorAll('.scheme-swatch').forEach((btn) => {
    btn.classList.toggle('is-active', PRESET_THEMES[btn.dataset.preset] === config.customTheme);
  });
}

function wireAppearance() {
  document.addEventListener('mousemove', handleParallaxMouseMove);

  $('#settings-nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-nav-item');
    if (!btn) return;
    $('#settings-nav').querySelectorAll('.settings-nav-item').forEach((b) => b.classList.toggle('is-active', b === btn));
    $('.settings-panels').querySelectorAll('.settings-panel').forEach((p) => { p.hidden = p.dataset.panel !== btn.dataset.panel; });
  });

  $('#theme-toggle').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-theme-value]');
    if (!btn) return;
    config = await window.onigiri.setConfig({ themeMode: btn.dataset.themeValue });
    applyAppearance();
    refreshAppearanceButtons();
  });

  $('#scheme-swatches').addEventListener('click', async (e) => {
    const btn = e.target.closest('.scheme-swatch');
    if (!btn) return;
    const preset = PRESET_THEMES[btn.dataset.preset] ?? null;
    config = await window.onigiri.setConfig({ customTheme: preset });
    applyAppearance();
    refreshAppearanceButtons();
  });

  $('#import-theme-btn').addEventListener('click', async () => {
    const res = await window.onigiri.importTheme();
    if (res.canceled) return;
    if (!res.ok) { toast(res.error || "Couldn't read that theme file."); return; }
    config = await window.onigiri.setConfig({ customTheme: res.theme });
    applyAppearance();
    toast('Theme imported');
  });

  $('#reset-theme-btn').addEventListener('click', async () => {
    config = await window.onigiri.setConfig({ customTheme: null });
    applyAppearance();
    toast('Theme reset');
  });

  $('#setting-blur-amount').addEventListener('input', (e) => {
    $('#blur-amount-label').textContent = `${e.target.value}px`;
    $('#setup-bg').style.filter = `blur(${e.target.value}px)`;
  });

  // Live preview so the cookie/background swap (and blur) reflect what's
  // typed immediately, rather than only after Save — that mismatch is what
  // made the cookie look like it was wrongly showing "while" a background
  // was set, when really it just hadn't been saved yet.
  $('#setting-background-url').addEventListener('input', (e) => {
    const url = e.target.value.trim();
    const bg = $('#setup-bg');
    const cookie = $('#setup-cookie');
    if (url) {
      bg.style.backgroundImage = `url("${url}")`;
      bg.hidden = false;
      cookie.setAttribute('hidden', '');
    } else {
      bg.hidden = true;
      cookie.removeAttribute('hidden');
    }
  });
}

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
    amIHost = true; // optimistic — presence sync confirms this within moments
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
  updateVideoControls();
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
  amIHost = false;
  seenFirstPeersUpdate = false;
  djUsernames = [];
  currentVideoUrl = null;
  currentItemId = null;
  lastKnownSyncedTime = 0;
  downloadingUrl = null;
  downloadError = null;
  roomQueue = [];
  roomQueueIndex = -1;
  typingUsers = new Set();
  lastParticipants = [];
  predownloadedPaths.clear();
  predownloadingUrls.clear();
  $('#top-participants').innerHTML = '';

  const video = $('#player');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.controls = false;
  $('#video-empty').querySelector('p').textContent = 'Add a video to start';
  $('#video-empty').style.display = 'flex';

  fadeTimers.forEach((t) => clearTimeout(t));
  fadeTimers.clear();
  $('#chat-log').innerHTML = '';
  closeChatInput();
  $('#queue-panel').hidden = true;
  $('#room-chip').hidden = true;
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

  video.addEventListener('play', () => {
    if (suppressPlayerEvents) return;
    if (!hasControlPermission()) { video.pause(); return; } // revert — no permission
    window.onigiri.sendPlayerEvent('play', video.currentTime, currentItemId);
    refreshBarVisibility();
  });
  video.addEventListener('pause', () => {
    if (suppressPlayerEvents) return;
    if (!hasControlPermission()) { video.play().catch(() => {}); return; } // revert
    window.onigiri.sendPlayerEvent('pause', video.currentTime, currentItemId);
    refreshBarVisibility();
  });
  video.addEventListener('seeked', () => {
    if (suppressPlayerEvents) return;
    if (!hasControlPermission()) { video.currentTime = lastKnownSyncedTime; return; } // snap back
    lastKnownSyncedTime = video.currentTime;
    window.onigiri.sendPlayerEvent('seek', video.currentTime, currentItemId);
  });
  video.addEventListener('volumechange', () => {
    syncVolumeUi();
    clearTimeout(video._volumeSaveTimer);
    video._volumeSaveTimer = setTimeout(async () => {
      config = await window.onigiri.setConfig({ playerVolume: video.volume });
    }, 500);
  });
  video.addEventListener('timeupdate', updateSeekUi);
  video.addEventListener('loadedmetadata', updateSeekUi);
  video.addEventListener('play', updatePlayPauseIcon);
  video.addEventListener('pause', updatePlayPauseIcon);
  wirePlayerControls();
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

  $('#skip-btn').addEventListener('click', () => {
    if (!hasControlPermission()) { toast("Only the host or a DJ can skip"); return; }
    window.onigiri.queueNext();
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
    const failed = downloadError && downloadError.itemId === item.id;
    row.className = 'queue-item' + (idx === roomQueueIndex ? ' is-current' : '') + (failed ? ' is-failed' : '');

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
    else if (failed) badge.textContent = 'Failed — download only failed for you';
    else if (predownloadingUrls.has(item.url)) badge.textContent = 'Pre-loading…';
    else if (idx === roomQueueIndex) badge.textContent = 'Now playing';
    else if (predownloadedPaths.has(item.url)) badge.textContent = 'Ready';

    const actions = document.createElement('div');
    actions.className = 'queue-item-actions';

    if (failed) {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.title = 'Retry download';
      retryBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8Z"/></svg>';
      retryBtn.addEventListener('click', () => {
        currentVideoUrl = null;
        loadVideo(item.url, item.id);
      });
      actions.appendChild(retryBtn);
    } else if (idx !== roomQueueIndex) {
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
// seek/play-state application after it (see onSync below). Also kicks off a
// silent background download of whatever's next, so skipping/advancing is
// instant instead of waiting on a fresh download.
async function applyQueueState(queue, queueIndex) {
  roomQueue = Array.isArray(queue) ? queue : [];
  roomQueueIndex = typeof queueIndex === 'number' ? queueIndex : -1;
  renderQueueList();

  const current = roomQueue[roomQueueIndex];
  if (current && current.url !== currentVideoUrl) {
    currentVideoUrl = current.url;
    $('#video-url').value = '';
    await loadVideo(current.url, current.id);
  } else if (!current) {
    currentVideoUrl = null;
  }
  predownloadNext();
}

async function predownloadNext() {
  const nextItem = roomQueue[roomQueueIndex + 1];
  if (!nextItem) return;
  if (predownloadedPaths.has(nextItem.url) || predownloadingUrls.has(nextItem.url) || nextItem.url === downloadingUrl) return;
  predownloadingUrls.add(nextItem.url);
  renderQueueList();
  try {
    const { filePath } = await window.onigiri.downloadVideo(nextItem.url);
    predownloadedPaths.set(nextItem.url, filePath);
  } catch {
    // Silent — if it's still broken once it actually becomes current,
    // the normal foreground download path surfaces the real error there.
  } finally {
    predownloadingUrls.delete(nextItem.url);
    renderQueueList();
  }
}

async function loadVideo(url, itemId) {
  if (!url) return;

  const cached = predownloadedPaths.get(url);
  if (cached) {
    downloadError = null;
    setLocalVideo(cached);
    currentItemId = itemId; // only set once the video is ACTUALLY loaded — see wireRoom's player listeners
    toast('Video ready');
    renderQueueList();
    return;
  }

  downloadingUrl = url;
  downloadError = null;
  renderQueueList();
  $('#add-queue-btn').disabled = true;
  $('#progress-row').hidden = false;
  $('#progress-fill').style.width = '0%';
  $('#progress-label').textContent = '0%';
  toast('Downloading video…');
  try {
    const { filePath } = await window.onigiri.downloadVideo(url);
    predownloadedPaths.set(url, filePath);
    setLocalVideo(filePath);
    currentItemId = itemId;
    toast('Video ready');
  } catch (err) {
    // Leave currentVideoUrl unset so a retry — or a future queue-update
    // that lands on this same item — will actually attempt the download
    // again, instead of silently staying stuck on whatever was there
    // before (or nothing at all).
    currentVideoUrl = null;
    currentItemId = null;
    downloadError = { itemId, url, message: err.message };
    toast(`Download failed: ${err.message}`);
    $('#video-empty').querySelector('p').textContent = `Download failed — ${err.message}`;
    $('#video-empty').style.display = 'flex';
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
  video.volume = config.playerVolume ?? 0.16;
  syncVolumeUi();
  video.load();
  setTimeout(() => { suppressPlayerEvents = false; }, 300);
  $('#video-empty').querySelector('p').textContent = 'Add a video to start';
  $('#video-empty').style.display = 'none';
}

// -------------------------------------------------------------- networking
function wireNetworkEvents() {
  const video = $('#player');

  // Releases suppressPlayerEvents once the browser confirms a programmatic
  // seek has actually finished (polling video.seeking) instead of guessing
  // with a fixed timer. A too-short fixed timer is exactly what caused the
  // multi-DJ desync: if suppression lifted before a seek truly settled, the
  // resulting native 'seeked' event would fire un-suppressed and get
  // rebroadcast — with two+ people doing this at once, it turns into an
  // endless corrective ping-pong between everyone's players.
  function releaseSuppressionWhenSettled(attemptsLeft = 40) {
    if (!video.seeking || attemptsLeft <= 0) { suppressPlayerEvents = false; return; }
    setTimeout(() => releaseSuppressionWhenSettled(attemptsLeft - 1), 50);
  }

  window.onigiri.onRemotePlayerEvent((msg) => {
    // The one check that actually matters: only apply this to the video
    // we've genuinely finished loading. main.js's own copy of "what's
    // current" updates the instant a queue change broadcasts, well before
    // the download finishes — currentItemId only updates once the video is
    // truly on screen, so this is the one comparison immune to that race.
    if (msg.queueItemId !== currentItemId) return;
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
    lastKnownSyncedTime = msg.time;
    setTimeout(() => releaseSuppressionWhenSettled(), 30);
  });

  window.onigiri.onQueue(({ queue, queueIndex }) => {
    applyQueueState(queue, queueIndex);
  });

  window.onigiri.onSync(async ({ time, isPlaying, queue, queueIndex, djUsernames: list }) => {
    if (list) { djUsernames = list; updateVideoControls(); renderParticipants(lastParticipants); }
    if (queue) await applyQueueState(queue, queueIndex);
    suppressPlayerEvents = true;
    if (typeof time === 'number') { video.currentTime = time; lastKnownSyncedTime = time; }
    if (isPlaying) video.play().catch(() => {}); else video.pause();
    setTimeout(() => releaseSuppressionWhenSettled(), 30);
  });

  window.onigiri.onChat((msg) => { appendChat(msg); clearTyping(msg.username); });
  window.onigiri.onSystem((msg) => appendSystem(msg.text));
  window.onigiri.onPeers(({ participants, amIHost: iAmHost }) => {
    lastParticipants = participants || [];
    if (typeof iAmHost === 'boolean') {
      const becameHost = iAmHost && !amIHost;
      amIHost = iAmHost;
      updateVideoControls();
      // Only worth announcing for someone who joined and is now standing in
      // for a host who left — not on first entering (host or not), which
      // would just be noise.
      if (becameHost && seenFirstPeersUpdate && role === 'client') toast("You're now the host");
    }
    seenFirstPeersUpdate = true;
    renderParticipants(lastParticipants);
  });
  window.onigiri.onDj(({ djUsernames: list }) => {
    djUsernames = list || [];
    updateVideoControls();
    renderParticipants(lastParticipants);
  });
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

// Play/pause/seek/skip are gated to host/DJs — but only those, not volume
// or the time-remaining display, which are personal/informational and
// should stay available to everyone. Native <video controls> was all-or-
// nothing (and the old attempt to selectively disable pieces of it was
// never actually wired up), so it's replaced entirely by the custom bar
// below: the play button and seek bar respect this gate, volume and time
// never do.
function updateVideoControls() {
  $('.video-wrap').classList.toggle('no-control', !hasControlPermission());
  updatePlayPauseIcon();
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updatePlayPauseIcon() {
  const video = $('#player');
  $('#play-icon').hidden = !video.paused;
  $('#pause-icon').hidden = video.paused;
}

function updateSeekUi() {
  const video = $('#player');
  const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
  $('#player-seek-fill').style.width = `${pct}%`;
  $('#player-time-current').textContent = formatTime(video.currentTime);
  $('#player-time-duration').textContent = formatTime(video.duration);
}

// Volume uses a quadratic curve rather than mapping the slider straight to
// video.volume — linear volume feels disproportionately loud across most of
// the slider's range (a well-known perceptual-loudness issue), which is
// exactly what made "near max" unusably loud and "near zero" the only
// comfortable setting. Squaring the slider fraction spreads the useful,
// comfortable range across much more of the slider.
function sliderToVolume(pct) { return Math.pow(pct / 100, 2); }
function volumeToSlider(vol) { return Math.round(Math.sqrt(Math.max(vol, 0)) * 100); }

function syncVolumeUi() {
  const video = $('#player');
  $('#volume-slider').value = volumeToSlider(video.volume);
  const isMuted = video.muted || video.volume === 0;
  $('#volume-icon').hidden = isMuted;
  $('#muted-icon').hidden = !isMuted;
}

function seekTrackToTime(clientX) {
  const video = $('#player');
  const track = $('#player-seek-track');
  const rect = track.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return frac * (video.duration || 0);
}

function wirePlayerControls() {
  const video = $('#player');

  $('#play-pause-btn').addEventListener('click', () => {
    if (!hasControlPermission()) return;
    if (video.paused) video.play().catch(() => {}); else video.pause();
  });

  let seekDragging = false;
  const trySeek = (e) => {
    if (!hasControlPermission()) return;
    video.currentTime = seekTrackToTime(e.clientX);
  };
  $('#player-seek-track').addEventListener('mousedown', (e) => {
    if (!hasControlPermission()) return;
    seekDragging = true;
    trySeek(e);
  });
  document.addEventListener('mousemove', (e) => { if (seekDragging) trySeek(e); });
  document.addEventListener('mouseup', () => { seekDragging = false; });

  $('#mute-btn').addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = sliderToVolume(16); // unmuting from 0 should be audible
  });

  $('#volume-slider').addEventListener('input', (e) => {
    video.muted = false;
    video.volume = sliderToVolume(Number(e.target.value));
  });

  syncVolumeUi();
}

function renderParticipants(participants) {
  const dock = $('#top-participants');
  dock.innerHTML = '';
  participants.forEach(({ username: name, avatarUrl }) => {
    const chip = document.createElement('div');
    const isSelf = name === username;
    const isDj = djUsernames.includes(name);
    const hostCanToggle = amIHost && !isSelf;
    chip.className = 'participant-chip' + (hostCanToggle ? ' is-host-controllable' : '');
    chip.title = hostCanToggle ? `Click to ${isDj ? 'revoke' : 'grant'} DJ` : '';

    if (avatarUrl && looksLikeImageUrl(avatarUrl)) {
      const img = document.createElement('img');
      img.className = 'participant-avatar';
      img.src = avatarUrl;
      img.alt = '';
      chip.appendChild(img);
    } else {
      const dot = document.createElement('span');
      dot.className = 'participant-dot';
      dot.style.background = nameColor(name);
      chip.appendChild(dot);
    }

    const label = document.createElement('span');
    label.className = 'participant-chip-name';
    label.textContent = name;
    if (isDj) {
      const badge = document.createElement('span');
      badge.className = 'participant-chip-dj';
      badge.textContent = 'DJ';
      label.appendChild(badge);
    }
    chip.appendChild(label);

    if (hostCanToggle) {
      chip.addEventListener('click', () => window.onigiri.toggleDj(name));
    }
    dock.appendChild(chip);
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
  $('#setting-background-url').value = config.backgroundUrl;
  $('#setting-blur-amount').value = config.backgroundBlur ?? 24;
  $('#blur-amount-label').textContent = `${config.backgroundBlur ?? 24}px`;
  $('#setting-parallax').checked = config.backgroundParallax !== false;
  refreshAppearanceButtons();
  $('#setting-avatar-url').value = config.avatarUrl;
  $('#setting-dir').value = config.downloadDir;
  $('#setting-webhook').value = config.webhookUrl;
  $('#setting-supabase-url').value = config.supabaseUrl;
  $('#setting-supabase-key').value = config.supabaseKey;
  const path = await window.onigiri.getEmotesPath();
  $('#emotes-file-path').textContent = path;
  renderCustomEmojiList();
  $('#settings-nav').querySelectorAll('.settings-nav-item').forEach((b, i) => b.classList.toggle('is-active', i === 0));
  $('.settings-panels').querySelectorAll('.settings-panel').forEach((p) => { p.hidden = p.dataset.panel !== 'appearance'; });
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
        backgroundUrl: $('#setting-background-url').value.trim(),
        backgroundBlur: parseInt($('#setting-blur-amount').value, 10),
        backgroundParallax: $('#setting-parallax').checked,
        downloadDir: $('#setting-dir').value.trim(),
        webhookUrl: $('#setting-webhook').value.trim(),
        supabaseUrl: $('#setting-supabase-url').value.trim(),
        supabaseKey: $('#setting-supabase-key').value.trim()
      });
      config = await window.onigiri.getConfig();
      applyAppearance();
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
