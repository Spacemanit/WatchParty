import { open } from 'node:fs/promises';

const MAX_METADATA = 32 * 1024 * 1024;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
export class Mp4IndexError extends Error {}
const invalid = () => new Mp4IndexError('This MP4 has a broken playback index that could not be repaired. Re-export it as an H.264/AAC MP4 and upload it again.');

function boxes(buffer, start = 0, end = buffer.length) {
  const result = [];
  while (start < end) {
    if (end - start < 8 || result.length >= 4096) throw invalid();
    let size = buffer.readUInt32BE(start);
    const header = size === 1 ? 16 : 8;
    if (end - start < header) throw invalid();
    if (size === 1) size = Number(buffer.readBigUInt64BE(start + 8));
    if (size === 0) size = end - start;
    if (!Number.isSafeInteger(size) || size < header || size > end - start) throw invalid();
    result.push({ type: buffer.toString('ascii', start + 4, start + 8), start, data: start + header, end: start + size, header });
    start += size;
  }
  return result;
}

function requireBytes(box, count) {
  if (!box || box.end - box.data < count) throw invalid();
  return box;
}

function table(buffer, box, prefix, stride, countOffset) {
  requireBytes(box, prefix);
  const count = buffer.readUInt32BE(box.data + countOffset);
  if (count > Math.floor((box.end - box.data - prefix) / stride)) throw invalid();
  return count;
}

async function read(file, position, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(buffer, done, length - done, position + done);
    if (!bytesRead) throw invalid();
    done += bytesRead;
  }
  return buffer;
}

async function write(file, buffer, position) {
  let done = 0;
  while (done < buffer.length) {
    const { bytesWritten } = await file.write(buffer, done, buffer.length - done, position + done);
    if (!bytesWritten) throw new Error('Could not write repaired MP4 metadata.');
    done += bytesWritten;
  }
}

async function keyframes(file, fileSize, buffer, children, entry) {
  const avc = boxes(buffer, requireBytes(entry, 78).data + 78, entry.end).find(box => box.type === 'avcC');
  requireBytes(avc, 5);
  const lengthBytes = (buffer[avc.data + 4] & 3) + 1;
  const sizes = children.find(box => box.type === 'stsz');
  requireBytes(sizes, 12);
  const fixedSize = buffer.readUInt32BE(sizes.data + 4);
  const sampleCount = buffer.readUInt32BE(sizes.data + 8);
  if (!fixedSize) table(buffer, sizes, 12, 4, 8);
  // Bound work even if a malformed file claims billions of tiny samples.
  if (sampleCount > 5_000_000) throw invalid();
  const chunks = children.find(box => box.type === 'stco' || box.type === 'co64');
  const width = chunks?.type === 'co64' ? 8 : 4;
  const chunkCount = table(buffer, chunks, 8, width, 4);
  const mapping = children.find(box => box.type === 'stsc');
  const mapCount = table(buffer, mapping, 8, 12, 4);
  if (!chunkCount || !mapCount || buffer.readUInt32BE(mapping.data + 8) !== 1) throw invalid();
  for (let i = 0; i < mapCount; i++) {
    const at = mapping.data + 8 + i * 12;
    if (!buffer.readUInt32BE(at + 4) || buffer.readUInt32BE(at + 8) !== 1 ||
        (i && buffer.readUInt32BE(at) <= buffer.readUInt32BE(at - 12))) throw invalid();
  }

  // Read small windows around NAL headers; do not load multi-GB videos into RAM.
  let window = Buffer.alloc(0), windowStart = -1;
  async function headerAt(position) {
    const needed = lengthBytes + 1;
    if (position < windowStart || position + needed > windowStart + window.length) {
      windowStart = position;
      window = await read(file, position, Math.min(65536, fileSize - position));
    }
    return window.subarray(position - windowStart, position - windowStart + needed);
  }
  const result = [];
  let sample = 0, map = 0;
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    while (map + 1 < mapCount && buffer.readUInt32BE(mapping.data + 8 + (map + 1) * 12) <= chunk) map++;
    const count = buffer.readUInt32BE(mapping.data + 12 + map * 12);
    if (count > sampleCount - sample) throw invalid();
    const at = chunks.data + 8 + (chunk - 1) * width;
    let position = width === 8 ? Number(buffer.readBigUInt64BE(at)) : buffer.readUInt32BE(at);
    if (!Number.isSafeInteger(position) || position < 0 || position > fileSize) throw invalid();
    for (let i = 0; i < count; i++, sample++) {
      const size = fixedSize || buffer.readUInt32BE(sizes.data + 12 + sample * 4);
      const end = position + size;
      if (end > fileSize) throw invalid();
      let idr = false;
      while (position < end) {
        if (end - position < lengthBytes + 1) throw invalid();
        const header = await headerAt(position);
        const length = header.readUIntBE(0, lengthBytes);
        if (!length || length > end - position - lengthBytes) throw invalid();
        if ((header[lengthBytes] & 31) === 5) idr = true; // AVC IDR picture.
        position += lengthBytes + length;
      }
      if (idr) result.push(sample + 1); // MP4 sample numbers start at one.
    }
  }
  if (sample !== sampleCount || !result.length) throw invalid();
  return result;
}

function syncBox(samples) {
  const buffer = Buffer.alloc(16 + samples.length * 4);
  buffer.writeUInt32BE(buffer.length, 0);
  buffer.write('stss', 4, 'ascii');
  buffer.writeUInt32BE(samples.length, 12);
  samples.forEach((sample, index) => buffer.writeUInt32BE(sample, 16 + index * 4));
  return buffer;
}

function rebuild(buffer, box, replacements, depth = 0) {
  if (depth > 8) throw invalid();
  if (replacements.has(box.start)) return replacements.get(box.start);
  if (!CONTAINERS.has(box.type)) return buffer.subarray(box.start, box.end);
  const content = boxes(buffer, box.data, box.end).map(child => rebuild(buffer, child, replacements, depth + 1)).filter(Boolean);
  const header = Buffer.from(buffer.subarray(box.start, box.data));
  const size = header.length + content.reduce((sum, child) => sum + child.length, 0);
  if (size > MAX_METADATA) throw invalid();
  if (box.header === 16) header.writeBigUInt64BE(BigInt(size), 8);
  else header.writeUInt32BE(size, 0);
  return Buffer.concat([header, ...content]);
}

// Repair only empty AVC/AAC sync tables. Valid files and other codecs pass through.
// The source on the user's computer is untouched: this runs on the uploaded copy.
export async function repairMp4Keyframes(filename) {
  const file = await open(filename, 'r+');
  try {
    const { size } = await file.stat();
    if (size < 8 || (await read(file, 0, 8)).toString('ascii', 4, 8) !== 'ftyp') return { repaired: false, size };
    const top = [];
    for (let start = 0; start < size;) {
      if (size - start < 8 || top.length >= 4096) throw invalid();
      const header = await read(file, start, Math.min(16, size - start));
      const rawSize = header.readUInt32BE(0), wide = rawSize === 1;
      if (wide && header.length < 16) throw invalid();
      const length = wide ? Number(header.readBigUInt64BE(8)) : rawSize || size - start;
      if (!Number.isSafeInteger(length) || length < (wide ? 16 : 8) || length > size - start) throw invalid();
      top.push({ type: header.toString('ascii', 4, 8), start, size: length, rawSize, header });
      start += length;
    }
    const moov = top.find(box => box.type === 'moov');
    if (!moov || top.some(box => box.type === 'moof')) return { repaired: false, size };
    if (moov.size > MAX_METADATA) throw invalid();
    const buffer = await read(file, moov.start, moov.size), root = boxes(buffer)[0];
    const replacements = new Map();
    for (const track of boxes(buffer, root.data, root.end).filter(box => box.type === 'trak')) {
      const child = (parent, type) => parent && boxes(buffer, parent.data, parent.end).find(box => box.type === type);
      const mdia = child(track, 'mdia'), handler = child(mdia, 'hdlr');
      requireBytes(handler, 12);
      const kind = buffer.toString('ascii', handler.data + 8, handler.data + 12);
      const stbl = child(child(mdia, 'minf'), 'stbl');
      if (!stbl) continue;
      const children = boxes(buffer, stbl.data, stbl.end), sync = child(stbl, 'stss');
      if (!sync || table(buffer, sync, 8, 4, 4) !== 0) continue;
      const sizes = child(stbl, 'stsz');
      if (!sizes || !buffer.readUInt32BE(requireBytes(sizes, 12).data + 8)) continue;
      const descriptions = requireBytes(child(stbl, 'stsd'), 8);
      if (buffer.readUInt32BE(descriptions.data + 4) !== 1) throw invalid();
      const entries = boxes(buffer, descriptions.data + 8, descriptions.end);
      if (entries.length !== 1) throw invalid();
      const entry = entries[0];
      if (kind === 'vide' && ['avc1', 'avc3'].includes(entry.type)) {
        replacements.set(sync.start, syncBox(await keyframes(file, size, buffer, children, entry)));
      } else if (kind === 'soun' && entry.type === 'mp4a') {
        replacements.set(sync.start, null); // AAC frames are independently seekable.
      }
    }
    if (!replacements.size) return { repaired: false, size };
    // Append new metadata and retire the original atom. Media offsets never move,
    // regardless of whether the original moov was before or after the video data.
    for (const box of top) if (box.rawSize === 0 && box.size > 0xffffffff) throw invalid();
    const repaired = rebuild(buffer, root, replacements);
    await write(file, repaired, size);
    for (const box of top) {
      if (box.rawSize === 0) {
        const explicitSize = Buffer.alloc(4);
        explicitSize.writeUInt32BE(box.size);
        await write(file, explicitSize, box.start);
      }
    }
    const retiredHeader = Buffer.from(moov.header.subarray(0, moov.rawSize === 1 ? 16 : 8));
    if (moov.rawSize === 0) retiredHeader.writeUInt32BE(moov.size);
    retiredHeader.write('free', 4, 'ascii');
    await write(file, retiredHeader, moov.start);
    return { repaired: true, size: size + repaired.length };
  } finally { await file.close(); }
}
