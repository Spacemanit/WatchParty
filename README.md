# Watch Party

A host-run watch party with a white-paper, black-ink interface based on the supplied wireframe. A home screen offers Create/Join tiles; the party screen pairs a video player with room details and participants, plus code/invitation popups. Plain HTML, CSS and browser JavaScript; Express, Socket.IO and HTTP video streaming on Node.js. No frontend build step or database.

## Run

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open **http://localhost:3000** on the computer running the server. Create a room, add a video, and copy its invite link. Guests open the **LAN address printed by the server** on devices connected to the same network. The invitation dialog lists detected addresses; pick your Wi-Fi/Ethernet address if VPNs or virtual adapters also appear. If needed, allow Node.js through the host's firewall on private networks.

The Node.js server must remain running for the whole party. Closing the host's browser does not stop the server. Internet access from another network requires an additional hosting/networking setup; local-network use is this version's target.

If the machine's `npm` launcher is broken, use the npm CLI from your Node.js installation, for example on Windows:

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' install
node server.js
```

## First edition

- Create/join rooms using six-character codes or invite links; display names and a live participant list.
- Host-uploaded MP4, WebM and OGV files, streamed from the server's local disk. HTTP range requests support seeking without downloading the full file first. The default file-size limit is 2 GB. Browser codec support still applies; H.264/AAC MP4 is the most practical starting format.
- YouTube links using the official IFrame API. Each guest streams directly from YouTube. Unavailable videos, disabled embedding, loading failures and browser autoplay restrictions have visible handling.
- Host-only play, pause, seek and source selection, validated on the server. Guest volume/mute and fullscreen are local controls.
- Server-ordered commands, per-video IDs to reject controls for a replaced source, and room state snapshots for late arrivals/reconnects.
- Room chat for hosts and guests, with an emoji picker, emoji-only messages, sender names and timestamps. Enter sends; Shift+Enter adds a line. New messages appear live, with an unread indicator when you scroll up. Emoji selection supports keyboard navigation and Escape.
- Each room keeps its latest 100 chat messages in memory for late joins and reconnects. Sending requires a room membership; sender identity is taken from the server session. Messages are plain text, limited to 1,000 Unicode code points and 6 accepted messages per participant every 5 seconds. The last 400 accepted message IDs are remembered to avoid duplicates when retrying an uncertain send. Unsent drafts stay in the current page during a connection loss.
- Manual host transfer. A disconnected host keeps the role for 20 seconds; then the server selects an online participant. Explicitly leaving transfers control immediately. The original server computer must remain running, including after host-role transfer.
- Reconnect sessions stay available for 10 minutes. A recovered session preserves its name/identity; explicitly leaving removes it. Rooms are limited to 20 members, including temporarily disconnected members. Empty rooms expire when their last session is removed.
- File uploads require the connected host's room token. Media access requires a participant token. Uploaded paths and tokens are not included in public room snapshots.

Deferred by scope: movie discovery/recommendations and filters/search, standalone reactions, playlists, polls, continuous playback drift detection/correction, clock synchronization, and latency optimization. This edition does not claim p99 latency or drift targets.

## How it works

`public/index.html`, `public/styles.css`, `public/app.js`, and the small `public/chat.js` component are the entire frontend. `server.js` serves the frontend, Socket.IO and authenticated upload/media routes. `lib/rooms.js` manages room membership, chat history, host permissions, playback state and reconnect windows. Chat uses separate Socket.IO events so messages do not trigger playback changes or repeat full video state broadcasts.

Socket.IO sends small commands and room snapshots. Uploaded files travel through a multipart HTTP endpoint and are streamed over HTTP, rather than broadcasting whole videos over Socket.IO. YouTube videos load through the embedded player. The frontend uses the same custom controls for both player types.

Playback position is anchored to the server's timestamp. A play/pause/seek updates that anchor; late joiners receive the calculated current position. Clients do **not** continuously correct playback position. Browser buffering, different YouTube ads, suspended tabs or network delay can therefore cause drift. YouTube embedding needs internet access and an HTTP-served page; opening the HTML directly as a local file is unsupported.

Room state and chat history are in memory. Restarting the server ends all rooms, clears their messages, and invalidates sessions. Files live under ignored `.data/uploads/`; replaced sources and expired rooms are cleaned up, and this process's upload directory is removed on a graceful shutdown. A forced crash can leave old upload directories on disk; remove those only while the server is stopped.

Room/session tokens are suitable for an invite-based LAN prototype, not a public authenticated service. Room codes are invitations, not passwords. Use HTTPS, user authentication, storage quotas and deployment hardening before exposing the service publicly. At 10 viewers the host needs outgoing bandwidth of roughly 10 times the video's bitrate, in addition to normal overhead. No transcoding is performed.

## Configuration

Environment variables: `PORT` (default `3000`), `MAX_UPLOAD_MB` (default `2048`). On PowerShell:

```powershell
$env:PORT = '3000'
$env:MAX_UPLOAD_MB = '2048'
node server.js
```

## Verification

```sh
npm run check
npm test
```

The integration suite starts real HTTP/Socket.IO servers on temporary ports. It checks 10 concurrent clients, command fan-out and ordering, permissions, late joins, reconnection identity, host transfer/failover, media replacement, room isolation/capacity/expiry, upload errors, authenticated streams and HTTP range/HEAD responses. Chat checks cover room isolation, sender identity, Unicode emoji sequences, length/rate limits, retry deduplication, bounded history, reconnects, and ordered messages across 10 simultaneous participants. Test upload bytes are synthetic; browser playback requires a real playable video.

See [TESTING.md](TESTING.md) for test conditions, failure behavior and the manual multi-device checklist. No latency benchmark is claimed by this first edition.

Official references: [Socket.IO server API](https://socket.io/docs/v4/server-api/), [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference), [HTTP range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests).
