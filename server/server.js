// WatchParty sync server — authoritative room state, LWW concurrency,
// late-join snapshots, reconnect resume, drift accounting, latency instrumentation.
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// roomId -> room
const rooms = new Map();
// ws -> meta { roomId, clientId }
const peers = new Map();

function now() { return Date.now(); }
function genId(n = 6) {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += abc[b[i] % abc.length];
  return s;
}
function uid(prefix = 'c') { return prefix + '_' + crypto.randomBytes(4).toString('hex'); }

function newRoom(hostName) {
  const roomId = genId(6);
  const room = {
    id: roomId,
    createdAt: now(),
    hostId: null,
    seq: 0, // playback event sequence (LWW ordering)
    videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    videoTitle: 'Big Buck Bunny (sample)',
    isPlaying: false,
    position: 0,
    updatedAt: now(), // server time of last playback change
    lastActor: null,
    lastAction: 'init',
    users: new Map(), // clientId -> { clientId, name, joinedAt, lastSeen, connected }
    sockets: new Map(), // clientId -> ws
    playlist: [], // { id, url, title, addedBy, addedAt }
    chat: [], // { id, from, fromName, text, ts }
    polls: [], // { id, question, options:[{text,votes}], voters:{clientId:idx}, open, createdBy }
    reactions: [], // ephemeral log last 30 { emoji, fromName, ts }
    actionLog: [], // last 100 { seq, action, actor, position, serverTs }
    latencySamples: [], // { action, ms } server-side fanout cost
  };
  rooms.set(roomId, room);
  return room;
}

function roomSnapshot(room) {
  // authoritative position projected to now
  let pos = room.position;
  if (room.isPlaying) pos = room.position + (now() - room.updatedAt) / 1000;
  return {
    roomId: room.id,
    hostId: room.hostId,
    seq: room.seq,
    videoUrl: room.videoUrl,
    videoTitle: room.videoTitle,
    isPlaying: room.isPlaying,
    position: pos,
    serverTime: now(),
    lastActor: room.lastActor,
    lastAction: room.lastAction,
    users: [...room.users.values()].map(u => ({ clientId: u.clientId, name: u.name, connected: u.connected })),
    playlist: room.playlist,
    chat: room.chat.slice(-50),
    polls: room.polls,
    reactions: room.reactions.slice(-30),
  };
}

function broadcast(room, msg, except = null) {
  const t0 = now();
  const data = JSON.stringify(msg);
  let n = 0;
  for (const [, ws] of room.sockets) {
    if (ws.readyState === 1 && ws !== except) { ws.send(data); n++; }
  }
  const ms = now() - t0;
  room.latencySamples.push({ action: msg.type, fanoutMs: ms, peers: n, ts: now() });
  if (room.latencySamples.length > 500) room.latencySamples.shift();
  return { fanoutMs: ms, peers: n };
}

function applyPlayback(room, { action, position, actor }) {
  // LWW: server serializes -> seq++ wins. Concurrent actions within 100ms:
  // last arrival wins, but we keep actionLog so clients can show "X overrode Y".
  room.seq += 1;
  room.position = Math.max(0, Number(position) || 0);
  room.updatedAt = now();
  room.lastActor = actor;
  room.lastAction = action;
  if (action === 'play') room.isPlaying = true;
  if (action === 'pause') room.isPlaying = false;
  if (action === 'seek') { /* keep isPlaying */ }
  if (action === 'setVideo') room.isPlaying = false;
  room.actionLog.push({ seq: room.seq, action, actor, position: room.position, serverTs: room.updatedAt });
  if (room.actionLog.length > 100) room.actionLog.shift();
}

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      rooms: rooms.size,
      detail: [...rooms.values()].map(r => ({
        id: r.id, users: r.users.size, connected: r.sockets.size,
        seq: r.seq, fanoutAvg: avg(r.latencySamples.map(s => s.fanoutMs)),
      })),
    }));
    return;
  }
  res.writeHead(200); res.end('WatchParty sync server. Use ws://<host>:PORT');
});

function avg(a) { if (!a.length) return 0; return a.reduce((x, y) => x + y, 0) / a.length; }

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  peers.set(ws, {});
  send(ws, { type: 'hello', serverTime: now() });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'bad json' }); }
    const meta = peers.get(ws) || {};

    if (m.type === 'ping') return send(ws, { type: 'pong', t0: m.t0, serverTime: now() });

    if (m.type === 'create') {
      const room = newRoom(m.name);
      const clientId = uid('c');
      const name = String(m.name || 'Host').slice(0, 24) || 'Host';
      room.hostId = clientId;
      room.users.set(clientId, { clientId, name, joinedAt: now(), lastSeen: now(), connected: true });
      room.sockets.set(clientId, ws);
      peers.set(ws, { roomId: room.id, clientId });
      send(ws, { type: 'joined', clientId, snapshot: roomSnapshot(room), serverTime: now() });
      return;
    }

    if (m.type === 'join') {
      const roomId = String(m.roomId || '').toUpperCase().trim();
      const room = rooms.get(roomId);
      if (!room) return send(ws, { type: 'error', message: 'room-not-found' });
      // reconnect? client supplies previous clientId
      let clientId = m.clientId && room.users.has(m.clientId) ? m.clientId : uid('c');
      const name = String(m.name || 'Guest').slice(0, 24) || 'Guest';
      const existing = room.users.get(clientId);
      if (existing) { existing.connected = true; existing.lastSeen = now(); if (m.name) existing.name = name; }
      else room.users.set(clientId, { clientId, name, joinedAt: now(), lastSeen: now(), connected: true });
      if (!room.hostId || !room.users.get(room.hostId)?.connected) {
        // host gone -> oldest connected member becomes host (deterministic failover)
        const oldest = [...room.users.values()].filter(u => u.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
        if (oldest) room.hostId = oldest.clientId;
      }
      if (!room.hostId) room.hostId = clientId;
      room.sockets.set(clientId, ws);
      peers.set(ws, { roomId, clientId });
      // late-join: full snapshot so newcomer converges instantly
      send(ws, { type: 'joined', clientId, resumed: !!existing, snapshot: roomSnapshot(room), serverTime: now() });
      broadcast(room, { type: 'users', users: roomSnapshot(room).users, hostId: room.hostId, joined: clientId });
      return;
    }

    const { roomId, clientId } = meta;
    if (!roomId || !clientId) return send(ws, { type: 'error', message: 'join-first' });
    const room = rooms.get(roomId);
    if (!room) return send(ws, { type: 'error', message: 'room-gone' });
    const user = room.users.get(clientId);
    if (user) user.lastSeen = now();

    const tRecv = now();
    switch (m.type) {
      case 'play':
      case 'pause':
      case 'seek': {
        applyPlayback(room, { action: m.type, position: m.position, actor: clientId });
        const snap = roomSnapshot(room);
        const { fanoutMs, peers: n } = broadcast(room, {
          type: 'playback', action: m.type, actor: clientId,
          actorName: user?.name, position: room.position, isPlaying: room.isPlaying,
          serverTime: room.updatedAt, seq: room.seq, clientTs: m.clientTs || null,
        });
        // echo latency accounting back to actor: recv->fanout cost + instruction to measure e2e
        send(ws, { type: 'ack', seq: room.seq, fanoutMs, peers: n, serverCostMs: now() - tRecv });
        break;
      }
      case 'setVideo': {
        const url = String(m.url || '').slice(0, 2000);
        if (!url) return send(ws, { type: 'error', message: 'empty-url' });
        room.videoUrl = url;
        room.videoTitle = String(m.title || url).slice(0, 120);
        applyPlayback(room, { action: 'setVideo', position: 0, actor: clientId });
        broadcast(room, {
          type: 'playback', action: 'setVideo', actor: clientId, actorName: user?.name,
          position: 0, isPlaying: false, serverTime: room.updatedAt, seq: room.seq,
          videoUrl: room.videoUrl, videoTitle: room.videoTitle,
        });
        broadcast(room, { type: 'playlist', playlist: room.playlist });
        break;
      }
      case 'playlistAdd': {
        const item = { id: uid('v'), url: String(m.url).slice(0, 2000), title: String(m.title || m.url).slice(0, 120), addedBy: user?.name || 'anon', addedAt: now() };
        room.playlist.push(item);
        broadcast(room, { type: 'playlist', playlist: room.playlist });
        break;
      }
      case 'playlistRemove': {
        room.playlist = room.playlist.filter(v => v.id !== m.id);
        broadcast(room, { type: 'playlist', playlist: room.playlist });
        break;
      }
      case 'playlistNext': {
        const next = room.playlist.shift();
        if (next) {
          room.videoUrl = next.url; room.videoTitle = next.title;
          applyPlayback(room, { action: 'setVideo', position: 0, actor: clientId });
          broadcast(room, {
            type: 'playback', action: 'setVideo', actor: clientId, actorName: user?.name,
            position: 0, isPlaying: true, serverTime: room.updatedAt, seq: room.seq,
            videoUrl: room.videoUrl, videoTitle: room.videoTitle,
          });
          broadcast(room, { type: 'playlist', playlist: room.playlist });
        }
        break;
      }
      case 'chat': {
        const text = String(m.text || '').slice(0, 500);
        if (!text.trim()) break;
        const msg = { id: uid('m'), from: clientId, fromName: user?.name || 'anon', text, ts: now() };
        room.chat.push(msg); if (room.chat.length > 200) room.chat.shift();
        broadcast(room, { type: 'chatMsg', msg });
        break;
      }
      case 'reaction': {
        const r = { emoji: String(m.emoji).slice(0, 8), fromName: user?.name || '?', ts: now() };
        room.reactions.push(r); if (room.reactions.length > 30) room.reactions.shift();
        broadcast(room, { type: 'reaction', ...r });
        break;
      }
      case 'pollCreate': {
        const poll = {
          id: uid('p'), question: String(m.question).slice(0, 140),
          options: (m.options || []).slice(0, 6).map(t => ({ text: String(t).slice(0, 60), votes: 0 })),
          voters: {}, open: true, createdBy: user?.name || 'anon',
        };
        if (!poll.question || poll.options.length < 2) return send(ws, { type: 'error', message: 'bad-poll' });
        room.polls.push(poll);
        broadcast(room, { type: 'polls', polls: room.polls });
        break;
      }
      case 'pollVote': {
        const poll = room.polls.find(p => p.id === m.pollId);
        if (!poll || !poll.open) break;
        const prev = poll.voters[clientId];
        if (prev !== undefined && poll.options[prev]) poll.options[prev].votes--;
        poll.voters[clientId] = m.optionIdx;
        if (poll.options[m.optionIdx]) poll.options[m.optionIdx].votes++;
        broadcast(room, { type: 'polls', polls: room.polls });
        break;
      }
      case 'pollClose': {
        const poll = room.polls.find(p => p.id === m.pollId);
        if (poll) poll.open = false;
        broadcast(room, { type: 'polls', polls: room.polls });
        break;
      }
      case 'transferHost': {
        if (room.hostId !== clientId) return send(ws, { type: 'error', message: 'only-host-can-transfer' });
        if (!room.users.has(m.toClientId)) return send(ws, { type: 'error', message: 'unknown-user' });
        room.hostId = m.toClientId;
        broadcast(room, { type: 'hostChanged', hostId: room.hostId });
        broadcast(room, { type: 'users', users: roomSnapshot(room).users, hostId: room.hostId });
        break;
      }
      case 'stateSync': {
        // client drift report: server logs + nudges if needed
        const expected = room.isPlaying ? room.position + (now() - room.updatedAt) / 1000 : room.position;
        const drift = Number(m.position) - expected;
        if (Math.abs(drift) > 0.5) {
          send(ws, {
            type: 'correction', expected, serverTime: now(),
            isPlaying: room.isPlaying, position: expected, seq: room.seq,
          });
        }
        break;
      }
      case 'leave': {
        try { ws.close(); } catch {}
        break;
      }
      default: send(ws, { type: 'error', message: 'unknown-type' });
    }
  });

  ws.on('close', () => {
    const meta = peers.get(ws);
    peers.delete(ws);
    if (!meta?.roomId) return;
    const room = rooms.get(meta.roomId);
    if (!room) return;
    room.sockets.delete(meta.clientId);
    const u = room.users.get(meta.clientId);
    if (u) u.connected = false;
    // grace period: keep user 60s for reconnect resume, then prune
    setTimeout(() => {
      const r = rooms.get(meta.roomId);
      if (!r) return;
      const uu = r.users.get(meta.clientId);
      if (uu && !uu.connected && now() - uu.lastSeen > 60000) {
        r.users.delete(meta.clientId);
        r.sockets.delete(meta.clientId);
      }
      if (r.sockets.size === 0 && now() - r.createdAt > 1000 * 60 * 60 * 4) rooms.delete(meta.roomId);
    }, 65000);
    // host failover
    if (room.hostId === meta.clientId) {
      const oldest = [...room.users.values()].filter(x => x.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (oldest) {
        room.hostId = oldest.clientId;
        broadcast(room, { type: 'hostChanged', hostId: room.hostId, reason: 'host-left' });
      }
    }
    broadcast(room, { type: 'users', users: roomSnapshot(room).users, hostId: room.hostId, left: meta.clientId });
  });
});

server.listen(PORT, () => console.log(`WatchParty server on :${PORT}`));
