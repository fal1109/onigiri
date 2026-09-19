

# onigiri
watch together app that downloads the videos so no one suffers from internet lag hopefully

## requirements

1. **Node.js** ≥ 18 — https://nodejs.org
2. **yt-dlp** — the app shells out to it to download videos from a link.
   - Linux: `sudo apt install yt-dlp` (or `pip install -U yt-dlp`)
   - Windows: download `yt-dlp.exe` from https://github.com/yt-dlp/yt-dlp/releases
     and put it somewhere on your `PATH` (or next to the app).
3. **ffmpeg** — needed by yt-dlp to merge separate video/audio streams into
   one file.
   - Linux: `sudo apt install ffmpeg`
   - Windows: https://www.gyan.dev/ffmpeg/builds/ (add the `bin` folder to `PATH`)

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
  queue, chat, and typing status.
- The room's video state *is* the queue — a list of links plus which one is
  current. Whoever's connected mirrors that queue locally, so when someone
  joins mid-session, any already-connected peer can answer "here's the
  queue, here's the current time, here's whether it's playing" — there's no
  single point of failure if whoever first created the room has since left.
- Chat is relayed to Discord only by whoever's hosting the room, so you don't
  get duplicate posts if multiple people have a webhook configured.
