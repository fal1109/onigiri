#!/usr/bin/env python3
"""Regenerate .preview-about.html with src/styles.css and images inlined,
because the preview server serves only the single registered HTML file."""
import base64, pathlib

root = pathlib.Path('/mnt/stuff/Documents/code/onigiri')
css = (root / 'src/styles.css').read_text()

def dataurl(p, mime):
    return f'data:{mime};base64,' + base64.b64encode((root / p).read_bytes()).decode()

fal = dataurl('src/assets/fal.png', 'image/png')
cat_dark = dataurl('build/catbox_darkmode.png', 'image/png')
cat_light = dataurl('build/catbox.png', 'image/png')

github_svg = '''<svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>'''

html = f'''<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<title>about-panel-preview</title>
<style>
{css}
</style>
</head>
<body>
<div class="dialog-scrim">
  <div class="dialog dialog-settings" role="dialog">
    <h2>Settings</h2>
    <div class="settings-body">
      <div class="settings-nav" id="settings-nav">
        <button type="button" class="settings-nav-item" data-panel="appearance">Appearance</button>
        <button type="button" class="settings-nav-item is-active" data-panel="about">About</button>
      </div>
      <div class="settings-panels">
        <div class="settings-panel" data-panel="about">
          <div class="about-card">
            <img class="about-avatar" src="{fal}" alt="fal1109's avatar">
            <div class="about-info">
              <div class="about-name">fal1109</div>
              <button type="button" id="about-tagline" class="about-tagline">for the onigiri boomer's council</button>
              <a class="about-site" href="#">fa11.netlify.app</a>
            </div>
            <a class="about-github" href="#" title="github.com/fal1109">{github_svg}</a>
          </div>

          <h3 class="panel-subheading">Services</h3>
          <div class="about-credit">
            <div class="about-credit-head">
              <img class="about-credit-img about-credit-img--light" src="{cat_light}" alt="">
              <img class="about-credit-img about-credit-img--dark" src="{cat_dark}" alt="">
              <span class="about-credit-line">video hosting platform</span>
            </div>
            <span class="about-credit-note"><a href="#" class="about-credit-link">catbox.moe</a> is not affiliated with onigiri</span>
          </div>

          <h3 class="panel-subheading">Version</h3>
          <div class="field">
            <div class="about-update-row">
              <span id="app-version" class="about-version">v1.6.0</span>
              <span id="update-status" class="about-update-status is-ok">You're on the latest version</span>
              <button type="button" id="check-updates-btn" class="btn btn-outlined btn-small">Check for updates</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>
'''

out = root / '.preview-about.html'
out.write_text(html)
print('wrote', out, len(html), 'bytes')
