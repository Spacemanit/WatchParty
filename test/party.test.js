import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createPartyServer } from '../server.js';
import { youtubeId } from '../lib/rooms.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = (socket, event, data = {}) => new Promise((resolve, reject) => socket.timeout(2000).emit(event, data, (error, response) => error ? reject(error) : resolve(response)));

async function fixture(t, options = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'watchparty-test-'));
  const server = await createPartyServer({ uploadDir: path.join(temp, '.data', 'uploads'), ...options });
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const clients = [];
  t.after(async () => { clients.forEach(socket => socket.disconnect()); await server.close(); await rm(temp, { recursive: true, force: true }); });
  async function connect() {
    const socket = io(base, { transports: ['websocket'], forceNew: true, reconnection: false });
    clients.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  }
  const host = await connect();
  const party = await emit(host, 'room:create', { name: 'Host' });
  assert.equal(party.ok, true);
  return { server, base, host, party, connect };
}

test('YouTube links are parsed without accepting lookalike domains', () => {
  for (const link of ['https://youtu.be/dQw4w9WgXcQ?t=2', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/live/dQw4w9WgXcQ']) assert.equal(youtubeId(link), 'dQw4w9WgXcQ');
  for (const link of ['javascript:alert(1)', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'https://youtu.be/bad', '', null]) assert.equal(youtubeId(link), null);
});

test('10 concurrent participants receive ordered host controls; guests cannot control or change the source', async t => {
  const { host, party, connect } = await fixture(t);
  const guests = await Promise.all(Array.from({ length: 9 }, () => connect()));
  const joins = [];
  for (const [index, socket] of guests.entries()) joins.push(await emit(socket, 'room:join', { code: party.state.code.toLowerCase(), name: `Guest ${index + 1}` }));
  assert(joins.every(result => result.ok));
  assert.equal((await emit(host, 'room:snapshot')).state.members.filter(member => member.online).length, 10);
  const selected = await emit(host, 'media:youtube', { url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(selected.ok, true);
  const mediaId = selected.state.media.id;
  assert.equal((await emit(guests[0], 'playback:action', { mediaId, action: 'play', position: 0 })).ok, false);
  assert.equal((await emit(guests[0], 'media:youtube', { url: 'https://youtu.be/dQw4w9WgXcQ' })).ok, false);
  const received = guests.map(socket => new Promise(resolve => socket.once('room:state', resolve)));
  const playing = await emit(host, 'playback:action', { mediaId, action: 'play', position: 12 });
  assert.equal(playing.ok, true);
  for (const event of await Promise.all(received)) { assert.equal(event.state.playing, true); assert.equal(event.state.sequence, playing.state.sequence); }
  const commands = await Promise.all([
    emit(host, 'playback:action', { mediaId, action: 'seek', position: 45 }),
    emit(host, 'playback:action', { mediaId, action: 'pause', position: 46 })
  ]);
  assert(commands[1].state.sequence > commands[0].state.sequence);
  const final = await emit(guests[8], 'room:snapshot');
  assert.equal(final.state.playing, false);
  assert.equal(final.state.position, 46);
  assert.equal(JSON.stringify(final.state).includes(party.token), false);
});

test('late joins receive current playback and reconnecting sessions retain identity', async t => {
  const { host, party, connect } = await fixture(t);
  const media = await emit(host, 'media:youtube', { url: 'https://youtu.be/dQw4w9WgXcQ' });
  await emit(host, 'playback:action', { mediaId: media.state.media.id, action: 'play', position: 100 });
  await delay(100);
  const guest = await connect();
  const joined = await emit(guest, 'room:join', { code: party.state.code, name: 'Returning guest' });
  assert.equal(joined.state.playing, true);
  assert(joined.state.position >= 100.08);
  guest.disconnect();
  await delay(30);
  const returning = await connect();
  const resumed = await emit(returning, 'room:join', { code: party.state.code, token: joined.token });
  assert.equal(resumed.selfId, joined.selfId);
  assert.equal(resumed.token, joined.token);
  assert.equal(resumed.state.members.length, 2);
  assert.equal((await emit(await connect(), 'room:join', { code: party.state.code, token: joined.token })).ok, false);
  assert.equal((await emit(await connect(), 'room:join', { code: party.state.code, token: 'forged', name: 'Intruder' })).ok, false);
});

test('manual transfer enforces the new host and disconnected hosts are replaced after the grace period', async t => {
  const { host, party, connect } = await fixture(t, { rooms: { graceMs: 50 } });
  const guest = await connect();
  const joined = await emit(guest, 'room:join', { code: party.state.code, name: 'New host' });
  assert.equal((await emit(host, 'host:transfer', { memberId: joined.selfId })).ok, true);
  assert.equal((await emit(host, 'media:youtube', { url: 'https://youtu.be/dQw4w9WgXcQ' })).ok, false);
  assert.equal((await emit(guest, 'media:youtube', { url: 'https://youtu.be/dQw4w9WgXcQ' })).ok, true);
  guest.disconnect();
  await delay(100);
  assert.equal((await emit(host, 'room:snapshot')).state.hostId, party.selfId);
  assert.equal((await emit(host, 'media:youtube', { url: 'https://youtu.be/dQw4w9WgXcQ' })).ok, true);
});

test('uploads require a host; streams support ranges, suffix ranges, HEAD and authorization', async t => {
  const { base, host, party, connect } = await fixture(t);
  const guest = await connect();
  const joined = await emit(guest, 'room:join', { code: party.state.code, name: 'Viewer' });
  const bytes = new Uint8Array(4096).map((_, i) => i % 256);
  const form = () => { const body = new FormData(); body.append('video', new Blob([bytes], { type: 'video/mp4' }), 'test.mp4'); return body; };
  const uploadUrl = `${base}/api/rooms/${party.state.code}/upload`;
  assert.equal((await fetch(uploadUrl, { method: 'POST', body: form(), headers: { Authorization: `Bearer ${joined.token}` } })).status, 403);
  const response = await fetch(uploadUrl, { method: 'POST', body: form(), headers: { Authorization: `Bearer ${party.token}` } });
  assert.equal(response.status, 200);
  const uploaded = await response.json();
  const media = uploaded.state.media;
  assert.equal(media.size, 4096);
  assert.equal(media.path, undefined);
  const url = `${base}/api/rooms/${party.state.code}/media/${media.id}?token=${joined.token}`;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
  const range = await fetch(url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 100-199/4096');
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), bytes.slice(100, 200));
  const suffix = await fetch(url, { headers: { Range: 'bytes=-20' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), bytes.slice(-20));
  assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('accept-ranges'), 'bytes');
  assert.equal((await fetch(url, { headers: { Range: 'bytes=9999-' } })).status, 416);
  assert.equal((await fetch(url.replace(joined.token, 'forged'))).status, 403);
  await emit(host, 'host:transfer', { memberId: joined.selfId });
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(uploadUrl, { method: 'POST', body: form(), headers: { Authorization: `Bearer ${party.token}` } })).status, 403);
  await emit(guest, 'media:youtube', { url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await emit(guest, 'playback:action', { mediaId: media.id, action: 'play', position: 0 })).ok, false);
});

test('invalid room, names, upload types, upload size and playback values return useful errors', async t => {
  const { base, host, party, connect } = await fixture(t, { maxUploadBytes: 16 });
  const guest = await connect();
  assert.equal((await emit(guest, 'room:join', { code: 'NOPE12', name: 'Guest' })).ok, false);
  assert.equal((await emit(guest, 'room:join', { code: party.state.code, name: '  ' })).ok, false);
  const upload = async (filename, size) => {
    const body = new FormData(); body.append('video', new Blob([new Uint8Array(size)]), filename);
    return fetch(`${base}/api/rooms/${party.state.code}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${party.token}` }, body });
  };
  assert.equal((await upload('bad.exe', 4)).status, 400);
  assert.equal((await upload('big.mp4', 17)).status, 413);
  assert.equal((await upload('empty.mp4', 0)).status, 400);
  const selected = await emit(host, 'media:youtube', { url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal((await emit(host, 'playback:action', { mediaId: selected.state.media.id, action: 'seek', position: -1 })).ok, false);
  assert.equal((await emit(host, 'playback:action', { mediaId: selected.state.media.id, action: 'seek', position: 'hello' })).ok, false);
  assert.equal((await emit(host, 'media:youtube', { url: 'https://evil.test/watch?v=dQw4w9WgXcQ' })).ok, false);
});

test('room capacity, explicit leaving, isolation and expired sessions are handled', async t => {
  const { party, host, connect, server } = await fixture(t, { rooms: { maxMembers: 2, expiryMs: 60, graceMs: 20 } });
  const guest = await connect();
  const joined = await emit(guest, 'room:join', { code: party.state.code, name: 'Guest' });
  const other = await connect();
  assert.equal((await emit(other, 'room:join', { code: party.state.code, name: 'Extra' })).ok, false);
  const otherRoom = await emit(other, 'room:create', { name: 'Other host' });
  assert.equal(otherRoom.ok, true);
  assert.notEqual(otherRoom.state.code, party.state.code);
  assert.equal((await emit(other, 'room:snapshot')).state.members.length, 1);
  guest.disconnect();
  await delay(100);
  const expired = await emit(await connect(), 'room:join', { code: party.state.code, token: joined.token });
  assert.equal(expired.ok, false);
  assert.equal((await emit(host, 'room:leave')).ok, true);
  assert.equal(server.rooms.rooms.has(party.state.code), false);
  assert.equal((await emit(host, 'room:snapshot')).ok, false);
});

