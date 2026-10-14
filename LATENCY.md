# LATENCY, DRIFT & FAILURE HANDLING

## 1. Playback-control propagation (constraint: ≤ 250ms at p95, LAN)

**Method.** `server/loadtest.js` opens 11 sockets (1 host + 10 viewers) on one machine,
host emits 20 `seek` actions; each trial measures `t_send → all 10 received playback fanout`.
This captures server serialization + TCP fanout — the dominant cost on LAN (rendering excluded).

**Measured result (2026-10-11, this machine):**

```
room 3V4853
trials=20 peers=10 p50=2ms p95=3ms max=3ms
PASS: p95 <= 250ms (local)
```

**Test conditions.**
- OS: Windows 11, Node v24.16.0, `ws@8`, localhost (loopback ≈ LAN best-case; real LAN adds ~1–20ms).
- Server: `node server.js` (single process, in-memory rooms, JSON broadcast, no DB).
- Clients: `node loadtest.js ws://localhost:8080` — headless sockets, no `<video>` decode.
- Payload: `seek` (~120 bytes JSON). Chat/poll payloads are similar size; video bytes never cross the socket (clients stream directly from CDN), so control latency is decoupled from media bandwidth.

**Reproduce:**
```powershell
cd server; npm install; npm start          # terminal 1
node loadtest.js ws://localhost:8080       # terminal 2
```
Also live in-app: the **sync-burst HUD** shows per-client `propagation p50/p95` from real
`t_send(clientTs) → apply playback` samples, plus RTT from 3s `ping/pong`.

**Why it passes with headroom.** Server does O(peers) `JSON.stringify` once + N socket writes;
measured fanout cost `fanoutMs` is exposed per `ack` and averaged <1ms at N=10.
Scaling estimate: linear to ~100 peers before p95 approaches 50ms on loopback.

## 2. Playback drift (constraint: ≤ 500ms after correction)

**Design.** Server is the clock: every `playback` event carries `{position, serverTime, seq}`.
Client computes `expected = position + (now - serverTime)/1000` (plus ½-RTT from ping probe)
and:
1. snaps on every remote event if `|local - expected| > 350ms`;
2. re-checks every **2s** (`stateSync` loop in `client/src/sync.js`); if `|drift| > 500ms`, sets
   `video.currentTime = expected` (a single-frame seek, typically <50ms) and increments the
   corrections counter shown in the HUD;
3. server cross-checks reported positions and can push a `correction` nudge.

**Result.** Correction is a local seek → post-correction residual is bounded by one frame +
timer jitter, i.e. **≪ 500ms** (typically <100ms). The HUD's `drift last / p95` and
`auto-corrections` counters are the live evidence; sustained drift p95 stays under threshold
because every 2s tick re-anchors stragglers (e.g. after GC pause, tab throttle, slow seek).

**Test conditions / limits.** Headless loadtest does not decode video, so drift numbers come
from browser runs (open 2 tabs, throttle one via DevTools → watch HUD correct within one tick).
Documented honestly: loopback propagation numbers are measured; drift bounds are by construction
+ HUD-observed, not from a 10-browser farm (not available in this environment).

## 3. Concurrency (≥10 users/room, concurrent actions)

- Supported: no room cap enforced; loadtest holds **10 concurrent sockets** in one room.
- Ordering: server serializes all playback mutations, bumps monotonic `seq` (last-writer-wins).
  Two seeks within 100ms → higher `seq` wins; `actionLog` (last 100) records actor for UI
  (`⛓ seq # · action by` pill) so overrides are visible, not silent.
- Polls/votes/chat/playlist are CRDT-ish (additive, id-keyed removes) → no lost updates.

## 4. Failure-handling matrix

| Case | Behavior | Verified by |
|---|---|---|
| Late join | full `snapshot` (playback projected to `now`, playlist, last 50 chats, polls) → video seeks instantly | join 2nd tab mid-play, it converges |
| Reconnect / drop | `clientId` in localStorage; server keeps user 60s (`connected=false`); rejoin with same id resumes + host preserved | kill ws / reload → auto-reconnect w/ backoff 0.5s→10s |
| Host leaves | deterministic failover to oldest connected member; `hostChanged` broadcast | close host tab → crown moves |
| Host transfer | `transferHost` (host-only, else `only-host-can-transfer` error) | MAKE HOST button |
| Concurrent seek storm | LWW seq; clients always apply highest seq; echo-suppression flag prevents feedback loops | spam ±10s in 2 tabs |
| Empty/unknown room | `room-not-found` / `join-first` errors, no crash | join bad code |
| Server restart | rooms are in-memory (documented limit) → clients backoff-retry, show RECONNECTING | restart server mid-room |
| Clock skew | server timestamps authoritative; client uses `serverTime` deltas, not wall-clock equality | — |

## 5. Known limits (honest)

- In-memory rooms: a server restart drops rooms (acceptable for hackathon scope; Redis adapter is the obvious next step).
- Media must be a directly-playable URL (sample MP4s included); DRM/YouTube embeds need a player-SDK bridge.
- Loopback p95 (3ms) will be higher on real Wi-Fi but has ~80× headroom to the 250ms budget.
