const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onigiri', {
  // config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  chooseDownloadDir: () => ipcRenderer.invoke('dialog:choose-dir'),

  // emotes (own file, separate from config — see README)
  getEmotes: () => ipcRenderer.invoke('emotes:get'),
  addEmote: (name, url) => ipcRenderer.invoke('emotes:add', { name, url }),
  removeEmote: (name) => ipcRenderer.invoke('emotes:remove', { name }),
  reloadEmotes: () => ipcRenderer.invoke('emotes:reload'),
  getEmotesPath: () => ipcRenderer.invoke('emotes:path'),

  // room
  hostRoom: (username) => ipcRenderer.invoke('room:host', { username }),
  joinRoom: (code, username) => ipcRenderer.invoke('room:join', { code, username }),
  leaveRoom: () => ipcRenderer.invoke('room:leave'),
  getRole: () => ipcRenderer.invoke('room:role'),
  requestSync: () => ipcRenderer.invoke('sync:request'),

  // video
  downloadVideo: (url) => ipcRenderer.invoke('video:download', { url }),
  openInFolder: (p) => ipcRenderer.invoke('shell:open-path', p),

  // queue
  queueAdd: (url) => ipcRenderer.invoke('queue:add', { url }),
  queueRemove: (id) => ipcRenderer.invoke('queue:remove', { id }),
  queuePlay: (id) => ipcRenderer.invoke('queue:play', { id }),
  queueNext: () => ipcRenderer.invoke('queue:next'),

  // player + chat events out
  sendPlayerEvent: (action, time) => ipcRenderer.invoke('player:event', { action, time }),
  sendChat: (username, text) => ipcRenderer.invoke('chat:send', { username, text }),
  sendTyping: (username) => ipcRenderer.invoke('chat:typing', { username }),
  sendTypingStop: (username) => ipcRenderer.invoke('chat:typing-stop', { username }),

  // events in
  onVideoProgress: (cb) => ipcRenderer.on('video:progress', (_e, data) => cb(data)),
  onVideoLog: (cb) => ipcRenderer.on('video:log', (_e, data) => cb(data)),
  onRemotePlayerEvent: (cb) => ipcRenderer.on('net:remote-player-event', (_e, data) => cb(data)),
  onQueue: (cb) => ipcRenderer.on('net:queue', (_e, data) => cb(data)),
  onChat: (cb) => ipcRenderer.on('net:chat', (_e, data) => cb(data)),
  onTyping: (cb) => ipcRenderer.on('net:typing', (_e, data) => cb(data)),
  onTypingStop: (cb) => ipcRenderer.on('net:typing-stop', (_e, data) => cb(data)),
  onSystem: (cb) => ipcRenderer.on('net:system', (_e, data) => cb(data)),
  onPeers: (cb) => ipcRenderer.on('net:peers', (_e, data) => cb(data)),
  onNetError: (cb) => ipcRenderer.on('net:error', (_e, data) => cb(data)),
  onSync: (cb) => ipcRenderer.on('net:sync', (_e, data) => cb(data))
});
