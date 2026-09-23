#!/usr/bin/env bash
# Onigiri — anime-site setup (Linux/macOS)
# Installs the yt-dlp plugins otaku.md describes. Safe to re-run.
set -euo pipefail

PLUGIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/yt-dlp/plugins"
mkdir -p "$PLUGIN_DIR"
cd "$PLUGIN_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> installing yt-dlp plugins into $PLUGIN_DIR"

fetch() { # fetch <url> <out>
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"
  else wget -qO "$2" "$1"; fi
}

fetch "https://github.com/yt-dlp-plugins/yt-dlp-animepahe/archive/refs/heads/main.zip" "$TMP/a.zip"
rm -rf yt-dlp-animepahe && unzip -qo "$TMP/a.zip" && mv yt-dlp-animepahe-main yt-dlp-animepahe

# The upstream plugin hardcodes its own user-agent, which breaks Cloudflare
# clearance cookies (they are pinned to YOUR browser's UA). Strip that header —
# Onigiri sends the correct one itself.
sed -i "/'user-agent':/d" "$PLUGIN_DIR/yt-dlp-animepahe/yt_dlp_plugins/extractor/animepahe/common.py" 2>/dev/null || true

fetch "https://github.com/pratikpatel8982/yt-dlp-hianime/archive/refs/heads/master.zip" "$TMP/h.zip"
rm -rf yt-dlp-hianime && unzip -qo "$TMP/h.zip" && mv yt-dlp-hianime-master yt-dlp-hianime

echo "==> done. Now set your cookie browser in Onigiri:"
echo "    Settings → Downloads → Cookie browser (e.g. brave, or firefox:~/path/to/profile)"
echo "Full details: otaku.md"
