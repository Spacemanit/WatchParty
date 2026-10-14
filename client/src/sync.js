import { useCallback, useEffect, useRef, useState } from 'react';

const WS_URL = (window.__WS_URL__ || `ws://${window.location.hostname}:8080`);
const LS_KEY = 'watchparty-identity-v1';

function loadIdent() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } }
function saveIdent(o) { localStorage.setItem(LS_KEY, JSON.stringify(o)); }

function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

export function useWatchParty(videoRef) {
  const [connected, setConnected] = useState(false);
  const [room, setRoom] = useState(null);       // snapshot-derived state
  const [clientId, setClientId] = useState(null);
  const [rtt, setRtt] = useState(0);
  const [propSamples, setPropSamples] = useState([]); // action propagation ms
  const [driftSamples, setDriftSamples] = useState([]); // |drift| ms at check time
  const [corrections, setCorrections] = useState(0);
  const [rain, setRain] = useState([]); // emoji rain ids
  const wsRef = useRef(null);
  const authRef = useRef({ isPlaying: false, position: 0, serverTime: Date.now(), seq: 0 });
  const applyingRef = useRef(false);
  const pendingT0 = useRef(new Map()); // seq? use clientTs echo: store t0 by action+time
  const lastT0 = useRef(0);
  const reconnectRef = useRef({ tries: 0, roomId: null, name: '' });
  const rainId = useRef(0);

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }, []);

  // --- apply authoritative playback to <video> ---
  const applyPlayback = useCallback((msg) => {
    const v = videoRef.current;
    authRef.current = {
      isPlaying: msg.isPlaying ?? authRef.current.isPlaying,
      position: msg.position ?? 0,
      serverTime: msg.serverTime ?? Date.now(),
      seq: msg.seq ?? authRef.current.seq,
      videoUrl: msg.videoUrl, videoTitle: msg.videoTitle,
    };
    setRoom((r) => {
      if (!r) return r;
      const nr = { ...r, seq: msg.seq ?? r.seq, lastAction: msg.action, lastActor: msg.actorName || msg.actor };
      if (msg.videoUrl) { nr.videoUrl = msg.videoUrl; nr.videoTitle = msg.videoTitle; }
      nr.isPlaying = msg.isPlaying ?? nr.isPlaying;
      return nr;
    });
    // propagation sample: t_send (clientTs or lastT0) -> now
    const t0 = msg.clientTs || lastT0.current;
    if (t0) {
      const dt = Date.now() - t0;
      if (dt >= 0 && dt < 5000) setPropSamples((s) => [...s.slice(-99), dt]);
    }
    if (!v) return;
    try {
      applyingRef.current = true;
      const expected = msg.isPlaying
        ? msg.position + (Date.now() - (msg.serverTime ?? Date.now())) / 1000
        : msg.position;
      if (msg.videoUrl && v.src !== msg.videoUrl && !v.src.endsWith(encodeURI(msg.videoUrl).slice(-20))) {
        v.src = msg.videoUrl;
      }
      if (Math.abs((v.currentTime || 0) - expected) > 0.35) v.currentTime = Math.max(0, expected);
      if (msg.isPlaying) v.play().catch(() => {});
      else v.pause();
    } finally {
      setTimeout(() => { applyingRef.current = false; }, 250);
    }
  }, [videoRef]);

  const connect = useCallback((roomId, name, prevClientId) => {
    reconnectRef.current = { tries: 0, roomId, name };
    if (wsRef.current) { try { wsRef.current.close(); } catch {} }
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectRef.current.tries = 0;
      if (roomId) ws.send(JSON.stringify({ type: 'join', roomId, name, clientId: prevClientId || undefined }));
      else ws.send(JSON.stringify({ type: 'create', name }));
      // rtt probe loop
      const probe = setInterval(() => {
        if (ws.readyState !== 1) { clearInterval(probe); return; }
        ws.send(JSON.stringify({ type: 'ping', t0: Date.now() }));
      }, 3000);
      ws._probe = probe;
    };

    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.type) {
        case 'hello': break;
        case 'pong': setRtt(Date.now() - m.t0); break;
        case 'joined': {
          setClientId(m.clientId);
          const s = m.snapshot;
          authRef.current = { isPlaying: s.isPlaying, position: s.position, serverTime: s.serverTime, seq: s.seq };
          setRoom({ ...s, resumed: m.resumed });
          saveIdent({ clientId: m.clientId, name, roomId: s.roomId });
          reconnectRef.current.roomId = s.roomId;
          // converge video instantly (late-join)
          const v = videoRef.current;
          if (v) {
            applyingRef.current = true;
            if (v.src !== s.videoUrl) v.src = s.videoUrl;
            const exp = s.isPlaying ? s.position + (Date.now() - s.serverTime) / 1000 : s.position;
            v.currentTime = Math.max(0, exp);
            if (s.isPlaying) v.play().catch(() => {}); else v.pause();
            setTimeout(() => { applyingRef.current = false; }, 300);
          }
          break;
        }
        case 'playback': applyPlayback(m); break;
        case 'correction': {
          const v = videoRef.current;
          if (v) {
            const exp = m.isPlaying ? m.position + (Date.now() - m.serverTime) / 1000 : m.position;
            v.currentTime = Math.max(0, exp);
            if (m.isPlaying) v.play().catch(() => {});
            setCorrections((c) => c + 1);
          }
          break;
        }
        case 'chatMsg':
          setRoom((r) => r ? { ...r, chat: [...r.chat.slice(-49), m.msg] } : r);
          break;
        case 'reaction': {
          setRoom((r) => r ? { ...r, reactions: [...(r.reactions || []).slice(-29), m] } : r);
          const id = ++rainId.current;
          setRain((x) => [...x.slice(-11), { id, emoji: m.emoji, left: Math.random() * 90 }]);
          setTimeout(() => setRain((x) => x.filter((e) => e.id !== id)), 2300);
          break;
        }
        case 'playlist': setRoom((r) => r ? { ...r, playlist: m.playlist } : r); break;
        case 'polls': setRoom((r) => r ? { ...r, polls: m.polls } : r); break;
        case 'users':
          setRoom((r) => r ? { ...r, users: m.users, hostId: m.hostId ?? r.hostId } : r);
          break;
        case 'hostChanged':
          setRoom((r) => r ? { ...r, hostId: m.hostId } : r);
          break;
        case 'ack': break;
        case 'error': console.warn('[wp]', m.message); break;
        default: break;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      clearInterval(ws._probe);
      // exponential-backoff reconnect (handles drops; server keeps 60s grace)
      const rec = reconnectRef.current;
      if (!rec.roomId && roomId) rec.roomId = roomId;
      rec.tries += 1;
      const delay = Math.min(10000, 500 * 2 ** rec.tries);
      const ident = loadIdent();
      setTimeout(() => {
        if (wsRef.current === ws) connect(rec.roomId, rec.name || ident.name || 'Guest', ident.clientId);
      }, delay);
    };
  }, [applyPlayback, videoRef]);

  // --- drift detection + correction loop (client self-heals to authoritative clock) ---
  useEffect(() => {
    const iv = setInterval(() => {
      const v = videoRef.current;
      if (!v || !room || applyingRef.current || !v.src) return;
      const a = authRef.current;
      const expected = a.isPlaying ? a.position + (Date.now() - a.serverTime) / 1000 : a.position;
      if (!isFinite(expected)) return;
      const driftMs = ((v.currentTime || 0) - expected) * 1000;
      setDriftSamples((s) => [...s.slice(-99), Math.abs(Math.round(driftMs))]);
      if (Math.abs(driftMs) > 500 && !v.paused) {
        v.currentTime = Math.max(0, expected); // snap correction (<500ms after)
        setCorrections((c) => c + 1);
      }
      // report to server (server may also nudge via 'correction')
      send({ type: 'stateSync', position: v.currentTime || 0 });
    }, 2000);
    return () => clearInterval(iv);
  }, [room, send, videoRef]);

  // --- local video events -> broadcast (ignore remote-applied echoes) ---
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !room) return;
    const onPlay = () => {
      if (applyingRef.current) return;
      lastT0.current = Date.now();
      send({ type: 'play', position: v.currentTime || 0, clientTs: lastT0.current });
    };
    const onPause = () => {
      if (applyingRef.current) return;
      lastT0.current = Date.now();
      send({ type: 'pause', position: v.currentTime || 0, clientTs: lastT0.current });
    };
    const onSeeked = () => {
      if (applyingRef.current) return;
      lastT0.current = Date.now();
      send({ type: 'seek', position: v.currentTime || 0, clientTs: lastT0.current });
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', onSeeked);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', onSeeked);
    };
  }, [room, send, videoRef]);

  const stats = {
    rtt,
    p50: Math.round(percentile(propSamples, 0.5)),
    p95: Math.round(percentile(propSamples, 0.95)),
    driftP95: Math.round(percentile(driftSamples, 0.95)),
    driftLast: driftSamples.length ? driftSamples[driftSamples.length - 1] : 0,
    samples: propSamples.length,
    corrections,
  };

  return { connected, room, clientId, stats, rain, send, connect, applyPlayback };
}
