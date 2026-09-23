# Onigiri — anime-site setup (Windows)
# Installs the yt-dlp plugins otaku.md describes. Safe to re-run.
$ErrorActionPreference = "Stop"

$PluginDir = "$env:APPDATA\yt-dlp\plugins"
New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
Set-Location $PluginDir

Write-Host "==> installing yt-dlp plugins into $PluginDir"

$Tmp = Join-Path $env:TEMP ("onigiri-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

Invoke-WebRequest -Uri "https://github.com/yt-dlp-plugins/yt-dlp-animepahe/archive/refs/heads/main.zip" -OutFile "$Tmp\a.zip"
If (Test-Path "yt-dlp-animepahe") { Remove-Item -Recurse -Force "yt-dlp-animepahe" }
Expand-Archive "$Tmp\a.zip" -DestinationPath $Tmp -Force
Rename-Item "$Tmp\yt-dlp-animepahe-main" "yt-dlp-animepahe"
Move-Item "$Tmp\yt-dlp-animepahe" $PluginDir

# The upstream plugin hardcodes its own user-agent, which breaks Cloudflare
# clearance cookies (they are pinned to YOUR browser's UA). Strip that header —
# Onigiri sends the correct one itself.
$Common = Join-Path $PluginDir "yt-dlp-animepahe\yt_dlp_plugins\extractor\animepahe\common.py"
If (Test-Path $Common) {
  (Get-Content $Common) | Where-Object { $_ -notmatch "'user-agent':" } | Set-Content $Common
}

Invoke-WebRequest -Uri "https://github.com/pratikpatel8982/yt-dlp-hianime/archive/refs/heads/master.zip" -OutFile "$Tmp\h.zip"
If (Test-Path "yt-dlp-hianime") { Remove-Item -Recurse -Force "yt-dlp-hianime" }
Expand-Archive "$Tmp\h.zip" -DestinationPath $Tmp -Force
Rename-Item "$Tmp\yt-dlp-hianime-master" "yt-dlp-hianime"
Move-Item "$Tmp\yt-dlp-hianime" $PluginDir

Remove-Item -Recurse -Force $Tmp

Write-Host "==> done. Now set your cookie browser in Onigiri:"
Write-Host "    Settings -> Downloads -> Cookie browser (e.g. brave, or firefox:C:\Users\you\...\Profiles\xxx.default)"
Write-Host "Full details: otaku.md"
