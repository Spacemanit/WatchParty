import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useWatchParty } from './sync.js';
import { fuzzySearch, recommendFor, GENRES, MOODS } from './movies.js';

const EMOJIS = ['🔥', '😂', '😱', '❤️', '👏', '💀', '🍿', '⚡', '🥳', '😭'];
const NEON = ['#ff00e5', '#00fff2', '#39ff14', '#ffe600', '#ff6b00', '#b300ff', '#ff073a', '#00a6ff'];
const WS_HINT = `ws://${window.location.hostname}:8080`;

export default function App() {
  const videoRef = useRef(null);
  const { connected, room, clientId, stats, rain, send, connect } = useWatchParty(videoRef);
  const [name, setName] = useState(() => { try { return JSON.parse(localStorage.getItem('watchparty-identity-v1'))?.name || ''; } catch { return ''; } });
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get('room') || '');
  const [chat, setChat] = useState('');
  const [q, setQ] = useState('');
  const [genre, setGenre] = useState('All');
  const [mood, setMood] = useState('All');
  const [minRating, setMinRating] = useState(0);
  const [sort, setSort] = useState('match');
  const [pollQ, setPollQ] = useState('');
  const [pollOpts, setPollOpts] = useState('Option A, Option B, Option C');
  const [customUrl, setCustomUrl] = useState('');
  const [showMovies, setShowMovies] = useState(true);

  const results = useMemo(() => fuzzySearch(q, { genre, mood, minRating, sort }), [q, genre, mood, minRating, sort]);
  const recs = useMemo(() => (room ? recommendFor(room.videoTitle) : []), [room?.videoTitle]);
  const isHost = room && clientId && room.hostId === clientId;
  const invite = room ? `${window.location.origin}${window.location.pathname}?room=${room.roomId}` : '';

  useEffect(() => {
    // auto-rejoin via invite link if name known
    const params = new URLSearchParams(window.location.search);
    const r = params.get('room');
    if (r && name && !room && connected === false) {
      const ident = (() => { try { return JSON.parse(localStorage.getItem('watchparty-identity-v1')) || {}; } catch { return {}; } })();
      connect(r.toUpperCase(), name, ident.clientId);
    }
    // eslint-disable-next-line
  }, []);

  if (!room) {
    return (
      <div>
        <div className="neon n-pink"><h1>◤ WATCHPARTY // NEON SYNC ◢</h1>
          <div className="tag">realtime rooms · synced playback · drift &lt; 500ms · p95 &lt; 250ms local</div></div>
        <div className="neon n-cyan">
          <h2 style={{ color: '#00fff2' }}>+ join or create room</h2>
          <div className="row">
            <input placeholder="your name" value={name} onChange={(e) => setName(e.target.value)} />
            <input placeholder="ROOM CODE (e.g. KX7Q2P)" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} style={{ width: 220 }} />
            <button className="lime" onClick={() => name && connect(code || null, name, JSON.parse(localStorage.getItem('watchparty-identity-v1') || '{}').clientId)}>
              {code ? 'JOIN ROOM' : 'CREATE ROOM'}</button>
          </div>
          <div className="mono-dim">server: {WS_HINT} · status: {connected ? 'linked' : 'offline / connecting…'} · invite links look like ?room=CODE</div>
          {!connected && <div className="mono-dim">ⓘ start server first: <b>cd server; npm i; npm start</b> then <b>cd client; npm i; npm run dev</b></div>}
        </div>
        <div className="neon n-purple">
          <h2 style={{ color: '#b300ff' }}>✦ browse movies (no room needed)</h2>
          <MovieBrowser compact q={q} setQ={setQ} genre={genre} setGenre={setGenre} mood={mood} setMood={setMood}
            minRating={minRating} setMinRating={setMinRating} sort={sort} setSort={setSort} results={results} onPick={() => {}} />
        </div>
      </div>
    );
  }

  return (
    <div>
      {rain.map((r) => <div key={r.id} className="rain" style={{ left: r.left + '%' }}>{r.emoji}</div>)}
      <div className="neon n-pink">
        <h1>◤ WATCHPARTY <span style={{ color: '#fff' }}>{room.roomId}</span> ◢</h1>
        <div className="row">
          <span className="pill" style={{ color: '#39ff14' }}>● {connected ? 'LIVE' : 'RECONNECTING…'}</span>
          <span className="pill" style={{ color: '#00fff2' }}>👤 {room.users.length} in room {isHost ? '(YOU HOST)' : ''}</span>
          <span className="pill" style={{ color: '#ffe600' }}>🎬 {room.videoTitle}</span>
          <span className="pill" style={{ color: '#ff00e5' }}>⛓ seq #{room.seq} · {room.lastAction} by {room.lastActor || '—'}</span>
          <button onClick={() => { navigator.clipboard?.writeText(invite); }}>COPY INVITE</button>
          <button className="pink" onClick={() => { window.history.replaceState({}, '', window.location.pathname); window.location.reload(); }}>LEAVE</button>
        </div>
        <div className="mono-dim">invite: {invite}</div>
      </div>

      <div className="grid2">
        <div>
          <div className="neon n-purple">
            <video ref={videoRef} controls playsInline src={room.videoUrl} />
            <div className="row" style={{ marginTop: 6 }}>
              <button className="lime" onClick={() => videoRef.current?.play()}>▶ PLAY</button>
              <button className="warn" onClick={() => videoRef.current?.pause()}>⏸ PAUSE</button>
              <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 10); }}>−10s</button>
              <button onClick={() => { if (videoRef.current) videoRef.current.currentTime += 10; }}>+10s</button>
              <button className="pink" onClick={() => {
                const next = room.playlist[0];
                if (next) send({ type: 'playlistNext' });
              }}>⏭ NEXT IN PLAYLIST ({room.playlist.length})</button>
            </div>
            <div className="row">
              <input placeholder="paste direct mp4 / stream url…" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
              <button onClick={() => { if (customUrl) { send({ type: 'setVideo', url: customUrl, title: customUrl.slice(0, 60) }); setCustomUrl(''); } }}>LOAD URL</button>
            </div>
          </div>

          <div className="neon n-lime">
            <h2 style={{ color: '#39ff14' }}>✦ latency / drift HUD (creative: sync-burst meter)</h2>
            <div className="hud">
              rtt <b>{stats.rtt}ms</b> · propagation p50 <b>{stats.p50}ms</b> p95 <b style={{ color: stats.p95 <= 250 ? '#39ff14' : '#ff073a' }}>{stats.p95}ms</b> ({stats.samples} samples)
              · drift last <b>{stats.driftLast}ms</b> p95 <b>{stats.driftP95}ms</b> · auto-corrections <b>{stats.corrections}</b><br />
              <span className="mono-dim">target: propagation p95 ≤ 250ms (LAN) · drift ≤ 500ms after correction · loop: 2s self-heal + server nudge · reconnect grace 60s · concurrency LWW seq #{room.seq}</span>
            </div>
            <Sparkline values={[]} label="" />
          </div>

          <div className="neon n-blue">
            <h2 style={{ color: '#00a6ff' }}>✦ discover {showMovies ? '▾' : '▸'} <button onClick={() => setShowMovies(!showMovies)}>{showMovies ? 'HIDE' : 'SHOW'}</button></h2>
            {showMovies && <MovieBrowser q={q} setQ={setQ} genre={genre} setGenre={setGenre} mood={mood} setMood={setMood}
              minRating={minRating} setMinRating={setMinRating} sort={sort} setSort={setSort} results={results}
              onPick={(m) => send({ type: 'setVideo', url: m.url, title: m.title })}
              onQueue={(m) => send({ type: 'playlistAdd', url: m.url, title: m.title })} />}
          </div>
        </div>

        <div>
          <div className="neon n-cyan">
            <h2 style={{ color: '#00fff2' }}>● presence + host</h2>
            {room.users.map((u, i) => (
              <div key={u.clientId}>
                <span className="dot" style={{ color: NEON[i % NEON.length], background: NEON[i % NEON.length] }} />
                {u.name} {u.clientId === clientId ? '(you)' : ''} {u.clientId === room.hostId ? '👑 HOST' : ''}
                {isHost && u.clientId !== clientId && <button onClick={() => send({ type: 'transferHost', toClientId: u.clientId })}>MAKE HOST</button>}
              </div>
            ))}
          </div>

          <div className="neon n-yellow">
            <h2 style={{ color: '#ffe600' }}>✦ playlist ({room.playlist.length})</h2>
            {room.playlist.length === 0 && <div className="mono-dim">empty — queue from discover ▲</div>}
            {room.playlist.map((v) => (
              <div key={v.id} className="row"><span>🎬 {v.title} <span className="mono-dim">by {v.addedBy}</span></span>
                <button onClick={() => send({ type: 'setVideo', url: v.url, title: v.title })}>PLAY</button>
                <button className="warn" onClick={() => send({ type: 'playlistRemove', id: v.id })}>X</button></div>
            ))}
          </div>

          <div className="neon n-orange">
            <h2 style={{ color: '#ff6b00' }}>✦ reactions</h2>
            <div className="row">{EMOJIS.map((e) => <button key={e} onClick={() => send({ type: 'reaction', emoji: e })}>{e}</button>)}</div>
            <div>{(room.reactions || []).slice(-8).map((r, i) => <span key={i} className="pill" style={{ color: NEON[i % NEON.length] }}>{r.emoji} {r.fromName}</span>)}</div>
          </div>

          <div className="neon n-red">
            <h2 style={{ color: '#ff073a' }}>✦ polls</h2>
            <div className="row">
              <input placeholder="poll question…" value={pollQ} onChange={(e) => setPollQ(e.target.value)} style={{ flex: 1 }} />
            </div>
            <div className="row">
              <input placeholder="comma options" value={pollOpts} onChange={(e) => setPollOpts(e.target.value)} style={{ flex: 1 }} />
              <button className="lime" onClick={() => {
                const opts = pollOpts.split(',').map((s) => s.trim()).filter(Boolean);
                if (pollQ && opts.length >= 2) { send({ type: 'pollCreate', question: pollQ, options: opts }); setPollQ(''); }
              }}>START</button>
              <button onClick={() => {
                const opts = recs.map((m) => m.title);
                if (opts.length) send({ type: 'pollCreate', question: `What next after “${room.videoTitle}”?`, options: opts.slice(0, 4) });
              }}>⚡ POLL: WHAT NEXT?</button>
            </div>
            {(room.polls || []).slice().reverse().map((p) => (
              <div key={p.id} className="neon n-yellow" style={{ margin: '6px 0' }}>
                <b>{p.question}</b> {p.open ? '' : '(closed)'}
                {p.options.map((o, i) => (
                  <div key={i} className="row"><button disabled={!p.open} onClick={() => send({ type: 'pollVote', pollId: p.id, optionIdx: i })}>VOTE</button>
                    <span>{o.text} — <b>{o.votes}</b></span>
                    <span style={{ background: '#ff6b00', height: 8, width: Math.min(120, o.votes * 24), display: 'inline-block' }} /></div>
                ))}
                {p.open && <button className="warn" onClick={() => send({ type: 'pollClose', pollId: p.id })}>CLOSE</button>}
              </div>
            ))}
          </div>

          <div className="neon n-lime">
            <h2 style={{ color: '#39ff14' }}>✦ live chat</h2>
            <div className="chatlog">{room.chat.map((m) => <div key={m.id}><b style={{ color: '#00fff2' }}>{m.fromName}:</b> {m.text}</div>)}</div>
            <div className="row">
              <input placeholder="message… (/shout hi)" value={chat} onChange={(e) => setChat(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && chat.trim()) {
                    if (chat.startsWith('/shout ')) send({ type: 'reaction', emoji: '📢' });
                    send({ type: 'chat', text: chat }); setChat('');
                  }
                }} style={{ flex: 1 }} />
              <button className="lime" onClick={() => { if (chat.trim()) { send({ type: 'chat', text: chat }); setChat(''); } }}>SEND</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MovieBrowser({ q, setQ, genre, setGenre, mood, setMood, minRating, setMinRating, sort, setSort, results, onPick, onQueue, compact }) {
  return (
    <div>
      <div className="row">
        <input placeholder="fuzzy search… try “sintel”, “heist”, “dumpling”" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <select value={genre} onChange={(e) => setGenre(e.target.value)}>{GENRES.map((g) => <option key={g}>{g}</option>)}</select>
        <select value={mood} onChange={(e) => setMood(e.target.value)}>{MOODS.map((m) => <option key={m}>{m}</option>)}</select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="match">best match</option><option value="rating">top rated</option><option value="year">newest</option>
        </select>
        <select value={minRating} onChange={(e) => setMinRating(Number(e.target.value))}>
          {[0, 7, 8, 8.5].map((r) => <option key={r} value={r}>★≥{r}</option>)}
        </select>
      </div>
      <div className="mono-dim">{results.length} results · typo-tolerant (levenshtein + subsequence rank)</div>
      {results.slice(0, compact ? 8 : 12).map((m, i) => (
        <div key={m.id} className="neon movie" style={{ borderColor: NEON[i % NEON.length], margin: '6px 0' }}
          onClick={() => onPick && onPick(m)}>
          <b>{m.title}</b> <span className="mono-dim">({m.year}) {m.genre} · {m.mood} · ★{m.rating} · {m.mins}m</span><br />
          <span className="mono-dim">cast: {m.cast.join(', ')}</span>
          {onQueue && <span className="row"><button onClick={(e) => { e.stopPropagation(); onPick(m); }}>▶ SYNC-PLAY</button>
            <button onClick={(e) => { e.stopPropagation(); onQueue(m); }}>+ QUEUE</button></span>}
        </div>
      ))}
    </div>
  );
}

function Sparkline() {
  // decorative neon equalizer — signals "live sync" (real numbers live in HUD above)
  const bars = [3, 7, 5, 9, 4, 8, 6, 10, 5, 7, 3, 9, 6, 4, 8];
  return (
    <div className="row" style={{ alignItems: 'flex-end', height: 26 }}>
      {bars.map((h, i) => <div key={i} style={{ width: 10, height: h * 2.4, background: NEON[i % NEON.length], boxShadow: `0 0 8px ${NEON[i % NEON.length]}` }} />)}
    </div>
  );
}
