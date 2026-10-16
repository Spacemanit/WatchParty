import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { repairMp4Keyframes, Mp4IndexError } from '../lib/mp4.js';
import { createPartyServer } from '../server.js';
import { io } from 'socket.io-client';

const u32 = (...values) => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32BE(value, index * 4));
  return bytes;
};
const atom = (type, ...parts) => {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(payload.length + 8), Buffer.from(type), payload]);
};

// Small structural fixture with AVC NAL headers; it does not claim to decode video.
function fixture({ before = false, wide = false, fixed = false, valid = false, idr = true, openEnded = false } = {}) {
  const ftyp = atom('ftyp', Buffer.from('isom'), u32(0), Buffer.from('isomavc1'));
  const samples = [idr ? 0x65 : 0x41, 0x41, idr ? 0x65 : 0x41].map(nal => Buffer.concat([u32(2), Buffer.from([nal, 0x80])]));
  const media = Buffer.concat([...samples, Buffer.from([1, 2, 3, 4])]);
  const mdat = atom('mdat', media);
  if (openEnded) mdat.writeUInt32BE(0);
  const sync = valid ? atom('stss', u32(0, 2, 1, 3)) : atom('stss', u32(0, 0));
  function track(kind, offset) {
    const audio = kind === 'soun';
    const codec = audio ? atom('mp4a', Buffer.alloc(28)) : atom('avc1', Buffer.alloc(78), atom('avcC', Buffer.from([1, 66, 0, 30, 255])));
    const chunk = wide ? atom('co64', u32(0, 1, 0, offset)) : atom('stco', u32(0, 1, offset));
    const sizes = audio ? atom('stsz', u32(0, 4, 1)) :
      fixed ? atom('stsz', u32(0, 6, 3)) : atom('stsz', u32(0, 0, 3, ...samples.map(sample => sample.length)));
    const stbl = atom('stbl', atom('stsd', u32(0, 1), codec), sizes, chunk,
      atom('stsc', u32(0, 1, 1, audio ? 1 : 3, 1)), audio ? (valid ? Buffer.alloc(0) : atom('stss', u32(0, 0))) : sync);
    return atom('trak', atom('mdia', atom('hdlr', u32(0, 0), Buffer.from(kind)), atom('minf', stbl)));
  }
  const metadata = offset => atom('moov', track('vide', offset), track('soun', offset + samples.reduce((sum, sample) => sum + sample.length, 0)));
  const moov = metadata(ftyp.length + (before ? metadata(0).length : 0) + 8);
  return { bytes: Buffer.concat(before ? [ftyp, moov, mdat] : [ftyp, mdat, moov]), media };
}

function children(buffer, start = 0, end = buffer.length) {
  const boxes = [];
  for (let at = start; at < end;) {
    const raw = buffer.readUInt32BE(at), size = raw || end - at;
    assert(size >= 8 && at + size <= end, 'Box boundaries remain valid');
    boxes.push({ type: buffer.toString('ascii', at + 4, at + 8), start: at, data: at + 8, end: at + size });
    at += size;
  }
  return boxes;
}

function inspect(buffer) {
  const top = children(buffer), moov = top.find(box => box.type === 'moov');
  const indexes = [], offsets = [];
  function visit(box) {
    if (box.type === 'stss') {
      const count = buffer.readUInt32BE(box.data + 4);
      indexes.push(Array.from({ length: count }, (_, index) => buffer.readUInt32BE(box.data + 8 + index * 4)));
    }
    if (box.type === 'stco' || box.type === 'co64') offsets.push(box.type === 'co64' ? Number(buffer.readBigUInt64BE(box.data + 8)) : buffer.readUInt32BE(box.data + 8));
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.type)) children(buffer, box.data, box.end).forEach(visit);
  }
  visit(moov);
  return { top, indexes, offsets, media: top.filter(box => box.type === 'mdat').map(box => buffer.subarray(box.data, box.end)) };
}

async function localFile(t, bytes) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'watchparty-mp4-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'upload.mp4');
  await writeFile(filename, bytes);
  return { directory, filename };
}

test('empty AVC/AAC indexes are repaired without moving or changing media bytes', async t => {
  for (const options of [{}, { before: true }, { wide: true }, { fixed: true }, { before: true, openEnded: true }]) {
    const { bytes, media } = fixture(options);
    const { filename } = await localFile(t, bytes);
    const previous = inspect(bytes);
    const result = await repairMp4Keyframes(filename);
    assert.equal(result.repaired, true);
    const repaired = await readFile(filename), next = inspect(repaired);
    assert.equal(result.size, repaired.length);
    assert.deepEqual(next.indexes, [[1, 3]], 'Video uses actual IDR frames; empty AAC table is removed');
    assert.deepEqual(next.offsets, previous.offsets);
    assert.deepEqual(next.media, [media]);
    assert.equal(next.top.filter(box => box.type === 'moov').length, 1);
    assert(next.top.some(box => box.type === 'free'));
    assert.equal((await repairMp4Keyframes(filename)).repaired, false, 'Repair is idempotent');
    assert.deepEqual(await readFile(filename), repaired);
  }
});

test('valid MP4s and non-MP4 byte fixtures pass through unchanged', async t => {
  for (const bytes of [fixture({ valid: true }).bytes, Buffer.from('not a recognizable mp4'), Buffer.alloc(0)]) {
    const { filename } = await localFile(t, bytes);
    assert.deepEqual(await repairMp4Keyframes(filename), { repaired: false, size: bytes.length });
    assert.deepEqual(await readFile(filename), bytes);
  }
});

test('missing IDR frames and invalid sample offsets fail before changing the file', async t => {
  const noIdr = fixture({ idr: false }).bytes;
  const badOffset = Buffer.from(fixture().bytes);
  const marker = badOffset.indexOf(Buffer.from('stco'));
  badOffset.writeUInt32BE(0xffffffff, marker + 12);
  const hugeMetadata = Buffer.concat([atom('ftyp', Buffer.from('isom')), u32(0xffffffff), Buffer.from('moov')]);
  for (const bytes of [noIdr, badOffset, hugeMetadata]) {
    const { filename } = await localFile(t, bytes);
    await assert.rejects(repairMp4Keyframes(filename), Mp4IndexError);
    assert.deepEqual(await readFile(filename), bytes);
  }
});

test('HTTP upload publishes a repaired file with correct size and working range responses', async t => {
  const { directory } = await localFile(t, Buffer.alloc(0));
  const server = await createPartyServer({ uploadDir: path.join(directory, 'uploads') });
  t.after(() => server.close());
  const address = await server.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const socket = io(base, { reconnection: false });
  t.after(() => socket.disconnect());
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  const party = await new Promise((resolve, reject) => socket.timeout(2000).emit('room:create', { name: 'MP4 host' }, (error, response) => error ? reject(error) : resolve(response)));
  const upload = async bytes => {
    const form = new FormData(); form.append('video', new Blob([bytes], { type: 'video/mp4' }), 'recording.mp4');
    return fetch(`${base}/api/rooms/${party.state.code}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${party.token}` }, body: form });
  };
  const response = await upload(fixture().bytes);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.state.position, 0);
  assert.equal(result.state.playing, false);
  const url = `${base}/api/rooms/${party.state.code}/media/${result.state.media.id}?token=${party.token}`;
  const stream = await fetch(url), bytes = Buffer.from(await stream.arrayBuffer());
  assert.equal(bytes.length, result.state.media.size);
  assert.deepEqual(inspect(bytes).indexes, [[1, 3]]);
  const ranged = await fetch(url, { headers: { Range: 'bytes=8-31' } });
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(8, 32));
  const failed = await upload(fixture({ idr: false }).bytes);
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /broken playback index/);
  assert.equal((await fetch(url)).status, 200, 'An unrepairable replacement keeps the current video');
});
