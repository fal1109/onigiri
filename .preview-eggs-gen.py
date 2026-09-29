#!/usr/bin/env python3
"""Rebuild .preview-eggs.html with src/styles.css and egg assets inlined,
so the sandboxed preview can render the setup decor, mayu room chip, and
shiggy empty-state exactly as the app will draw them."""
import base64, pathlib

root = pathlib.Path('/mnt/stuff/Documents/code/onigiri')
css = (root / 'src/styles.css').read_text()

def dataurl(p, mime='image/png'):
    return f'data:{mime};base64,' + base64.b64encode((root / p).read_bytes()).decode()

mascot = dataurl('build/mascots/1446463082730.png')
shiggy = dataurl('build/shiggy.webp', 'image/webp')

html = f'''<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<title>eggs-preview</title>
<style>
{css}
body{{ background: var(--md-surface); margin:0; padding:24px; display:flex; flex-direction:column; gap:28px; font-family:inherit; }}
.demo-label{{ font-size:12px; letter-spacing:.08em; text-transform:uppercase; opacity:.6; margin-bottom:8px; }}
.demo-setup{{ position:relative; height:380px; overflow:hidden; border-radius:16px;
  background: var(--md-surface-container); outline:1px dashed var(--md-outline-variant); }}
.demo-setup .setup-decor{{ position:absolute; inset:0; overflow:hidden; pointer-events:none; }}
.demo-header{{ display:flex; align-items:center; gap:12px; }}
.demo-video{{ height:320px; position:relative; }}
</style>
</head>
<body>
  <div>
    <div class="demo-label">1 · setup decor — mascot (random per launch) + quote bottom-left</div>
    <div class="demo-setup">
      <div class="setup-decor" aria-hidden="true">
        <img class="setup-cookie-img" src="{mascot}" alt="">
      </div>
      <div class="quote-line">imagine showering, cant be me -rui</div>
    </div>
  </div>

  <div>
    <div class="demo-label">2 · room code chip — mayu style</div>
    <div class="demo-header">
      <button id="room-chip" class="chip chip--mayu">Room code: ABC123</button>
      <button id="room-chip2" class="chip">In room: XYZ789</button>
    </div>
  </div>

  <div>
    <div class="demo-label">3 · empty video stage — shiggy</div>
    <div class="video-wrap demo-video">
      <div class="video-empty has-egg">
        <img class="video-empty-egg" src="{shiggy}" alt="">
        <svg viewBox="0 0 24 24" class="video-empty-icon"><path d="M8 5v14l11-7Z" /></svg>
        <p>Add a video to start</p>
      </div>
    </div>
  </div>
</body>
</html>
'''

out = root / '.preview-eggs.html'
out.write_text(html)
print('wrote', out, len(html), 'bytes')
