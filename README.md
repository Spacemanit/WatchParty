# ◤ WATCHPARTY // NEON SYNC ◢

Real-time watch-party: synced playback + discovery + chat + reactions + playlists + polls + host transfer.
Minimal **pitch-black UI** — every panel is `#000` with a **multicolour high-contrast neon border + glow**.

## Quick start

```powershell
cd server; npm install; npm start      # ws://localhost:8080
cd ../client; npm install; npm run dev # http://localhost:5173
```

Open the dev URL in 2+ tabs (or share on LAN via `http://<your-ip>:5173`).
Create a room → copy the **invite link** (`?room=CODE`) → join from other tabs/devices.

## What was built

| Requirement | Where |
|---|---|
| Create/join via invite link or room code | `client/src/App.jsx` (?room=), `server/server.js` create/join |
| Sync play / pause / seek | authoritative server seq + `playback` fanout, `client/src/sync.js` |
| Movie recs: categories, filters, fuzzy search | `client/src/movies.js` (24 titles, genre/mood/rating/sort, Levenshtein + subsequence scoring) |
| Emoji reactions, live chat, shared playlist, polls, host transfer | `server/server.js` + panels in `App.jsx` |
| Drift detection + correction | 2s self-heal loop + server `stateSync`/`correction` nudge (threshold 500ms) |
| Late join / reconnect / concurrent actions | full `snapshot` on join, 60s reconnect grace w/ same clientId, LWW `seq`, host auto-failover |

**Bonus / originality:** live sync-burst HUD (rtt, p50/p95, drift, corrections), emoji rain overlay,
`⚡ POLL: WHAT NEXT?` one-click recommendation poll, `/shout` chat command, neon presence dots,
direct-URL loading + queue-to-playlist flow.

## Repo layout

```
server/server.js    # authoritative sync engine (ws), rooms, failover, latency accounting
server/loadtest.js  # 10-client propagation probe (node loadtest.js)
client/src/         # React: App.jsx (neon UI), sync.js (protocol+drift), movies.js (fuzzy), styles.css (pitch black + neon)
LATENCY.md          # measurements, conditions, failure handling
```

## Protocol (ws JSON)

`create|join|play|pause|seek|setVideo|playlistAdd|Remove|Next|chat|reaction|pollCreate|Vote|Close|transferHost|stateSync|ping`
→ `joined(snapshot)|playback|chatMsg|reaction|playlist|polls|users|hostChanged|correction|ack|pong|error`

See `LATENCY.md` for measurement methodology and failure-handling matrix.
