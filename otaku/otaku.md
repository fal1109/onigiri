# anime-site support (otaku mode)

Everything needed to download from anime streaming sites. Kept in its own
file, and intentionally separate from the main app — the base app works fine
for normal video sites without any of this.

Onigiri checks all of it for you: **Settings → Downloads → "Run setup check"**
(also opens automatically on first run) and tells you exactly what's missing
and how to fix it.

## 1. plugins

yt-dlp needs two community extractor plugins for these sites. One-shot
installers (safe to re-run) ship with the repo:

- **Linux / macOS:** `./setup-otaku.sh`
- **Windows:** double-click `setup-otaku.bat`
  (or right-click `setup-otaku.ps1` → *Run with PowerShell*)

They install into the standard yt-dlp plugin folders (`~/.config/yt-dlp/plugins`
on Linux/macOS, `%APPDATA%\yt-dlp\plugins` on Windows). Manual equivalent,
Linux/macOS:

```bash
mkdir -p ~/.config/yt-dlp/plugins
cd ~/.config/yt-dlp/plugins
curl -fsSL -o /tmp/a.zip https://github.com/yt-dlp-plugins/yt-dlp-animepahe/archive/refs/heads/main.zip && unzip /tmp/a.zip && mv yt-dlp-animepahe-main yt-dlp-animepahe
curl -fsSL -o /tmp/h.zip https://github.com/pratikpatel8982/yt-dlp-hianime/archive/refs/heads/master.zip && unzip /tmp/h.zip && mv yt-dlp-hianime-master yt-dlp-hianime
```

<details>
<summary>Manual equivalent — Windows (PowerShell)</summary>

```powershell
mkdir -Force "$env:APPDATA\yt-dlp\plugins" | Out-Null
cd "$env:APPDATA\yt-dlp\plugins"
Invoke-WebRequest -Uri "https://github.com/yt-dlp-plugins/yt-dlp-animepahe/archive/refs/heads/main.zip" -OutFile "$env:TEMP\a.zip"
Expand-Archive "$env:TEMP\a.zip" -DestinationPath . -Force
Rename-Item "yt-dlp-animepahe-main" "yt-dlp-animepahe"
Invoke-WebRequest -Uri "https://github.com/pratikpatel8982/yt-dlp-hianime/archive/refs/heads/master.zip" -OutFile "$env:TEMP\h.zip"
Expand-Archive "$env:TEMP\h.zip" -DestinationPath . -Force
Rename-Item "yt-dlp-hianime-master" "yt-dlp-hianime"
```

</details>

## 2. cookie browser

These sites sit behind Cloudflare and only serve video to a session that has
already passed the check **in a real browser**. So:

1. In your normal browser, visit the site once (pass the Cloudflare check if
   it appears). you do have to go there eitherway to get the download/episode link 
2. In Onigiri: **Settings → Downloads → Cookie browser** and put that
   browser's name, e.g. `brave` or `chrome`. On Linux you may need a keyring
   suffix (`brave+gnomekeyring`) — the setup check will say so if extraction
   comes back empty.

Known-by-name browsers: `brave`, `chrome`, `chromium`, `edge`, `opera`,
`vivaldi`, `whale`, `firefox`, `safari`.

Firefox forks (Floorp, Zen, LibreWolf, Waterfox) aren't known by name — point
at the profile folder instead:

- Linux: `firefox:~/.floorp/xxxxxxxx.default-default`
- Windows: `firefox:C:\Users\you\AppData\Roaming\Floorp\Profiles\xxxx.default`
  (Zen: `AppData\Roaming\zen\Profiles\…`; check the `profiles.ini` inside
  each browser's folder for the exact profile name)

The app sends the matching user-agent automatically — Cloudflare ties the
clearance cookie to it, so this part is not optional. Close the cookie browser
while downloading so its cookie database isn't locked.

## 3. linux distro packages (Arch-family only)

If yt-dlp came from a distro package manager (pacman/apt) rather than the
official binary, it also needs:

```
sudo pacman -S python-secretstorage python-pycryptodomex
```

- `secretstorage` — decrypt browser cookies from the OS keyring
- `pycryptodomex` — decrypt AES-128 HLS streams natively (without it,
  downloads fall back to ffmpeg and 403)

Official yt-dlp binaries from GitHub releases already bundle both — pip users
need `pip install secretstorage pycryptodomex` (names differ slightly per
distro; the setup check will tell you if these are the problem).

## sites

| site | how |
|---|---|
| animepahe | paste the watch-page URL (`animepahe.pw/play/...`). Direct `vault-*.uwucdn.top` file links expire within minutes — never use those. |
| hianime | paste episode or series URLs; series URLs queue as playlists. |
| animetake | visit once in your cookie browser first (its watch pages are Cloudflare challenge-gated). Then paste `animetake.tv/watch/...` URLs. |

## troubleshooting

- **403 with "link has expired"** → you pasted a direct CDN link; use the
  watch-page URL instead.
- **403 on the watch page itself** → your cookie browser hasn't visited the
  site (or the clearance expired) — re-visit once, run the setup check.
- **"Requested format is not available"** → the site rate-limited you; wait a
  minute (the app already spaces its requests).
- **"ffmpeg exited with code 8"** → missing `pycryptodomex` (see section 3).
