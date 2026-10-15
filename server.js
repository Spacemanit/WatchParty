import express from 'express';
import multer from 'multer';
import { Server } from 'socket.io';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Rooms, PartyError, youtubeId } from './lib/rooms.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const formats = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg' };

export async function createPartyServer(options = {}) {
  const uploadDir = options.uploadDir || path.join(root, '.data', 'uploads', randomUUID());
  await mkdir(uploadDir, { recursive: true });
  const app = express();
  app.disable('x-powered-by');
  const http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 16_384, serveClient: true });
  const cleanFile = file => file?.path && rm(file.path, { force: true }).catch(error => console.warn('Could not remove an unused upload:', error.code));
  const rooms = new Rooms({
    ...options.rooms,
    onChange: (room, activity) => io.to(room.code).emit('room:state', { state: rooms.snapshot(room), activity }),
    onDelete: room => cleanFile(room.media)
  });
  const maxUploadBytes = options.maxUploadBytes ?? Number(process.env.MAX_UPLOAD_MB || 2048) * 1024 * 1024;
  const upload = multer({
    storage: multer.diskStorage({ destination: uploadDir, filename: (req, file, cb) => cb(null, randomUUID() + path.extname(file.originalname).toLowerCase()) }),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 0 },
    fileFilter: (req, file, cb) => {
      if (!formats[path.extname(file.originalname).toLowerCase()]) return cb(new PartyError('Choose an MP4, WebM or OGV video. MP4 with H.264/AAC is recommended.'));
      cb(null, true);
    }
  });

  app.get('/api/config', (req, res) => {
    const port = http.address()?.port || 3000;
    const lanUrls = Object.values(os.networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal).map(item => `http://${item.address}:${port}`);
    res.json({ lanUrls, maxUploadBytes, maxMembers: rooms.maxMembers });
  });
  app.get('/api/health', (req, res) => res.json({ ok: true, rooms: rooms.rooms.size }));

  function uploadAuth(req, res, next) {
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      req.party = { ...rooms.authorize(req.params.code, token, true), token };
      req.party.generation = req.party.room.generation;
      next();
    } catch (error) { res.status(403).json({ error: error.message }); }
  }

  app.post('/api/rooms/:code/upload', uploadAuth, upload.single('video'), async (req, res, next) => {
    try {
      if (!req.file) throw new PartyError('Choose a video to upload.');
      const { room } = rooms.authorize(req.params.code, req.party.token, true);
      if (room !== req.party.room || room.generation !== req.party.generation) throw new PartyError('The room or video changed during upload. Try again.');
      if (!req.file.size) throw new PartyError('This video file is empty.');
      const media = { id: randomUUID(), kind: 'file', title: path.basename(req.file.originalname).slice(0, 180), path: req.file.path, type: formats[path.extname(req.file.originalname).toLowerCase()], size: req.file.size, uploadedBy: room.hostId };
      const old = rooms.select(room, media);
      await cleanFile(old);
      res.json({ ok: true, state: rooms.snapshot(room) });
    } catch (error) { await cleanFile(req.file); next(error); }
  });

  app.get('/api/rooms/:code/media/:id', (req, res) => {
    try {
      const { room } = rooms.authorize(req.params.code, req.query.token);
      if (room.media?.kind !== 'file' || room.media.id !== req.params.id) return res.status(404).json({ error: 'This video is no longer available.' });
      res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'Content-Type': room.media.type, 'X-Content-Type-Options': 'nosniff' });
      // Uploads live under .data; only this authenticated, generated path may bypass dotfile filtering.
      res.sendFile(room.media.path, { acceptRanges: true, dotfiles: 'allow' }, error => {
        if (error && !res.headersSent) res.status(error.statusCode || 500).end();
      });
    } catch (error) { res.status(403).json({ error: error.message }); }
  });

  app.use(express.static(path.join(root, 'public'), { etag: true }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const message = error.code === 'LIMIT_FILE_SIZE' ? `Video exceeds the ${Math.round(maxUploadBytes / 1024 / 1024)} MB upload limit.` : error instanceof PartyError || error instanceof multer.MulterError ? error.message : 'Something went wrong. Please try again.';
    if (!(error instanceof PartyError || error instanceof multer.MulterError)) console.error(error);
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
  });

  io.on('connection', socket => {
    let binding = null;
    const buckets = new Map();
    const handle = (event, fn) => socket.on(event, (payload, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const now = Date.now();
        let bucket = buckets.get(event);
        if (!bucket || now - bucket.start > 1000) buckets.set(event, bucket = { start: now, count: 0 });
        if (++bucket.count > (event === 'playback:action' ? 30 : 8)) throw new PartyError('Too many requests. Wait a moment and try again.');
        ack({ ok: true, ...fn(payload || {}) });
      } catch (error) {
        if (!(error instanceof PartyError)) console.error(error);
        ack({ ok: false, error: error instanceof PartyError ? error.message : 'Unable to complete this action.' });
      }
    });
    function attach({ room, member }) {
      binding = { code: room.code, id: member.id, token: member.token };
      socket.join(room.code);
      rooms.changed(room, `${member.name} joined the room.`);
      return { state: rooms.snapshot(room), selfId: member.id, token: member.token, chat: rooms.chatHistory(room) };
    }
    function bound() {
      if (!binding) throw new PartyError('Join a room first.');
      return rooms.authorize(binding.code, binding.token);
    }
    handle('room:create', ({ name }) => {
      if (binding) throw new PartyError('Leave your current room first.');
      return attach(rooms.create(name, socket.id));
    });
    handle('room:join', ({ code, name, token }) => {
      if (binding) throw new PartyError('Leave your current room first.');
      return attach(rooms.join(code, name, socket.id, token));
    });
    handle('room:snapshot', () => { const { room } = bound(); return { state: rooms.snapshot(room) }; });
    handle('chat:history', () => { const { room } = bound(); return { chat: rooms.chatHistory(room) }; });
    handle('chat:send', payload => {
      bound();
      const result = rooms.sendChat(binding.code, binding.token, payload);
      if (!result.duplicate) io.to(binding.code).emit('chat:message', { code: binding.code, message: result.message });
      return { message: result.message, duplicate: result.duplicate };
    });
    handle('room:leave', () => {
      bound();
      const prior = binding;
      binding = null;
      socket.leave(prior.code);
      rooms.disconnect(prior.code, prior.id, socket.id, true);
      return {};
    });
    handle('media:youtube', ({ url }) => {
      bound();
      const { room } = rooms.authorize(binding.code, binding.token, true);
      const videoId = youtubeId(url);
      if (!videoId) throw new PartyError('Enter a valid YouTube video link.');
      const old = rooms.select(room, { id: randomUUID(), kind: 'youtube', videoId, title: `YouTube · ${videoId}` });
      cleanFile(old);
      return { state: rooms.snapshot(room) };
    });
    handle('playback:action', payload => {
      bound();
      const room = rooms.playback(binding.code, binding.token, payload);
      return { state: rooms.snapshot(room) };
    });
    handle('host:transfer', ({ memberId }) => { bound(); rooms.transfer(binding.code, binding.token, memberId); return {}; });
    socket.on('disconnect', () => { if (binding) rooms.disconnect(binding.code, binding.id, socket.id); });
  });

  return {
    app, io, http, rooms,
    async listen(port = 3000, host = '0.0.0.0') { await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, host, resolve); }); return http.address(); },
    async close() { rooms.close(); await new Promise(resolve => io.close(resolve)); await rm(uploadDir, { recursive: true, force: true }); }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = await createPartyServer();
  const port = Number(process.env.PORT || 3000);
  await server.listen(port);
  console.log(`\n  WATCH PARTY\n  Local: http://localhost:${port}\n  Join from another device on the same Wi-Fi using:`);
  for (const network of Object.values(os.networkInterfaces()).flat()) if (network?.family === 'IPv4' && !network.internal) console.log(`  http://${network.address}:${port}`);
  console.log('\n  Keep this server running while your party is active.\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
}
