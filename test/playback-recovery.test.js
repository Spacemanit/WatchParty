import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Rooms } from '../lib/rooms.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function pausedPlayer() {
  const gate = { hidden: true };
  const video = {
    paused: true, seeking: false, error: null, duration: 120,
    readyState: 4, currentTime: 10,
    play() { this.paused = false; return Promise.resolve(); }
  };
  const context = vm.createContext({
    socket: { connected: true }, restoring: false, sourceLoading: false,
    document: { hidden: false, getElementById: id => {
      assert.equal(id, 'playback-gate');
      return gate;
    } },
    room: { media: { kind: 'file', id: 'video' }, playing: true, position: 30, updatedAt: 1000, playbackRevision: 1 },
    currentMediaId: 'video', video,
    estimatedServerNow: () => { throw new Error('Paused players must wait for a fresh snapshot, not seek repeatedly.'); }
  });
  // Run the actual browser function with a simulated media element; no browser or decoding required.
  vm.runInContext(source.slice(source.indexOf('function checkDrift()'), source.indexOf('function stopSync()')), context);
  return { context, gate, video };
}

test('an unexpected local pause offers Join playback without repeatedly seeking the paused player', () => {
  const { context, gate, video } = pausedPlayer();
  for (let i = 0; i < 20; i++) context.checkDrift();
  assert.equal(gate.hidden, false);
  assert.equal(video.currentTime, 10);
  assert.equal(context.room.position, 30);
  assert.equal(context.room.playing, true);
});

test('disconnects, loading and hidden tabs do not offer premature playback recovery', () => {
  for (const setup of [
    context => { context.socket.connected = false; },
    context => { context.restoring = true; },
    context => { context.sourceLoading = true; },
    context => { context.document.hidden = true; },
    context => { context.video.readyState = 1; },
    context => { context.video.seeking = true; }
  ]) {
    const { context, gate } = pausedPlayer();
    setup(context);
    context.checkDrift();
    assert.equal(gate.hidden, true);
  }
});

test('Join playback requests a fresh timeline before applying the current room position', async () => {
  const { context, gate, video } = pausedPlayer();
  context.checkDrift();
  let click;
  const snapshot = { ...context.room, position: 45, updatedAt: 16000 };
  context.document.getElementById = id => {
    if (id === 'playback-gate') return gate;
    assert.equal(id, 'enable-playback');
    return { addEventListener: (event, handler) => { assert.equal(event, 'click'); click = handler; } };
  };
  context.request = async event => { assert.equal(event, 'room:snapshot'); return { state: snapshot }; };
  let applied = false;
  context.applyState = (state, force) => {
    assert.equal(state, snapshot);
    assert.equal(force, true);
    video.currentTime = state.position;
    applied = true;
  };
  context.toast = message => { throw new Error(message); };
  vm.runInContext(source.slice(source.indexOf("document.getElementById('enable-playback').addEventListener"), source.indexOf('async function sendPlayback(')), context);
  await click();
  assert.equal(applied, true);
  assert.equal(video.paused, false);
  assert.equal(video.currentTime, 45);
  assert.equal(gate.hidden, true);
});

test('joining during the host grace period preserves the host and reconnecting cancels takeover', t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const rooms = new Rooms({ graceMs: 20000 });
  t.after(() => rooms.close());
  const { room, member: host } = rooms.create('Host', 'original');
  rooms.disconnect(room.code, host.id, 'original');
  now += 19999;
  rooms.join(room.code, 'Guest', 'guest');
  assert.equal(room.hostId, host.id);
  rooms.join(room.code, undefined, 'returning', host.token);
  now += 20001;
  rooms.join(room.code, 'Another guest', 'another');
  assert.equal(room.hostId, host.id);
});

function hostControls({ roomPosition = 0, actual = 0, playing = false, onPlay = () => {} } = {}) {
  const handlers = new Map();
  const commands = [];
  const video = {
    currentTime: actual, duration: 26.88702,
    play() { onPlay(this); return Promise.resolve(); }
  };
  const context = vm.createContext({
    room: { media: { id: 'upload', kind: 'file' }, playing, position: roomPosition },
    video, sourceLoading: false, canControl: () => true,
    position: () => video.currentTime, duration: () => video.duration,
    document: { getElementById: id => ({ addEventListener: (event, callback) => handlers.set(`${id}:${event}`, callback) }) },
    sendPlayback: (action, target = video.currentTime) => commands.push({ action, target })
  });
  vm.runInContext(source.slice(source.indexOf("document.getElementById('play-button').addEventListener"), source.indexOf("document.getElementById('seek').addEventListener")), context);
  return { click: () => handlers.get('play-button:click')(), commands, video };
}

test('starting an upload publishes the paused room position even if native play changes currentTime', () => {
  const { click, commands } = hostControls({ onPlay: video => { video.currentTime = video.duration; } });
  click();
  assert.deepEqual(commands, [{ action: 'play', target: 0 }]);
});

test('Play resumes from the shared paused position instead of a stale local position', () => {
  for (const [roomPosition, actual] of [[0, 26.88702], [8.5, 0]]) {
    const { click, commands, video } = hostControls({ roomPosition, actual });
    click();
    assert.deepEqual(commands, [{ action: 'play', target: roomPosition }]);
    assert.equal(video.currentTime, roomPosition);
  }
});

test('Play at the end restarts from zero, while Pause captures the live player position', () => {
  const replay = hostControls({ roomPosition: 26.88702, actual: 26.88702 });
  replay.click();
  assert.deepEqual(replay.commands, [{ action: 'play', target: 0 }]);
  assert.equal(replay.video.currentTime, 0);
  const pause = hostControls({ roomPosition: 0, actual: 7.25, playing: true });
  pause.click();
  assert.deepEqual(pause.commands, [{ action: 'pause', target: 7.25 }]);
});

test('applying a matching playback snapshot does not interrupt native playback with another seek', async () => {
  let seeks = 0;
  const context = vm.createContext({
    socket: { connected: true }, room: { media: { kind: 'file' }, position: 0, playing: true },
    currentMediaId: 'upload', video: {
      readyState: 4, duration: 26.88702,
      get currentTime() { return 0; }, set currentTime(value) { seeks++; },
      play: () => Promise.resolve()
    }, document: { getElementById: () => ({ hidden: true }) }
  });
  vm.runInContext(source.slice(source.indexOf('function applyPlayback()'), source.indexOf('async function syncLoadedPlayer(')), context);
  context.applyPlayback();
  await Promise.resolve();
  assert.equal(seeks, 0);
});
