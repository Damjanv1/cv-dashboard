// Aggregate Lichess games NDJSON into a compact summary JSON for the dashboard
const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');

const USER_ID = 'damjanv';
const IN_FILE = path.join(__dirname, 'games.ndjson');
const OUT_FILE = path.join(__dirname, 'summary.json');

const lines = fs.readFileSync(IN_FILE, 'utf8').split('\n').filter(Boolean);
const games = lines.map(l => JSON.parse(l));

// --- Helpers ---
const myColor = g => (g.players.white.user && g.players.white.user.id === USER_ID) ? 'white' : 'black';
const oppColor = g => myColor(g) === 'white' ? 'black' : 'white';
const result = g => {
  if (!g.winner) return 'draw';
  return g.winner === myColor(g) ? 'win' : 'loss';
};
const myRating = g => g.players[myColor(g)].rating;
const oppRating = g => g.players[oppColor(g)].rating;
const ratingDiff = g => (g.players[myColor(g)].ratingDiff) || 0;

const moveList = g => (g.moves || '').split(' ').filter(Boolean);

// Identify piece from SAN move — 'Q..' = Queen, 'R..'=Rook, 'B..'=Bishop, 'N..'=Knight, 'K..'=King (only moves), 'O-O' castles, else pawn
const pieceFromMove = (san) => {
  if (!san) return null;
  const s = san.replace(/[+#!?]/g, '');
  if (s.startsWith('O-O')) return 'King'; // castle (unlikely to be mating move but possible)
  const c = s[0];
  if (c === 'Q') return 'Queen';
  if (c === 'R') return 'Rook';
  if (c === 'B') return 'Bishop';
  if (c === 'N') return 'Knight';
  if (c === 'K') return 'King';
  return 'Pawn';
};

// Opening family from ECO code (A00-E99)
const ecoFamily = eco => {
  if (!eco) return '?';
  const c = eco[0];
  if ('ABCDE'.includes(c)) return c;
  return '?';
};
const FAMILY_NAMES = {
  A: 'Flank openings & English',
  B: 'Semi-open (Sicilian, Caro-Kann, etc.)',
  C: 'Open games (1.e4 e5) & French',
  D: 'Closed & Semi-closed (1.d4 d5, Slav, QGD)',
  E: 'Indian defences (KID, NID, QID)',
};

// Main opening name (strip variation after colon)
const mainOpening = name => name ? name.split(':')[0].trim() : 'Unknown';

// --- Aggregates ---
const agg = {
  meta: {
    user: 'Damjanv',
    userId: USER_ID,
    pulledAt: new Date().toISOString(),
    totalGames: games.length,
    firstGame: new Date(Math.min(...games.map(g => g.createdAt))).toISOString(),
    lastGame: new Date(Math.max(...games.map(g => g.createdAt))).toISOString(),
    hasAccuracy: games.some(g => g.players.white.accuracy || g.players.black.accuracy),
  },
};

// KPIs
let w = 0, l = 0, d = 0;
games.forEach(g => { const r = result(g); if (r === 'win') w++; else if (r === 'loss') l++; else d++; });
// Post-game rating for each rapid game (this is what Lichess actually shows as "rating" after each game)
const rapidPost = games.filter(g => g.speed === 'rapid').map(g => myRating(g) + (ratingDiff(g) || 0));
const blitzPost = games.filter(g => g.speed === 'blitz').map(g => myRating(g) + (ratingDiff(g) || 0));
const lastRapid = games.filter(g => g.speed === 'rapid').sort((a, b) => b.createdAt - a.createdAt)[0];
const lastRapidPost = lastRapid ? (lastRapid.players[myColor(lastRapid)].rating + (lastRapid.players[myColor(lastRapid)].ratingDiff || 0)) : null;
agg.kpi = {
  total: games.length,
  wins: w, losses: l, draws: d,
  winPct: +(w / games.length * 100).toFixed(2),
  winPctDecisive: +(w / (w + l) * 100).toFixed(2),
  rapidRatingCurrent: lastRapidPost,
  rapidPeak: rapidPost.length ? Math.max(...rapidPost) : null,
  rapidLow: rapidPost.length ? Math.min(...rapidPost) : null,
  blitzPeak: blitzPost.length ? Math.max(...blitzPost) : null,
  blitzLow: blitzPost.length ? Math.min(...blitzPost) : null,
};

// By color
const byColor = { white: { w: 0, l: 0, d: 0 }, black: { w: 0, l: 0, d: 0 } };
games.forEach(g => {
  const c = myColor(g); const r = result(g);
  if (r === 'win') byColor[c].w++;
  else if (r === 'loss') byColor[c].l++;
  else byColor[c].d++;
});
agg.byColor = byColor;

// By speed
const bySpeed = {};
games.forEach(g => {
  if (!bySpeed[g.speed]) bySpeed[g.speed] = { w: 0, l: 0, d: 0, n: 0 };
  bySpeed[g.speed].n++;
  const r = result(g);
  if (r === 'win') bySpeed[g.speed].w++;
  else if (r === 'loss') bySpeed[g.speed].l++;
  else bySpeed[g.speed].d++;
});
agg.bySpeed = bySpeed;

// By speed × color
const bySpeedColor = {};
games.forEach(g => {
  const s = g.speed, c = myColor(g);
  if (!bySpeedColor[s]) bySpeedColor[s] = { white: { w: 0, l: 0, d: 0, n: 0 }, black: { w: 0, l: 0, d: 0, n: 0 } };
  bySpeedColor[s][c].n++;
  const r = result(g);
  if (r === 'win') bySpeedColor[s][c].w++;
  else if (r === 'loss') bySpeedColor[s][c].l++;
  else bySpeedColor[s][c].d++;
});
agg.bySpeedColor = bySpeedColor;

// Rating over time — store every rapid game (a compact [ts, rating] pair)
const rapidGames = games.filter(g => g.speed === 'rapid').sort((a, b) => a.createdAt - b.createdAt);
const blitzGames = games.filter(g => g.speed === 'blitz').sort((a, b) => a.createdAt - b.createdAt);
agg.ratingOverTime = {
  rapid: rapidGames.map(g => [g.createdAt, myRating(g)]),
  blitz: blitzGames.map(g => [g.createdAt, myRating(g)]),
};
// Post-game (rating + ratingDiff) — what Lichess displays as the rating AFTER each game.
agg.ratingAfter = {
  rapid: rapidGames.map(g => [g.createdAt, myRating(g) + (ratingDiff(g) || 0)]),
  blitz: blitzGames.map(g => [g.createdAt, myRating(g) + (ratingDiff(g) || 0)]),
};

// Game endings (status)
const endings = { wins: {}, losses: {}, draws: {} };
games.forEach(g => {
  const r = result(g);
  const bucket = r === 'win' ? 'wins' : (r === 'loss' ? 'losses' : 'draws');
  endings[bucket][g.status] = (endings[bucket][g.status] || 0) + 1;
});
agg.endings = endings;

// Mating piece
const matingGiven = {}, matingReceived = {};
games.forEach(g => {
  if (g.status !== 'mate') return;
  const moves = moveList(g);
  const lastMove = moves[moves.length - 1];
  const piece = pieceFromMove(lastMove);
  if (!piece) return;
  const r = result(g);
  if (r === 'win') matingGiven[piece] = (matingGiven[piece] || 0) + 1;
  else if (r === 'loss') matingReceived[piece] = (matingReceived[piece] || 0) + 1;
});
agg.matingPiece = { given: matingGiven, received: matingReceived };

// Openings (by full name)
const openingStats = {};
games.forEach(g => {
  if (!g.opening) return;
  const key = g.opening.name;
  if (!openingStats[key]) openingStats[key] = { name: key, eco: g.opening.eco, family: ecoFamily(g.opening.eco), n: 0, w: 0, l: 0, d: 0, asWhite: 0, asBlack: 0 };
  const r = result(g);
  openingStats[key].n++;
  if (r === 'win') openingStats[key].w++;
  else if (r === 'loss') openingStats[key].l++;
  else openingStats[key].d++;
  if (myColor(g) === 'white') openingStats[key].asWhite++; else openingStats[key].asBlack++;
});
agg.openings = Object.values(openingStats).sort((a, b) => b.n - a.n);

// Opening families (ECO letter)
const families = { A: 0, B: 0, C: 0, D: 0, E: 0 };
const familiesResult = { A: { w: 0, l: 0, d: 0 }, B: { w: 0, l: 0, d: 0 }, C: { w: 0, l: 0, d: 0 }, D: { w: 0, l: 0, d: 0 }, E: { w: 0, l: 0, d: 0 } };
games.forEach(g => {
  const f = ecoFamily(g.opening && g.opening.eco);
  if (!(f in families)) return;
  families[f]++;
  const r = result(g);
  if (r === 'win') familiesResult[f].w++;
  else if (r === 'loss') familiesResult[f].l++;
  else familiesResult[f].d++;
});
agg.families = Object.keys(families).map(k => ({ eco: k, name: FAMILY_NAMES[k], n: families[k], ...familiesResult[k] }));

// Main openings grouped (top-level, before colon)
const mainOp = {};
games.forEach(g => {
  if (!g.opening) return;
  const key = mainOpening(g.opening.name);
  if (!mainOp[key]) mainOp[key] = { name: key, n: 0, w: 0, l: 0, d: 0 };
  mainOp[key].n++;
  const r = result(g);
  if (r === 'win') mainOp[key].w++;
  else if (r === 'loss') mainOp[key].l++;
  else mainOp[key].d++;
});
agg.mainOpenings = Object.values(mainOp).sort((a, b) => b.n - a.n);

// Move counts by result
const moveCounts = { win: [], loss: [], draw: [] };
games.forEach(g => {
  const count = moveList(g).length;
  const halfMoves = count; // ply count
  const fullMoves = Math.ceil(count / 2);
  const r = result(g);
  moveCounts[r].push(fullMoves);
});
const stats = arr => {
  if (!arr.length) return { n: 0, avg: 0, median: 0, min: 0, max: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return {
    n: s.length,
    avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
    median: s[Math.floor(s.length / 2)],
    min: s[0],
    max: s[s.length - 1],
    p25: s[Math.floor(s.length * 0.25)],
    p75: s[Math.floor(s.length * 0.75)],
  };
};
agg.moveStats = { win: stats(moveCounts.win), loss: stats(moveCounts.loss), draw: stats(moveCounts.draw) };

// Move count histogram (bucketed by 5 moves)
const bucketSize = 5;
const maxBucket = 100;
const histogram = { win: {}, loss: {}, draw: {} };
['win', 'loss', 'draw'].forEach(r => {
  for (let b = 0; b <= maxBucket; b += bucketSize) histogram[r][b] = 0;
  moveCounts[r].forEach(m => {
    const b = Math.min(Math.floor(m / bucketSize) * bucketSize, maxBucket);
    histogram[r][b]++;
  });
});
agg.moveHistogram = histogram;

// Activity by month
const byMonth = {};
games.forEach(g => {
  const d = new Date(g.createdAt);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  if (!byMonth[key]) byMonth[key] = { month: key, n: 0, w: 0, l: 0, d: 0 };
  byMonth[key].n++;
  const r = result(g);
  if (r === 'win') byMonth[key].w++;
  else if (r === 'loss') byMonth[key].l++;
  else byMonth[key].d++;
});
agg.byMonth = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));

// Record when favoured (by ELO): bucket by (myRating - oppRating) at game start
const favourBuckets = [
  { label: 'Opp much stronger (>100)', lo: -Infinity, hi: -100, n: 0, w: 0, l: 0, d: 0 },
  { label: 'Opp stronger (50-100)', lo: -100, hi: -50, n: 0, w: 0, l: 0, d: 0 },
  { label: 'Even (±50)', lo: -50, hi: 50, n: 0, w: 0, l: 0, d: 0 },
  { label: 'I was favoured (50-100)', lo: 50, hi: 100, n: 0, w: 0, l: 0, d: 0 },
  { label: 'I was much stronger (>100)', lo: 100, hi: Infinity, n: 0, w: 0, l: 0, d: 0 },
];
games.forEach(g => {
  const diff = myRating(g) - oppRating(g);
  const b = favourBuckets.find(b => diff >= b.lo && diff < b.hi);
  if (!b) return;
  b.n++;
  const r = result(g);
  if (r === 'win') b.w++;
  else if (r === 'loss') b.l++;
  else b.d++;
});
agg.favourBuckets = favourBuckets;

// First move by me
const firstMove = { asWhite: {}, asBlack: {} };
games.forEach(g => {
  const moves = moveList(g);
  if (!moves.length) return;
  const col = myColor(g);
  const myFirst = col === 'white' ? moves[0] : moves[1];
  if (!myFirst) return;
  const key = col === 'white' ? 'asWhite' : 'asBlack';
  if (!firstMove[key][myFirst]) firstMove[key][myFirst] = { move: myFirst, n: 0, w: 0, l: 0, d: 0 };
  firstMove[key][myFirst].n++;
  const r = result(g);
  if (r === 'win') firstMove[key][myFirst].w++;
  else if (r === 'loss') firstMove[key][myFirst].l++;
  else firstMove[key][myFirst].d++;
});
agg.firstMoves = {
  asWhite: Object.values(firstMove.asWhite).sort((a, b) => b.n - a.n),
  asBlack: Object.values(firstMove.asBlack).sort((a, b) => b.n - a.n),
};

// Rolling 50-game win rate (for trend)
const sortedGames = [...games].sort((a, b) => a.createdAt - b.createdAt);
const rolling = [];
const w50 = 50;
for (let i = w50 - 1; i < sortedGames.length; i++) {
  let wc = 0, lc = 0, dc = 0;
  for (let j = i - w50 + 1; j <= i; j++) {
    const r = result(sortedGames[j]);
    if (r === 'win') wc++;
    else if (r === 'loss') lc++;
    else dc++;
  }
  rolling.push({ idx: i + 1, ts: sortedGames[i].createdAt, winPct: +(wc / w50 * 100).toFixed(1) });
}
agg.rolling50 = rolling;

// Longest win/loss streaks
let curWin = 0, curLoss = 0, bestWin = 0, worstLoss = 0;
sortedGames.forEach(g => {
  const r = result(g);
  if (r === 'win') { curWin++; curLoss = 0; bestWin = Math.max(bestWin, curWin); }
  else if (r === 'loss') { curLoss++; curWin = 0; worstLoss = Math.max(worstLoss, curLoss); }
  else { curWin = 0; curLoss = 0; }
});
agg.streaks = { longestWin: bestWin, longestLoss: worstLoss };

// Rating diff distribution (cumulative rating change over time — for rapid only)
const rapidSorted = rapidGames.map(g => ({ ts: g.createdAt, diff: ratingDiff(g), ratingAfter: myRating(g) + (ratingDiff(g) || 0) }));
// Note: rating shown is pre-game rating in Lichess API; ratingAfter = rating + ratingDiff

// Game source types
const sources = {};
games.forEach(g => sources[g.source || 'unknown'] = (sources[g.source || 'unknown'] || 0) + 1);
agg.sources = sources;

// --- PHASE & MATERIAL ANALYSIS ---
// Phase buckets by ply count where the game ended: opening (<20 ply ≈ <10 moves), middlegame (20-60 ply ≈ 10-30 moves), endgame (>=60 ply ≈ >=30 moves)
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const countMaterial = (board) => {
  // board is chess.js board() — 8x8 array of {type,color} or null
  let white = 0, black = 0;
  for (const row of board) for (const sq of row) {
    if (!sq) continue;
    const v = PIECE_VALUE[sq.type] || 0;
    if (sq.color === 'w') white += v; else black += v;
  }
  return { white, black };
};

const phaseFromPly = ply => {
  if (ply < 20) return 'Opening (<10 moves)';
  if (ply < 60) return 'Middlegame (10-30)';
  return 'Endgame (30+)';
};

// Per-phase record
const phaseRecord = {
  'Opening (<10 moves)': { n: 0, w: 0, l: 0, d: 0 },
  'Middlegame (10-30)': { n: 0, w: 0, l: 0, d: 0 },
  'Endgame (30+)':      { n: 0, w: 0, l: 0, d: 0 },
};

// Material buckets (signed: positive = I was ahead)
const matBuckets = [
  { label: 'Down 9+', lo: -Infinity, hi: -8.5, n: 0, w: 0, l: 0, d: 0 },
  { label: 'Down 5-9', lo: -8.5,     hi: -4.5, n: 0, w: 0, l: 0, d: 0 },
  { label: 'Down 2-5', lo: -4.5,     hi: -1.5, n: 0, w: 0, l: 0, d: 0 },
  { label: 'Even (±1)', lo: -1.5,    hi:  1.5, n: 0, w: 0, l: 0, d: 0 },
  { label: 'Up 2-5',   lo:  1.5,     hi:  4.5, n: 0, w: 0, l: 0, d: 0 },
  { label: 'Up 5-9',   lo:  4.5,     hi:  8.5, n: 0, w: 0, l: 0, d: 0 },
  { label: 'Up 9+',    lo:  8.5,     hi:  Infinity, n: 0, w: 0, l: 0, d: 0 },
];

// Phase × Result Sankey-style flow: phase-of-end → result
const phaseFlow = []; // array of {phase, result} pairs — will be aggregated into sankey nodes/links

// Material at end of game × result
const matByResult = { win: [], loss: [], draw: [] };

// Material differential along the game: average differential at moves 20, 40, 60 (where applicable) by result
const matTrajectory = { win: { 20: [], 40: [], 60: [] }, loss: { 20: [], 40: [], 60: [] }, draw: { 20: [], 40: [], 60: [] } };

let parsedOk = 0, parseFail = 0;
for (const g of games) {
  const moves = moveList(g);
  const plies = moves.length;
  const phase = phaseFromPly(plies);
  const r = result(g);
  phaseRecord[phase].n++;
  if (r === 'win') phaseRecord[phase].w++; else if (r === 'loss') phaseRecord[phase].l++; else phaseRecord[phase].d++;
  phaseFlow.push({ phase, result: r });

  // Simulate moves with chess.js to track material
  try {
    const chess = new Chess();
    let final = null;
    let snapshots = {};
    for (let i = 0; i < moves.length; i++) {
      try {
        chess.move(moves[i], { strict: false });
      } catch (e) {
        // SAN may have unusual chars; skip this game's material analysis
        throw e;
      }
      const ply = i + 1;
      if (ply === 20 || ply === 40 || ply === 60) {
        const m = countMaterial(chess.board());
        snapshots[ply] = m;
      }
    }
    final = countMaterial(chess.board());
    parsedOk++;
    // My material − opponent material
    const myCol = myColor(g) === 'white' ? 'white' : 'black';
    const oppCol = myCol === 'white' ? 'black' : 'white';
    const diff = final[myCol] - final[oppCol];
    matByResult[r].push(diff);
    const b = matBuckets.find(b => diff >= b.lo && diff < b.hi);
    if (b) { b.n++; if (r === 'win') b.w++; else if (r === 'loss') b.l++; else b.d++; }
    for (const ply of [20, 40, 60]) {
      if (snapshots[ply]) matTrajectory[r][ply].push(snapshots[ply][myCol] - snapshots[ply][oppCol]);
    }
  } catch (e) {
    parseFail++;
  }
}

const mean = arr => arr.length ? +(arr.reduce((a,b)=>a+b,0) / arr.length).toFixed(2) : null;
agg.phaseRecord = Object.entries(phaseRecord).map(([phase, v]) => ({ phase, ...v }));
agg.phaseFlow = (() => {
  // Sankey-ready: nodes = phases + results, links = phase → result with counts
  const links = {};
  phaseFlow.forEach(({phase, result}) => {
    const key = phase + '||' + result;
    links[key] = (links[key] || 0) + 1;
  });
  return Object.entries(links).map(([k, count]) => {
    const [from, to] = k.split('||');
    return { from, to: to === 'win' ? 'Win' : (to === 'loss' ? 'Loss' : 'Draw'), count };
  });
})();
agg.materialBuckets = matBuckets;
agg.materialByResult = {
  win:  { n: matByResult.win.length,  mean: mean(matByResult.win),  median: matByResult.win.length ? [...matByResult.win].sort((a,b)=>a-b)[Math.floor(matByResult.win.length/2)] : null },
  loss: { n: matByResult.loss.length, mean: mean(matByResult.loss), median: matByResult.loss.length ? [...matByResult.loss].sort((a,b)=>a-b)[Math.floor(matByResult.loss.length/2)] : null },
  draw: { n: matByResult.draw.length, mean: mean(matByResult.draw), median: matByResult.draw.length ? [...matByResult.draw].sort((a,b)=>a-b)[Math.floor(matByResult.draw.length/2)] : null },
};
agg.materialTrajectory = {
  win:  { 20: mean(matTrajectory.win[20]),  40: mean(matTrajectory.win[40]),  60: mean(matTrajectory.win[60]) },
  loss: { 20: mean(matTrajectory.loss[20]), 40: mean(matTrajectory.loss[40]), 60: mean(matTrajectory.loss[60]) },
  draw: { 20: mean(matTrajectory.draw[20]), 40: mean(matTrajectory.draw[40]), 60: mean(matTrajectory.draw[60]) },
};
agg.materialParseStats = { ok: parsedOk, failed: parseFail };

// Write summary
fs.writeFileSync(OUT_FILE, JSON.stringify(agg, null, 2));
console.log('Summary written to', OUT_FILE);
console.log('Size:', fs.statSync(OUT_FILE).size, 'bytes');
console.log('KPI:', agg.kpi);
console.log('Meta:', agg.meta);
console.log('Top 5 openings:', agg.openings.slice(0, 5).map(o => `${o.n}× ${o.name} (W${o.w}/L${o.l})`));
console.log('Families:', agg.families);
console.log('Wins end in:', agg.endings.wins);
console.log('Losses end in:', agg.endings.losses);
console.log('Mating given:', agg.matingPiece.given);
console.log('Mating received:', agg.matingPiece.received);
console.log('Streaks:', agg.streaks);
console.log('Move stats:', agg.moveStats);
console.log('Favour buckets:', agg.favourBuckets.map(b => `${b.label}: ${b.n}g → W${b.w}/L${b.l}/D${b.d}`));
