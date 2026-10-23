// Agent Desk — 2-week direction forecast (pure functions, no I/O).
//
// The Technical agent turns the indicator set into 19 features per day and fits two
// logistic-regression models on this market's own history (h = 10 trading days for
// stocks, 14 days for crypto):
//   * "rel" — will this name beat the average name over the next h bars? (stock selection)
//   * "abs" — will its price simply be higher after h bars? (mostly the market's direction)
// Five-year tests showed only the first has a stable edge, so it drives the Uptrend /
// Downtrend call; the second is shown alongside as the plain chance of a higher price.
// Every model is tested walk-forward on periods it has NOT seen (with an h-bar gap so
// overlapping 2-week windows cannot leak) before the final fit, and the dashboard shows
// those results so the calls can be judged honestly.
import { indicatorSet } from './indicators.js';

export const FEATURES = [
  ['p50', 'Price vs 50-day average'],
  ['p200', 'Price vs 200-day average'],
  ['s50', '50-day average slope'],
  ['p10', 'Price vs 10-day EMA'],
  ['macd', 'MACD histogram'],
  ['rsi', 'RSI (14)'],
  ['pb', 'Bollinger %B'],
  ['atr', 'Volatility (ATR %)'],
  ['r5', '1-week return'],
  ['r21', '1-month return'],
  ['r63', '3-month return'],
  ['vt', 'Volume trend (20 vs 50 day)'],
  ['vw', 'VWMA vs 20-day average'],
  ['hi', 'Distance below 1-year high'],
  ['st2', 'MMS Stage 2 (uptrend)'],
  ['st4', 'MMS Stage 4 (downtrend)'],
  ['rs', 'Strength vs market (1 month)'],
  ['mk', 'Market above its 200-day average'],
  ['mr', 'Market 1-month return'],
];
const NF = FEATURES.length;
export const START = 200; // first bar with a 200-day average

// Benchmark context (SPY for stocks, BTC for crypto), looked up by date.
export function benchContext(benchBars) {
  const map = new Map();
  if (!benchBars || benchBars.length < 30) return map;
  const ind = indicatorSet(benchBars);
  for (let i = 21; i < benchBars.length; i++) {
    const c = benchBars[i].c, long = ind.sma200[i] ?? ind.sma150[i] ?? ind.sma50[i];
    map.set(benchBars[i].t, { r21: c / benchBars[i - 21].c - 1, above: long == null ? 0 : (c > long ? 1 : -1) });
  }
  return map;
}

export function featureRow(bars, ind, i, bench) {
  const c = ind.c[i];
  if (i < START || ind.sma200[i] == null || ind.macd.hist[i] == null || ind.atr[i] == null || ind.vol50[i] == null) return null;
  let hi = 0;
  for (let j = Math.max(0, i - 251); j <= i; j++) hi = Math.max(hi, bars[j].h);
  const slope150 = ind.sma150[i - 20] ? ind.sma150[i] / ind.sma150[i - 20] - 1 : 0;
  const b = bench?.get(bars[i].t) || { r21: 0, above: 0 };
  const r21 = c / ind.c[i - 21] - 1;
  const width = ind.boll.ub[i] - ind.boll.lb[i];
  return [
    c / ind.sma50[i] - 1,
    c / ind.sma200[i] - 1,
    ind.sma50[i] / ind.sma50[i - 10] - 1,
    c / ind.ema10[i] - 1,
    ind.macd.hist[i] / ind.atr[i],
    (ind.rsi[i] - 50) / 50,
    width > 0 ? (c - ind.boll.lb[i]) / width - 0.5 : 0,
    ind.atr[i] / c,
    c / ind.c[i - 5] - 1,
    r21,
    c / ind.c[i - 63] - 1,
    ind.vol50[i] > 0 && ind.vol20[i] > 0 ? Math.log(ind.vol20[i] / ind.vol50[i]) : 0,
    ind.vwma[i] && ind.sma20[i] ? ind.vwma[i] / ind.sma20[i] - 1 : 0,
    hi > 0 ? c / hi - 1 : 0,
    slope150 > 0.01 && c > ind.sma150[i] ? 1 : 0,
    slope150 < -0.01 && c < ind.sma150[i] ? 1 : 0,
    r21 - b.r21,
    b.above,
    b.r21,
  ];
}

// Build training samples for every ticker: x = features on day i, y = 1 if the close
// h bars later is higher. Also returns today's feature row per ticker.
export function buildDataset(histories, benchBars, h) {
  const bench = benchContext(benchBars);
  const samples = [], today = {};
  for (const [ticker, bars] of Object.entries(histories)) {
    if (!bars || bars.length < START + 5) continue;
    const ind = indicatorSet(bars);
    for (let i = START; i < bars.length; i++) {
      const x = featureRow(bars, ind, i, bench);
      if (!x || x.some(v => !Number.isFinite(v))) continue;
      if (i === bars.length - 1) today[ticker] = { x, t: bars[i].t };
      if (i + h < bars.length) samples.push({ x, y: bars[i + h].c > bars[i].c ? 1 : 0, t: bars[i].t, r: bars[i + h].c / bars[i].c - 1 });
    }
  }
  // relative label: did it beat the median name over the same h bars?
  const byDay = new Map();
  for (const s of samples) { if (!byDay.has(s.t)) byDay.set(s.t, []); byDay.get(s.t).push(s.r); }
  const med = new Map([...byDay].map(([t, a]) => { a.sort((x, y) => x - y); return [t, a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2]; }));
  for (const s of samples) { s.ex = s.r - med.get(s.t); s.yr = s.ex > 0 ? 1 : 0; }
  return { samples, today };
}

const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

export function fitScaler(X) {
  const mu = new Array(NF).fill(0), sd = new Array(NF).fill(0);
  for (const x of X) for (let j = 0; j < NF; j++) mu[j] += x[j];
  for (let j = 0; j < NF; j++) mu[j] /= X.length || 1;
  for (const x of X) for (let j = 0; j < NF; j++) sd[j] += (x[j] - mu[j]) ** 2;
  for (let j = 0; j < NF; j++) sd[j] = Math.sqrt(sd[j] / (X.length || 1)) || 1;
  return { mu, sd };
}
const scale = (x, s) => x.map((v, j) => Math.max(-5, Math.min(5, (v - s.mu[j]) / s.sd[j])));

// L2-regularised logistic regression, full-batch Adam.
export function trainLogistic(samples, { epochs = 250, lr = 0.05, l2 = 1e-3, label = 'y' } = {}) {
  const scaler = fitScaler(samples.map(s => s.x));
  const X = samples.map(s => scale(s.x, scaler)), y = samples.map(s => s[label]);
  const w = new Array(NF).fill(0); let b = 0;
  const m = new Array(NF + 1).fill(0), v = new Array(NF + 1).fill(0);
  const n = X.length || 1;
  for (let ep = 1; ep <= epochs; ep++) {
    const g = new Array(NF + 1).fill(0);
    for (let i = 0; i < X.length; i++) {
      let z = b; for (let j = 0; j < NF; j++) z += w[j] * X[i][j];
      const e = sigmoid(z) - y[i];
      for (let j = 0; j < NF; j++) g[j] += e * X[i][j];
      g[NF] += e;
    }
    for (let j = 0; j <= NF; j++) {
      const gj = g[j] / n + (j < NF ? l2 * w[j] : 0);
      m[j] = 0.9 * m[j] + 0.1 * gj; v[j] = 0.999 * v[j] + 0.001 * gj * gj;
      const step = lr * (m[j] / (1 - 0.9 ** ep)) / (Math.sqrt(v[j] / (1 - 0.999 ** ep)) + 1e-8);
      if (j < NF) w[j] -= step; else b -= step;
    }
  }
  return { w, b, scaler };
}

export function predict(model, x) {
  const xs = scale(x, model.scaler);
  let z = model.b; for (let j = 0; j < NF; j++) z += model.w[j] * xs[j];
  return sigmoid(z);
}

// Which features pushed today's probability up or down (weight x scaled value).
export function contributions(model, x) {
  const xs = scale(x, model.scaler);
  return FEATURES.map(([k, label], j) => ({ k, label, v: model.w[j] * xs[j] })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
}

// Score one held-out window: train on everything before it (minus an h-bar gap).
export function testWindow(samples, dates, startIdx, len, h, { label = 'y', coverage = 0.35, epochs } = {}) {
  const from = dates[startIdx], to = dates[Math.min(dates.length - 1, startIdx + len - 1)];
  const trainEnd = dates[Math.max(0, startIdx - h)];
  const train = samples.filter(s => s.t < trainEnd), test = samples.filter(s => s.t >= from && s.t <= to);
  const m0 = trainLogistic(train, { epochs, label });
  const scored = test.map(s => ({ y: s[label], r: s.r, ex: s.ex, t: s.t, p: predict(m0, s.x) }));
  const margins = scored.map(s => Math.abs(s.p - 0.5)).sort((a, b) => b - a);
  const margin = margins[Math.floor(margins.length * coverage)] ?? 0.05;
  const conf = scored.filter(s => Math.abs(s.p - 0.5) >= margin);
  const up = conf.filter(s => s.p > 0.5), dn = conf.filter(s => s.p < 0.5);
  const share = (arr, f) => (arr.length ? arr.filter(f).length / arr.length : null);
  // averages cap each 2-week return at ±100% so one bad price print cannot swamp the result
  const clip = v => Math.max(-1, Math.min(1, v));
  const avg = (arr, k = 'r') => (arr.length ? arr.reduce((a, s) => a + clip(s[k]), 0) / arr.length : null);
  // top vs bottom 10% by probability on each date: does the ranking work?
  const byDay = new Map();
  for (const s of scored) { if (!byDay.has(s.t)) byDay.set(s.t, []); byDay.get(s.t).push(s); }
  let top = 0, bot = 0, topX = 0, botX = 0, k = 0;
  for (const day of byDay.values()) {
    if (day.length < 20) continue;
    day.sort((a, b) => b.p - a.p);
    const q = Math.max(1, Math.floor(day.length / 10));
    top += avg(day.slice(0, q)); bot += avg(day.slice(-q)); topX += avg(day.slice(0, q), 'ex'); botX += avg(day.slice(-q), 'ex'); k++;
  }
  const r4 = x => (x == null ? null : Math.round(x * 1e4) / 1e4);
  return {
    from, to, samples: scored.length, margin: r4(margin), coverage: r4(conf.length / (scored.length || 1)),
    baseUp: r4(share(scored, s => s.y === 1)), accuracyAll: r4(share(scored, s => (s.p > 0.5) === (s.y === 1))), accuracyConfident: r4(share(conf, s => (s.p > 0.5) === (s.y === 1))),
    upCalls: up.length, upCallHit: r4(share(up, s => s.y === 1)), downCalls: dn.length, downCallHit: r4(share(dn, s => s.y === 0)),
    avgRetUpCalls: r4(avg(up)), avgRetDownCalls: r4(avg(dn)), avgExUpCalls: r4(avg(up, 'ex')), avgExDownCalls: r4(avg(dn, 'ex')),
    topDecileRet: k ? r4(top / k) : null, bottomDecileRet: k ? r4(bot / k) : null, topDecileEx: k ? r4(topX / k) : null, bottomDecileEx: k ? r4(botX / k) : null,
  };
}

// Walk-forward: `folds` back-to-back test windows of `testDays` each (the last ending today),
// then one final fit on all the data. The confidence margin is the average of the windows'.
export function trainAndTest(samples, h, { testDays = 40, folds = 1, label = 'y', coverage = 0.35, epochs } = {}) {
  const dates = [...new Set(samples.map(s => s.t))].sort();
  while (folds > 1 && dates.length < folds * testDays + 100) folds--; // keep at least ~100 days to train the first window
  if (dates.length < testDays + h + 30) testDays = Math.max(10, Math.floor(dates.length / 4));
  const windows = [];
  for (let f = folds; f >= 1; f--) windows.push(testWindow(samples, dates, dates.length - f * testDays, testDays, h, { label, coverage, epochs }));
  const test = windows[windows.length - 1];
  const margin = windows.reduce((a, w) => a + w.margin, 0) / windows.length;
  const model = trainLogistic(samples, { epochs, label });
  return { model, test, folds: windows, margin, trainedOn: samples.length, from: dates[0], to: dates[dates.length - 1] };
}
