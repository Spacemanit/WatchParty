---
type: "query"
date: "2026-10-15T10:25:26.698216+00:00"
question: "explain the whole codebase, what all functions do and in what order they are performed"
contributor: "graphify"
source_nodes: ["createPartyServer()", "Rooms", "applyState()", "applyPlayback()", "send()", "join()"]
---

# Q: explain the whole codebase, what all functions do and in what order they are performed

## Answer

Expanded from graph vocabulary: [server, create, join, room, playback, media, chat, transfer, connection, state, snapshot, upload]. Current runtime source was also read because the graph predates the user's uncalled calibrate(room) addition.
Watch Party is event-driven: server startup creates Express, HTTP, Socket.IO and Rooms, registers routes and event handlers, then listens. Browser deferred script order is socket.io.js, chat.js (class definition), app.js (socket connection, chat construction, stored session, handlers, config fetch, render, invite processing).
Server helpers: createPartyServer assembles the service; cleanFile removes unused uploads; uploadAuth validates host and source generation; handle wraps synchronous socket handlers with acknowledgment/error/rate limits; attach binds membership and socket room; bound revalidates membership; listen starts HTTP; close clears timers, sockets/HTTP and upload directory. HTTP routes provide configuration, health, host upload, member-authenticated range streaming and public static files.
Rooms helpers: youtubeId validates/extracts YouTube IDs; displayName cleans names; PartyError distinguishes expected user errors. Rooms.constructor owns room and timer Maps/Sets. later schedules tracked timers; create/addMember/join/get/authorize manage membership; position calculates anchor-based intended position; snapshot returns public serializable state; changed advances room sequence and broadcasts through callback; chatHistory/sendChat manage bounded ordered/deduplicated/rate-limited messages; select replaces media and resets playback; playback validates host commands and updates anchor/revision; transfer/remove/disconnect/destroy/close handle lifecycle. calibrate reanchors position/time but has no caller and is not drift detection or clock synchronization.
Frontend app helpers: $, readStorage, saveStorage, icon, setIcon, toast, request, isHost, canControl, time, position, duration, connection, openRoomDialog, adoptRoom, applyState, renderPermissions, renderRoom, resetParty, clearPlayerError, playerError, loadYouTubeAPI, loadMedia, applyPlayback, syncLoadedPlayer, sendPlayback, updateMute, addYouTube, uploadFile, copyText, updateInvite, showInvite. applyState chooses media loading versus playback application versus UI-only rendering. The 250-ms interval only updates the displayed player progress. Browser position() reads actual player time; server position(room) computes intended time.
PartyChat methods: constructor installs UI/keyboard/emoji listeners; reset clears room-specific UI; join binds room and replays buffered events; hydrate merges history with newer local messages; refreshHistory repairs gaps; receive buffers, deduplicates and orders incoming messages; confirmDraft clears only the confirmed pending draft; send uses stable retry IDs; refreshStatus updates connection/limit/send controls; renderMessages updates keyed DOM preserving scroll; makeMessage uses textContent; updateUnread, toggleEmoji and insertEmoji manage controls. getContext is injected by app.js and returns room, identity and connection state.
Main flows: create/join form -> request -> server handle -> Rooms.create/join -> attach -> changed/onChange -> room:state broadcasts plus acknowledgment -> adoptRoom -> applyState/renderRoom -> chat.join. Playback: sendPlayback -> playback:action -> Rooms.playback -> changed -> snapshots -> applyState -> applyPlayback. Upload: uploadFile/XHR -> uploadAuth -> Multer -> reauthorization/generation check -> Rooms.select -> broadcast -> loadMedia -> metadata/YouTube ready -> syncLoadedPlayer -> fresh snapshot -> applyPlayback. Chat: PartyChat.send -> request -> sendChat -> room-only chat:message plus acknowledgment -> receive -> confirmDraft/renderMessages; retry IDs prevent duplicates. Disconnect pauses local playback and preserves identity/draft, server schedules grace/expiry; reconnect joins using token and gets current media/history. Explicit leave removes membership immediately; host transfer changes role without moving server/files.
Protection counters: sequence orders room states; playbackRevision changes only playback/source; generation prevents stale upload completion; media.id rejects commands for replaced videos; chatSequence orders independent chat events. Tokens and disk paths stay out of public snapshots.
Tests use delay, emit, fixture, nested connect and collect helpers with real loopback HTTP/Socket.IO servers. Thirteen cases cover parsing, 10-user commands, late joins/reconnect, transfer, upload/ranges, invalid input, lifecycle/isolation, and six chat reliability cases. Protocol tests do not establish real multi-device playback/latency. HTML/CSS/SVG contain layout, styles and icons; package.json holds scripts/dependencies; Graphify outputs and docs are supporting artifacts. No application implementation changes were made for this explanation.

## Source Nodes

- createPartyServer()
- Rooms
- applyState()
- applyPlayback()
- send()
- join()