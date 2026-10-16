/* Plain browser JavaScript. Socket.IO carries room state; HTTP carries video bytes. */
'use strict';

const socket = io({ reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 4000, timeout: 8000 });
const video = document.getElementById('local-player');
let room = null;
let identity = null;
let mode = 'create';
let currentMediaId = null;
let yt = null;
let ytReady = false;
let ytPromise = null;
let config = { lanUrls: [], maxUploadBytes: 2 * 1024 ** 3 };
let uploadRequest = null;
let pendingFile = null;
let pendingSource = null;
let restoring = false;
let sourceLoading = false;
let playbackFailureId = null;
let youtubeReadyTimer = null;

const DRIFT_TOLERANCE = 0.25;       // Seconds
const CORRECTION_COOLDOWN = 1500;  // Milliseconds
const LOG_DRIFT = true;

let clockOffsetMs = null;
let clockCalibratedAt = 0;
let syncGeneration = 0;
let calibratingGeneration = null;

let syncTimer = null;
let clockTimer = null;
let lastCorrectionAt = -Infinity;
let lastSyncMediaId = null;
let lastSyncRevision = null;
let outOfSyncChecks = 0;
const chat = new window.PartyChat({
  request,
  getContext: () => ({ roomCode: room?.code, selfId: identity?.selfId, connected: socket.connected && !restoring })
});

function readStorage(store, key, fallback = null) {
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveStorage(store, key, value) { try { value === null ? store.removeItem(key) : store.setItem(key, JSON.stringify(value)); } catch { /* Private browsing may disable storage. */ } }
let savedSession = readStorage(sessionStorage, 'watchparty.session');
document.getElementById('display-name').value = readStorage(localStorage, 'watchparty.name', '');

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function setIcon(element, name) { element.replaceChildren(icon(name)); }
function toast(message, error = false) {
  const item = document.createElement('div');
  item.className = `toast${error ? ' error' : ''}`;
  item.textContent = message;
  document.getElementById('toast-stack').append(item);
  while (document.getElementById('toast-stack').children.length > 3) document.getElementById('toast-stack').firstChild.remove();
  setTimeout(() => item.remove(), error ? 6500 : 4000);
}
function request(event, data = {}) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) return reject(new Error('You are disconnected. Waiting to reconnect…'));
    socket.timeout(8000).emit(event, data, (error, result) => {
      if (error) return reject(new Error('The server did not respond. Try again in a moment.'));
      if (!result?.ok) return reject(new Error(result?.error || 'Unable to complete this action.'));
      resolve(result);
    });
  });
}
function isHost() { return Boolean(room && identity && room.hostId === identity.selfId); }
function canControl() { return isHost() && socket.connected && !restoring; }
function time(value) {
  if (!Number.isFinite(value)) return '00:00';
  const seconds = Math.max(0, Math.floor(value));
  return (seconds >= 3600 ? `${Math.floor(seconds / 3600)}:` : '') + `${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function position() { return room?.media?.kind === 'youtube' ? (ytReady ? yt.getCurrentTime() || 0 : 0) : video.currentTime || 0; }
function duration() { return room?.media?.kind === 'youtube' ? (ytReady ? yt.getDuration() || 0 : 0) : Number.isFinite(video.duration) ? video.duration : 0; }
function connection(status, text) { document.getElementById('connection').className = `connection ${status}`; document.getElementById('connection').lastElementChild.textContent = text; renderPermissions(); }

function openRoomDialog(nextMode, code = '') {
  mode = nextMode;
  document.getElementById('create-tab').classList.toggle('active', mode === 'create');
  document.getElementById('join-tab').classList.toggle('active', mode === 'join');
  document.getElementById('join-code-field').hidden = mode !== 'join';
  document.getElementById('join-code').required = mode === 'join';
  if (code) document.getElementById('join-code').value = code.toUpperCase();
  document.getElementById('dialog-title').textContent = mode === 'create' ? 'Create a party.' : 'Enter the code.';
  document.getElementById('room-submit').replaceChildren(document.createTextNode(mode === 'create' ? 'Create my party' : 'Join the fun'), icon('arrow'));
  document.getElementById('room-error').hidden = true;
  if (!document.getElementById('room-dialog').open) document.getElementById('room-dialog').showModal();
}

document.getElementById('create-open').addEventListener('click', () => openRoomDialog('create'));
document.getElementById('join-open').addEventListener('click', () => openRoomDialog('join'));
document.getElementById('create-tab').addEventListener('click', () => openRoomDialog('create'));
document.getElementById('join-tab').addEventListener('click', () => openRoomDialog('join'));
document.getElementById('screen-start').addEventListener('click', () => room ? document.getElementById('youtube-url').focus() : openRoomDialog('create'));
document.getElementById('help-button').addEventListener('click', () => document.getElementById('help-dialog').showModal());
document.getElementById('room-menu-open').addEventListener('click', () => { if (room) document.getElementById('party-dialog').showModal(); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
}));
document.getElementById('room-dialog').addEventListener('close', () => { if (!room) { pendingFile = null; pendingSource = null; } });

document.getElementById('room-form').addEventListener('submit', async event => {
  event.preventDefault();
  document.getElementById('room-submit').disabled = true;
  document.getElementById('room-error').hidden = true;
  try {
    const name = document.getElementById('display-name').value.trim();
    const data = await request(mode === 'create' ? 'room:create' : 'room:join', { name, code: document.getElementById('join-code').value.trim() });
    saveStorage(localStorage, 'watchparty.name', name);
    adoptRoom(data);
    document.getElementById('room-dialog').close();
    toast(mode === 'create' ? 'Your room is ready. Save your people a seat.' : 'You’re in. Make yourself comfortable.');
    if (pendingFile && isHost()) { const file = pendingFile; pendingFile = null; uploadFile(file); }
    if (pendingSource && isHost()) { pendingSource = null; addYouTube(); }
  } catch (error) { document.getElementById('room-error').textContent = error.message; document.getElementById('room-error').hidden = false; }
  finally { document.getElementById('room-submit').disabled = false; }
});

function adoptRoom(data) {
  identity = { selfId: data.selfId, token: data.token };
  savedSession = { code: data.state.code, ...identity };
  saveStorage(sessionStorage, 'watchparty.session', savedSession);
  room = null;
  applyState(data.state, true);
  chat.join(data.state.code, data.selfId, data.chat);
  const url = new URL(location.href); url.searchParams.set('room', room.code); history.replaceState(null, '', url);
}

function applyState(state, force = false) {
  if (room && (room.code !== state.code || state.sequence < room.sequence)) return;
  const mediaChanged = (state.media?.id || null) !== currentMediaId;
  const playbackChanged = force || mediaChanged || state.playbackRevision !== room?.playbackRevision;
  room = state;
  renderRoom();
  if (mediaChanged) loadMedia(state.media);
  else if (playbackChanged && state.media) applyPlayback();
}

function renderPermissions() {
  const controllable = canControl();
  const hasMedia = Boolean(room?.media);
  document.getElementById('play-button').disabled = !controllable || !hasMedia || sourceLoading || !document.getElementById('player-error').hidden;
  document.getElementById('seek').disabled = !controllable || !hasMedia || sourceLoading || !duration() || !document.getElementById('player-error').hidden;
  document.getElementById('upload-button').disabled = Boolean(room && !controllable) || Boolean(uploadRequest);
  document.getElementById('youtube-url').disabled = Boolean(room && !controllable);
  document.getElementById('youtube-submit').disabled = Boolean(room && !controllable);
  document.getElementById('mute-button').disabled = !hasMedia;
  document.getElementById('volume').disabled = !hasMedia;
  document.getElementById('invite-button').disabled = !room;
  document.getElementById('copy-code').disabled = !room;
  document.getElementById('control-label').replaceChildren(icon('crown'), document.createTextNode(isHost() ? 'YOU CONTROL PLAYBACK' : 'HOST CONTROLS PLAYBACK'));
  document.getElementById('source-permission').textContent = room ? isHost() ? 'HOST CONTROLS · THAT’S YOU' : 'YOUR HOST PICKS THE PICTURE' : 'YOUR VIDEO. YOUR CHOICE.';
  document.getElementById('create-open').disabled = document.getElementById('join-open').disabled = !socket.connected || restoring;
  document.getElementById('leave-button').disabled = !socket.connected || restoring;
  chat.refreshStatus();
}

function renderRoom() {
  document.getElementById('home-view').hidden = Boolean(room);
  document.getElementById('party-view').hidden = !room;
  document.getElementById('lobby-actions').hidden = Boolean(room);
  document.getElementById('room-actions').hidden = !room;
  document.getElementById('heading-description').textContent = room ? isHost() ? 'Your room. Your people. You have the controls.' : 'You’re in good company. Settle in.' : 'Different places. One movie night.';
  document.getElementById('room-code').textContent = room?.code || '— — — — — —';
  document.getElementById('room-code').classList.toggle('empty-code', !room);
  const members = room?.members || [];
  const host = members.find(member => member.id === room?.hostId);
  const title = host ? `${host.name}’s party` : 'Your party';
  document.getElementById('party-title').textContent = title;
  document.getElementById('menu-title').textContent = title;
  document.getElementById('menu-room-code').textContent = room?.code || '';
  document.getElementById('menu-members').replaceChildren();
  for (const member of members) {
    const item = document.createElement('span');
    item.className = `popup-member${member.online ? '' : ' offline'}`;
    item.textContent = `${member.name}${member.id === room.hostId ? ' · Host' : ''}${member.id === identity?.selfId ? ' · You' : ''}${member.online ? '' : ' · Reconnecting'}`;
    document.getElementById('menu-members').append(item);
  }
  const online = members.filter(member => member.online).length;
  document.getElementById('member-count').textContent = String(members.length).padStart(2, '0');
  document.getElementById('online-count').textContent = `${online} ONLINE`;
  document.getElementById('empty-guests').hidden = Boolean(room);
  document.getElementById('invite-description').textContent = room ? 'Share a code. Save someone a seat.' : 'Good nights start with good company.';
  document.getElementById('room-bottom-text').textContent = room ? `${online} ${online === 1 ? 'person' : 'people'}. One shared screen.` : 'A private space for your people.';
  document.getElementById('member-list').replaceChildren();
  for (const member of members) {
    const row = document.createElement('div'); row.className = `member${member.online ? '' : ' member-offline'}`;
    const avatar = document.createElement('div'); avatar.className = 'member-avatar'; avatar.textContent = Array.from(member.name)[0].toUpperCase();
    const copy = document.createElement('div'); copy.className = 'member-copy';
    const name = document.createElement('div'); name.className = 'member-name'; name.textContent = member.name;
    if (member.id === identity?.selfId) { const you = document.createElement('small'); you.textContent = '(you)'; name.append(you); }
    const status = document.createElement('div'); status.className = 'member-status'; status.textContent = member.online ? 'In the room' : 'Reconnecting…';
    copy.append(name, status); row.append(avatar, copy);
    if (member.id === room.hostId) { const role = document.createElement('span'); role.className = 'member-role'; role.append(icon('crown'), 'HOST'); row.append(role); }
    else if (canControl() && member.online) {
      const transfer = document.createElement('button'); transfer.className = 'transfer-button'; transfer.textContent = 'Make host'; transfer.setAttribute('aria-label', `Make ${member.name} the host`);
      transfer.addEventListener('click', async () => {
        transfer.disabled = true;
        try { await request('host:transfer', { memberId: member.id }); toast(`${member.name} now has the controls.`); }
        catch (error) { toast(error.message, true); transfer.disabled = false; }
      }); row.append(transfer);
    }
    document.getElementById('member-list').append(row);
  }
  document.getElementById('now-playing').hidden = !room?.media;
  document.getElementById('media-title').textContent = room?.media?.title || '';
  document.getElementById('media-type').textContent = room?.media?.kind === 'youtube' ? 'YOUTUBE' : 'LOCAL VIDEO';
  document.getElementById('source-badge').textContent = room?.media ? room.playing ? 'PLAYING TOGETHER' : 'READY WHEN YOU ARE' : 'WAITING FOR A VIDEO';
  document.getElementById('screen-note').textContent = room ? isHost() ? 'You have the controls. Everyone follows your play, pause and seek.' : 'Your host controls the picture. Volume is all yours.' : 'One host. A shared screen. A proper movie night.';
  document.getElementById('screen-start').textContent = room ? isHost() ? 'Choose your first video ↓' : 'Your host is choosing the video' : 'Create a party to begin';
  document.getElementById('screen-start').disabled = Boolean(room && !isHost());
  setIcon(document.getElementById('play-button'), room?.playing ? 'pause' : 'play');
  document.getElementById('play-button').setAttribute('aria-label', room?.playing ? 'Pause for everyone' : 'Play for everyone');
  renderPermissions();
}

function resetParty() {
  for (const id of ['party-dialog', 'invite-dialog']) if (document.getElementById(id).open) document.getElementById(id).close();
  if (uploadRequest) uploadRequest.abort();
  room = null; identity = null; savedSession = null; pendingSource = null; pendingFile = null;
  chat.reset();
  saveStorage(sessionStorage, 'watchparty.session', null);
  loadMedia(null);
  renderRoom();
  document.getElementById('activity-text').textContent = 'Your next movie night starts here.';
  const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
}
document.getElementById('leave-button').addEventListener('click', async () => {
  try { await request('room:leave'); resetParty(); toast('You left the room. Until the next movie night.'); }
  catch (error) { toast(error.message, true); }
});

socket.on('connect', async () => {
  connection('online', 'Connected');
  if (savedSession && !restoring) {
    restoring = true; renderPermissions();
    try {
      const result = await request('room:join', { code: savedSession.code, token: savedSession.token });
      adoptRoom(result); document.getElementById('activity-text').textContent = 'Back in the room. Your place was saved.';
    } catch (error) {
      if (!socket.connected) return;
      const previousCode = savedSession.code;
      resetParty(); openRoomDialog('join', previousCode);
      document.getElementById('room-error').textContent = error.message; document.getElementById('room-error').hidden = false;
    } finally { restoring = false; renderRoom(); }
  }
});
socket.on('disconnect', () => {
  chat.toggleEmoji(false);
  connection('offline', 'Reconnecting');
  video.pause(); if (ytReady) yt.pauseVideo();
  document.getElementById('activity-text').textContent = 'Connection lost. Playback is paused here while we reconnect.';
  renderRoom();
});
socket.on('connect_error', () => connection('offline', 'Server unavailable'));
socket.on('room:state', ({ state, activity }) => {
  if (!identity || room?.code !== state.code) return;
  applyState(state);
  if (activity) document.getElementById('activity-text').textContent = activity;
});
socket.on('chat:message', ({ code, message }) => chat.receive(code, message));

function clearPlayerError() { document.getElementById('player-error').hidden = true; playbackFailureId = null; }
function playerError(message) { document.getElementById('player-error-text').textContent = message; document.getElementById('player-error').hidden = false; }
function loadYouTubeAPI() {
  if (window.YT?.Player) return Promise.resolve();
  if (ytPromise) return ytPromise;
  ytPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api';
    const timer = setTimeout(() => { script.remove(); ytPromise = null; reject(new Error('YouTube could not load. Check your internet connection and try again.')); }, 15_000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); ytPromise = null; script.remove(); reject(new Error('YouTube could not load. Check your connection.')); };
    document.head.append(script);
  });
  return ytPromise;
}

async function loadMedia(media) {
  const id = media?.id || null;
  currentMediaId = id; sourceLoading = Boolean(media);
  clearTimeout(youtubeReadyTimer);
  clearPlayerError(); document.getElementById('playback-gate').hidden = true;
  video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
  if (yt) { yt.destroy(); yt = null; }
  ytReady = false;
  document.getElementById('youtube-wrap').replaceChildren(Object.assign(document.createElement('div'), { id: 'youtube-player' }));
  document.getElementById('youtube-wrap').hidden = true;
  document.getElementById('empty-screen').hidden = Boolean(media);
  document.getElementById('current-time').textContent = document.getElementById('duration').textContent = '00:00';
  document.getElementById('seek').value = '0';
  renderPermissions();
  if (!media) return;
  if (media.kind === 'file') {
    video.hidden = false;
    video.src = `/api/rooms/${room.code}/media/${media.id}?token=${encodeURIComponent(identity.token)}`;
    video.volume = Number(document.getElementById('volume').value) / 100;
    video.load();
  } else {
    document.getElementById('youtube-wrap').hidden = false;
    try {
      await loadYouTubeAPI();
      if (currentMediaId !== id) return;
      youtubeReadyTimer = setTimeout(() => {
        if (currentMediaId !== id || ytReady) return;
        sourceLoading = false;
        playerError('The YouTube player did not respond. Check your internet connection, allow embedded YouTube content, then try again.');
        renderPermissions();
      }, 20_000);
      yt = new YT.Player('youtube-player', {
        width: '100%', height: '100%', videoId: media.videoId,
        playerVars: { controls: 0, playsinline: 1, rel: 0, origin: location.origin, disablekb: 1 },
        events: {
          onReady: event => {
            if (currentMediaId !== id) return;
            clearTimeout(youtubeReadyTimer); clearPlayerError();
            ytReady = true; sourceLoading = false;
            event.target.setVolume(Number(document.getElementById('volume').value));
            if (video.muted) event.target.mute();
            renderPermissions(); syncLoadedPlayer(id);
          },
          onAutoplayBlocked: () => { if (currentMediaId === id) document.getElementById('playback-gate').hidden = false; },
          onStateChange: event => { if (currentMediaId === id && event.data === 0 && canControl() && room?.playing) sendPlayback('pause'); },
          onError: event => {
            if (currentMediaId !== id) return;
            clearTimeout(youtubeReadyTimer);
            sourceLoading = false;
            const errors = { 2: 'This YouTube link is invalid.', 5: 'Your browser could not play this YouTube video.', 100: 'This YouTube video is private, removed or unavailable.', 101: 'This video does not allow embedded playback. Try another YouTube link.', 150: 'This video does not allow embedded playback. Try another YouTube link.', 153: 'YouTube could not verify this page. Open Watch Party through its HTTP address and allow referrer headers.' };
            playerError(errors[event.data] || 'YouTube could not play this video. Try another link.'); renderPermissions();
          }
        }
      });
    } catch (error) { if (currentMediaId === id) { sourceLoading = false; playerError(error.message); renderPermissions(); } }
  }
}

function applyPlayback() {
  if (!room?.media || !socket.connected) return;
  const target = Math.max(0, room.position);
  if (room.media.kind === 'file') {
    if (!video.readyState) return;
    const nextPosition = Math.min(target, Number.isFinite(video.duration) ? video.duration : target);
    // Reassigning currentTime starts a seek, even when the player is already aligned.
    if (Math.abs(video.currentTime - nextPosition) > 0.05) video.currentTime = nextPosition;
    if (room.playing) {
      const id = currentMediaId;
      video.play().then(() => { if (id === currentMediaId) document.getElementById('playback-gate').hidden = true; }).catch(error => {
        if (id !== currentMediaId || !room?.playing || error.name === 'AbortError') return;
        if (error.name === 'NotAllowedError') document.getElementById('playback-gate').hidden = false;
        else if (playbackFailureId !== id) { playbackFailureId = id; playerError('This browser could not decode the video. Try an MP4 encoded with H.264 video and AAC audio.'); }
      });
    } else { video.pause(); document.getElementById('playback-gate').hidden = true; }
  } else if (ytReady) {
    yt.seekTo(target, true);
    if (room.playing) yt.playVideo();
    else { yt.pauseVideo(); document.getElementById('playback-gate').hidden = true; }
  }
}

async function syncLoadedPlayer(mediaId) {
  // Loading may take seconds. Fetch a fresh position once ready, especially for late arrivals.
  try {
    const result = await request('room:snapshot');
    if (currentMediaId === mediaId) applyState(result.state, true);
  } catch { if (currentMediaId === mediaId) applyPlayback(); }
}

video.addEventListener('loadedmetadata', () => { if (room?.media?.kind === 'file') { sourceLoading = false; renderPermissions(); syncLoadedPlayer(currentMediaId); } });
video.addEventListener('error', () => {
  if (!video.getAttribute('src') || room?.media?.kind !== 'file') return;
  sourceLoading = false;
  console.warn('Video playback failed:', video.error?.code, video.error?.message || 'No browser diagnostic available.');
  playerError(video.error?.code === 4 ? 'This browser cannot play this video format. Try an MP4 encoded with H.264 video and AAC audio.' : 'The video could not load. Check the host’s connection and try again.');
  renderPermissions();
});
video.addEventListener('ended', () => { if (canControl() && room?.playing) sendPlayback('pause'); });
document.getElementById('retry-player').addEventListener('click', () => { if (room?.media) loadMedia(room.media); });
document.getElementById('enable-playback').addEventListener('click', async () => {
  if (!room?.media) return;
  if (room.media.kind === 'file') video.play().catch(() => { });
  else if (ytReady) yt.playVideo();
  document.getElementById('playback-gate').hidden = true;
  try { const result = await request('room:snapshot'); applyState(result.state, true); }
  catch (error) { toast(error.message, true); }
});

async function sendPlayback(action, target = position()) {
  if (!canControl() || !room?.media) return;
  if (LOG_DRIFT) console.log('Playback command', { action, position: target, localPosition: position(), roomPosition: room.position });
  try { const result = await request('playback:action', { action, position: target, mediaId: room.media.id }); applyState(result.state); }
  catch (error) { toast(error.message, true); }
}
document.getElementById('play-button').addEventListener('click', () => {
  if (!canControl() || !room?.media || sourceLoading) return;
  const action = room.playing ? 'pause' : 'play';
  // A paused room's shared position is authoritative. Native play() can change
  // currentTime, so capture and send the intended position before calling it.
  let target = action === 'play' ? Math.max(0, room.position) : position();
  const length = duration();
  if (action === 'play' && length > 0 && target >= length) target = 0;
  sendPlayback(action, target);
  if (action === 'play') {
    if (room.media.kind === 'file') {
      if (Math.abs(video.currentTime - target) > 0.05) video.currentTime = target;
      video.play().catch(() => { });
    } else if (ytReady) { yt.seekTo(target, true); yt.playVideo(); }
  }
});
document.getElementById('seek').addEventListener('change', () => sendPlayback('seek', duration() * Number(document.getElementById('seek').value) / 1000));
document.getElementById('seek').addEventListener('input', () => { document.getElementById('current-time').textContent = time(duration() * Number(document.getElementById('seek').value) / 1000); });
function updateMute() { setIcon(document.getElementById('mute-button'), video.muted ? 'muted' : 'volume'); document.getElementById('mute-button').setAttribute('aria-label', video.muted ? 'Unmute your audio' : 'Mute your audio'); }
document.getElementById('mute-button').addEventListener('click', () => { video.muted = !video.muted; if (ytReady) video.muted ? yt.mute() : yt.unMute(); updateMute(); });
document.getElementById('volume').addEventListener('input', () => { video.volume = Number(document.getElementById('volume').value) / 100; video.muted = false; if (ytReady) { yt.setVolume(Number(document.getElementById('volume').value)); yt.unMute(); } updateMute(); });
document.getElementById('fullscreen-button').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else if (document.getElementById('player-stage').closest('.theater').requestFullscreen) await document.getElementById('player-stage').closest('.theater').requestFullscreen(); else toast('Fullscreen is not available in this browser.', true); }
  catch { toast('Your browser could not enter fullscreen.', true); }
});
setInterval(() => {
  if (!room?.media) return;
  const length = duration();
  document.getElementById('duration').textContent = time(length);
  if (document.activeElement !== document.getElementById('seek')) {
    document.getElementById('current-time').textContent = time(position());
    document.getElementById('seek').value = length ? Math.min(1000, position() / length * 1000) : 0;
  }
  document.getElementById('seek').disabled = !canControl() || sourceLoading || !length || !document.getElementById('player-error').hidden;
}, 250);

async function addYouTube() {
  if (!room) { pendingSource = 'youtube'; openRoomDialog('create'); return; }
  if (!canControl()) return toast('Only the host can change the video.', true);
  document.getElementById('youtube-submit').disabled = true;
  try { const result = await request('media:youtube', { url: document.getElementById('youtube-url').value }); applyState(result.state); document.getElementById('youtube-url').value = ''; toast('YouTube video added. Hit play when everyone is ready.'); }
  catch (error) { toast(error.message, true); }
  finally { renderPermissions(); }
}
document.getElementById('youtube-form').addEventListener('submit', event => { event.preventDefault(); addYouTube(); });
document.getElementById('upload-button').addEventListener('click', () => document.getElementById('file-input').click());
document.getElementById('file-input').addEventListener('change', () => { if (document.getElementById('file-input').files[0]) uploadFile(document.getElementById('file-input').files[0]); document.getElementById('file-input').value = ''; });
for (const eventName of ['dragenter', 'dragover']) document.getElementById('upload-button').addEventListener(eventName, event => { event.preventDefault(); if (!room || canControl()) document.getElementById('upload-button').classList.add('drag-over'); });
for (const eventName of ['dragleave', 'drop']) document.getElementById('upload-button').addEventListener(eventName, event => { event.preventDefault(); document.getElementById('upload-button').classList.remove('drag-over'); });
document.getElementById('upload-button').addEventListener('drop', event => { if (event.dataTransfer.files[0] && !uploadRequest) uploadFile(event.dataTransfer.files[0]); });

function uploadFile(file) {
  if (!/\.(mp4|webm|ogv)$/i.test(file.name)) return toast('Choose an MP4, WebM or OGV video.', true);
  if (file.size > config.maxUploadBytes) return toast(`This file exceeds the ${Math.round(config.maxUploadBytes / 1024 ** 2)} MB limit.`, true);
  if (!file.size) return toast('This video file is empty.', true);
  if (!room) { pendingFile = file; openRoomDialog('create'); return; }
  if (!canControl()) return toast('Only the host can add a video.', true);
  if (uploadRequest) return;
  const code = room.code;
  const xhr = new XMLHttpRequest(); uploadRequest = xhr;
  const data = new FormData(); data.append('video', file);
  document.getElementById('upload-progress').hidden = false; document.getElementById('upload-meter').value = 0;
  document.getElementById('upload-label').textContent = `Uploading ${file.name}…`;
  renderPermissions();
  xhr.open('POST', `/api/rooms/${code}/upload`); xhr.setRequestHeader('Authorization', `Bearer ${identity.token}`);
  xhr.upload.onprogress = event => {
    if (event.lengthComputable) { const percent = Math.round(event.loaded / event.total * 100); document.getElementById('upload-meter').value = percent; document.getElementById('upload-label').textContent = percent === 100 ? 'Getting your video ready…' : `Uploading your video · ${percent}%`; }
  };
  xhr.onload = () => {
    let response;
    try { response = JSON.parse(xhr.responseText); } catch { response = { error: 'The upload failed. Try again.' }; }
    if (xhr.status >= 200 && xhr.status < 300 && response.ok) { if (room?.code === code) applyState(response.state); toast('Your video is ready for its audience.'); }
    else toast(response.error || 'The upload failed. Try again.', true);
  };
  xhr.onerror = () => toast('Upload interrupted. Check your connection and try again.', true);
  xhr.onabort = () => toast('Upload cancelled.');
  xhr.onloadend = () => { uploadRequest = null; document.getElementById('upload-progress').hidden = true; renderPermissions(); };
  xhr.send(data);
}
document.getElementById('cancel-upload').addEventListener('click', () => uploadRequest?.abort());

async function copyText(text, success) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const input = document.createElement('textarea'); input.value = text; input.style.cssText = 'position:fixed;left:-9999px';
      const parent = document.querySelector('dialog[open]') || document.body; parent.append(input); input.select();
      const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error('Copy is unavailable. Select the invite address and copy it manually.');
    }
    toast(success);
  } catch (error) { toast(error.message || 'Copy failed. Select and copy the address manually.', true); }
}
document.getElementById('copy-code').addEventListener('click', () => { if (room) copyText(room.code, 'Room code copied.'); });
document.getElementById('menu-copy-code').addEventListener('click', () => { if (room) copyText(room.code, 'Party code copied.'); });
function updateInvite() { const url = new URL(document.getElementById('invite-address').value); url.searchParams.set('room', room.code); document.getElementById('invite-url').textContent = url.href; }
function showInvite() {
  if (!room) return;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const addresses = [...new Set(local && config.lanUrls.length ? config.lanUrls : [location.origin, ...config.lanUrls])];
  document.getElementById('invite-address').replaceChildren();
  for (const address of addresses) { const option = document.createElement('option'); option.value = address; option.textContent = address; document.getElementById('invite-address').append(option); }
  updateInvite(); document.getElementById('invite-dialog').showModal();
  copyText(document.getElementById('invite-url').textContent, 'Invite link copied. Send it to your people.');
}
document.getElementById('invite-button').addEventListener('click', showInvite);
document.getElementById('menu-invite').addEventListener('click', () => { document.getElementById('party-dialog').close(); showInvite(); });
document.getElementById('invite-address').addEventListener('change', updateInvite);
document.getElementById('copy-invite-dialog').addEventListener('click', () => copyText(document.getElementById('invite-url').textContent, 'Invite link copied.'));

fetch('/api/config').then(response => response.json()).then(data => {
  config = data;
  const mb = Math.round(config.maxUploadBytes / 1024 ** 2);
  document.getElementById('upload-formats').textContent = `MP4, WEBM, OGV · UP TO ${mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`}`;
}).catch(() => { });
renderRoom();
const invitedCode = new URL(location.href).searchParams.get('room');
if (invitedCode && savedSession?.code !== invitedCode.toUpperCase()) {
  savedSession = null; saveStorage(sessionStorage, 'watchparty.session', null);
  openRoomDialog('join', invitedCode);
}

// Send clock requests and keep the lowest-delay sample.
async function syncClock(generation = syncGeneration) {
  if (
    !socket.connected ||
    generation !== syncGeneration ||
    calibratingGeneration === generation
  ) return;

  calibratingGeneration = generation;

  try {
    const samples = [];

    for (let i = 0; i < 5; i++) {
      if (!socket.connected || generation !== syncGeneration) return;

      const sentAt = performance.now();
      const { serverNow } = await request('time:request');
      const receivedAt = performance.now();

      // Ignore replies belonging to an earlier connection.
      if (!socket.connected || generation !== syncGeneration) return;

      if (!Number.isFinite(serverNow)) {
        throw new Error('Invalid server time');
      }

      const rtt = receivedAt - sentAt;

      // Discard unusually slow samples.
      if (rtt >= 0 && rtt <= 500) {
        samples.push({
          rtt,
          offset: serverNow - (sentAt + receivedAt) / 2
        });
      }
    }

    if (!samples.length) {
      throw new Error('No reliable clock samples');
    }

    samples.sort((a, b) => a.rtt - b.rtt);
    clockOffsetMs = samples[0].offset;
    clockCalibratedAt = performance.now();
  } catch (error) {
    if (generation === syncGeneration) {
      console.warn('Clock sync:', error.message);
    }
  } finally {
    if (calibratingGeneration === generation) {
      calibratingGeneration = null;
    }
  }
}

// Read estimated server time without making a network request.
function estimatedServerNow() {
  const clockExpired =
    performance.now() - clockCalibratedAt > 100000;

  if (clockOffsetMs === null || clockExpired) return null;

  return performance.now() + clockOffsetMs;
}

function checkDrift() {
  if (
    !socket.connected ||
    restoring ||
    document.hidden ||
    sourceLoading ||
    room?.media?.kind !== 'file' ||
    room.media.id !== currentMediaId
  ) return;

  if (
    video.seeking ||
    video.error ||
    !Number.isFinite(video.duration) ||
    video.duration <= 0 ||
    video.readyState < (room.playing ? 3 : 2)
  ) return;

  // A local pause needs a way back into playback, including when autoplay is blocked.
  // The click handler fetches a fresh room snapshot before restoring the position.
  if (room.playing && video.paused) {
    document.getElementById('playback-gate').hidden = false;
    return;
  }

  const serverNow = estimatedServerNow();
  if (serverNow === null) return;

  const now = performance.now();

  // Allow new media and explicit host commands to settle.
  if (
    lastSyncMediaId !== currentMediaId ||
    lastSyncRevision !== room.playbackRevision
  ) {
    lastSyncMediaId = currentMediaId;
    lastSyncRevision = room.playbackRevision;
    lastCorrectionAt = now;
    outOfSyncChecks = 0;
    return;
  }

  if (!room.playing && !video.paused) video.pause();

  const elapsed = room.playing
    ? Math.max(0, (serverNow - room.updatedAt) / 1000)
    : 0;

  const target = Math.min(
    video.duration,
    Math.max(0, room.position + elapsed)
  );

  const actual = video.currentTime;
  const drift = actual - target;

  if (LOG_DRIFT) {
    console.log({
      target,
      actual,
      driftMs: Math.round(drift * 1000)
    });
  }

  if (Math.abs(drift) <= DRIFT_TOLERANCE) {
    outOfSyncChecks = 0;
    return;
  }

  if (now - lastCorrectionAt < CORRECTION_COOLDOWN) return;

  // Require two out-of-sync checks before correcting.
  if (++outOfSyncChecks < 2) return;

  video.currentTime = target; // Only this viewer's player.
  lastCorrectionAt = now;
  outOfSyncChecks = 0;
}

function stopSync() {
  syncGeneration++;

  clearInterval(syncTimer);
  clearInterval(clockTimer);
  syncTimer = clockTimer = null;

  clockOffsetMs = null;
  calibratingGeneration = null;
  lastSyncMediaId = lastSyncRevision = null;
  outOfSyncChecks = 0;
  lastCorrectionAt = -Infinity;
}

function startSync() {
  stopSync();

  if (!socket.connected || document.hidden) return;

  const generation = syncGeneration;

  void syncClock(generation);

  clockTimer = setInterval(
    () => void syncClock(generation),
    30000
  );

  syncTimer = setInterval(checkDrift, 500);
}

socket.on('connect', startSync);
socket.on('disconnect', stopSync);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopSync();
  else startSync();
});

if (socket.connected) startSync();
