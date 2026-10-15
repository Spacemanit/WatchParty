# Graph Report - WatchParty  (2026-10-15)

## Corpus Check
- Corpus is ~25,022 words - fits in a single context window. You may not need a graph.

## Summary
- 165 nodes · 360 relationships (327 unique links) · 7 communities
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 28 edges (avg confidence: 0.89)
- Token cost: actual model-token usage unavailable (the collaboration tool exposes no token counts).

## Community Hubs (Navigation)
- Server and Protocol Tests
- Playback and Room UI
- Interface and Feature Documentation
- Room State and Permissions
- Chat and Emoji Messaging
- Wireframe Design
- Project Run Scripts

## God Nodes (most connected - your core abstractions)
1. `Rooms` - 22 edges
2. `createPartyServer()` - 19 edges
3. `Watch Party LAN prototype` - 14 edges
4. `PartyError` - 12 edges
5. `renderPermissions()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `Watch Party LAN prototype` --references--> `Watch Party page wireframe`  [INFERRED]
  README.md → Watch Party Video Page Wireframe.png
- `Video upload and YouTube source forms` --conceptually_related_to--> `Authenticated HTTP uploaded-video delivery`  [INFERRED]
  public/index.html → README.md
- `bound()` --calls--> `PartyError`  [EXTRACTED]
  server.js → lib/rooms.js

## Import Cycles
- None detected.

## Communities (7 total, 0 thin omitted)

### Community 0 - "Server and Protocol Tests"
Cohesion: 0.07
Nodes (23): youtubeId(), dependencies, express, multer, socket.io, description, devDependencies, socket.io-client (+15 more)

### Community 1 - "Playback and Room UI"
Cohesion: 0.13
Nodes (34): addYouTube(), adoptRoom(), applyPlayback(), applyState(), canControl(), chat, clearPlayerError(), config (+26 more)

### Community 2 - "Interface and Feature Documentation"
Cohesion: 0.11
Nodes (16): White rounded square with dark border, Favicon SVG, Media play symbol, Dark right-pointing triangle, Separate home and party views, Accessible party-chat markup, Room code, participants and LAN invitation UI, Shared player and custom transport surface (+8 more)

### Community 3 - "Room State and Permissions"
Cohesion: 0.20
Nodes (5): displayName(), PartyError, Rooms, createPartyServer(), bound()

### Community 4 - "Chat and Emoji Messaging"
Cohesion: 0.36
Nodes (15): confirmDraft(), constructor(), $() DOM lookup, hydrate(), insertEmoji(), join(), makeMessage(), receive() (+7 more)

### Community 5 - "Wireframe Design"
Cohesion: 0.16
Nodes (14): Chat panel beside video, Create a Party card, Home page: What to Watch?, Enter the code popup with Join the Fun button, Join a Party card, Movie search field, Details about the people in the party, Party code popup with Copy Code, Invite, and People Already In (+6 more)

### Community 6 - "Project Run Scripts"
Cohesion: 0.40
Nodes (5): scripts, check, dev, start, test

## Knowledge Gaps
- **11 isolated node(s):** `White-paper and black-ink design tokens`, `Responsive home and party layouts`, `Keyboard, hidden and reduced-motion states`, `Scrollable responsive chat and emoji styling`, `Movie search field` (+6 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 50 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Watch Party LAN prototype` connect `Interface and Feature Documentation` to `Server and Protocol Tests`, `Playback and Room UI`, `Chat and Emoji Messaging`, `Wireframe Design`?**
  _High betweenness centrality (0.655) - this node is a cross-community bridge._
- **Are the 11 inferred relationships involving `createPartyServer()` (e.g. with `.authorize()` and `.chatHistory()`) actually correct?**
  _`createPartyServer()` has 11 INFERRED edges - model-reasoned connections that need verification._
- **What connects `White-paper and black-ink design tokens`, `Responsive home and party layouts`, `Keyboard, hidden and reduced-motion states` to the rest of the system?**
  _11 weakly-connected nodes found - possible documentation gaps or missing edges._
## Extraction notes

- Code relationships were extracted locally with Graphify tree-sitter. Documentation, HTML, CSS, the wireframe and favicon were interpreted by assistant agents.
- Eight Node.js built-in dependency references had import edges but no node records in the AST output. Their nodes were materialized from the exact import statements so the delivered graph has complete endpoints.
- Two parser self-references were corrected against their exact source lines: the chat DOM lookup is a function defined inside its constructor, and the test helper invokes Socket.IO emit rather than calling itself.
- graph.json preserves every original relationship, including multiple relation types between one pair of nodes. Community analysis uses unique links; repeated endpoint pairs are not missing evidence.
- The stylesheet was included as a semantic document because the detector does not classify CSS as code. The SVG was interpreted from its vector elements. The PNG was inspected visually.
- EXTRACTED describes direct source evidence; INFERRED describes interpretation. Wireframe recommendations and search are design concepts, not implemented functionality.
- No tests or playback/latency measurements were run for this graph build. Verification claims describe the existing project documentation.
- Actual semantic model-token usage is not available; any zero token fields in intermediate extraction data are placeholders, not measured usage.
- `graphify-out/` was written into the working tree and is not ignored. Commit the shareable outputs or add the directory to `.gitignore` as appropriate.
- Graph health warning for the simple analysis view: directed_same_endpoint_collapsed_edges: 33; undirected_same_endpoint_collapsed_edges: 33. All original relationships are retained in graph.json; inspect graph-health.json for the raw diagnostic.
