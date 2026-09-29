// MMS (Market Maker Strategy) screening engine — pure functions, no I/O.
// Runs unchanged in Node (GitHub Actions) and in a browser.
// Every rule below is traced to the course lesson it comes from (see RULES.md).

export const CONFIG = {
  stageSlopeBars: 20,        // how far back to measure the 150 MA slope
  stageSlopeFlat: 0.01,      // |slope| <= 1% over 20 bars counts as "flat" (L4, L6)
  stage1MinSidewaysBars: 126,// Stage 1 sideways for at least half a year (L4)
  baseLookback: 130,         // look for C1 inside the last ~6 months
  maxContractions: 6,        // buy point appears between C2 and C6 (L11)
  maxBuyContraction: 0.10,   // buying contraction must be < 10% (L11, L14)
  buffer: 0.01,              // daily-chart buffer: +1% entry / -1% stop (L14-15, L18)
  rewardRisk: 2,             // minimum 1:2 target (L14, L20)
  breakevenAt: 1.5,          // move stop to entry at 1:1.5 when target is 1:2 (L19)
  firstPositionPct: 6.25,    // first order = 6.25% of capital (L22)
  minDollarVolume: 1e6,      // 50-day avg volume x price > US$1M (L13); Bursa uses RM1M (cfg.currency = 'RM')
  triggerFreshBars: 5,       // a close above entry within this many bars = "triggered"
  extendedPct: 0.05,         // more than 5% past entry = extended (do not chase)
};

// ---------- indicators ----------
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function atrPct(bars, n = 20) {
  const k = bars.length;
  if (k < n + 1) return 0.03;
  let s = 0;
  for (let i = k - n; i < k; i++) {
    const pc = bars[i - 1].c;
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc));
    s += tr / bars[i].c;
  }
  return s / n;
}

// ZigZag swing pivots on highs/lows. Returns alternating confirmed pivots
// plus the still-running extreme as `last` (not confirmed).
export function zigzag(bars, th) {
  const piv = [];
  const n = bars.length;
  if (n < 3) return { piv, last: null };
  let dir = 0, hiI = 0, loI = 0, ext = 0;
  for (let i = 1; i < n; i++) {
    const b = bars[i];
    if (dir === 0) {
      if (b.h > bars[hiI].h) hiI = i;
      if (b.l < bars[loI].l) loI = i;
      if (loI < hiI && (bars[hiI].h - bars[loI].l) / bars[loI].l >= th) {
        piv.push({ i: loI, type: 'L', p: bars[loI].l }); dir = 1; ext = hiI;
      } else if (hiI < loI && (bars[hiI].h - bars[loI].l) / bars[hiI].h >= th) {
        piv.push({ i: hiI, type: 'H', p: bars[hiI].h }); dir = -1; ext = loI;
      }
      continue;
    }
    if (dir === 1) {
      if (b.h >= bars[ext].h) ext = i;
      else if ((bars[ext].h - b.l) / bars[ext].h >= th) {
        piv.push({ i: ext, type: 'H', p: bars[ext].h }); dir = -1; ext = i;
      }
    } else {
      if (b.l <= bars[ext].l) ext = i;
      else if ((b.h - bars[ext].l) / bars[ext].l >= th) {
        piv.push({ i: ext, type: 'L', p: bars[ext].l }); dir = 1; ext = i;
      }
    }
  }
  const last = dir === 0 ? null : { i: ext, type: dir === 1 ? 'H' : 'L', p: dir === 1 ? bars[ext].h : bars[ext].l };
  return { piv, last };
}

// Flip a series so a downtrend reads as an uptrend (p -> 1/p, highs<->lows).
// Lets the same contraction logic find rally-contractions for short setups.
export function invertBars(bars) {
  return bars.map(b => ({ t: b.t, o: 1 / b.o, h: 1 / b.l, l: 1 / b.h, c: 1 / b.c, v: b.v }));
}

export function computeIndicators(bars) {
  const c = bars.map(b => b.c), v = bars.map(b => b.v);
  return { sma50: sma(c, 50), sma150: sma(c, 150), sma200: sma(c, 200), vol50: sma(v, 50) };
}

// ---------- Agent 1: Stage agent (L3-L7) ----------
export function stageAgent(bars, ind, cfg = CONFIG) {
  const n = bars.length, i = n - 1, k = cfg.stageSlopeBars;
  const m = ind.sma150;
  if (m[i] == null || m[i - k] == null) return { stage: null, note: 'not enough history for 150 MA' };
  const close = bars[i].c;
  const slope = (m[i] - m[i - k]) / m[i - k];
  const prevSlope = m[i - 3 * k] != null ? (m[i - 2 * k] - m[i - 3 * k]) / m[i - 3 * k] : 0;
  const dist = close / m[i] - 1; // "strength": how far price is from the 150 MA (L5)
  const flat = Math.abs(slope) <= cfg.stageSlopeFlat;
  let stage;
  if (slope > cfg.stageSlopeFlat && close > m[i]) stage = 2;
  else if (slope < -cfg.stageSlopeFlat && close < m[i]) stage = 4;
  else if (flat && close < m[i] && prevSlope > 0) stage = 3;
  else if (flat && prevSlope < 0) stage = 1;
  else if (flat) stage = close >= m[i] ? 1 : 3;
  else stage = slope > 0 ? 3 : 1; // MA and price disagree: transition
  // Stage 1 detail: sideways >= half a year (L4)
  let sidewaysBars = 0;
  if (stage === 1) {
    for (let j = i; j >= Math.max(k, i - 400); j--) {
      if (m[j - k] == null) break;
      const s = (m[j] - m[j - k]) / m[j - k];
      if (Math.abs(s) > cfg.stageSlopeFlat) break;
      sidewaysBars++;
    }
  }
  return { stage, slope, dist, sidewaysBars, sma150: m[i] };
}

// ---------- Agent 2: Contraction agent (L9-L12, L17) ----------
// Works on "long" bars; for shorts it is fed inverted bars.
export function contractionAgent(bars, ind, crossIdx, cfg = CONFIG) {
  const n = bars.length;
  const start = Math.max(crossIdx ?? 0, n - 1 - 260, 0);
  const seg = bars.slice(start);
  const th = Math.min(0.06, Math.max(0.025, 1.5 * atrPct(bars)));
  const { piv, last } = zigzag(seg, th);
  const P = piv.map(p => ({ ...p, i: p.i + start }));
  const lastExt = last ? { ...last, i: last.i + start } : null;

  // C1 = highest swing high inside the base window (L10: measure from the highest high after the 150/200 cross)
  const baseFrom = Math.max(start, n - 1 - cfg.baseLookback);
  const highs = P.filter(p => p.type === 'H' && p.i >= baseFrom);
  if (!highs.length) return { valid: false, reason: 'no swing high in base window', contractions: [] };
  const c1 = highs.reduce((a, b) => (b.p > a.p ? b : a));

  // Build H->L contractions from C1 onward
  const after = P.filter(p => p.i >= c1.i);
  const cs = [];
  for (let j = 0; j < after.length; j++) {
    if (after[j].type !== 'H') continue;
    const h = after[j];
    const l = after.slice(j + 1).find(p => p.type === 'L');
    if (l) cs.push({ hiI: h.i, hi: h.p, loI: l.i, lo: l.p });
    else {
      // open contraction: from last confirmed high to lowest low since
      let lo = Infinity, loI = h.i;
      for (let q = h.i + 1; q < n; q++) if (bars[q].l < lo) { lo = bars[q].l; loI = q; }
      if (lo < Infinity && lo < h.p) cs.push({ hiI: h.i, hi: h.p, loI, lo, open: true });
    }
  }
  // a still-running decline off an unconfirmed high counts as the newest contraction
  if (lastExt && lastExt.type === 'L' && cs.length && lastExt.i > cs[cs.length - 1].loI) {
    const prevH = P.filter(p => p.type === 'H').pop();
    if (prevH && prevH.i > cs[cs.length - 1].loI) cs.push({ hiI: prevH.i, hi: prevH.p, loI: lastExt.i, lo: lastExt.p, open: true });
  }
  cs.forEach(c => { c.depth = (c.hi - c.lo) / c.hi; c.hiT = bars[c.hiI].t; c.loT = bars[c.loI].t; });
  if (!cs.length) return { valid: false, reason: 'no completed contraction yet', contractions: [] };

  const used = cs.slice(0, cfg.maxContractions);
  const C1 = used[0], CL = used[used.length - 1];
  const depths = used.map(c => c.depth);
  let increases = 0;
  for (let j = 1; j < depths.length; j++) if (depths[j] > depths[j - 1] * 1.05) increases++;
  let risingLows = 0;
  for (let j = 1; j < used.length; j++) if (used[j].lo >= used[j - 1].lo * 0.995) risingLows++;

  // C1 established when price pulled back to the 50 MA (L17)
  const m50 = ind.sma50[C1.loI];
  const c1Established = m50 != null && C1.lo <= m50 * 1.03;
  // Base established: >= 2 contractions (L12)
  const baseOk = used.length >= 2;
  // Breakout zone inside C1's range (L17)
  const pos = (CL.hi - C1.lo) / (C1.hi - C1.lo);
  const zone = pos >= 2 / 3 ? 'Pivot' : pos >= 1 / 3 ? 'Cheat' : 'Low Cheat';

  const entry = CL.hi * (1 + cfg.buffer);
  const stop = CL.lo * (1 - cfg.buffer);
  const close = bars[n - 1].c;
  let status;
  const crossedAt = (() => { for (let q = n - 1; q > CL.hiI; q--) if (bars[q].c >= entry && bars[q - 1].c < entry) return q; return -1; })();
  if (close < stop) status = 'BROKEN';
  else if (close >= entry) status = (crossedAt >= n - cfg.triggerFreshBars && close <= entry * (1 + cfg.extendedPct)) ? 'TRIGGERED' : 'EXTENDED';
  else status = (entry / close - 1) <= 0.08 ? 'SETUP' : 'FORMING';

  const tooMany = cs.length > cfg.maxContractions;
  // L11: "bands get smaller and smaller, bottoms get higher and higher"
  const tightening = tighteningCheck(used);
  const valid = baseOk && CL.depth < cfg.maxBuyContraction && tightening.ok && status !== 'BROKEN' && !tooMany;
  let reason = '';
  if (!baseOk) reason = 'only 1 contraction (needs C2-C6)';
  else if (CL.depth >= cfg.maxBuyContraction) reason = `latest contraction ${(CL.depth * 100).toFixed(1)}% is not < 10%`;
  else if (!tightening.ok) reason = tightening.reason;
  else if (status === 'BROKEN') reason = 'price closed below the contraction stop';
  else if (tooMany) reason = 'more than 6 contractions — base too long';

  return {
    valid, reason, contractions: used, count: used.length, increases, risingLows,
    c1Established, baseOk, zone, zonePos: pos, entry, stop, status,
    distToEntry: entry / close - 1, zigzagThreshold: th,
  };
}

// Contractions must shrink and their lows must rise (L11). Small tolerances absorb noise.
export function tighteningCheck(cs) {
  if (cs.length < 2) return { ok: false, reason: 'only 1 contraction (needs C2-C6)' };
  const d = cs.map(c => c.depth);
  if (Math.max(...d.slice(1)) > d[0] * 0.95) return { ok: false, reason: 'C1 is not the widest contraction — not tightening' };
  let inc = 0;
  for (let j = 1; j < d.length; j++) if (d[j] > d[j - 1] * 1.1) inc++;
  if (inc > Math.floor((d.length - 1) / 3)) return { ok: false, reason: 'contractions widen again — not tightening' };
  if (d[d.length - 1] > d[d.length - 2] * 1.15) return { ok: false, reason: 'latest contraction is wider than the previous one' };
  let lowerLows = 0;
  for (let j = 1; j < cs.length; j++) if (cs[j].lo < cs[j - 1].lo * 0.995) lowerLows++;
  if (cs[cs.length - 1].lo < cs[0].lo * 0.995) return { ok: false, reason: 'latest low undercuts C1 low — bottoms not rising' };
  if (lowerLows > Math.floor((cs.length - 1) / 3)) return { ok: false, reason: 'bottoms are not rising' };
  return { ok: true, reason: '' };
}

// ---------- Agent 3: Volume agent (L13, L2/L5/L6 volume rules) ----------
function validCandle(b) {
  const body = Math.abs(b.c - b.o);
  const wicks = (b.h - Math.max(b.c, b.o)) + (Math.min(b.c, b.o) - b.l);
  return body > wicks; // L8: body larger than both wicks together
}
export function volumeAgent(bars, ind, fromIdx, side = 'long', cfg = CONFIG) {
  const n = bars.length;
  let up = 0, down = 0;
  for (let i = Math.max(fromIdx, 50); i < n; i++) {
    const vm = ind.vol50[i];
    if (vm == null || bars[i].v <= vm || !validCandle(bars[i])) continue; // below the orange line is ignored
    if (bars[i].c > bars[i].o) up++; else if (bars[i].c < bars[i].o) down++;
  }
  const favour = side === 'long' ? up : down;
  const against = side === 'long' ? down : up;
  const ratio = favour + against ? favour / (favour + against) : 0.5;
  // stocks report volume in shares; crypto feeds report it already in USD
  const dollarVol = (ind.vol50[n - 1] || 0) * (cfg.volumeInQuote ? 1 : bars[n - 1].c);
  return { upBig: up, downBig: down, ratio, dollarVol, liquid: dollarVol >= cfg.minDollarVolume, ...(cfg.currency ? { ccy: cfg.currency } : {}) };
}

// ---------- Agent 4: Risk agent (L14-L22) ----------
export function riskAgent(side, setup, cfg = CONFIG) {
  if (!setup || setup.entry == null) return null;
  // setup prices are in "long space"; for shorts they come from inverted bars
  let entry, stop;
  if (side === 'long') { entry = setup.entry; stop = setup.stop; }
  else { entry = 1 / setup.entry; stop = 1 / setup.stop; }
  const R = Math.abs(entry - stop);
  const dir = side === 'long' ? 1 : -1;
  return {
    entry, stop,
    target: entry + dir * cfg.rewardRisk * R,
    breakeven: entry + dir * cfg.breakevenAt * R,
    riskPct: R / entry,
    positionPct: cfg.firstPositionPct,
    trailing: 'After target 1 or momentum fade, trail the stop at the 50-day MA -/+ 1% (passive profit, L21)',
  };
}

// ---------- helpers ----------
export function lastCross(a, b, dirUp) {
  for (let i = a.length - 1; i > 0; i--) {
    if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) return i; // no cross in data
    const now = a[i] > b[i], prev = a[i - 1] > b[i - 1];
    if (dirUp ? (now && !prev) : (!now && prev)) return i;
  }
  return 0;
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function triggerScore(st, dist) {
  if (st === 'TRIGGERED') return 18;
  if (st === 'SETUP') return dist <= 0.03 ? 20 : 20 - (dist - 0.03) / 0.05 * 12;
  if (st === 'EXTENDED') return 5;
  if (st === 'FORMING') return 3;
  return 0;
}

// ---------- Orchestrator for one ticker ----------
// Data-quality agent: rejects price series that are clearly broken
// (long runs of days with no price movement at all, or single-day jumps no real market makes).
export function dataQuality(bars) {
  let flat = 0, maxJump = 1;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].c === bars[i - 1].c && bars[i].h === bars[i].l) flat++; // no trading at all that day (tiny prices can repeat a close legitimately)
    const r = bars[i].c / bars[i - 1].c;
    maxJump = Math.max(maxJump, r, 1 / r);
  }
  if (flat / bars.length > 0.1) return `no price movement on ${flat} days — data too coarse or broken`;
  if (maxJump > 4) return `a ${(maxJump * 100 - 100).toFixed(0)}% one-day move — broken or re-based data`;
  return '';
}

export function analyzeTicker(meta, bars, cfg = CONFIG) {
  if (!bars || bars.length < 220) return { ticker: meta.ticker, skip: 'less than 220 daily bars' };
  const dq = dataQuality(bars.slice(-260));
  if (dq) return { ticker: meta.ticker, skip: dq };
  const ind = computeIndicators(bars);
  const n = bars.length;
  const stage = stageAgent(bars, ind, cfg);
  const close = bars[n - 1].c;
  const ret126 = n > 127 ? close / bars[n - 127].c - 1 : 0;
  const base = { ticker: meta.ticker, name: meta.name, sector: meta.sector, close, asOf: bars[n - 1].t,
    stage: stage.stage, slope150: stage.slope, dist150: stage.dist, ret126,
    sma50: ind.sma50[n - 1], sma150: ind.sma150[n - 1], sma200: ind.sma200[n - 1] };

  const out = { ...base, long: null, short: null };

  const sideAnalysis = (side) => {
    if (side === 'long') {
      const cross = ind.sma150[n - 1] > ind.sma200[n - 1] ? lastCross(ind.sma150, ind.sma200, true) : n - 60;
      const setup = contractionAgent(bars, ind, cross, cfg);
      const vol = volumeAgent(bars, ind, setup.contractions?.[0]?.hiI ?? n - 130, 'long', cfg);
      return { setup, vol, risk: setup.entry ? riskAgent('long', setup, cfg) : null, ma150above200: ind.sma150[n - 1] > ind.sma200[n - 1] };
    }
    const inv = invertBars(bars);
    const indInv = computeIndicators(inv);
    const cross = ind.sma150[n - 1] < ind.sma200[n - 1] ? lastCross(ind.sma150, ind.sma200, false) : n - 60;
    const setup = contractionAgent(inv, indInv, cross, cfg);
    // express contractions back in real prices (rallies inside the downtrend)
    setup.contractions = (setup.contractions || []).map(c => ({ ...c, lo: 1 / c.hi, hi: 1 / c.lo, loT: c.hiT, hiT: c.loT, loI: c.hiI, hiI: c.loI }));
    const vol = volumeAgent(bars, ind, setup.contractions?.[0]?.loI ?? n - 130, 'short', cfg);
    return { setup, vol, risk: setup.entry ? riskAgent('short', setup, cfg) : null, ma150below200: ind.sma150[n - 1] < ind.sma200[n - 1] };
  };

  if (stage.stage === 2) out.long = sideAnalysis('long');
  if (stage.stage === 4) out.short = sideAnalysis('short');
  // Lean agent: every stock gets a direction and trade levels, so any ticker can be looked up.
  // Stage 2 -> up, Stage 4 -> down, Stage 3 (topping) -> down, Stage 1 (basing) -> side of the 150 MA.
  if (stage.stage) {
    out.lean = stage.stage === 2 ? 'long' : stage.stage === 4 || stage.stage === 3 ? 'short' : (close >= ind.sma150[n - 1] ? 'long' : 'short');
    out.leanS = out.lean === 'long' ? (out.long || sideAnalysis('long')) : (out.short || sideAnalysis('short'));
  }
  out.chart = chartData(bars, ind, 180);
  return out;
}

export function chartData(bars, ind, k) {
  const s = Math.max(0, bars.length - k);
  const r = x => (x == null ? null : +x.toPrecision(6)); // keeps sub-cent coin prices intact
  return {
    t: bars.slice(s).map(b => b.t),
    o: bars.slice(s).map(b => r(b.o)), h: bars.slice(s).map(b => r(b.h)),
    l: bars.slice(s).map(b => r(b.l)), c: bars.slice(s).map(b => r(b.c)), v: bars.slice(s).map(b => b.v),
    sma50: ind.sma50.slice(s).map(r), sma150: ind.sma150.slice(s).map(r), sma200: ind.sma200.slice(s).map(r),
    offset: s,
  };
}

// ---------- Agent 5: Ranking / portfolio agent ----------
export function scoreSide(a, side, rsPct) {
  const S = side === 'long' ? a.long : a.short;
  if (!S) return null;
  const st = S.setup;
  const strength = side === 'long' ? a.dist150 : -a.dist150;
  const slope = side === 'long' ? a.slope150 : -a.slope150;
  const stageScore = 15 * clamp(strength / 0.30, 0, 1) + 10 * clamp(slope / 0.08, 0, 1);
  let vcp = 0;
  if (st.contractions?.length) {
    const d1 = st.contractions[0].depth, dl = st.contractions[st.contractions.length - 1].depth;
    vcp = (st.baseOk ? 8 : 0) + 8 * clamp(1 - dl / d1, 0, 1) + 8 * clamp((0.10 - dl) / 0.08, 0, 1)
      + (st.c1Established ? 3 : 0) + 3 * clamp(1 - st.increases / 2, 0, 1);
  }
  const trig = triggerScore(st.status, st.distToEntry ?? 1);
  const volScore = 15 * S.vol.ratio;
  const rs = 10 * rsPct;
  const total = stageScore + vcp + trig + volScore + rs;
  return { total: +total.toFixed(1), stage: +stageScore.toFixed(1), vcp: +vcp.toFixed(1), trigger: +trig.toFixed(1), volume: +volScore.toFixed(1), rs: +rs.toFixed(1) };
}

export function rankAll(analyses, topN = 5) {
  const ok = analyses.filter(a => !a.skip);
  const byRet = [...ok].sort((x, y) => x.ret126 - y.ret126);
  const pct = new Map(byRet.map((a, i) => [a.ticker, byRet.length > 1 ? i / (byRet.length - 1) : 0.5]));
  const longs = [], shorts = [];
  for (const a of ok) {
    if (a.long) {
      const s = scoreSide(a, 'long', pct.get(a.ticker));
      longs.push({ a, s, gate: a.long.setup.valid && a.long.vol.liquid });
    }
    if (a.short) {
      const s = scoreSide(a, 'short', 1 - pct.get(a.ticker));
      shorts.push({ a, s, gate: a.short.setup.valid && a.short.vol.liquid });
    }
  }
  const pick = (arr) => {
    arr.sort((x, y) => y.s.total - x.s.total);
    const passed = arr.filter(x => x.gate && !['EXTENDED', 'BROKEN'].includes(x.a.long?.setup.status ?? x.a.short?.setup.status));
    const top = passed.slice(0, topN).map(x => ({ ...x, tier: 'setup' }));
    if (top.length < topN) {
      // watch-list fill: best remaining names, but never illiquid ones (L13 liquidity rule still applies)
      const rest = arr.filter(x => (x.a.long || x.a.short).vol.liquid && (x.a.long || x.a.short).setup.status !== 'BROKEN' && !top.some(t => t.a.ticker === x.a.ticker)).slice(0, topN - top.length);
      top.push(...rest.map(x => ({ ...x, tier: 'watch' })));
    }
    return { top, passedCount: passed.length, total: arr.length };
  };
  const stageCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
  ok.forEach(a => { if (a.stage) stageCounts[a.stage]++; });
  return { up: pick(longs), down: pick(shorts), stageCounts, scanned: ok.length };
}

// Human-readable reasoning for a pick (what each agent concluded)
export const fmtPrice = x => (x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(3) : x.toPrecision(4));
export function explain(a, side, S0) {
  const S = S0 || (side === 'long' ? a.long : a.short);
  const st = S.setup, pct = x => (x * 100).toFixed(1) + '%';
  const notes = [];
  notes.push(`Stage agent: Stage ${a.stage} — 150-day MA ${a.slope150 >= 0 ? 'rising' : 'falling'} ${pct(Math.abs(a.slope150))} over 20 days; price ${pct(Math.abs(a.dist150))} ${a.dist150 >= 0 ? 'above' : 'below'} it.`);
  if (st.contractions?.length) {
    notes.push(`Contraction agent: ${st.count} ${side === 'long' ? 'pullbacks' : 'rallies'} (${st.contractions.map((c, i) => 'C' + (i + 1) + ' ' + pct(c.depth)).join(' → ')}); ${st.valid ? 'valid buy-point structure' : 'not valid yet: ' + st.reason}. Breakout zone: ${st.zone}.`);
  } else notes.push(`Contraction agent: ${st.reason}.`);
  notes.push(`Volume agent: ${S.vol.upBig} big up-days vs ${S.vol.downBig} big down-days above the 50-day volume average; ${S.vol.ccy || '$'}${(S.vol.dollarVol / 1e6).toFixed(0)}M/day traded.`);
  if (S.risk) notes.push(`Risk agent: ${side === 'long' ? 'buy-stop' : 'sell-stop'} ${fmtPrice(S.risk.entry)}, stop ${fmtPrice(S.risk.stop)} (${pct(S.risk.riskPct)} risk), target ${fmtPrice(S.risk.target)} (1:2), move stop to entry at ${fmtPrice(S.risk.breakeven)}.`);
  return notes;
}

// ---------- Lookup agent: one compact record per ticker for the "Analyse a stock" box ----------
const VERDICT = {
  2: ['up', 'Uptrend', 'Stage 2: the 150-day MA is rising and price is above it.'],
  4: ['down', 'Downtrend', 'Stage 4: the 150-day MA is falling and price is below it.'],
  3: ['down', 'Topping — leaning down', 'Stage 3: the 150-day MA has flattened after an uptrend; a Stage 4 decline often follows.'],
  1: ['neutral', 'Basing — no trend yet', 'Stage 1: the 150-day MA is flat. Wait for Stage 2 (buy) or Stage 4 (short).'],
};
export function scoreAny(a, rsPct) {
  const S = a.leanS;
  if (!S) return null;
  return scoreSide({ ...a, long: a.lean === 'long' ? S : null, short: a.lean === 'short' ? S : null }, a.lean, a.lean === 'long' ? rsPct : 1 - rsPct);
}
export function lookupRecord(a, rsPct, k = 120) {
  if (a.skip) return { t: a.ticker, skip: a.skip };
  const S = a.leanS, st = S?.setup || {}, side = a.lean;
  const [dir, head, why] = VERDICT[a.stage] || ['neutral', 'Not enough data', ''];
  let action;
  if (a.stage === 2 || a.stage === 4) action = st.valid && !['EXTENDED', 'BROKEN'].includes(st.status)
    ? (side === 'long' ? 'Valid buy setup' : 'Valid short setup')
    : `No valid ${side === 'long' ? 'buy' : 'short'} point yet${st.reason ? ': ' + st.reason : st.status === 'EXTENDED' ? ': price has run more than 5% past the trigger' : ''}`;
  else action = `Levels below are for a ${side === 'long' ? 'breakout up' : 'breakdown'} only — the course trades Stage ${side === 'long' ? '2' : '4'}`;
  const r = x => (x == null ? null : +(+x).toPrecision(5));
  const r4 = x => (x == null ? null : +(+x).toPrecision(4));
  const n = a.chart.t.length, s0 = Math.max(0, n - k), t0 = a.chart.t[s0];
  const day = t => Math.round((Date.parse(t) - Date.parse(t0)) / 864e5);
  const idx = t => a.chart.t.indexOf(t) - s0;
  return {
    t: a.ticker, n: a.name, sec: a.sector, st: a.stage, dir, side, head, why, action,
    status: st.status || null, valid: !!st.valid, zone: st.zone || null,
    close: r(a.close), asOf: a.asOf, slope150: +a.slope150.toFixed(4), dist150: +a.dist150.toFixed(4), ret126: +a.ret126.toFixed(4),
    lv: S?.risk ? { e: r(S.risk.entry), s: r(S.risk.stop), tg: r(S.risk.target), be: r(S.risk.breakeven), risk: +S.risk.riskPct.toFixed(4), size: S.risk.positionPct } : null,
    score: scoreAny(a, rsPct),
    cs: (st.contractions || []).map(c => ({ hi: r(c.hi), lo: r(c.lo), a: idx(side === 'long' ? c.hiT : c.loT), b: idx(side === 'long' ? c.loT : c.hiT), d: +c.depth.toFixed(4) })),
    notes: S ? explain(a, side, S) : [],
    ch: {
      t0, d: a.chart.t.slice(s0).map(day),
      c: a.chart.c.slice(s0).map(r),
      m50: a.chart.sma50.slice(s0).map(r4), m150: a.chart.sma150.slice(s0).map(r4), m200: a.chart.sma200.slice(s0).map(r4),
    },
  };
}
export function lookupTable(analyses) {
  const ok = analyses.filter(a => !a.skip);
  const byRet = [...ok].sort((x, y) => x.ret126 - y.ret126);
  const pct = new Map(byRet.map((a, i) => [a.ticker, byRet.length > 1 ? i / (byRet.length - 1) : 0.5]));
  return analyses.map(a => lookupRecord(a, pct.get(a.ticker) ?? 0.5));
}
