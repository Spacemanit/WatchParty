# Watch Party — usability redesign

Date: 2026-10-16

## Direction agreed with the owner

The interface now follows an independent-cinema direction: white paper, near-black ink, restrained typewriter typography and generous space. It combines the Screenplay proposal's Courier Prime/Hanken Grotesk pairing with Projection's centered home layout. The brand is consistently **Watch Party**.

Primary buttons stay black. Muted orange marks focus, active tabs, range selections and an active file-drop target. There are no custom animations. Desktop and mobile share the same tasks, with chat beside the video on desktop and visible below it on smaller screens. Cinejoy was a loose taste reference; its page could not be inspected reliably, and no layout, copy or assets were copied from it.

## Research and how it informed the design

The research did not establish a verifiable public font/color selection algorithm for the requested “Fable 5.1” name. This work does not claim to reproduce private model behavior or make an interface's authorship undetectable.

The applicable public process is documented in [Anthropic's frontend aesthetics guide](https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics): define typography and color deliberately, use contextual references and avoid habitual template choices. Its [frontend design skill](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md) also emphasizes a coherent aesthetic. Here, those principles became two concrete font/layout proposals followed by the owner's selections. Suggestions about decorative backgrounds and animation were omitted to respect the requested minimal white surface and no-motion preference.

[Courier Prime was designed for screenplays](https://quoteunquoteapps.com/courierprime/), making its typewriter character relevant to watching films together. It appears in headings, branding, room codes and timecodes. [Hanken Grotesk supports interface and mobile use](https://github.com/marcologous/hanken-grotesk); it handles controls, conversation and longer text. This division gives the product a recognizable voice without making every message look like a screenplay.

The [Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines) informed labels, focus visibility, keyboard behavior, feedback and responsive wrapping. These are implementation choices, not evidence of a completed accessibility certification or user study.

## Changes, usefulness and tradeoffs

| Change implemented | Usefulness added or clutter removed | Tradeoff |
| --- | --- | --- |
| Removed the outer frame, repeated footers, nested feature cards and ornamental status captions. | The page has fewer competing boundaries. Content groups through spacing and alignment; borders remain around inputs, the composer and dialogs where they serve interaction. | The home page offers less feature exposition. The Help dialog retains practical instructions. |
| Centered the home heading, one factual source description and two clear actions. | The first decision is immediately Create or Join. Both open the same compact, labelled dialog. | More product detail is deferred until someone needs it. |
| Replaced mixed typography with two fonts and four size presets. | Headings, reading text, controls and supporting detail have repeatable roles. Body text and fields remain 16 px by default. | Five local font files add 306,128 bytes before HTTP compression. Critical regular-body and bold-heading fonts are preloaded; fallback fonts remain available. |
| Standardized ordinary corners at 6 px and replaced icons with one Lucide SVG set. | Link, upload, file, playback, chat and utility controls share stroke weight and sizing. Icon-only buttons have accessible names. | Icons remain secondary to visible action labels where their meaning could be ambiguous. |
| Put chat beside the video and removed the permanent people panel. | Watching and conversation occupy the main workspace. People, presence and host transfer remain together in a drawer. | Checking the full participant list takes an extra click. The People count remains visible. |
| Kept chat visible below the player and source actions at widths of 960 px or less. | Mobile users can find conversation without switching tabs or opening an overlay. | The page scrolls vertically and chat has its own bounded message scroll area. |
| Reduced source selection to Upload video and YouTube link actions. | The player remains dominant. Hosts retain file-format/size guidance, upload progress and cancellation; guests see a useful waiting state without source actions they cannot use. | YouTube entry requires opening a dialog. File dropping remains supported on the Upload button, with a smaller target than a large upload card. |
| Made invitation copying explicit. Hid the server-address selector when there is only one choice. | Opening Invite no longer overwrites the clipboard. Multiple network addresses remain selectable when necessary. Copy feedback appears inside the open modal. | Sharing requires pressing Copy. The app cannot determine which network address every guest can reach. |
| Added confirmation before leaving and before transferring the host role. | Accidental clicks are less likely to stop a viewer's participation or hand over control. The transfer dialog explains the role change. | Each action takes one extra confirmation. |
| Added arrow/Home/End navigation to Create/Join tabs and retained emoji arrow navigation in the new six-column grid. | Visual arrangement and keyboard movement agree. Selected tabs expose their state through ARIA as well as an underline. | Native dialog focus trapping and assistive-technology behavior still need browser verification. |
| Kept errors close to their task, added short submission states and restored editable fields after failure. | A failed YouTube URL remains available to fix. Chat errors retain the draft. Reconnecting disables unavailable host actions. | Feedback appears only when relevant, so the resting interface shows fewer technical status details. |
| Removed permanent “LIVE”, redundant role slogans and the always-visible chat counter/instructions. | Chat reads like a conversation. The counter appears from 800 characters; errors and reconnect guidance remain visible when needed. Keyboard instructions remain available to assistive technology. | Keyboard shortcuts are less visually discoverable during normal use. |

## Shared design rules

| Role | Token/value | Use |
| --- | --- | --- |
| Supporting text | `--text-small: .875rem` / 14 px | Labels, hints, timestamps, timecodes and feedback |
| Reading and controls | `--text-body: 1rem` / 16 px | Messages, inputs, buttons and normal text |
| Section emphasis | `--text-heading: 1.5rem` / 24 px | Party/dialog headings, room codes and emoji glyphs |
| Home display | `--text-display: 2.5rem` / 40 px | Home heading only |
| Main surface / text | `#ffffff` / `#171717` | Paper and ink |
| Secondary text | `#626262` | Supporting detail |
| Rules / quiet surface | `#d5d5d5` / `#f5f5f5` | Dividers and light grouping |
| Interaction accent | `#b15b32` | Focus and selected/active control states |
| Standard corner | `6px` | Buttons, fields, player and dialogs |

Sizes use rem units so browser font preferences can scale them. Round presence indicators and avatars are deliberate shape exceptions; the edge-to-edge People drawer has square viewport corners. Icon-only controls are 44 × 44 px. Coarse-pointer range controls also receive 44 px height. Long names, filenames and messages wrap instead of requiring fixed-width content.

The fonts and [Lucide icons](https://github.com/lucide-icons/lucide) are served locally, with license notices in `public/licenses/`. The UI needs no runtime font/icon CDN. The existing YouTube player still needs YouTube access.

## Behavior retained

The redesign preserves room codes/invites, file uploads, YouTube sources, host-only shared play/pause/seek, local audio/fullscreen controls, late joins, reconnects, host transfer/failover, emoji chat, message history and retry behavior. Existing local-file clock calibration/drift checks and MP4 index repair remain in place. No backend protocol or media-repair changes were introduced for the redesign.

Movie discovery, playlists, polls, standalone reactions, YouTube drift correction and latency tuning were not added as part of this UI work.

## Verification and remaining acceptance checks

On Windows with Node.js 24.16.0, **35 tests passed**: 14 HTTP/Socket.IO integration tests, 12 existing playback/media/room regression tests and nine new interface tests. JavaScript syntax and whitespace checks also pass. The network cases use real loopback sockets, including ten concurrent protocol clients. The interface tests execute the actual HTML and scripts against a simulated DOM, with controlled socket responses and browser primitives.

The nine interface cases check page boot and valid labels/icons/targets; keyboard Create/Join tabs; creation and the People drawer; confirmed host transfer/permissions; explicit invite copying/address selection; leave cancellation/confirmation; emoji keyboard navigation/plain-text messages; preserved drafts/offline controls; and editable inline YouTube errors.

**Browser visual inspection was blocked by the browser security policy.** No alternate inspection method was used to bypass it. These checks do not establish pixel-level rendering, responsive appearance, native modal focus behavior, screen-reader output, real clipboard fallback, video decoding or autoplay in the redesigned interface. No measured usability improvement, p99 latency or playback-drift guarantee is claimed.

Before signing off browser acceptance:

1. Inspect home, room and every dialog at 320, 375, 768 and 1440 CSS pixels, plus 200% zoom and a short viewport. Check wrapping, clipping, visible focus and scroll behavior.
2. Complete Create/Join, copy an invite and use People/host transfer with keyboard alone. Check Tab order, arrow keys, Escape and focus after closing native dialogs.
3. Test real MP4/WebM and YouTube playback with a host and guest, including source replacement, autoplay recovery, volume, seek and fullscreen.
4. Send long names/messages, emojis and multiline chat; scroll up for unread feedback, reconnect with a draft and test send errors.
5. Check field names, dialog titles, messages and connection/error announcements with a screen reader. Repeat invite copying on a plain HTTP LAN address where clipboard fallback is used.

The detailed protocol conditions, playback regressions and LAN checklist remain in [TESTING.md](../TESTING.md).
