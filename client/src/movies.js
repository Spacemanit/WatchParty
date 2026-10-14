// Curated sample catalog (direct-play mp4s so sync actually works).
// In production swap urls for HLS/DASH + TMDB metadata.
const SAMPLES = [
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
];

export const MOVIES = [
  { id: 1,  title: 'Big Buck Bunny', year: 2008, genre: 'Animation', mood: 'Chill', rating: 7.2, mins: 10, cast: ['Bunny', 'Rodents'] },
  { id: 2,  title: 'Elephants Dream', year: 2006, genre: 'Sci-Fi', mood: 'Trippy', rating: 6.8, mins: 11, cast: ['Proog', 'Emo'] },
  { id: 3,  title: 'Blaze Runner Nights', year: 2023, genre: 'Action', mood: 'Hype', rating: 8.1, mins: 15, cast: ['Rex', 'Nova'] },
  { id: 4,  title: 'Escape Velocity', year: 2022, genre: 'Thriller', mood: 'Tense', rating: 7.9, mins: 15, cast: ['Mara', 'Juno'] },
  { id: 5,  title: 'Fun Circuit', year: 2021, genre: 'Comedy', mood: 'Party', rating: 7.4, mins: 12, cast: ['Pip', 'Zed'] },
  { id: 6,  title: 'Joyride Overdrive', year: 2024, genre: 'Action', mood: 'Hype', rating: 8.4, mins: 14, cast: ['Axel', 'Vex'] },
  { id: 7,  title: 'Sintel: Ember Quest', year: 2010, genre: 'Fantasy', mood: 'Epic', rating: 8.7, mins: 15, cast: ['Sintel', 'Dragon'] },
  { id: 8,  title: 'Tears of Steel', year: 2012, genre: 'Sci-Fi', mood: 'Epic', rating: 7.8, mins: 12, cast: ['Forty', 'Celia'] },
  { id: 9,  title: 'Neon Heist', year: 2024, genre: 'Thriller', mood: 'Hype', rating: 8.0, mins: 118, cast: ['Kira', 'Dax'] },
  { id: 10, title: 'Midnight LoFi Lounge', year: 2023, genre: 'Romance', mood: 'Chill', rating: 7.1, mins: 96, cast: ['Yuki', 'Sol'] },
  { id: 11, title: 'Quantum Popcorn', year: 2022, genre: 'Comedy', mood: 'Party', rating: 7.6, mins: 104, cast: ['Bex', 'Mo'] },
  { id: 12, title: 'The Last Buffer', year: 2025, genre: 'Horror', mood: 'Tense', rating: 8.9, mins: 111, cast: ['Iris', 'Cole'] },
  { id: 13, title: 'Starlight Ramen Run', year: 2021, genre: 'Animation', mood: 'Cozy', rating: 8.2, mins: 88, cast: ['Pocky', 'Miso'] },
  { id: 14, title: 'Desert Frequency', year: 2020, genre: 'Drama', mood: 'Slow', rating: 7.0, mins: 122, cast: ['Amar', 'Sana'] },
  { id: 15, title: 'Glitch Wedding', year: 2024, genre: 'Comedy', mood: 'Chaotic', rating: 7.7, mins: 99, cast: ['Liv', 'Jay'] },
  { id: 16, title: 'Iron Monsoon', year: 2019, genre: 'Action', mood: 'Epic', rating: 7.5, mins: 130, cast: ['Vik', 'Ara'] },
  { id: 17, title: 'Paper Moons', year: 2018, genre: 'Romance', mood: 'Cozy', rating: 7.9, mins: 101, cast: ['Noa', 'Eli'] },
  { id: 18, title: 'Cryptid Camp', year: 2023, genre: 'Horror', mood: 'Party', rating: 6.9, mins: 93, cast: ['Sam', 'Tess'] },
  { id: 19, title: 'Zero Gravity Hearts', year: 2025, genre: 'Sci-Fi', mood: 'Romantic', rating: 8.5, mins: 116, cast: ['Lyra', ' Orion'.trim()] },
  { id: 20, title: 'The Projectionist', year: 2017, genre: 'Drama', mood: 'Slow', rating: 8.3, mins: 124, cast: ['Otto', 'Mabel'] },
  { id: 21, title: 'Bass Drop Detective', year: 2024, genre: 'Comedy', mood: 'Chaotic', rating: 7.3, mins: 97, cast: ['Dee', 'Kay'] },
  { id: 22, title: 'Silent Orbit', year: 2022, genre: 'Sci-Fi', mood: 'Tense', rating: 8.6, mins: 109, cast: ['Hal', 'Ivy'] },
  { id: 23, title: 'Curse of the Pause Button', year: 2023, genre: 'Horror', mood: 'Meta', rating: 7.8, mins: 90, cast: ['Rin', 'Bo'] },
  { id: 24, title: 'Dumpling Heist 2', year: 2025, genre: 'Animation', mood: 'Party', rating: 8.8, mins: 95, cast: ['Bao', 'Gyo'] },
].map((m, i) => ({ ...m, url: SAMPLES[i % SAMPLES.length] }));

// --- fuzzy search: normalized substring + subsequence + levenshtein rank ---
function norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(); }
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!a) return n; if (!b) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[m][n];
}
function subseqScore(q, t) {
  // returns 0..1 — how cleanly q appears in order inside t
  let ti = 0, gaps = 0;
  for (const c of q) {
    const f = t.indexOf(c, ti);
    if (f === -1) return 0;
    gaps += f - ti; ti = f + 1;
  }
  return Math.max(0, 1 - gaps / Math.max(t.length, 1));
}

export function fuzzySearch(query, filters = {}) {
  const q = norm(query);
  const { genre = 'All', mood = 'All', minRating = 0, sort = 'match' } = filters;
  let list = MOVIES.filter(m =>
    (genre === 'All' || m.genre === genre) &&
    (mood === 'All' || m.mood === mood) &&
    m.rating >= minRating
  ).map(m => {
    if (!q) return { ...m, _score: 1 };
    const hay = norm(m.title + ' ' + m.genre + ' ' + m.cast.join(' '));
    let score = 0;
    if (hay.includes(q)) score = 2 + q.length / hay.length;         // exact substring wins
    else {
      const lev = levenshtein(q, norm(m.title).slice(0, q.length + 4));
      score = subseqScore(q, hay) * 1.5 - lev * 0.05;                 // typo-tolerant
    }
    return { ...m, _score: score };
  }).filter(m => !q || m._score > 0.15);

  if (sort === 'rating') list.sort((a, b) => b.rating - a.rating);
  else if (sort === 'year') list.sort((a, b) => b.year - a.year);
  else list.sort((a, b) => b._score - a._score);
  return list;
}

export function recommendFor(roomTitle, n = 3) {
  // "More like this" — same genre/mood first, then top rated. Used for group polls.
  const cur = MOVIES.find(m => m.title === roomTitle);
  if (!cur) return [...MOVIES].sort((a, b) => b.rating - a.rating).slice(0, n);
  return MOVIES.filter(m => m.id !== cur.id)
    .map(m => ({ ...m, _r: (m.genre === cur.genre ? 2 : 0) + (m.mood === cur.mood ? 1.5 : 0) + m.rating / 10 }))
    .sort((a, b) => b._r - a._r).slice(0, n);
}

export const GENRES = ['All', ...new Set(MOVIES.map(m => m.genre))];
export const MOODS = ['All', ...new Set(MOVIES.map(m => m.mood))];
