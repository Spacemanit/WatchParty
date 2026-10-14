// Minimal load/latency probe: 10 fake clients join, one seeks, measure propagation p95.
// Run: node loadtest.js [wsUrl] [roomId?]  (starts server separately first)
const WebSocket = require('ws');
const url = process.argv[2] || 'ws://localhost:8080';

function once(ws, type) {
  return new Promise((res) => {
    const h = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === type) { ws.off('message', h); res(m); }
      } catch {}
    };
    ws.on('message', h);
  });
}
async function join(name, roomId, clientId) {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.on('open', r));
  const joinedP = once(ws, 'joined');
  ws.send(JSON.stringify(roomId ? { type: 'join', roomId, name, clientId } : { type: 'create', name }));
  const j = await joinedP;
  return { ws, j };
}
(async () => {
  const N = 10;
  const { ws: host, j: j0 } = await join('probe-host');
  const roomId = j0.snapshot.roomId;
  console.log('room', roomId);
  const clients = [{ ws: host, j: j0 }];
  for (let i = 1; i < N; i++) {
    clients.push(await join('u' + i, roomId));
  }
  // measure propagation: host emits seek, all others time receipt
  const TRIALS = 20;
  const samples = [];
  for (let t = 0; t < TRIALS; t++) {
    const t0 = Date.now();
    const waits = clients.slice(1).map(({ ws }) => once(ws, 'playback'));
    host.send(JSON.stringify({ type: 'seek', position: t * 1.5, clientTs: t0 }));
    const got = await Promise.all(waits);
    const dt = Date.now() - t0;
    // per-client propagation approximated by trial time (fanout serial) — worst case
    samples.push(dt);
    got.forEach(() => {});
    await new Promise((r) => setTimeout(r, 50));
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const p95 = samples[Math.floor(samples.length * 0.95)];
  console.log(`trials=${TRIALS} peers=${N} p50=${p50}ms p95=${p95}ms max=${samples[samples.length-1]}ms`);
  console.log(p95 <= 250 ? 'PASS: p95 <= 250ms (local)' : 'FAIL: p95 > 250ms — see LATENCY.md for conditions');
  clients.forEach(({ ws }) => ws.close());
  process.exit(0);
})();
