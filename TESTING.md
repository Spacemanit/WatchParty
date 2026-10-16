# First-edition verification

## Scope and conditions

Automated tests run on one Windows development computer with Node.js 24.16.0. HTTP and Socket.IO clients connect to loopback using real network sockets. The 10-user check uses one host and nine separate Socket.IO clients. These are protocol clients, not ten decoding video players or ten physical devices. Upload tests use synthetic byte fixtures and test streaming/authorization, rather than video decoding.

The original interface was checked in the in-app browser with two independent tabs: room creation, joining by invite, session restoration after refresh, host transfer, local WebM loading, shared play/pause/seek, YouTube loading and shared play/pause, and disabled guest playback/source controls. A 375-pixel-wide guest view had no horizontal overflow in that original layout. A public Mozilla flower-video sample was used for browser QA only (stored in ignored `.data/qa/`, not bundled as app content). A regression test uses a hidden `.data/uploads` path, matching the actual server layout, to verify authenticated file serving from that directory.

The current usability revision replaces the earlier wireframe layout with a centered home page, a video/chat workspace, a People drawer and compact source/invitation dialogs. It uses locally hosted Courier Prime and Hanken Grotesk fonts, four text sizes, consistent controls and no custom animation. See [UX_REDESIGN.md](docs/UX_REDESIGN.md) for the change report.

As of 2026-10-16, **all 35 tests pass**, along with JavaScript syntax checks. Nine interface tests run the actual HTML and frontend scripts against a simulated DOM. They cover page boot and valid DOM/icon/label references; keyboard Create/Join tabs; room creation and the People drawer; confirmed host transfer and guest permissions; explicit invite copying and address selection; cancelled/confirmed leaving; emoji navigation and plain-text chat; preserved drafts and offline controls; and YouTube inline error recovery. Native focus trapping, browser layout, screen-reader output, autoplay and video decoding are not simulated faithfully and are not established by these tests.

Chat protocol coverage includes room-scoped delivery, server-owned sender identity, late-join/reconnect history, duplicate retries, literal HTML text, complex emoji sequences, character/rate limits, bounded history, and ten simultaneous chat senders. The ten-client chat test also checks that messaging does not change playback sequence or playback revision.

Visual/interaction inspection of the redesigned app was blocked by the browser's security policy. No alternate browser inspection was attempted. Desktop/mobile rendering, zoom, native dialogs, clipboard fallback and real playback in this layout still need the manual checks below; earlier browser checks do not validate the redesign.

Uploaded files now have clock calibration and local drift checks; YouTube drift correction and latency tuning remain unimplemented. **p99 < 250 ms propagation and < 500 ms drift after correction are not measured or claimed.** A later benchmark must separately measure actual command-to-player application and player drift on physical LAN devices, and record hardware, browser versions, Wi-Fi/Ethernet conditions, video bitrate and number of viewers.

## Local playback regressions

Browser-function simulations cover recovery from an unexpected local pause, Play using the shared paused position, replay from zero after the end, and avoiding redundant seeks. Host tests also cover a participant joining after an empty host grace period.

MP4 tests reproduce an upload with empty video/audio sync tables. They verify rebuilding the H.264 index from IDR frames, removing the empty AAC sync table, preserving encoded media bytes and chunk offsets, metadata before/after media, 64-bit offsets, fixed sample sizes, an open-ended media atom, repeat processing, invalid input, and authenticated HTTP upload/range responses. The reported 57,315,464-byte MP4 was separately inspected: it contains 1,618 video samples and six IDR frames, but its original sync tables contain no entries. A repaired copy preserves the media payload's SHA-256 hash. The user confirmed that the repaired copy plays directly in Firefox; playback through the redesigned room still needs a manual check.

After upgrading the server, restart it and re-upload an affected MP4 so the new index repair runs. Already uploaded files are not modified retroactively.

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
9. Repeat at 320, 375, 768 and 1440 CSS pixels and at 200% zoom. Check long participant names, filenames, messages, small-height dialogs and horizontal overflow. Chat should sit beside the video above 960 pixels and remain visible below it at smaller widths. Use keyboard-only navigation through Create/Join tabs, dialogs, range controls, the People drawer and emoji choices; check Escape and restored focus. Verify that assistive technology announces field labels and useful feedback.
10. Send text, emoji-only messages, multi-line messages and HTML-like text from both a host and guest. Confirm the other room receives none of them. Check the picker with mouse and keyboard, including Escape and arrow navigation.
11. Scroll up in chat, receive new messages and use the unread button. Disconnect/reconnect with an unsent draft. Check history, retry after a failed send, and send enough messages to see the rate-limit error.
