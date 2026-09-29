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
const downloadingUrls = new Set(); // multiple downloads can overlap now that queueing stays live
let foregroundUrl = null; // download currently driving the player
let downloadError = null; // { itemId, url, message } — local to this client only
const progressByUrl = new Map(); // url -> latest percent from yt-dlp
const predownloadedPaths = new Map(); // url -> local file path, ready to use instantly
const predownloadingUrls = new Set();
const failedPrefetchUrls = new Set(); // urls that already failed a background prefetch — skipped, not retried in a loop
let activeUploadPath = null; // file currently uploading to litterbox
let isCurrentItemLocal = false; // player is showing a user-picked local file instead of the download
// Captions: tracks probed from the loaded file via ffprobe. The CC button
// only exists while captionTracks is non-empty (no captions → no button).
let captionTracks = [];
let captionTrackIndex = -1; // -1 = off
let captionTrackEl = null; // the <track> element currently attached to the player
let currentLocalVideoPath = null; // file backing the player right now
const captionTempUrls = new Map(); // trackId -> blob: URL of extracted WebVTT
let captionProbeToken = 0;
let captionApplyToken = 0;
let roomQueue = [];
let roomQueueIndex = -1;
let typingUsers = new Set();
let typingStopTimer = null;
let djUsernames = [];
let lastParticipants = [];

// emoji tray keyboard navigation state (Ctrl+E to open, Tab to cycle)
let councilClicks = 0;
let trayOpen = false;
let trayButtons = [];
let traySelectedIndex = 0;

const $ = (sel) => document.querySelector(sel);
const allEmotes = () => [...BUILTIN_EMOTES, ...customEmotes];
const hasControlPermission = () => amIHost || djUsernames.includes(username);

// Person glyph dropped inside the colored dot for participants without an
// avatar image — gives the dim/bright download state something to read on.
const PERSON_GLYPH = '<svg class="participant-dot-glyph" viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm0 2c-3.3 0-8 1.7-8 5v1h16v-1c0-3.3-4.7-5-8-5Z"/></svg>';

// A video that hasn't finished downloading means the room isn't ready to
// watch — everyone's icon dims until it is (hover lightens it back up).
const isAnyVideoPendingDownload = () => downloadingUrls.size > 0 || predownloadingUrls.size > 0;
function refreshParticipantDimming() {
  const dim = isAnyVideoPendingDownload();
  document.querySelectorAll('#top-participants .participant-chip').forEach((chip) => {
    chip.classList.toggle('is-buffering', dim);
  });
}

// ------------------------------- extras easter eggs -------------------------
// One config object gates everything: easterEggs.enabled is the master
// switch; each feature flag defaults to on when unset. Egg assets (mascot
// pngs, greeting sounds) are packed inside the asar, so the main process
// hands us file:// listings once at startup; the mascot and greeting are
// picked randomly per launch and then stick for the whole session.
const EGG_FEATURES = ['openingSound', 'quotes', 'shiggy'];
// A mascot SET is a character: build/mascots/<id>/ paired with
// build/sounds/<id>/, so the same character greets you with their own
// voice. The legacy flat closet sticker pile is retired from the picker.
// 'random' isn't a real set — it re-rolls the character every launch (and
// every asset reload, e.g. Ctrl+R), so it needs its own branch rather than
// mapping to a folder like a real set id would.
const MASCOT_RANDOM = 'random';
const mascotStyle = () => {
  if (config.mascotStyle === 'cookie') return 'cookie';
  if (config.mascotStyle === MASCOT_RANDOM) return MASCOT_RANDOM;
  // An unknown saved id ('weeb'/'closet', or a deleted set folder) falls
  // back to the first set found on disk; with no sets at all, the cookie.
  if (config.mascotStyle && mascotSets[config.mascotStyle]) return config.mascotStyle;
  return mascotOrder[0] || 'cookie';
};
const roomCodeStyle = () => (config.roomCodeStyle === 'girls' ? 'girls' : 'plain');

const eggFlags = () => ({
  enabled: true, openingSound: true, quotes: true, shiggy: true,
  ...(config.easterEggs || {})
});
let mascotSets = {};      // set id -> { images, sounds } (character folders)
let mascotOrder = [];     // set ids in stable order, for the picker
let eggMascotUrl = null;  // chosen once per launch
// What the decor corner is actually showing: 'cookie', 'random' (a rolled
// character), or a real set id. 'random' and real ids are visually the same
// (a character) — only 'cookie' may ever show the cookie.
let mascotStyleMode = 'cookie';
let eggSoundUrl = null;   // chosen once per launch
let eggQuote = null;       // chosen once per launch
let customQuotes = [];     // loaded from the hand-editable quotes JSON
let digitSprites = {};     // digit-0..9.png urls for the girls room-code chip

const QUOTES = [
  { text: 'imagine showering, cant be me', by: 'rui' }
];

// Quotes live in their own plain JSON file (like the emotes file) so the
// council can add/edit/remove them without touching the app:
//   [{ "text": "…", "by": "rui" }, …]
// Falls back to the built-in list above when the file is missing/empty.
function quotePool() {
  return customQuotes.length ? customQuotes : QUOTES;
}

const pick = (arr) => (arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);

async function loadEggAssets() {
  try {
    const assets = await window.onigiri.getEggAssets();
    mascotSets = assets.sets || {};
    mascotOrder = Object.keys(mascotSets).sort();
  } catch { /* eggs are optional — degrade quietly */ }
  try {
    const digitAssets = await window.onigiri.getDigitAssets();
    digitSprites = digitAssets.digits || {};
  } catch { /* girls chip just falls back to plain text */ }
  // A saved id whose folder disappeared (or the legacy 'closet'/'weeb')
  // gets persisted as the first set actually on disk.
  let resolved = mascotStyle();
  if (resolved === MASCOT_RANDOM && !mascotOrder.length) resolved = 'cookie'; // nothing to roll between
  if (resolved !== 'cookie' && resolved !== MASCOT_RANDOM && !mascotSets[resolved]) {
    resolved = mascotOrder[0] || 'cookie';
    try { config = await window.onigiri.setConfig({ mascotStyle: resolved }); } catch {}
  }
  // The set IS the character: image and sound both come from it, so the
  // opening greeting sounds like the mascot on screen is saying it.
  // 'random' rolls across the real character sets every launch/reload — the
  // cookie is its own explicit picker option and is never part of the roll.
  const set = resolved === 'cookie'
    ? null
    : resolved === MASCOT_RANDOM
      ? mascotSets[pick(mascotOrder)]
      : mascotSets[resolved];
  mascotStyleMode = set ? resolved : 'cookie';
  eggMascotUrl = set ? pick(set.images) : null;
  renderRoomChip();
  // Rotate greetings: never repeat the sound from the previous launch, so
  // every one of them gets heard over time instead of the same lucky pick.
  const pool = set ? set.sounds : [];
  const fresh = pool.filter((s) => s !== config.lastOpeningSound);
  eggSoundUrl = pick(fresh.length ? fresh : pool);
  if (eggSoundUrl && eggSoundUrl !== config.lastOpeningSound) {
    try { config = await window.onigiri.setConfig({ lastOpeningSound: eggSoundUrl }); } catch {}
  }
  syncEggSettings(); // populates the mascot picker from the discovered sets
  applyEasterEggs();
  // The greeting belongs to the app opening, not to joining a room.
  playOpeningSound();
}

// Pull the hand-editable quotes file in; the picker re-rolls so an edit
// shows up next launch (or instantly via the reload button in settings).
async function loadQuotes() {
  try {
    const list = await window.onigiri.getQuotes();
    if (Array.isArray(list)) {
      customQuotes = list
        .filter((q) => q && typeof q.text === 'string' && q.text.trim())
        .map((q) => ({ text: String(q.text), by: String(q.by || 'onigiri') }));
      eggQuote = null; // re-roll from the fresh pool
      applyQuoteEgg();
    }
  } catch { /* quotes are optional — the built-in one covers this */ }
}

// Decor corner of the setup screen. Which mascot shows depends on the
// mascotStyle choice:
//   <set id> — one random image from that character's folder, static
//   'random' — same, but the character itself is re-rolled per launch
//   'cookie' — the original spinning onigiri cookie
// A background image wins unless "show mascot over background" is on.
function applySetupDecorEggs() {
  const cookie = $('#setup-cookie');
  const mascot = $('#setup-cookie-img');
  const egg = eggFlags();
  if (bgActive() && !(egg.enabled && config.mascotOverBackground)) {
    cookie.setAttribute('hidden', '');
    mascot.hidden = true;
    return;
  }
  // A character (specific or random-rolled) is wanted unless the choice is
  // literally the cookie. eggMascotUrl can be briefly null while assets
  // load — that shows an empty corner for a beat rather than flashing the
  // cookie, so the cookie only ever appears when Cookie is the real pick.
  const wantMascot = egg.enabled && mascotStyleMode !== 'cookie';
  if (wantMascot && eggMascotUrl) {
    cookie.setAttribute('hidden', '');
    if (mascot.getAttribute('src') !== eggMascotUrl) mascot.setAttribute('src', eggMascotUrl);
    mascot.hidden = false;
  } else {
    mascot.hidden = true;
    cookie.removeAttribute('hidden');
  }
}

function applyQuoteEgg() {
  const line = $('#quote-line');
  const egg = eggFlags();
  if (!egg.enabled || !egg.quotes) { line.hidden = true; return; }
  if (!eggQuote) eggQuote = pick(quotePool());
  line.textContent = eggQuote ? `${eggQuote.text} -${eggQuote.by}` : '';
  line.hidden = !eggQuote;
}

function applyShiggyEgg() {
  $('#video-empty').classList.toggle('has-egg', eggFlags().enabled && eggFlags().shiggy);
}

// Launch splash: the onigiri logo pops in on a solid, slightly-different
// shade of the themed background, holds for a beat, then the whole sheet
// sweeps off toward the bottom-right corner (its 45° edge traveling from the
// top-left corner down to the bottom-right one) and the layer unmounts. Kept
// entirely theme/CSS-driven so custom themes recolor it for free.
const LAUNCH_SPLASH_HOLD_MS = 900;  // logo visible before the sweep starts
const LAUNCH_SPLASH_SWEEP_MS = 650; // must match the CSS sweep transition
function runLaunchSplash() {
  const splash = document.getElementById('launch-splash');
  if (!splash) return;
  // Wipe once the brand has settled. Prefers visibilitychange over load —
  // style/layout is ready long before images/fonts finish, and the sweep
  // starting the moment the window appears reads better than a fixed delay
  // that can race slow first paint.
  const start = () => setTimeout(() => {
    splash.classList.add('is-wiping');
    setTimeout(() => splash.remove(), LAUNCH_SPLASH_SWEEP_MS + 80);
  }, LAUNCH_SPLASH_HOLD_MS);
  if (document.visibilityState === 'visible') start();
  else document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') start();
  }, { once: true });
}

// Greeting sound — fires once, when the app opens (from loadEggAssets).

function playOpeningSound() {
  const egg = eggFlags();
  if (!egg.enabled || !egg.openingSound || !eggSoundUrl) return;
  try {
    const audio = new Audio(eggSoundUrl);
    audio.volume = 0.5; // subtle — half volume, it's just a greeting
    audio.play().catch(() => {});
  } catch { /* autoplay blocks are non-fatal */ }
}

// Re-apply every egg after a settings change or asset load.
function applyEasterEggs() {
  applySetupDecorEggs();
  applyQuoteEgg();
  applyShiggyEgg();
}

function syncEggSettings() {
  const egg = eggFlags();
  $('#setting-eggs-enabled').checked = !!egg.enabled;
  $('#eggs-feature-list').hidden = !egg.enabled;
  for (const key of EGG_FEATURES) {
    const box = $(`#setting-egg-${key}`);
    if (box) box.checked = egg[key] !== false;
  }
  // Mascot picker: one button per discovered set + Cookie — built from the
  // folders on disk, so future character sets appear with no code change.
  // Random leads the row (only when there's something to be random between).
  const toggle = $('#mascot-style-toggle');
  toggle.innerHTML = '';
  if (mascotOrder.length) {
    const randomBtn = document.createElement('button');
    randomBtn.type = 'button';
    randomBtn.dataset.mascotValue = MASCOT_RANDOM;
    randomBtn.textContent = 'Random';
    toggle.appendChild(randomBtn);
  }
  for (const id of mascotOrder) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.mascotValue = id;
    btn.textContent = id.charAt(0).toUpperCase() + id.slice(1);
    toggle.appendChild(btn);
  }
  const cookieBtn = document.createElement('button');
  cookieBtn.type = 'button';
  cookieBtn.dataset.mascotValue = 'cookie';
  cookieBtn.textContent = 'Cookie';
  toggle.appendChild(cookieBtn);
  const style = mascotStyle();
  toggle.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mascotValue === style);
  });
  // Room-code chip picker (plain pill / sprite girls).
  $('#room-code-style-toggle').querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.codeStyleValue === roomCodeStyle());
  });
  $('#setting-mascot-over-bg').checked = !!config.mascotOverBackground;
}

function wireEggSettings() {
  $('#setting-eggs-enabled').addEventListener('change', async (e) => {
    await window.onigiri.setConfig({ easterEggs: { ...eggFlags(), enabled: e.target.checked } });
    config = await window.onigiri.getConfig();
    syncEggSettings();
    applyEasterEggs();
  });
  $('#setting-mascot-over-bg').addEventListener('change', async (e) => {
    config = await window.onigiri.setConfig({ mascotOverBackground: e.target.checked });
    applyEasterEggs();
  });
  $('#mascot-style-toggle').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-mascot-value]');
    if (!btn) return;
    config = await window.onigiri.setConfig({ mascotStyle: btn.dataset.mascotValue });
    // Switching sets re-rolls the mascot from the new character right away,
    // so the home screen updates instantly. The greeting itself is a launch
    // event — the next opening picks a voice line from the new set. Random
    // re-rolls across the real characters here too, never the cookie.
    const style = mascotStyle();
    const setId = style === 'cookie' ? null : style === MASCOT_RANDOM ? pick(mascotOrder) : style;
    const set = setId ? mascotSets[setId] : null;
    mascotStyleMode = set ? style : 'cookie';
    eggMascotUrl = set ? pick(set.images) : null;
    syncEggSettings();
    applyEasterEggs();
  });
  $('#room-code-style-toggle').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-code-style-value]');
    if (!btn) return;
    config = await window.onigiri.setConfig({ roomCodeStyle: btn.dataset.codeStyleValue });
    syncEggSettings();
    renderRoomChip();
  });
  for (const key of EGG_FEATURES) {
    const box = $(`#setting-egg-${key}`);
    if (!box) continue;
    box.addEventListener('change', async (e) => {
      await window.onigiri.setConfig({ easterEggs: { ...eggFlags(), [key]: e.target.checked } });
      config = await window.onigiri.getConfig();
      applyEasterEggs();
    });
  }
}

// ---------------------------------------------------------------------- init
(async function init() {
  config = await window.onigiri.getConfig();
  customEmotes = await window.onigiri.getEmotes();
  $('#host-username').value = config.username;
  $('#join-username').value = config.username;

  applyAppearance();
  runLaunchSplash();
  buildEmojiTray();
  wireSetup();
  wireRoom();
  wireChat();
  wireCaptions();
  wireSettings();
  wireAppearance();
  wireNetworkEvents();
  wireHealthCheck();
  wireAboutLinks();
  wireAboutVersion();
  wireEggSettings();
  loadEggAssets();
  loadQuotes();
  refreshConfigNotice();

  // Probe the download stack quietly; only surface the checklist when
  // something actually needs fixing (never assume what the user downloads).
  window.onigiri.healthCheck().then((result) => {
    if (!result.allOk) runHealthCheck();
  }).catch(() => {});
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

// Matugen-style tokens derived from an image palette instead of a single
// seed. The accent/secondary/tertiary hexes come from main.js's histogram;
// every surface, container, and outline is regenerated through the same
// HSL generator the preset themes use, so it follows dark/light mode.
function buildImageThemeTokens(palette, mode) {
  const tokens = {};
  const dark = mode !== 'light';
  for (const [key, hex] of [['--md-primary', palette.accent], ['--md-secondary', palette.secondary], ['--md-tertiary', palette.tertiary]]) {
    const seed = buildThemeTokens(hex, dark ? 'dark' : 'light');
    tokens[key] = seed[key];
    tokens[key === '--md-primary' ? '--md-on-primary' : `--md-on-${key.slice(5)}`] = seed[`--md-on-${key.slice(5)}`];
    tokens[`--md-${key.slice(5)}-container`] = seed[`--md-${key.slice(5)}-container`];
    tokens[`--md-on-${key.slice(5)}-container`] = seed[`--md-on-${key.slice(5)}-container`];
  }
  // Surfaces tint toward the accent hue (the palette's dominant character),
  // so the whole app shifts with the image rather than just the buttons.
  const [hue] = hexToHsl(palette.accent);
  const surface = buildThemeTokens(hslToHex(hue, 30, dark ? 40 : 70), mode);
  for (const k of ['--nori', '--md-surface', '--md-surface-dim', '--md-surface-bright',
    '--md-surface-container-lowest', '--md-surface-container-low', '--md-surface-container',
    '--md-surface-container-high', '--md-surface-container-highest',
    '--md-on-surface', '--md-on-surface-variant', '--md-outline', '--md-outline-variant']) {
    tokens[k] = surface[k];
  }
  return tokens;
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

const PRESET_NAMES = {
  asuka: 'Asuka', lilith: 'Lilith', sartre: 'Sartre', fouco: 'Fouco',
  kallen: 'Kallen', green: 'Green', morphean: 'Morphean Paradox', miku: 'Miku'
};

// config.customTheme is either: null (no theme, pure CSS defaults), a seed
// hex string (a preset — regenerated per current dark/light mode), a full
// {--token: value} object (an imported theme JSON, fixed regardless of mode,
// since hand-authored files only cover accent tokens), or { fromBackground:
// …palette } — derived from the background image (feature 2), also
// regenerated per mode.
function applyCustomTheme(theme) {
  const root = document.documentElement;
  THEME_KEYS.forEach((k) => root.style.removeProperty(k));
  if (!theme) return;
  const mode = config.themeMode === 'light' ? 'light' : 'dark';
  const tokens = typeof theme === 'string'
    ? buildThemeTokens(theme, mode)
    : theme && theme.fromBackground
      ? buildImageThemeTokens(theme.fromBackground, mode)
      : theme;
  Object.entries(tokens).forEach(([k, v]) => { if (v) root.style.setProperty(k, v); });
}

// A background shows when a local file is picked and not switched off.
const bgActive = () => !!(config.backgroundFile && config.backgroundEnabled !== false);

function applyAppearance() {
  document.documentElement.dataset.theme = config.themeMode || 'dark';
  applyCustomTheme(config.customTheme);

  const bg = $('#setup-bg');
  // cookie is an <svg> element — SVGElement doesn't reliably support the
  // .hidden IDL property the way HTMLElement does, so setting it directly
  // can silently no-op. setAttribute/removeAttribute always works.
  // backgroundEnabled (Material switch) toggles the image without wiping the file.
  if (bgActive()) {
    bg.style.backgroundImage = `url("${config.backgroundFile}")`;
    bg.style.filter = `blur(${config.backgroundBlur ?? 24}px)`;
    bg.hidden = false;
  } else {
    bg.hidden = true;
  }
  applySetupDecorEggs();
  setBackgroundTransform(0, 0);
}

// scale(1.1) keeps the blurred edges from ever showing the layer's own
// boundary; the translate is the parallax offset (0,0 when disabled/idle).
function setBackgroundTransform(x, y) {
  $('#setup-bg').style.transform = `scale(1.1) translate(${x}px, ${y}px)`;
}

function handleParallaxMouseMove(e) {
  if (!config.backgroundParallax || !bgActive() || $('#setup-view').hidden) return;
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

// The palette swatches are generated: each one is a four-tone Material
// palette circle (primary / primary-container / tertiary / on-primary-container)
// computed from that preset's seed through the same token generator the live
// theme uses — so the swatch always previews what picking it produces.
function renderSchemeSwatches() {
  const wrap = $('#scheme-swatches');
  wrap.innerHTML = '';
  for (const [name, seed] of Object.entries(PRESET_THEMES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scheme-swatch';
    btn.dataset.preset = name;
    btn.title = PRESET_NAMES[name] || name;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', PRESET_NAMES[name] || name);
    wrap.appendChild(btn);
  }
  paintSchemeSwatches();
}

function paintSchemeSwatches() {
  const mode = config.themeMode === 'light' ? 'light' : 'dark';
  $('#scheme-swatches').querySelectorAll('.scheme-swatch').forEach((btn) => {
    const t = buildThemeTokens(PRESET_THEMES[btn.dataset.preset], mode);
    // conic runs clockwise from 12 o'clock: top-right, bottom-right,
    // bottom-left, top-left — matching the reference palette circles.
    btn.style.setProperty('--swatch',
      `conic-gradient(${t['--md-primary-container']} 0 25%, ${t['--md-primary']} 0 50%, ${t['--md-tertiary']} 0 75%, ${t['--md-on-primary-container']} 0)`);
  });
}

// Keeps a range input's CSS --fill-pct in sync with its value so the styled
// track shows the filled portion. Top-level: used by both wireAppearance and
// openSettings.
function syncRangeFill(el) {
  el.style.setProperty('--fill-pct', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
}

function wireAppearance() {
  document.addEventListener('mousemove', handleParallaxMouseMove);
  renderSchemeSwatches();

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
    paintSchemeSwatches(); // palette circles shift with dark/light mode
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
    syncRangeFill(e.target);
    $('#blur-amount-label').textContent = `${e.target.value}px`;
    $('#setup-bg').style.filter = `blur(${e.target.value}px)`;
  });

  // Live preview so the cookie/background swap (and blur) reflect what's
  // picked immediately, rather than only after Save — that mismatch is what
  // made the cookie look like it was wrongly showing "while" a background
  // was set, when really it just hadn't been saved yet.
  $('#background-browse-btn').addEventListener('click', async () => {
    const btn = $('#background-browse-btn');
    btn.disabled = true;
    try {
      const res = await window.onigiri.chooseBackgroundImage();
      if (res.canceled) return;
      if (!res.ok) { toast(res.error || "Couldn't open the file picker — type the path in manually instead."); return; }
      $('#setting-background-file').value = res.url;
      const bg = $('#setup-bg');
      bg.style.backgroundImage = `url("${res.url}")`;
      bg.hidden = false;
      applySetupDecorEggs();
    } catch (err) {
      toast(err.message || "Couldn't open the file picker.");
    } finally {
      btn.disabled = false;
    }
  });

  $('#background-clear-btn').addEventListener('click', () => {
    $('#setting-background-file').value = '';
    const bg = $('#setup-bg');
    bg.style.backgroundImage = '';
    bg.hidden = true;
    applySetupDecorEggs();
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

  // Room codes are digits only — strip anything else as it's typed.
  $('#join-code').addEventListener('input', (e) => {
    const digits = e.target.value.replace(/\D+/g, '').slice(0, 6);
    if (digits !== e.target.value) e.target.value = digits;
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

// The room-code chip. Two styles, picked by the "roomCodeStyle" config
// (toggle lives in Settings → Extras): 'plain' is a rounded text pill,
// "Room code: 123456" when hosting, "In room: 123456" when joining; 'girls'
// spells the code in digit-sign sprites (one girl per code character;
// redrawn whenever the assets load, the style flips, or a new code is set).
// Click still copies the code in both styles.
let currentChipCode = null;
let currentChipText = '';
function setRoomChip(text, code) {
  currentChipCode = code;
  currentChipText = text;
  renderRoomChip();
}
function renderRoomChip() {
  const chip = $('#room-chip');
  const spriteChip = $('#room-chip-sprite');
  const girls = roomCodeStyle() === 'girls' && currentChipCode
    && String(currentChipCode).split('').every((ch) => digitSprites[ch]);
  chip.hidden = girls || !currentChipCode;
  spriteChip.hidden = !girls;
  if (!currentChipCode) return;
  if (girls) {
    spriteChip.title = `Copy room code ${currentChipCode}`;
    spriteChip.innerHTML = '';
    for (const ch of String(currentChipCode)) {
      const img = document.createElement('img');
      img.className = 'room-chip-digit';
      img.alt = ch;
      img.src = digitSprites[ch] || '';
      img.draggable = false;
      spriteChip.appendChild(img);
    }
  } else {
    chip.textContent = currentChipText;
    chip.title = `Copy room code ${currentChipCode}`;
  }
}
async function copyRoomCode() {
  if (!currentChipCode) return;
  try {
    await navigator.clipboard.writeText(currentChipCode);
    toast('Room code copied');
  } catch {
    toast(`Room code: ${currentChipCode}`);
  }
}
$('#room-chip').addEventListener('click', copyRoomCode);
$('#room-chip-sprite').addEventListener('click', copyRoomCode);
async function leaveRoom() {
  await window.onigiri.leaveRoom();
  role = null;
  amIHost = false;
  seenFirstPeersUpdate = false;
  djUsernames = [];
  currentVideoUrl = null;
  currentItemId = null;
  lastKnownSyncedTime = 0;
  downloadingUrls.clear();
  foregroundUrl = null;
  downloadError = null;
  roomQueue = [];
  roomQueueIndex = -1;
  typingUsers = new Set();
  lastParticipants = [];
  predownloadedPaths.clear();
  predownloadingUrls.clear();
  failedPrefetchUrls.clear();
  $('#top-participants').innerHTML = '';
  activeUploadPath = null;
  isCurrentItemLocal = false;
  $('#upload-video-btn').disabled = false;

  const video = $('#player');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.controls = false;
  currentLocalVideoPath = null;
  refreshCaptionTracks(null);
  $('#video-empty').querySelector('p').textContent = 'Add a video to start';
  $('#video-empty').style.display = 'flex';

  fadeTimers.forEach((t) => clearTimeout(t));
  fadeTimers.clear();
  $('#chat-log').innerHTML = '';
  closeChatInput();
  $('#queue-panel').hidden = true;
  $('#room-chip').hidden = true;
  $('#room-chip-sprite').hidden = true;
  currentChipCode = null;
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
    updatePlayerControlsVisibility();
  });
  video.addEventListener('pause', () => {
    if (suppressPlayerEvents) return;
    if (!hasControlPermission()) { video.play().catch(() => {}); return; } // revert
    window.onigiri.sendPlayerEvent('pause', video.currentTime, currentItemId);
    refreshBarVisibility();
    updatePlayerControlsVisibility();
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
  video.addEventListener('playing', updatePlayPauseIcon);
  video.addEventListener('pause', updatePlayPauseIcon);
  video.addEventListener('play', updatePlayerControlsVisibility);
  video.addEventListener('pause', updatePlayerControlsVisibility);
  wirePlayerControls();
  document.addEventListener('mousemove', (e) => refreshBarVisibility(e.clientY));
  $('.video-wrap').addEventListener('mousemove', showPlayerControls);

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

  // Upload → litterbox (12h expiry, 6-char anonymous name, 1 GiB cap).
  $('#upload-video-btn').addEventListener('click', async () => {
    if (activeUploadPath) { toast('Already uploading a video — hang on.'); return; }
    const filePath = await window.onigiri.chooseLocalVideo();
    if (!filePath) return;
    activeUploadPath = filePath;
    $('#upload-video-btn').disabled = true;
    toast('Uploading to litterbox (expires in 12h)…');
    try {
      const url = await window.onigiri.uploadVideo(filePath);
      // There's no point downloading what we just uploaded: register the
      // local file as "already on disk" BEFORE the link enters the queue, so
      // the load pipeline plays it instantly from disk instead of fetching
      // the litterbox link. Everyone else (and future joiners) downloads it
      // through the queue as usual.
      predownloadedPaths.set(url, filePath);
      await window.onigiri.queueAdd(url);

      // Give the queue-update echo a beat to land, then decide how to show it.
      await new Promise((r) => setTimeout(r, 250));
      if (roomQueue[roomQueueIndex]?.url === url) {
        // The upload became the room's current video — the pipeline already
        // put our local copy on screen, and room sync applies as usual.
        toast('Upload complete — playing from your copy');
      } else {
        // The room is watching something else: open the upload locally for
        // this viewer without touching the room's playback. Detached from
        // sync (currentItemId = null) so remote play/pause/seek events for
        // the room's video can't hijack the preview; when the queue reaches
        // the link later, it plays from this same local copy and rejoins.
        setLocalVideo(filePath);
        currentItemId = null;
        noteWatchStart(null);
        $('#player').play().catch(() => {});
        toast('Upload complete — link added to the queue');
      }
    } catch (err) {
      toast(`Upload failed: ${err.message}`);
    } finally {
      activeUploadPath = null;
      $('#upload-video-btn').disabled = false;
    }
  });

  let lastUploadPercentShown = -1;
  window.onigiri.onUploadProgress(({ filePath, percent }) => {
    if (filePath !== activeUploadPath) return;
    // Toasts are re-created on every call — only refresh when the rounded
    // percent actually changes, not on every 64 KiB chunk.
    const rounded = Math.round(percent);
    if (rounded !== lastUploadPercentShown && percent < 99) {
      lastUploadPercentShown = rounded;
      toast(`Uploading… ${rounded}%`);
    }
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

  window.onigiri.onVideoProgress(({ percent, url }) => {
    if (!url) return;
    progressByUrl.set(url, percent);
    refreshParticipantDimming(); // download state changed → icon brightness
    // Update this video's own bar in place if it's rendered; otherwise
    // (re)render the list so a just-started download grows its bar.
    for (const el of document.querySelectorAll('.queue-item-progress')) {
      if (el.dataset.url === url) {
        el.querySelector('.queue-item-progress-fill').style.width = `${percent}%`;
        // Keep the item's live percent label in step with its bar.
        const badge = el.closest('.queue-item')?.querySelector('.queue-item-badge');
        if (badge?.dataset.downloadLabel) badge.textContent = `${badge.dataset.downloadLabel} ${Math.round(percent)}%`;
        return;
      }
    }
    if (downloadingUrls.has(url)) renderQueueList();
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

  // Preserve each in-flight bar's live DOM element across re-renders so the
  // CSS width transition runs smoothly instead of restarting on every update.
  const liveBars = new Map();
  for (const el of list.querySelectorAll('.queue-item-progress')) liveBars.set(el.dataset.url, el);

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
    if (downloadingUrls.has(item.url)) {
      badge.dataset.downloadLabel = 'Downloading —';
      badge.textContent = `${badge.dataset.downloadLabel} ${Math.round(progressByUrl.get(item.url) ?? 0)}%`;
    }
    else if (failed) badge.textContent = 'Failed — download only failed for you';
    else if (predownloadingUrls.has(item.url)) {
      badge.dataset.downloadLabel = 'Pre-loading —';
      badge.textContent = `${badge.dataset.downloadLabel} ${Math.round(progressByUrl.get(item.url) ?? 0)}%`;
    }
    else if (idx === roomQueueIndex) badge.textContent = 'Now playing';
    else if (predownloadedPaths.has(item.url)) badge.textContent = 'Ready';

    const actions = document.createElement('div');
    actions.className = 'queue-item-actions';

    const isDownloading = downloadingUrls.has(item.url) || predownloadingUrls.has(item.url);

    // While a download runs, the user can bail out of it by picking a file
    // they already have — open-file icon sits to the left of the percentage
    // bar, per the v1.5 spec. Also offered while the download is merely
    // failed (nothing in flight to cancel, but the swap still makes sense).
    if (isDownloading || failed) {
      const localBtn = document.createElement('button');
      localBtn.type = 'button';
      localBtn.title = 'Use a video already on this device instead';
      localBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2Z"/></svg>';
      localBtn.addEventListener('click', () => playLocalInstead(item));
      actions.appendChild(localBtn);
    }

    // Every item gets its own progress bar — shown while downloading,
    // hidden otherwise (retry sits to its right when failed).
    if (isDownloading) {
      const bar = liveBars.get(item.url) || document.createElement('div');
      bar.className = 'queue-item-progress';
      bar.dataset.url = item.url;
      bar.innerHTML = '<div class="queue-item-progress-track"><div class="queue-item-progress-fill"></div></div>';
      bar.querySelector('.queue-item-progress-fill').style.width = `${progressByUrl.get(item.url) ?? 0}%`;
      actions.appendChild(bar);
    }

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

    // Copy the source link so the video can be grabbed with an external
    // downloader or archived — works for every item in the queue.
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.title = 'Copy video link';
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1Zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2Zm0 16H8V7h11v14Z"/></svg>';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.url);
        toast('Link copied');
      } catch {
        toast(item.url); // clipboard blocked — at least show it
      }
    });
    actions.appendChild(copyBtn);

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

let prefetchChainActive = false;

async function predownloadNext() {
  // Playlist mode: work through the queue ahead of the playhead one video at
  // a time, so everything is (nearly) local before its turn comes up. Links
  // that already failed a prefetch are remembered and skipped rather than
  // retried forever — if one becomes current, loadVideo surfaces the real
  // error through the normal foreground path. The chain flag keeps the many
  // queue-update triggers from stacking parallel downloads.
  if (prefetchChainActive) return;
  const start = Math.max(roomQueueIndex + 1, 0);
  let nextItem = null;
  for (let i = start; i < roomQueue.length; i++) {
    const it = roomQueue[i];
    if (predownloadedPaths.has(it.url) || predownloadingUrls.has(it.url) || downloadingUrls.has(it.url) || failedPrefetchUrls.has(it.url)) continue;
    nextItem = it;
    break;
  }
  if (!nextItem) return;
  prefetchChainActive = true;
  predownloadingUrls.add(nextItem.url);
  progressByUrl.set(nextItem.url, 0);
  renderQueueList();
  try {
    const { filePath } = await window.onigiri.downloadVideo(nextItem.url);
    predownloadedPaths.set(nextItem.url, filePath);
  } catch {
    failedPrefetchUrls.add(nextItem.url);
  } finally {
    predownloadingUrls.delete(nextItem.url);
    prefetchChainActive = false;
    renderQueueList();
    // The timeout re-reads the (possibly edited) queue before continuing.
    setTimeout(() => { if (roomQueue.length) predownloadNext(); }, 250);
  }
}

async function loadVideo(url, itemId) {
  if (!url) return;

  const cached = predownloadedPaths.get(url);
  if (cached) {
    downloadError = null;
    setLocalVideo(cached);
    currentItemId = itemId; // only set once the video is ACTUALLY loaded — see wireRoom's player listeners
    noteWatchStart(roomQueue.find((q) => q.id === itemId));
    toast('Video ready');
    renderQueueList();
    return;
  }

  downloadingUrls.add(url);
  foregroundUrl = url;
  downloadError = null;
  progressByUrl.set(url, 0);
  renderQueueList();
  toast('Downloading video…');
  try {
    const { filePath } = await window.onigiri.downloadVideo(url);
    if (url !== foregroundUrl) {
      // The user moved on to a different video while this downloaded — don't
      // stomp the player (or its progress bar) with a stale completion.
      predownloadedPaths.set(url, filePath);
      return;
    }
    predownloadedPaths.set(url, filePath);
    setLocalVideo(filePath);
    currentItemId = itemId;
    noteWatchStart(roomQueue.find((q) => q.id === itemId));
    toast('Video ready');
  } catch (err) {
    if (url !== foregroundUrl) {
      // Stale failure for a video the user already moved on from — the queue
      // badge shows the error; no toasts or empty-state overwrites needed.
      downloadError = { itemId, url, message: err.message };
      renderQueueList();
      return;
    }
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
    downloadingUrls.delete(url);
    renderQueueList();
    if (url === foregroundUrl) foregroundUrl = null;
  }
}

// Swap a queue item's video for one already on this device: cancels the
// running/partial download (deleting its .part file), then plays the local
// file for THIS viewer only — everyone else keeps syncing off the queue item.
async function playLocalInstead(item) {
  let filePath;
  try {
    filePath = await window.onigiri.chooseLocalVideo();
  } catch (err) {
    toast(err.message || "Couldn't open the file picker.");
    return;
  }
  if (!filePath) return;

  // Roommates are still waiting on the download — the source URL stays
  // broadcast as-is; we just detach this client's player from it. For the
  // current item, currentVideoUrl keeps pointing at the queue URL, so a
  // redundant queue-update for it won't re-trigger a download here, while
  // moving to a different item still loads normally.
  if (downloadingUrls.has(item.url) || predownloadingUrls.has(item.url)) {
    try { await window.onigiri.cancelDownload(item.url); } catch { /* best effort */ }
  }
  downloadingUrls.delete(item.url);
  predownloadingUrls.delete(item.url);
  if (foregroundUrl === item.url) foregroundUrl = null;
  setLocalVideo(filePath);
  currentItemId = item.id;
  // Not watching a downloaded file — suspend auto-delete bookkeeping so a
  // locally-played 'ended' can't delete the room's copy mid-download.
  noteWatchStart(null);
  downloadError = null;
  renderQueueList();
  toast('Playing your local copy — the room download continues untouched.');
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
  currentLocalVideoPath = filePath;
  refreshCaptionTracks(filePath);
}

// ----------------------------------------------------------------- captions
// Probes the loaded file for embedded subtitle tracks. Empty result → the CC
// button stays hidden entirely (per spec: don't show it when there are no
// captions). Runs after every video swap; the token guards against a slow
// probe answering after the next video already loaded.
async function refreshCaptionTracks(filePath) {
  const token = ++captionProbeToken;
  captionTracks = [];
  captionTrackIndex = -1;
  if (captionTrackEl) { captionTrackEl.remove(); captionTrackEl = null; }
  updateCcButton();
  if (!filePath) return;
  try {
    const tracks = await window.onigiri.getSubtitleTracks(filePath);
    if (token !== captionProbeToken) return; // another video took over
    captionTracks = Array.isArray(tracks) ? tracks : [];
    updateCcButton();
  } catch { /* ffprobe unavailable → no captions UI, downloads still work */ }
}

function updateCcButton() {
  const btn = $('#cc-btn');
  if (!captionTracks.length) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.classList.toggle('is-active', captionTrackIndex !== -1);
  btn.title = captionTrackIndex === -1
    ? 'Captions off'
    : `Captions: ${captionTracks[captionTrackIndex].label}`;
}

// Cycles off → track 1 → track 2 → … → off on repeated clicks.
async function cycleCaptionTrack() {
  if (!captionTracks.length) return;
  let next = captionTrackIndex + 1;
  if (next >= captionTracks.length) next = -1;
  await applyCaptionTrack(next);
}

async function applyCaptionTrack(index) {
  const token = ++captionApplyToken;
  const video = $('#player');
  if (captionTrackEl) { captionTrackEl.remove(); captionTrackEl = null; }
  captionTrackIndex = index;
  if (index === -1 || !captionTracks[index]) {
    updateCcButton();
    return;
  }
  const track = captionTracks[index];
  try {
    // Extraction (ffmpeg → WebVTT temp file) is cached in the main process,
    // so revisiting a track this session is instant.
    let url = captionTempUrls.get(track.id);
    if (!url) {
      // Main process returns raw WebVTT text; a blob URL sidesteps
      // Chromium's cross-origin restrictions on file:// subtitle loads.
      const vttText = await window.onigiri.extractSubtitle(currentLocalVideoPath, track.id);
      url = URL.createObjectURL(new Blob([vttText], { type: 'text/vtt' }));
      captionTempUrls.set(track.id, url);
    }
    if (token !== captionApplyToken) return; // user kept cycling mid-extract
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = track.label;
    if (track.lang) el.srclang = track.lang;
    el.src = url;
    el.default = true;
    video.appendChild(el);
    captionTrackEl = el;
  } catch (err) {
    if (token === captionApplyToken) {
      captionTrackIndex = -1;
      toast(`Couldn't load captions: ${err.message}`);
    }
  }
  updateCcButton();
}

function wireCaptions() {
  $('#cc-btn').addEventListener('click', cycleCaptionTrack);
}

// Auto-delete bookkeeping: tell the main process which queue item is on
// screen (so "after watching" deletion can find the file) and reset the
// local flag whenever a downloaded video finishes loading.
function noteWatchStart(item) {
  isCurrentItemLocal = !item;
  window.onigiri.watchStart(item ? item.url : null).catch(() => {});
}

function wireWatchTracking() {
  const video = $('#player');
  video.addEventListener('ended', () => {
    window.onigiri.watchDone().catch(() => {});
  });
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

  wireWatchTracking();

  window.onigiri.onTyping(({ username: who }) => {
    if (who === username) return;
    typingUsers.add(who);
    renderTypingIndicator();
  });
  window.onigiri.onTypingStop(({ username: who }) => clearTyping(who));
}

// Unique-ish name colors: hsl(hue) from a string hash collides constantly
// ("rui" and "fal" both landed on the same hue), so this mixes the name
// through FNV-1a plus a murmur3-style avalanche finalizer — every input bit
// spreads across all 32 output bits, which the old polynomial hash never did
// for short names. Same name always gets the same color.
function nameColor(name) {
  let hash = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0; // FNV prime
  }
  // murmur3 32-bit finalizer — full avalanche so short names spread too.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0; // >>> 0: ^ returns a SIGNED int32
  // Hue from the whole hash, saturation/lightness from independent bits —
  // so even two names that land near the same hue stay visually distinct.
  const hue = hash % 360;
  const sat = 45 + ((hash >>> 7) % 30);   // 45–75% — colorful but never neon
  const lig = 60 + ((hash >>> 14) % 18);  // 60–78% — readable on the dark bubble
  return `hsl(${hue}, ${sat}%, ${lig}%)`;
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
  updatePlayerControlsVisibility();
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updatePlayPauseIcon() {
  const video = $('#player');
  const playIcon = $('#play-icon');
  const pauseIcon = $('#pause-icon');
  if (video.paused) {
    playIcon.removeAttribute('hidden');
    pauseIcon.setAttribute('hidden', '');
  } else {
    playIcon.setAttribute('hidden', '');
    pauseIcon.removeAttribute('hidden');
  }
  $('#player-seek-track').classList.toggle('is-playing', !video.paused); // added
}


function updateSeekUi() {
  const video = $('#player');
  const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
  $('#player-seek-fill').style.width = `${pct}%`;
  $('#player-seek-marker').style.left = `${pct}%`;
  $('#player-time-current').textContent = formatTime(video.currentTime);
  $('#player-time-duration').textContent = formatTime(video.duration);
}

const PLAYER_CONTROLS_HIDE_DELAY = 1600;
let playerControlsHideTimer = null;

function showPlayerControls() {
  const videoWrap = $('.video-wrap');
  videoWrap.classList.remove('player-controls-hidden');
  clearTimeout(playerControlsHideTimer);
  if (!$('#player').paused) {
    playerControlsHideTimer = setTimeout(() => {
      videoWrap.classList.add('player-controls-hidden');
    }, PLAYER_CONTROLS_HIDE_DELAY);
  }
}

function updatePlayerControlsVisibility() {
  if ($('#player').paused) {
    clearTimeout(playerControlsHideTimer);
    $('.video-wrap').classList.remove('player-controls-hidden');
    return;
  }
  showPlayerControls();
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
  const isMuted = video.muted || video.volume === 0;
  $('#volume-ring').style.setProperty('--vol-pct', isMuted ? 0 : volumeToSlider(video.volume));
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
    if (video.paused) {
      video.play().then(updatePlayPauseIcon).catch(updatePlayPauseIcon);
    } else {
      video.pause();
      updatePlayPauseIcon();
    }
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

  $('#volume-ring').addEventListener('click', () => {
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = sliderToVolume(16); // unmuting from 0 should be audible
  });

  $('#volume-ring').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) video.volume = sliderToVolume(16);
  });

  $('#volume-ring').addEventListener('wheel', (e) => {
    e.preventDefault();
    const current = video.muted ? 0 : volumeToSlider(video.volume);
    video.muted = false;
    video.volume = sliderToVolume(Math.min(100, Math.max(0, current + (e.deltaY < 0 ? 4 : -4))));
  }, { passive: false });

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
    chip.className = 'participant-chip' + (hostCanToggle ? ' is-host-controllable' : '') + (isAnyVideoPendingDownload() ? ' is-buffering' : '');
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
      dot.innerHTML = PERSON_GLYPH; // icon placeholder so the state reads
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
  refreshParticipantDimming();
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
    // Message sent — close the input right away. No more "press Space/Escape
    // to get out"; the next Enter reopens it.
    closeChatInput();
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
    closeChatInput(); // sent an emote → back to watching, same as typing one
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
  try {
    config = await window.onigiri.getConfig();
    customEmotes = await window.onigiri.getEmotes();
    $('#setting-background-file').value = config.backgroundFile || '';
    $('#setting-bg-theming').checked = config.backgroundTheming !== false;
    $('#setting-blur-amount').value = config.backgroundBlur ?? 24;
    syncRangeFill($('#setting-blur-amount'));
    $('#blur-amount-label').textContent = `${config.backgroundBlur ?? 24}px`;
    $('#setting-parallax').checked = config.backgroundParallax !== false;
    refreshAppearanceButtons();
    $('#setting-avatar-url').value = config.avatarUrl;
    $('#setting-dir').value = config.downloadDir;
    refreshQualityButtons();
    refreshAutoDeleteButtons();
    $('#setting-bg-enabled').checked = config.backgroundEnabled !== false;
    $('#bg-switch-label').textContent = config.backgroundEnabled !== false ? 'Show background image' : 'Background image hidden';
    $('#setting-webhook').value = config.webhookUrl;
    $('#setting-supabase-url').value = config.supabaseUrl;
    $('#setting-supabase-key').value = config.supabaseKey;
    const rpc = config.discordRpc || {};
    $('#setting-rpc-enabled').checked = !!rpc.enabled;
    $('#setting-rpc-participants').checked = rpc.showParticipants !== false;
    $('#setting-rpc-github').checked = rpc.showGithubButton !== false;
    const path = await window.onigiri.getEmotesPath();
    $('#emotes-file-path').textContent = path;
    renderCustomEmojiList();
    // The Extras nav item only exists for those who earned it.
    $('#settings-nav .settings-nav-item--council').hidden = !config.councilUnlocked;
    syncEggSettings();
    showSettingsPanel('appearance');
  } finally {
    // The dialog must ALWAYS open, even if one optional control above failed
    // to populate — a dead settings button is worse than a half-filled panel.
    $('#settings-dialog').hidden = false;
  }
}

function showSettingsPanel(panelName) {
  $('#settings-nav').querySelectorAll('.settings-nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.panel === panelName));
  $('.settings-panels').querySelectorAll('.settings-panel').forEach((p) => { p.hidden = p.dataset.panel !== panelName; });
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

  // background-image on/off switch (keeps the picked file)
  $('#setting-bg-enabled').checked = config.backgroundEnabled !== false;
  $('#setting-bg-enabled').addEventListener('change', async (e) => {
    try {
      await window.onigiri.setConfig({ backgroundEnabled: e.target.checked });
      config = await window.onigiri.getConfig();
      applyAppearance();
      const label = $('#bg-switch-label');
      label.textContent = e.target.checked ? 'Show background image' : 'Background image hidden';
      toast(e.target.checked ? 'Background shown' : 'Background hidden — image kept');
    } catch (err) {
      toast(err.message);
    }
  });

  // "Match theme to background": derives the app palette from the picked
  // image (matugen-style) and stores it as customTheme = { fromBackground }.
  // Any preset/import/reset just writes a different customTheme, so the
  // sources never fight — the switch only controls whether choosing or
  // changing a background re-derives the theme.
  $('#setting-bg-theming').addEventListener('change', async (e) => {
    try {
      const on = e.target.checked;
      await window.onigiri.setConfig({ backgroundTheming: on });
      if (on && bgActive()) {
        const palette = await window.onigiri.getBackgroundPalette(config.backgroundFile);
        if (palette.ok) {
          config = await window.onigiri.setConfig({ customTheme: { fromBackground: palette } });
          applyAppearance();
          paintSchemeSwatches();
        } else {
          toast(palette.error || "Couldn't read colors from that image.");
        }
      } else if (!on && config.customTheme && config.customTheme.fromBackground) {
        config = await window.onigiri.setConfig({ customTheme: null });
        applyAppearance();
        paintSchemeSwatches();
      }
    } catch (err) {
      toast(err.message);
    }
  });

  // Discord RPC toggles — save instantly so they apply without pressing Save
  const rpcKeys = [
    ['setting-rpc-enabled', 'enabled'],
    ['setting-rpc-participants', 'showParticipants'],
    ['setting-rpc-github', 'showGithubButton'],
  ];
  for (const [id, key] of rpcKeys) {
    $(`#${id}`).addEventListener('change', async (e) => {
      try {
        const rpc = { ...(config.discordRpc || {}), [key]: e.target.checked };
        await window.onigiri.setConfig({ discordRpc: rpc });
        config = await window.onigiri.getConfig();
      } catch (err) {
        toast(err.message);
      }
    });
  }

  $('#quality-toggle').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-quality-value]');
    if (!btn) return;
    try {
      await window.onigiri.setConfig({ downloadQuality: btn.dataset.qualityValue });
      config = await window.onigiri.getConfig();
      refreshQualityButtons();
    } catch (err) {
      toast(err.message);
    }
  });

  // Auto-delete saves instantly like the other Downloads toggles — 'watched'
  // deletes a video as soon as it ends, timed options sweep periodically.
  $('#setting-autodelete').addEventListener('change', async (e) => {
    try {
      await window.onigiri.setConfig({ autoDelete: e.target.value });
      config = await window.onigiri.getConfig();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#settings-save').addEventListener('click', async () => {
    const btn = $('#settings-save');
    btn.disabled = true;
    try {
      const pickedUrl = $('#setting-background-file').value.trim();
      const bgChanged = pickedUrl !== (config.backgroundFile || '');
      await window.onigiri.setConfig({
        avatarUrl: $('#setting-avatar-url').value.trim(),
        backgroundFile: pickedUrl,
        backgroundBlur: parseInt($('#setting-blur-amount').value, 10),
        backgroundParallax: $('#setting-parallax').checked,
        downloadDir: $('#setting-dir').value.trim(),
        downloadQuality: config.downloadQuality || 'best',
        autoDelete: config.autoDelete || 'never',
        discordRpc: config.discordRpc || { enabled: false, showParticipants: true, showGithubButton: true },
        webhookUrl: $('#setting-webhook').value.trim(),
        supabaseUrl: $('#setting-supabase-url').value.trim(),
        supabaseKey: $('#setting-supabase-key').value.trim()
      });
      config = await window.onigiri.getConfig();
      applyAppearance();
      // A newly picked image (re)derives the theme from it when theming is
      // on; a cleared one drops the derived theme. Any hand-picked preset
      // or imported theme survives — theming only acts on its own theme.
      if (config.backgroundTheming !== false && bgChanged) {
        if (bgActive()) {
          const palette = await window.onigiri.getBackgroundPalette(config.backgroundFile);
          if (palette.ok) {
            config = await window.onigiri.setConfig({ customTheme: { fromBackground: palette } });
          } else {
            toast(palette.error || "Couldn't read colors from that image.");
          }
        } else if (config.customTheme && config.customTheme.fromBackground) {
          config = await window.onigiri.setConfig({ customTheme: null });
        }
      }
      applyAppearance();
      paintSchemeSwatches();
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

function refreshQualityButtons() {
  const current = config.downloadQuality || 'best';
  document.querySelectorAll('#quality-toggle [data-quality-value]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.qualityValue === current);
  });
}

function refreshAutoDeleteButtons() {
  $('#setting-autodelete').value = config.autoDelete || 'never';
}

// Links inside the settings dialog must open in the user's default browser —
// target=_blank alone would spawn a new Electron window.
function wireAboutLinks() {
  for (const a of document.querySelectorAll('.about-site, .about-github, .about-credit-link')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.onigiri.openExternal(a.href);
    });
  }
  // Easter egg: eleven clicks on the tagline unlock the Extras section in
  // settings (v1.6). Persisted, so it's a one-time ceremony.
  $('#about-tagline').addEventListener('click', async () => {
    if (config.councilUnlocked) return;
    councilClicks += 1;
    if (councilClicks < 11) return;
    config = await window.onigiri.setConfig({ councilUnlocked: true });
    $('#settings-nav .settings-nav-item--council').hidden = false;
    showSettingsPanel('council');
  });
}

// --- About panel: version number + update check against GitHub releases ----
// The tag on the latest published release is compared against the running
// app's version (package.json → app.getVersion() in main.js).
function wireAboutVersion() {
  const status = $('#update-status');
  const setStatus = (text, cls = '', link = null) => {
    status.textContent = text;
    status.className = ('about-update-status ' + cls).trim();
    status.querySelectorAll('button').forEach((b) => b.remove());
    if (link) {
      const a = document.createElement('button');
      a.type = 'button';
      a.className = 'link-btn';
      a.textContent = link.text;
      a.addEventListener('click', () => window.onigiri.openExternal(link.url));
      status.appendChild(document.createTextNode(' '));
      status.appendChild(a);
    }
  };

  const check = async () => {
    setStatus('Checking for updates…');
    try {
      const res = await window.onigiri.checkForUpdates();
      if (!res.ok) return setStatus(`Couldn't check for updates — ${res.error}`, 'is-error');
      if (res.updateAvailable) return setStatus(`New version available: v${res.latest}`, 'is-outdated', { text: 'See release', url: res.releaseUrl });
      if (!res.latest) return setStatus(res.message || 'No published releases yet', '');
      setStatus("You're on the latest version", 'is-ok');
    } catch (err) {
      setStatus(`Couldn't check for updates — ${err.message}`, 'is-error');
    }
  };

  window.onigiri.getAppVersion().then((v) => { $('#app-version').textContent = `v${v}`; });
  $('#check-updates-btn').addEventListener('click', check);
  // Also check automatically whenever the About tab is opened.
  document.querySelector('.settings-nav-item[data-panel="about"]').addEventListener('click', check);
}

// ---------------------------------------------------------------------------
// First-run setup check — live probes of everything video downloads need.
// The heavy lifting lives in main.js (health:check); this renders it.
// ---------------------------------------------------------------------------
function wireHealthCheck() {
  $('#health-rerun').addEventListener('click', runHealthCheck);
  $('#health-done').addEventListener('click', () => { $('#health-dialog').hidden = true; });
  $('#health-dialog').addEventListener('click', (e) => {
    if (e.target.id === 'health-dialog') $('#health-dialog').hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#health-dialog').hidden) $('#health-dialog').hidden = true;
  });
  $('#run-setup-check-btn').addEventListener('click', runHealthCheck);
}

async function runHealthCheck() {
  const list = $('#health-list');
  const dialog = $('#health-dialog');
  dialog.hidden = false;
  list.innerHTML = '';

  const rows = ['ytdlp', 'ffmpeg'].map((id) => {
    const row = document.createElement('div');
    row.className = 'health-item is-running';
    row.dataset.id = id;
    row.innerHTML = '<span class="health-dot"></span><div><div class="health-label">' + id + '</div><div class="health-detail">checking…</div></div>';
    list.appendChild(row);
    return row;
  });

  let result;
  try {
    result = await window.onigiri.healthCheck();
  } catch (err) {
    rows.forEach((row) => {
      row.className = 'health-item is-fail';
      row.querySelector('.health-detail').textContent = `check failed: ${err.message}`;
    });
    return;
  }

  for (const item of result.items) {
    const row = rows.find((r) => r.dataset.id === item.id);
    if (!row) continue;
    // warn = works but outdated (yellow); fail = missing/broken (red)
    row.className = `health-item ${item.ok ? (item.warn ? 'is-warn' : 'is-ok') : 'is-fail'}`;
    row.querySelector('.health-label').textContent = item.label;
    row.querySelector('.health-detail').textContent = item.detail;
    if (item.fix && (!item.ok || item.warn)) {
      const fix = document.createElement('div');
      fix.className = 'health-fix';
      fix.textContent = `→ ${item.fix}`;
      row.querySelector('div').appendChild(fix);
    }
  }

  if (result.allOk && !result.items.some((i) => i.warn)) toast('All good — downloads are ready');
}
