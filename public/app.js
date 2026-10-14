/* Plain browser JavaScript. Socket.IO carries room state; HTTP carries video bytes. */
'use strict';

const $ = id => document.getElementById(id);
const socket = io({ reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 4000, timeout: 8000 });
const video = $('local-player');
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

function readStorage(store, key, fallback = null) {
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveStorage(store, key, value) { try { value === null ? store.removeItem(key) : store.setItem(key, JSON.stringify(value)); } catch { /* Private browsing may disable storage. */ } }
let savedSession = readStorage(sessionStorage, 'watchparty.session');
$('display-name').value = readStorage(localStorage, 'watchparty.name', '');

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
  $('toast-stack').append(item);
  while ($('toast-stack').children.length > 3) $('toast-stack').firstChild.remove();
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
function connection(status, text) { $('connection').className = `connection ${status}`; $('connection').lastElementChild.textContent = text; renderPermissions(); }

function openRoomDialog(nextMode, code = '') {
  mode = nextMode;
  $('create-tab').classList.toggle('active', mode === 'create');
  $('join-tab').classList.toggle('active', mode === 'join');
  $('join-code-field').hidden = mode !== 'join';
  $('join-code').required = mode === 'join';
  if (code) $('join-code').value = code.toUpperCase();
  $('dialog-title').textContent = mode === 'create' ? 'Create a party.' : 'Enter the code.';
  $('room-submit').replaceChildren(document.createTextNode(mode === 'create' ? 'Create my party' : 'Join the fun'), icon('arrow'));
  $('room-error').hidden = true;
  if (!$('room-dialog').open) $('room-dialog').showModal();
}

$('create-open').addEventListener('click', () => openRoomDialog('create'));
$('join-open').addEventListener('click', () => openRoomDialog('join'));
$('create-tab').addEventListener('click', () => openRoomDialog('create'));
$('join-tab').addEventListener('click', () => openRoomDialog('join'));
$('screen-start').addEventListener('click', () => room ? $('youtube-url').focus() : openRoomDialog('create'));
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('room-menu-open').addEventListener('click', () => { if (room) $('party-dialog').showModal(); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
}));
$('room-dialog').addEventListener('close', () => { if (!room) { pendingFile = null; pendingSource = null; } });

$('room-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('room-submit').disabled = true;
  $('room-error').hidden = true;
  try {
    const name = $('display-name').value.trim();
    const data = await request(mode === 'create' ? 'room:create' : 'room:join', { name, code: $('join-code').value.trim() });
    saveStorage(localStorage, 'watchparty.name', name);
    adoptRoom(data);
    $('room-dialog').close();
    toast(mode === 'create' ? 'Your room is ready. Save your people a seat.' : 'You’re in. Make yourself comfortable.');
    if (pendingFile && isHost()) { const file = pendingFile; pendingFile = null; uploadFile(file); }
    if (pendingSource && isHost()) { pendingSource = null; addYouTube(); }
  } catch (error) { $('room-error').textContent = error.message; $('room-error').hidden = false; }
  finally { $('room-submit').disabled = false; }
});

function adoptRoom(data) {
  identity = { selfId: data.selfId, token: data.token };
  savedSession = { code: data.state.code, ...identity };
  saveStorage(sessionStorage, 'watchparty.session', savedSession);
  room = null;
  applyState(data.state, true);
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
  $('play-button').disabled = !controllable || !hasMedia || sourceLoading || !$('player-error').hidden;
  $('seek').disabled = !controllable || !hasMedia || sourceLoading || !duration() || !$('player-error').hidden;
  $('upload-button').disabled = Boolean(room && !controllable) || Boolean(uploadRequest);
  $('youtube-url').disabled = Boolean(room && !controllable);
  $('youtube-submit').disabled = Boolean(room && !controllable);
  $('mute-button').disabled = !hasMedia;
  $('volume').disabled = !hasMedia;
  $('invite-button').disabled = !room;
  $('copy-code').disabled = !room;
  $('control-label').replaceChildren(icon('crown'), document.createTextNode(isHost() ? 'YOU CONTROL PLAYBACK' : 'HOST CONTROLS PLAYBACK'));
  $('source-permission').textContent = room ? isHost() ? 'HOST CONTROLS · THAT’S YOU' : 'YOUR HOST PICKS THE PICTURE' : 'YOUR VIDEO. YOUR CHOICE.';
  $('create-open').disabled = $('join-open').disabled = !socket.connected || restoring;
  $('leave-button').disabled = !socket.connected || restoring;
}

function renderRoom() {
  $('home-view').hidden = Boolean(room);
  $('party-view').hidden = !room;
  $('lobby-actions').hidden = Boolean(room);
  $('room-actions').hidden = !room;
  $('heading-description').textContent = room ? isHost() ? 'Your room. Your people. You have the controls.' : 'You’re in good company. Settle in.' : 'Different places. One movie night.';
  $('room-code').textContent = room?.code || '— — — — — —';
  $('room-code').classList.toggle('empty-code', !room);
  const members = room?.members || [];
  const host = members.find(member => member.id === room?.hostId);
  const title = host ? `${host.name}’s party` : 'Your party';
  $('party-title').textContent = title;
  $('menu-title').textContent = title;
  $('menu-room-code').textContent = room?.code || '';
  $('menu-members').replaceChildren();
  for (const member of members) {
    const item = document.createElement('span');
    item.className = `popup-member${member.online ? '' : ' offline'}`;
    item.textContent = `${member.name}${member.id === room.hostId ? ' · Host' : ''}${member.id === identity?.selfId ? ' · You' : ''}${member.online ? '' : ' · Reconnecting'}`;
    $('menu-members').append(item);
  }
  const online = members.filter(member => member.online).length;
  $('member-count').textContent = String(members.length).padStart(2, '0');
  $('online-count').textContent = `${online} ONLINE`;
  $('empty-guests').hidden = Boolean(room);
  $('invite-description').textContent = room ? 'Share a code. Save someone a seat.' : 'Good nights start with good company.';
  $('room-bottom-text').textContent = room ? `${online} ${online === 1 ? 'person' : 'people'}. One shared screen.` : 'A private space for your people.';
  $('member-list').replaceChildren();
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
    $('member-list').append(row);
  }
  $('now-playing').hidden = !room?.media;
  $('media-title').textContent = room?.media?.title || '';
  $('media-type').textContent = room?.media?.kind === 'youtube' ? 'YOUTUBE' : 'LOCAL VIDEO';
  $('source-badge').textContent = room?.media ? room.playing ? 'PLAYING TOGETHER' : 'READY WHEN YOU ARE' : 'WAITING FOR A VIDEO';
  $('screen-note').textContent = room ? isHost() ? 'You have the controls. Everyone follows your play, pause and seek.' : 'Your host controls the picture. Volume is all yours.' : 'One host. A shared screen. A proper movie night.';
  $('screen-start').textContent = room ? isHost() ? 'Choose your first video ↓' : 'Your host is choosing the video' : 'Create a party to begin';
  $('screen-start').disabled = Boolean(room && !isHost());
  setIcon($('play-button'), room?.playing ? 'pause' : 'play');
  $('play-button').setAttribute('aria-label', room?.playing ? 'Pause for everyone' : 'Play for everyone');
  renderPermissions();
}

function resetParty() {
  for (const id of ['party-dialog', 'invite-dialog']) if ($(id).open) $(id).close();
  if (uploadRequest) uploadRequest.abort();
  room = null; identity = null; savedSession = null; pendingSource = null; pendingFile = null;
  saveStorage(sessionStorage, 'watchparty.session', null);
  loadMedia(null);
  renderRoom();
  $('activity-text').textContent = 'Your next movie night starts here.';
  const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
}
$('leave-button').addEventListener('click', async () => {
  try { await request('room:leave'); resetParty(); toast('You left the room. Until the next movie night.'); }
  catch (error) { toast(error.message, true); }
});

socket.on('connect', async () => {
  connection('online', 'Connected');
  if (savedSession && !restoring) {
    restoring = true; renderPermissions();
    try {
      const result = await request('room:join', { code: savedSession.code, token: savedSession.token });
      adoptRoom(result); $('activity-text').textContent = 'Back in the room. Your place was saved.';
    } catch (error) {
      if (!socket.connected) return;
      const previousCode = savedSession.code;
      resetParty(); openRoomDialog('join', previousCode);
      $('room-error').textContent = error.message; $('room-error').hidden = false;
    } finally { restoring = false; renderRoom(); }
  }
});
socket.on('disconnect', () => {
  connection('offline', 'Reconnecting');
  video.pause(); if (ytReady) yt.pauseVideo();
  $('activity-text').textContent = 'Connection lost. Playback is paused here while we reconnect.';
  renderRoom();
});
socket.on('connect_error', () => connection('offline', 'Server unavailable'));
socket.on('room:state', ({ state, activity }) => {
  if (!identity || room?.code !== state.code) return;
  applyState(state);
  if (activity) $('activity-text').textContent = activity;
});

function clearPlayerError() { $('player-error').hidden = true; playbackFailureId = null; }
function playerError(message) { $('player-error-text').textContent = message; $('player-error').hidden = false; }
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
  clearPlayerError(); $('playback-gate').hidden = true;
  video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
  if (yt) { yt.destroy(); yt = null; }
  ytReady = false;
  $('youtube-wrap').replaceChildren(Object.assign(document.createElement('div'), { id: 'youtube-player' }));
  $('youtube-wrap').hidden = true;
  $('empty-screen').hidden = Boolean(media);
  $('current-time').textContent = $('duration').textContent = '00:00';
  $('seek').value = '0';
  renderPermissions();
  if (!media) return;
  if (media.kind === 'file') {
    video.hidden = false;
    video.src = `/api/rooms/${room.code}/media/${media.id}?token=${encodeURIComponent(identity.token)}`;
    video.volume = Number($('volume').value) / 100;
    video.load();
  } else {
    $('youtube-wrap').hidden = false;
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
            event.target.setVolume(Number($('volume').value));
            if (video.muted) event.target.mute();
            renderPermissions(); syncLoadedPlayer(id);
          },
          onAutoplayBlocked: () => { if (currentMediaId === id) $('playback-gate').hidden = false; },
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
    video.currentTime = Math.min(target, Number.isFinite(video.duration) ? video.duration : target);
    if (room.playing) {
      const id = currentMediaId;
      video.play().then(() => { if (id === currentMediaId) $('playback-gate').hidden = true; }).catch(error => {
        if (id !== currentMediaId || !room?.playing || error.name === 'AbortError') return;
        if (error.name === 'NotAllowedError') $('playback-gate').hidden = false;
        else if (playbackFailureId !== id) { playbackFailureId = id; playerError('This browser could not decode the video. Try an MP4 encoded with H.264 video and AAC audio.'); }
      });
    } else { video.pause(); $('playback-gate').hidden = true; }
  } else if (ytReady) {
    yt.seekTo(target, true);
    if (room.playing) yt.playVideo();
    else { yt.pauseVideo(); $('playback-gate').hidden = true; }
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
$('retry-player').addEventListener('click', () => { if (room?.media) loadMedia(room.media); });
$('enable-playback').addEventListener('click', async () => {
  if (!room?.media) return;
  if (room.media.kind === 'file') video.play().catch(() => {});
  else if (ytReady) yt.playVideo();
  $('playback-gate').hidden = true;
  try { const result = await request('room:snapshot'); applyState(result.state, true); }
  catch (error) { toast(error.message, true); }
});

async function sendPlayback(action, target = position()) {
  if (!canControl() || !room?.media) return;
  try { const result = await request('playback:action', { action, position: target, mediaId: room.media.id }); applyState(result.state); }
  catch (error) { toast(error.message, true); }
}
$('play-button').addEventListener('click', () => {
  if (!canControl()) return;
  const action = room.playing ? 'pause' : 'play';
  if (action === 'play') {
    if (room.media.kind === 'file') video.play().catch(() => {});
    else if (ytReady) yt.playVideo();
  }
  sendPlayback(action);
});
$('seek').addEventListener('change', () => sendPlayback('seek', duration() * Number($('seek').value) / 1000));
$('seek').addEventListener('input', () => { $('current-time').textContent = time(duration() * Number($('seek').value) / 1000); });
function updateMute() { setIcon($('mute-button'), video.muted ? 'muted' : 'volume'); $('mute-button').setAttribute('aria-label', video.muted ? 'Unmute your audio' : 'Mute your audio'); }
$('mute-button').addEventListener('click', () => { video.muted = !video.muted; if (ytReady) video.muted ? yt.mute() : yt.unMute(); updateMute(); });
$('volume').addEventListener('input', () => { video.volume = Number($('volume').value) / 100; video.muted = false; if (ytReady) { yt.setVolume(Number($('volume').value)); yt.unMute(); } updateMute(); });
$('fullscreen-button').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('player-stage').closest('.theater').requestFullscreen) await $('player-stage').closest('.theater').requestFullscreen(); else toast('Fullscreen is not available in this browser.', true); }
  catch { toast('Your browser could not enter fullscreen.', true); }
});
setInterval(() => {
  if (!room?.media) return;
  const length = duration();
  $('duration').textContent = time(length);
  if (document.activeElement !== $('seek')) {
    $('current-time').textContent = time(position());
    $('seek').value = length ? Math.min(1000, position() / length * 1000) : 0;
  }
  $('seek').disabled = !canControl() || sourceLoading || !length || !$('player-error').hidden;
}, 250);

async function addYouTube() {
  if (!room) { pendingSource = 'youtube'; openRoomDialog('create'); return; }
  if (!canControl()) return toast('Only the host can change the video.', true);
  $('youtube-submit').disabled = true;
  try { const result = await request('media:youtube', { url: $('youtube-url').value }); applyState(result.state); $('youtube-url').value = ''; toast('YouTube video added. Hit play when everyone is ready.'); }
  catch (error) { toast(error.message, true); }
  finally { renderPermissions(); }
}
$('youtube-form').addEventListener('submit', event => { event.preventDefault(); addYouTube(); });
$('upload-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', () => { if ($('file-input').files[0]) uploadFile($('file-input').files[0]); $('file-input').value = ''; });
for (const eventName of ['dragenter', 'dragover']) $('upload-button').addEventListener(eventName, event => { event.preventDefault(); if (!room || canControl()) $('upload-button').classList.add('drag-over'); });
for (const eventName of ['dragleave', 'drop']) $('upload-button').addEventListener(eventName, event => { event.preventDefault(); $('upload-button').classList.remove('drag-over'); });
$('upload-button').addEventListener('drop', event => { if (event.dataTransfer.files[0] && !uploadRequest) uploadFile(event.dataTransfer.files[0]); });

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
  $('upload-progress').hidden = false; $('upload-meter').value = 0;
  $('upload-label').textContent = `Uploading ${file.name}…`;
  renderPermissions();
  xhr.open('POST', `/api/rooms/${code}/upload`); xhr.setRequestHeader('Authorization', `Bearer ${identity.token}`);
  xhr.upload.onprogress = event => {
    if (event.lengthComputable) { const percent = Math.round(event.loaded / event.total * 100); $('upload-meter').value = percent; $('upload-label').textContent = percent === 100 ? 'Getting your video ready…' : `Uploading your video · ${percent}%`; }
  };
  xhr.onload = () => {
    let response;
    try { response = JSON.parse(xhr.responseText); } catch { response = { error: 'The upload failed. Try again.' }; }
    if (xhr.status >= 200 && xhr.status < 300 && response.ok) { if (room?.code === code) applyState(response.state); toast('Your video is ready for its audience.'); }
    else toast(response.error || 'The upload failed. Try again.', true);
  };
  xhr.onerror = () => toast('Upload interrupted. Check your connection and try again.', true);
  xhr.onabort = () => toast('Upload cancelled.');
  xhr.onloadend = () => { uploadRequest = null; $('upload-progress').hidden = true; renderPermissions(); };
  xhr.send(data);
}
$('cancel-upload').addEventListener('click', () => uploadRequest?.abort());

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
$('copy-code').addEventListener('click', () => { if (room) copyText(room.code, 'Room code copied.'); });
$('menu-copy-code').addEventListener('click', () => { if (room) copyText(room.code, 'Party code copied.'); });
function updateInvite() { const url = new URL($('invite-address').value); url.searchParams.set('room', room.code); $('invite-url').textContent = url.href; }
function showInvite() {
  if (!room) return;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const addresses = [...new Set(local && config.lanUrls.length ? config.lanUrls : [location.origin, ...config.lanUrls])];
  $('invite-address').replaceChildren();
  for (const address of addresses) { const option = document.createElement('option'); option.value = address; option.textContent = address; $('invite-address').append(option); }
  updateInvite(); $('invite-dialog').showModal();
  copyText($('invite-url').textContent, 'Invite link copied. Send it to your people.');
}
$('invite-button').addEventListener('click', showInvite);
$('menu-invite').addEventListener('click', () => { $('party-dialog').close(); showInvite(); });
$('invite-address').addEventListener('change', updateInvite);
$('copy-invite-dialog').addEventListener('click', () => copyText($('invite-url').textContent, 'Invite link copied.'));

fetch('/api/config').then(response => response.json()).then(data => {
  config = data;
  const mb = Math.round(config.maxUploadBytes / 1024 ** 2);
  $('upload-formats').textContent = `MP4, WEBM, OGV · UP TO ${mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`}`;
}).catch(() => {});
renderRoom();
const invitedCode = new URL(location.href).searchParams.get('room');
if (invitedCode && savedSession?.code !== invitedCode.toUpperCase()) {
  savedSession = null; saveStorage(sessionStorage, 'watchparty.session', null);
  openRoomDialog('join', invitedCode);
}
