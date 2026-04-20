// Aggregate Lichess games NDJSON into a compact summary JSON for the dashboard.
// Emits { all, rapid, blitz } — each a full aggregate — so the dashboard can filter without re-fetching.
const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');

const USER_ID = 'damjanv';
const IN_FILE = path.join(__dirname, 'games.ndjson');
const OUT_FILE = path.join(__dirname, 'summary.json');

const lines = fs.readFileSync(IN_FILE, 'utf8').split('\n').filter(Boolean);
const allGamesRaw = lines.map(l => JSON.parse(l));

// --- Helpers (pure) ---
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

const pieceFromMove = (san) => {
  if (!san) return null;
  const s = san.replace(/[+#!?]/g, '');
  if (s.startsWith('O-O')) return 'King';
  const c = s[0];
  if (c === 'Q') return 'Queen';
  if (c === 'R') return 'Rook';
  if (c === 'B') return 'Bishop';
  if (c === 'N') return 'Knight';
  if (c === 'K') return 'King';
  return 'Pawn';
};

const ecoFamily = eco => { if (!eco) return '?'; const c = eco[0]; return 'ABCDE'.includes(c) ? c : '?'; };
const FAMILY_NAMES = {
  A: 'Flank openings & English',
  B: 'Semi-open (Sicilian, Caro-Kann, etc.)',
  C: 'Open games (1.e4 e5) & French',
  D: 'Closed & Semi-closed (1.d4 d5, Slav, QGD)',
  E: 'Indian defences (KID, NID, QID)',
};
const mainOpening = name => name ? name.split(':')[0].trim() : 'Unknown';

// --- Material analysis (expensive, so compute ONCE per game and cache on the object) ---
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const countMaterial = (board) => {
  let white = 0, black = 0;
  for (const row of board) for (const sq of row) {
    if (!sq) continue;
    const v = PIECE_VALUE[sq.type] || 0;
    if (sq.color === 'w') white += v; else black += v;
  }
  return { white, black };
};
let materialOk = 0, materialFail = 0;
for (const g of allGamesRaw) {
  try {
    const moves = moveList(g);
    const chess = new Chess();
    const snapshots = {};
    for (let i = 0; i < moves.length; i++) {
      chess.move(moves[i], { strict: false });
      const ply = i + 1;
      if (ply === 20 || ply === 40 || ply === 60) snapshots[ply] = countMaterial(chess.board());
    }
    const final = countMaterial(chess.board());
    const myCol = myColor(g) === 'white' ? 'white' : 'black';
    const oppCol = myCol === 'white' ? 'black' : 'white';
    g._matFinal = final[myCol] - final[oppCol];
    g._matSnapshots = {};
    for (const ply of [20, 40, 60]) if (snapshots[ply]) g._matSnapshots[ply] = snapshots[ply][myCol] - snapshots[ply][oppCol];
    materialOk++;
  } catch (e) {
    g._matFailed = true;
    materialFail++;
  }
}
console.log('Material analysis:', materialOk, 'ok /', materialFail, 'failed');

// --- Aggregator function — builds a full summary from a slice of games ---
function buildAgg(games, label) {
  const agg = {
    meta: {
      user: 'Damjanv',
      userId: USER_ID,
      label,
      pulledAt: new Date().toISOString(),
      totalGames: games.length,
      firstGame: games.length ? new Date(Math.min(...games.map(g => g.createdAt))).toISOString() : null,
      lastGame:  games.length ? new Date(Math.max(...games.map(g => g.createdAt))).toISOString() : null,
      hasAccuracy: games.some(g => g.players.white.accuracy || g.players.black.accuracy),
    },
  };
  if (!games.length) return agg;

  // KPIs
  let w = 0, l = 0, d = 0;
  games.forEach(g => { const r = result(g); if (r === 'win') w++; else if (r === 'loss') l++; else d++; });
  const rapidPost = games.filter(g => g.speed === 'rapid').map(g => myRating(g) + (ratingDiff(g) || 0));
  const blitzPost = games.filter(g => g.speed === 'blitz').map(g => myRating(g) + (ratingDiff(g) || 0));
  const lastRapid = games.filter(g => g.speed === 'rapid').sort((a, b) => b.createdAt - a.createdAt)[0];
  const lastBlitz = games.filter(g => g.speed === 'blitz').sort((a, b) => b.createdAt - a.createdAt)[0];
  const lastRapidPost = lastRapid ? (lastRapid.players[myColor(lastRapid)].rating + (lastRapid.players[myColor(lastRapid)].ratingDiff || 0)) : null;
  const lastBlitzPost = lastBlitz ? (lastBlitz.players[myColor(lastBlitz)].rating + (lastBlitz.players[myColor(lastBlitz)].ratingDiff || 0)) : null;
  agg.kpi = {
    total: games.length,
    wins: w, losses: l, draws: d,
    winPct: +(w / games.length * 100).toFixed(2),
    winPctDecisive: +(w / (w + l) * 100).toFixed(2),
    rapidRatingCurrent: lastRapidPost,
    blitzRatingCurrent: lastBlitzPost,
    rapidPeak: rapidPost.length ? Math.max(...rapidPost) : null,
    rapidLow:  rapidPost.length ? Math.min(...rapidPost) : null,
    blitzPeak: blitzPost.length ? Math.max(...blitzPost) : null,
    blitzLow:  blitzPost.length ? Math.min(...blitzPost) : null,
  };

  // By colour
  const byColor = { white: { w: 0, l: 0, d: 0 }, black: { w: 0, l: 0, d: 0 } };
  games.forEach(g => { const c = myColor(g); const r = result(g); byColor[c][r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++; });
  agg.byColor = byColor;

  // By speed
  const bySpeed = {};
  games.forEach(g => {
    if (!bySpeed[g.speed]) bySpeed[g.speed] = { w: 0, l: 0, d: 0, n: 0 };
    bySpeed[g.speed].n++;
    const r = result(g);
    bySpeed[g.speed][r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++;
  });
  agg.bySpeed = bySpeed;

  // By speed × colour
  const bySpeedColor = {};
  games.forEach(g => {
    const s = g.speed, c = myColor(g);
    if (!bySpeedColor[s]) bySpeedColor[s] = { white: { w: 0, l: 0, d: 0, n: 0 }, black: { w: 0, l: 0, d: 0, n: 0 } };
    bySpeedColor[s][c].n++;
    const r = result(g);
    bySpeedColor[s][c][r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++;
  });
  agg.bySpeedColor = bySpeedColor;

  // Rating over time — include every game in the slice, AND specifically emit rapid/blitz series
  const rapidGames = games.filter(g => g.speed === 'rapid').sort((a, b) => a.createdAt - b.createdAt);
  const blitzGames = games.filter(g => g.speed === 'blitz').sort((a, b) => a.createdAt - b.createdAt);
  // For the "filtered" view, also emit a primary series that prefers the dominant speed so the line chart shows something.
  const primaryGames = rapidGames.length >= blitzGames.length ? rapidGames : blitzGames;
  agg.ratingOverTime = {
    rapid: rapidGames.map(g => [g.createdAt, myRating(g)]),
    blitz: blitzGames.map(g => [g.createdAt, myRating(g)]),
  };
  agg.ratingAfter = {
    rapid: rapidGames.map(g => [g.createdAt, myRating(g) + (ratingDiff(g) || 0)]),
    blitz: blitzGames.map(g => [g.createdAt, myRating(g) + (ratingDiff(g) || 0)]),
  };

  // Endings
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
    const piece = pieceFromMove(moves[moves.length - 1]);
    if (!piece) return;
    const r = result(g);
    if (r === 'win') matingGiven[piece] = (matingGiven[piece] || 0) + 1;
    else if (r === 'loss') matingReceived[piece] = (matingReceived[piece] || 0) + 1;
  });
  agg.matingPiece = { given: matingGiven, received: matingReceived };

  // Openings
  const openingStats = {};
  games.forEach(g => {
    if (!g.opening) return;
    const key = g.opening.name;
    if (!openingStats[key]) openingStats[key] = { name: key, eco: g.opening.eco, family: ecoFamily(g.opening.eco), n: 0, w: 0, l: 0, d: 0, asWhite: 0, asBlack: 0 };
    const r = result(g);
    openingStats[key].n++;
    openingStats[key][r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++;
    if (myColor(g) === 'white') openingStats[key].asWhite++; else openingStats[key].asBlack++;
  });
  agg.openings = Object.values(openingStats).sort((a, b) => b.n - a.n);

  // Families
  const families = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const familiesResult = { A: { w: 0, l: 0, d: 0 }, B: { w: 0, l: 0, d: 0 }, C: { w: 0, l: 0, d: 0 }, D: { w: 0, l: 0, d: 0 }, E: { w: 0, l: 0, d: 0 } };
  games.forEach(g => {
    const f = ecoFamily(g.opening && g.opening.eco);
    if (!(f in families)) return;
    families[f]++;
    const r = result(g);
    familiesResult[f][r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++;
  });
  agg.families = Object.keys(families).map(k => ({ eco: k, name: FAMILY_NAMES[k], n: families[k], ...familiesResult[k] }));

  // Move stats / histogram
  const moveCounts = { win: [], loss: [], draw: [] };
  games.forEach(g => moveCounts[result(g)].push(Math.ceil(moveList(g).length / 2)));
  const stats = arr => {
    if (!arr.length) return { n: 0, avg: 0, median: 0, min: 0, max: 0, p25: 0, p75: 0 };
    const s = [...arr].sort((a, b) => a - b);
    return { n: s.length, avg: +(s.reduce((a,b)=>a+b,0)/s.length).toFixed(1), median: s[Math.floor(s.length/2)], min: s[0], max: s[s.length-1], p25: s[Math.floor(s.length*0.25)], p75: s[Math.floor(s.length*0.75)] };
  };
  agg.moveStats = { win: stats(moveCounts.win), loss: stats(moveCounts.loss), draw: stats(moveCounts.draw) };
  const bucketSize = 5, maxBucket = 100;
  const histogram = { win: {}, loss: {}, draw: {} };
  ['win','loss','draw'].forEach(r => {
    for (let b = 0; b <= maxBucket; b += bucketSize) histogram[r][b] = 0;
    moveCounts[r].forEach(m => { const b = Math.min(Math.floor(m/bucketSize)*bucketSize, maxBucket); histogram[r][b]++; });
  });
  agg.moveHistogram = histogram;

  // Activity by month
  const byMonth = {};
  games.forEach(g => {
    const dt = new Date(g.createdAt);
    const key = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
    if (!byMonth[key]) byMonth[key] = { month: key, n: 0, w: 0, l: 0, d: 0 };
    byMonth[key].n++;
    const r = result(g);
    byMonth[key][r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++;
  });
  agg.byMonth = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));

  // Favour (by ELO gap)
  const favourBuckets = [
    { label: 'Opp much stronger (>100)', lo: -Infinity, hi: -100, n: 0, w: 0, l: 0, d: 0 },
    { label: 'Opp stronger (50-100)',    lo: -100,      hi: -50,  n: 0, w: 0, l: 0, d: 0 },
    { label: 'Even (±50)',               lo: -50,       hi: 50,   n: 0, w: 0, l: 0, d: 0 },
    { label: 'I was favoured (50-100)',  lo:  50,       hi: 100,  n: 0, w: 0, l: 0, d: 0 },
    { label: 'I was much stronger (>100)', lo: 100, hi: Infinity, n: 0, w: 0, l: 0, d: 0 },
  ];
  games.forEach(g => {
    const diff = myRating(g) - oppRating(g);
    const b = favourBuckets.find(b => diff >= b.lo && diff < b.hi);
    if (!b) return;
    b.n++;
    const r = result(g);
    b[r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++;
  });
  agg.favourBuckets = favourBuckets;

  // First moves
  const firstMove = { asWhite: {}, asBlack: {} };
  games.forEach(g => {
    const moves = moveList(g); if (!moves.length) return;
    const col = myColor(g);
    const myFirst = col === 'white' ? moves[0] : moves[1];
    if (!myFirst) return;
    const key = col === 'white' ? 'asWhite' : 'asBlack';
    if (!firstMove[key][myFirst]) firstMove[key][myFirst] = { move: myFirst, n: 0, w: 0, l: 0, d: 0 };
    firstMove[key][myFirst].n++;
    const r = result(g);
    firstMove[key][myFirst][r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++;
  });
  agg.firstMoves = {
    asWhite: Object.values(firstMove.asWhite).sort((a, b) => b.n - a.n),
    asBlack: Object.values(firstMove.asBlack).sort((a, b) => b.n - a.n),
  };

  // Rolling 50 win rate
  const sortedGames = [...games].sort((a, b) => a.createdAt - b.createdAt);
  const rolling = [];
  const w50 = Math.min(50, sortedGames.length);
  for (let i = w50 - 1; i < sortedGames.length; i++) {
    let wc = 0, lc = 0;
    for (let j = i - w50 + 1; j <= i; j++) { const r = result(sortedGames[j]); if (r === 'win') wc++; else if (r === 'loss') lc++; }
    rolling.push({ idx: i + 1, ts: sortedGames[i].createdAt, winPct: +(wc / w50 * 100).toFixed(1) });
  }
  agg.rolling50 = rolling;

  // Streaks
  let curWin = 0, curLoss = 0, bestWin = 0, worstLoss = 0;
  sortedGames.forEach(g => {
    const r = result(g);
    if (r === 'win') { curWin++; curLoss = 0; bestWin = Math.max(bestWin, curWin); }
    else if (r === 'loss') { curLoss++; curWin = 0; worstLoss = Math.max(worstLoss, curLoss); }
    else { curWin = 0; curLoss = 0; }
  });
  agg.streaks = { longestWin: bestWin, longestLoss: worstLoss };

  // Sources
  const sources = {};
  games.forEach(g => sources[g.source || 'unknown'] = (sources[g.source || 'unknown'] || 0) + 1);
  agg.sources = sources;

  // --- PHASE & MATERIAL (uses per-game cache from the global pass) ---
  const phaseFromPly = ply => ply < 20 ? 'Opening (<10 moves)' : (ply < 60 ? 'Middlegame (10-30)' : 'Endgame (30+)');
  const phaseRecord = {
    'Opening (<10 moves)': { n: 0, w: 0, l: 0, d: 0 },
    'Middlegame (10-30)': { n: 0, w: 0, l: 0, d: 0 },
    'Endgame (30+)':      { n: 0, w: 0, l: 0, d: 0 },
  };
  const matBuckets = [
    { label: 'Down 9+',   lo: -Infinity, hi: -8.5, n: 0, w: 0, l: 0, d: 0 },
    { label: 'Down 5-9',  lo: -8.5,      hi: -4.5, n: 0, w: 0, l: 0, d: 0 },
    { label: 'Down 2-5',  lo: -4.5,      hi: -1.5, n: 0, w: 0, l: 0, d: 0 },
    { label: 'Even (±1)', lo: -1.5,      hi:  1.5, n: 0, w: 0, l: 0, d: 0 },
    { label: 'Up 2-5',    lo:  1.5,      hi:  4.5, n: 0, w: 0, l: 0, d: 0 },
    { label: 'Up 5-9',    lo:  4.5,      hi:  8.5, n: 0, w: 0, l: 0, d: 0 },
    { label: 'Up 9+',     lo:  8.5,      hi:  Infinity, n: 0, w: 0, l: 0, d: 0 },
  ];
  const matByResult = { win: [], loss: [], draw: [] };
  const matTrajectory = { win: { 20: [], 40: [], 60: [] }, loss: { 20: [], 40: [], 60: [] }, draw: { 20: [], 40: [], 60: [] } };
  let parsedOk = 0, parseFail = 0;
  for (const g of games) {
    const r = result(g);
    phaseRecord[phaseFromPly(moveList(g).length)].n++;
    phaseRecord[phaseFromPly(moveList(g).length)][r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++;
    if (g._matFailed) { parseFail++; continue; }
    parsedOk++;
    const diff = g._matFinal;
    matByResult[r].push(diff);
    const b = matBuckets.find(b => diff >= b.lo && diff < b.hi);
    if (b) { b.n++; b[r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++; }
    for (const ply of [20, 40, 60]) if (g._matSnapshots && g._matSnapshots[ply] != null) matTrajectory[r][ply].push(g._matSnapshots[ply]);
  }
  const mean = arr => arr.length ? +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2) : null;
  const median = arr => arr.length ? [...arr].sort((a,b)=>a-b)[Math.floor(arr.length/2)] : null;
  agg.phaseRecord = Object.entries(phaseRecord).map(([phase, v]) => ({ phase, ...v }));
  agg.materialBuckets = matBuckets;
  agg.materialByResult = {
    win:  { n: matByResult.win.length,  mean: mean(matByResult.win),  median: median(matByResult.win) },
    loss: { n: matByResult.loss.length, mean: mean(matByResult.loss), median: median(matByResult.loss) },
    draw: { n: matByResult.draw.length, mean: mean(matByResult.draw), median: median(matByResult.draw) },
  };
  agg.materialTrajectory = {
    win:  { 20: mean(matTrajectory.win[20]),  40: mean(matTrajectory.win[40]),  60: mean(matTrajectory.win[60]) },
    loss: { 20: mean(matTrajectory.loss[20]), 40: mean(matTrajectory.loss[40]), 60: mean(matTrajectory.loss[60]) },
    draw: { 20: mean(matTrajectory.draw[20]), 40: mean(matTrajectory.draw[40]), 60: mean(matTrajectory.draw[60]) },
  };
  agg.materialParseStats = { ok: parsedOk, failed: parseFail };
  // Main openings (top-level, before colon)
  const mainOp = {};
  games.forEach(g => {
    if (!g.opening) return;
    const key = mainOpening(g.opening.name);
    if (!mainOp[key]) mainOp[key] = { name: key, n: 0, w: 0, l: 0, d: 0 };
    mainOp[key].n++;
    const r = result(g);
    mainOp[key][r === 'win' ? 'w' : (r === 'loss' ? 'l' : 'd')]++;
  });
  agg.mainOpenings = Object.values(mainOp).sort((a, b) => b.n - a.n);

  return agg;
}

// --- Build all three views ---
const out = {
  all:   buildAgg(allGamesRaw,                                           'All games'),
  rapid: buildAgg(allGamesRaw.filter(g => g.speed === 'rapid'),          'Rapid only'),
  blitz: buildAgg(allGamesRaw.filter(g => g.speed === 'blitz'),          'Blitz only'),
};

fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.log('Summary written to', OUT_FILE);
console.log('Size:', fs.statSync(OUT_FILE).size, 'bytes');
console.log('All KPI:',   out.all.kpi);
console.log('Rapid KPI:', out.rapid.kpi);
console.log('Blitz KPI:', out.blitz.kpi);
