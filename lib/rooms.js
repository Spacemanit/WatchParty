import { randomBytes, randomUUID } from 'node:crypto';

export class PartyError extends Error {}

export function youtubeId(input) {
  try {
    const url = new URL(String(input).trim());
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    let id;
    if (['youtu.be', 'www.youtu.be'].includes(url.hostname)) id = url.pathname.split('/')[1];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(embed|shorts|live)\//.test(url.pathname) ? url.pathname.split('/')[2] : null;
    }
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

export function displayName(name) {
  if (typeof name !== 'string' || !name.trim()) throw new PartyError('Enter your display name to continue.');
  return name.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24) || 'Guest';
}

export class Rooms {
  constructor({ onChange = () => {}, onDelete = () => {}, graceMs = 20_000, expiryMs = 600_000, maxMembers = 20 } = {}) {
    Object.assign(this, { onChange, onDelete, graceMs, expiryMs, maxMembers });
    this.rooms = new Map();
    this.timers = new Set();
  }

  later(fn, ms) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    timer.unref();
    this.timers.add(timer);
    return timer;
  }

  create(name, socketId) {
    name = displayName(name);
    let code;
    do { code = Array.from(randomBytes(6), n => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n % 32]).join(''); } while (this.rooms.has(code));
    const room = { code, members: new Map(), hostId: null, media: null, playing: false, position: 0, updatedAt: Date.now(), sequence: 0, generation: 0, playbackRevision: 0 };
    this.rooms.set(code, room);
    const member = this.addMember(room, name, socketId);
    room.hostId = member.id;
    return { room, member };
  }

  addMember(room, name, socketId) {
    if (room.members.size >= this.maxMembers) throw new PartyError('This room is full. Try again in a moment.');
    const member = { id: randomUUID(), token: randomBytes(32).toString('hex'), name: displayName(name), socketId, joinedAt: Date.now(), disconnectedAt: null };
    room.members.set(member.id, member);
    return member;
  }

  join(code, name, socketId, token) {
    const room = this.get(code);
    let member = token && [...room.members.values()].find(item => item.token === token);
    if (member) {
      if (member.socketId && member.socketId !== socketId) throw new PartyError('This session is already open in another tab. Join with a new session.');
      member.socketId = socketId;
      member.disconnectedAt = null;
    } else {
      if (token) throw new PartyError('Your previous session expired. Join the room again.');
      member = this.addMember(room, name, socketId);
    }
    if (!room.hostId || !room.members.has(room.hostId)) room.hostId = member.id;
    return { room, member };
  }

  get(code) {
    const room = this.rooms.get(String(code || '').trim().toUpperCase());
    if (!room) throw new PartyError('Room not found. Check the code or create a new room.');
    return room;
  }

  authorize(code, token, host = false) {
    const room = this.get(code);
    const member = [...room.members.values()].find(item => item.token === token);
    if (!member) throw new PartyError('Join this room before accessing its video.');
    if (host && (room.hostId !== member.id || !member.socketId)) throw new PartyError('Only the connected host can do that.');
    return { room, member };
  }

  position(room) {
    return Math.max(0, room.position + (room.playing ? (Date.now() - room.updatedAt) / 1000 : 0));
  }

  snapshot(room) {
    return {
      code: room.code, hostId: room.hostId, sequence: room.sequence, playbackRevision: room.playbackRevision,
      media: room.media ? { id: room.media.id, kind: room.media.kind, title: room.media.title, videoId: room.media.videoId, size: room.media.size, uploadedBy: room.media.uploadedBy } : null,
      playing: room.playing, position: this.position(room), updatedAt: Date.now(),
      members: [...room.members.values()].map(({ id, name, socketId }) => ({ id, name, online: Boolean(socketId) }))
    };
  }

  changed(room, activity) {
    room.sequence += 1;
    this.onChange(room, activity);
  }

  select(room, media) {
    const old = room.media;
    room.media = media;
    room.position = 0;
    room.playing = false;
    room.updatedAt = Date.now();
    room.generation += 1;
    room.playbackRevision += 1;
    this.changed(room, `The host added ${media.title}.`);
    return old;
  }

  playback(code, token, { action, position, mediaId } = {}) {
    const { room } = this.authorize(code, token, true);
    if (!room.media) throw new PartyError('Add a video first.');
    if (mediaId !== room.media.id) throw new PartyError('The video changed. Try that control again.');
    if (!['play', 'pause', 'seek'].includes(action)) throw new PartyError('Unknown playback action.');
    if (typeof position !== 'number' || !Number.isFinite(position) || position < 0 || position > 604800) throw new PartyError('Invalid playback position.');
    room.position = position;
    room.updatedAt = Date.now();
    if (action !== 'seek') room.playing = action === 'play';
    room.playbackRevision += 1;
    this.changed(room);
    return room;
  }

  transfer(code, token, targetId) {
    const { room } = this.authorize(code, token, true);
    const next = room.members.get(targetId);
    if (!next?.socketId) throw new PartyError('Choose a participant who is online.');
    if (next.id === room.hostId) return;
    room.hostId = next.id;
    this.changed(room, `${next.name} is now the host.`);
  }

  remove(room, member) {
    room.members.delete(member.id);
    if (room.hostId === member.id) {
      room.hostId = [...room.members.values()].find(item => item.socketId)?.id || null;
    }
    this.changed(room, `${member.name} left the room.`);
    if (!room.members.size) this.destroy(room);
  }

  disconnect(code, memberId, socketId, explicit = false) {
    const room = this.rooms.get(code);
    const member = room?.members.get(memberId);
    if (!member || member.socketId !== socketId) return;
    if (explicit) return this.remove(room, member);
    member.socketId = null;
    member.disconnectedAt = Date.now();
    const disconnectedAt = member.disconnectedAt;
    this.changed(room, `${member.name} disconnected. Waiting for them to reconnect…`);
    this.later(() => {
      if (this.rooms.get(code) !== room || member.socketId || member.disconnectedAt !== disconnectedAt) return;
      if (room.hostId === member.id) {
        const next = [...room.members.values()].find(item => item.socketId);
        if (next) { room.hostId = next.id; this.changed(room, `${next.name} is now the host.`); }
      }
    }, this.graceMs);
    this.later(() => {
      if (this.rooms.get(code) !== room || member.socketId || member.disconnectedAt !== disconnectedAt) return;
      this.remove(room, member);
    }, this.expiryMs);
  }

  destroy(room) {
    if (this.rooms.get(room.code) !== room) return;
    this.rooms.delete(room.code);
    this.onDelete(room);
  }

  close() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
}
