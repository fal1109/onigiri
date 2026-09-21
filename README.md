

# onigiri
watch together app that downloads the videos so no one suffers from internet lag hopefully

## requirement

1. **yt-dlp** — the app shells out to it to download videos from a link.
   - Linux: `sudo apt install yt-dlp` (or `pip install -U yt-dlp`)
   - Windows: download `yt-dlp.exe` from https://github.com/yt-dlp/yt-dlp/releases
     and put it somewhere on your `PATH` (or next to the app).
2. **ffmpeg** — needed by yt-dlp to merge separate video/audio streams into
   one file.
   - Linux: `sudo apt install ffmpeg`
   - Windows: https://www.gyan.dev/ffmpeg/builds/ (add the `bin` folder to `PATH`)


### the app is still in development, expect bugs

## THIS IS AI SLOP. I MADE THIS FOR A GROUP OF FRIENDS AND YOU CAN DO WHATEVER YOU WANT WITH IT.


## Install & run

```bash
npm install
npm start
```

## One-time setup: supabase

everything is managed by supabase [timestamps, play/pause, participants etc.]. every participant needs to have the same set of project url and anon key. one person making it will do, the rest can copy it from the host and they can use it to host and join rooms [limited to that project that is]

1. Go to https://supabase.com, sign up, and create a new project.
2. Once it's ready, go to **Project Settings → API**.
3. Copy the **Project URL** and the **`anon` `public`** key.
4. In Onigiri, open **Settings** (gear icon) and paste both in.
5. Share those same two values with everyone who'll be in your rooms (a
   pinned message works fine — the anon key is meant to be used from
   client apps, it can't read or change anything by itself).


## Using it

**Host:**
1. Enter your name and click **Create room**. You'll get a short room code
   (e.g. `K7P2Q9`).
2. Share that code with friends — that's all they need, no address or port.
3. Paste a video link into the bar under the player and click **Add to
   queue** — first item added starts playing automatically. Everyone in the
   room (including people who join later) downloads their own local copy of
   whatever's currently playing, automatically.
4. Press play. Everyone's playback follows yours.

**Everyone else:** click **Join a room**, enter the code, and you're in —
you'll immediately start downloading whatever's currently playing and land
at the right timestamp. Anyone in the room can add to the queue, not just
the host, and anyone can jump to a different queued item or remove one.

### Queue

Click **Queue** (next to Add to queue) to see what's up next. Each item
shows its status — downloading, pre-loading, ready, now playing, or failed —
with buttons to jump to it immediately or remove it. Whatever's one slot
ahead of the current item downloads quietly in the background while you
watch, so skipping ahead (the ⏭ button, or jumping to any item) is usually
instant instead of waiting on a fresh download.

If a download fails for you specifically (a dead link, a site blocking your
IP, etc.) — it only affects you. The failed item gets a **Failed** badge and
a retry button; everyone else keeps watching normally.

### Playback control & DJs

By default, only the host can actually control playback (play/pause/seek/
skip) — everyone else is a passive viewer with no controls on their player
at all. The host can promote specific people to **DJ** by clicking their
chip in the participants list (top bar), which gives them the same control.
Click again to revoke it. Queue management (adding/removing/jumping to a
link) stays open to everyone regardless of DJ status — only playback state
itself is gated.

### Participants

Shown in the top bar, just left of Settings, as small avatar/color-dot
chips — hover one to see their name. If you're the host, click a chip to
toggle that person's DJ status.

### Chat

Chat lives right on the video, bottom-left, like a stream-party overlay —
it never covers most of the screen. Recent messages are always visible;
press **Enter** anywhere (outside a text field) to reveal the message box
right below them, type, **Enter** to send, **Esc** to hide the box again
(the message log itself stays visible either way). You'll see a "so-and-so
is typing…" indicator while others are composing a message. The first time
you ever join a room, a small one-time hint appears over the top of the
video reminding you to press Enter — it won't show again after that.

### Emotes

Press **Ctrl+E** to open the emote tray, **Tab** to cycle through it,
**Enter** to send the highlighted one — your own custom emotes are listed
first, ahead of the built-ins. The emoji-face icon next to the chat box
opens the same tray to click through instead.
=======

### Emotes

ctrl+e opens the emote picker


Add your own in Settings → *Custom emotes* (name in the left box, image
link in the right) or hand-edit the emotes file directly — its path is
shown right there in Settings, and there's a *reload from file* link to
pick up your edits without restarting the app. It's a plain JSON array:

```json
[
  { "name": "myemote", "url": "https://example.com/myemote.png" }
]
```


Custom emotes show up correctly for *everyone* in the room when you send
one — not just people who've added the same emote locally — since the app
just recognizes "this whole message is an image link" and renders it
inline, regardless of whose custom set it came from.

### Appearance

Settings → *Appearance* is its own section now (Settings is split into a
left-hand list of sections rather than one long page):

- **Theme** — Dark or Light, an explicit toggle rather than following the OS.
- **Color theme** — eight presets to click through (Asuka, the original
  color; Lilith; Sartre; Fouco; Kallen; Green; Morphean Paradox; Miku), or
  bring your own by importing a flat JSON file of hex colors:
  ```json
  { "--md-primary": "#B3401F", "--md-primary-container": "#FFDBCF" }
  ```
  Recognized keys: `--md-primary`, `--md-on-primary`, `--md-primary-container`,
  `--md-on-primary-container`, `--md-secondary`, `--md-on-secondary`,
  `--md-tertiary`, `--md-on-tertiary`. Each preset is really just one seed
  color — every other color (surfaces, the settings modal, the top/bottom
  bars, the cookie mascot) is derived from it automatically, and adapts if
  you also switch Dark/Light. An imported JSON theme only overrides the
  accent tokens above, same as before — it won't recolor surfaces.
  *Reset to default* clears back to the plain built-in look.
- **Background image URL** — sets a background on the home screen, shown
  blurred behind the cards so they stay readable over any image. Leave it
  blank and a rotating cookie mascot shows in the corner instead — the two
  are mutually exclusive, and both update live as you type/adjust, not only
  after hitting Save.
- **Background blur** — how strong that blur is, 0–50px.
- **Cursor-based parallax** — the background shifts slightly opposite your
  cursor while you're on the home screen. Only does anything when a
  background image is actually set.

### Discord logging

### Discord logging [optional]


Open **Settings** (gear icon, top right) and paste a Discord webhook URL.
To get one: in Discord, go to the target channel → *Edit Channel* → *Integrations*
→ *Webhooks* → *New Webhook* → *Copy Webhook URL*. Every chat message sent in
the room (including emoji) gets posted there. Only the room's current *host*
process needs the webhook configured — that's who relays chat to Discord.

Emoji in chat are sent as image links, so Discord automatically shows them
as inline image previews, same as in the app.

### Download folder

Defaults to your OS's Videos folder, in an `onigiri` subfolder. Change it any
time from Settings → *Video download folder* → *Browse* (or just type a path
directly into the field).

## How the sync works

- The video file itself is **never sent over the room connection** — each
  participant downloads their own local copy via `yt-dlp`, so playback has no
  streaming latency.
- Everyone connects outbound to Supabase Realtime (no inbound ports needed on
  anyone's machine) and joins a broadcast channel named after the room code.
  Only small JSON messages travel over it: `play`, `pause`, `seek`, the
  queue, DJ list, chat, and typing status.
- The room's video state *is* the queue — a list of links plus which one is
  current. Whoever's connected mirrors that queue locally, so when someone
  joins mid-session, any already-connected peer can answer "here's the
  queue, here's the current time, here's whether it's playing" — there's no
  single point of failure if whoever first created the room has since left.
- Every playback event carries the id of the video it's for. If your player
  is showing a different video than whoever sent the event (say, their
  download of the current one failed and they're stuck on an old one), it's
  silently ignored — one person's stuck download can't drag everyone else's
  timestamp around.
- Chat is relayed to Discord only by whoever's hosting the room, so you don't
  get duplicate posts if multiple people have a webhook configured.
