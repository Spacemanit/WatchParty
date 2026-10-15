# First-edition verification

## Scope and conditions

Automated tests run on one Windows development computer with Node.js 24.16.0. HTTP and Socket.IO clients connect to loopback using real network sockets. The 10-user check uses one host and nine separate Socket.IO clients. These are protocol clients, not ten decoding video players or ten physical devices. Upload tests use synthetic byte fixtures and test streaming/authorization, rather than video decoding.

The original interface was checked in the in-app browser with two independent tabs: room creation, joining by invite, session restoration after refresh, host transfer, local WebM loading, shared play/pause/seek, YouTube loading and shared play/pause, and disabled guest playback/source controls. A 375-pixel-wide guest view had no horizontal overflow in that original layout. A public Mozilla flower-video sample was used for browser QA only (stored in ignored `.data/qa/`, not bundled as app content). A regression test uses a hidden `.data/uploads` path, matching the actual server layout, to verify authenticated file serving from that directory.

The wireframe/e-ink revision adds separate home/party views and a party-code menu, with responsive monochrome styles. All seven existing integration tests and JavaScript syntax checks pass. Static checks confirm every JavaScript control reference, SVG symbol and input label resolves to a unique page element. Browser visual/interaction verification of this revised layout was blocked by the browser's security policy; it still needs a normal-browser visual check.

Chat adds six integration cases (13 tests total): room-scoped delivery, server-owned sender identity, late-join/reconnect history, duplicate retries, literal HTML text, complex emoji sequences, character/rate limits, bounded history, and ten simultaneous chat senders. The ten-client chat test also checks that messaging does not change playback sequence or playback revision. These are real Socket.IO protocol tests; the chat panel and emoji picker have not been visually verified in a browser because preview inspection remains unavailable.

There is no continuous drift correction or latency tuning in this edition. **p99 < 250 ms propagation and < 500 ms drift after correction are not measured or claimed.** A later benchmark must separately measure actual command-to-player application and player drift on physical LAN devices, and record hardware, browser versions, Wi-Fi/Ethernet conditions, video bitrate and number of viewers.

## Expected failure behavior

| Situation | Behavior |
| --- | --- |
| Wrong/expired room code | Join form displays an error. |
| Guest attempts to control/select/upload | Server rejects the request. |
| Several host commands arrive together | Server processes them in arrival order and increments the state sequence. |
| A delayed control targets an old video | Rejected by its media ID. |
| Guest joins while the video is playing | Receives the active source and calculated position, then loads the player. |
| Connection drops | Local playback pauses; Socket.IO retries and rejoins using its saved session. |
| Host temporarily disconnects | Role reserved for 20 seconds, then transferred to an online guest. |
| Host explicitly leaves | Role transfers immediately to an online guest. |
| Host role changes during an upload | Upload cannot replace the source; rejected and removed. |
| File is empty/unsupported/too large | Upload rejected with a useful error. Extension validation does not guarantee codec support. |
| Uploaded video's codec is unsupported | Player displays a compatible-format suggestion. |
| Browser blocks scripted playback | Viewer clicks “Join playback.” |
| YouTube disallows embedding or video unavailable | Player displays an error and host can choose a new source. |
| YouTube ads, buffering or suspended tabs differ | Playback can drift; this version does not continuously correct it. |
| Server restarts | Rooms and session tokens are lost; users create/join a new room. |
| Chat connection drops | Sending is disabled while disconnected; the current page keeps its unsent draft. Rejoining restores up to 100 recent messages. |
| Chat acknowledgment is delayed/lost | A retry reuses its message ID; the last 400 accepted IDs per room are remembered to prevent duplicate broadcasts. |
| Chat sender exceeds limits | Server rejects messages over 1,000 Unicode code points or more than 6 messages in 5 seconds; the draft remains available. |
| A message contains HTML or emoji sequences | Rendered as plain text; emoji joiners, skin tones, flags and variation selectors are preserved. |
| Host server goes offline | All clients lose service. Host-role transfer cannot move the server or its video files. |

## Manual LAN acceptance checklist

1. Start the server; create a room in a current Chrome/Edge/Firefox browser.
2. Copy a reachable LAN invite link and join from another physical device on the same network. Check name, participant count and room code.
3. Upload a real H.264/AAC MP4. Verify playback, pause, seeking, separate local volume/mute and fullscreen. Repeat with a supported WebM video.
4. Join while playing and check the late arrival's position. Disconnect/reconnect a guest, then the host. Verify the 20-second host grace period and manual transfer.
5. Add a YouTube link that allows embedding. Check playback commands on both devices and the user-gesture prompt if autoplay is blocked. Try a video that disallows embedding.
6. Run ten actual browser participants/devices with an appropriately low-bitrate video. Observe bandwidth, buffering and CPU. Protocol tests alone cannot establish ten-video-stream capacity.
7. Confirm a guest cannot control playback, change the source or upload after role transfer.
8. Try an invalid room code, unsupported file, cancelled upload, oversized file and server restart. Check visible messages and recovery paths.
9. Repeat at a narrow mobile viewport and with keyboard-only navigation.
10. Send text, emoji-only messages, multi-line messages and HTML-like text from both a host and guest. Confirm the other room receives none of them. Check the picker with mouse and keyboard, including Escape and arrow navigation.
11. Scroll up in chat, receive new messages and use the unread button. Disconnect/reconnect with an unsent draft. Check history, retry after a failed send, and send enough messages to see the rate-limit error.
