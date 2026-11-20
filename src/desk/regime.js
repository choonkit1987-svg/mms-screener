// Market regime agent — reads the three US indexes (S&P 500 via SPY, Nasdaq-100 via QQQ, Dow Jones via
// DIA) and says whether the broad market is helping or hurting long trades over the next two weeks.
//
// Why: the 2-week technical model ranks a stock against the AVERAGE stock. When the whole market falls,
// a stock can "beat the average" and still lose money (STLD, November 2026). The portfolio manager now
// takes this regime into account before giving a Buy.
//
// Each index gets a score from -1 (clearly falling) to +1 (clearly rising):
//   price vs its 50-day average  ±0.20     price vs its 200-day average     ±0.20
//   50-day average rising/falling ±0.15    MMS stage (150-day slope)        ±0.15
//   1-month return (±5% = full)   ±0.20    drawdown from 52-week high       0 to -0.10
// The regime score is the average of the three indexes.
import { sma } from './indicators.js';

export const US_INDEXES = [
  { ticker: 'SPY', name: 'S&P 500' },
  { ticker: 'QQQ', name: 'Nasdaq-100' },
  { ticker: 'DIA', name: 'Dow Jones' },
];

// score bands -> label; the portfolio manager uses the label for its caps
export const REGIME_BANDS = [
  [0.4, 'Bullish', 'All three indexes are in rising trends — the market is a tailwind for long trades.'],
  [-0.1, 'Neutral', 'The indexes are mixed — no strong push either way from the market.'],
  [-0.5, 'Caution', 'The indexes are weakening — falling markets drag most stocks down.'],
  [-Infinity, 'Bearish', 'The indexes are in falling trends — most stocks fall with the market.'],
];
export const regimeLabel = s => REGIME_BANDS.find(([min]) => s >= min);

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r4 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

// one index at bar i (closes only, so it works on any {t, c} series)
export function indexState(bars, i = bars.length - 1) {
  if (!bars || i < 200) return null;
  const c = bars.map(b => b.c);
  const s50 = sma(c, 50), s150 = sma(c, 150), s200 = sma(c, 200);
  if (s200[i] == null || s50[i - 10] == null || s150[i - 20] == null) return null;
  let hi = 0;
  for (let j = Math.max(0, i - 251); j <= i; j++) hi = Math.max(hi, c[j]);
  const close = c[i], r21 = close / c[i - 21] - 1, dd = close / hi - 1;
  const slope50 = s50[i] / s50[i - 10] - 1, slope150 = s150[i] / s150[i - 20] - 1;
  // MMS stage, same rule as the screener's stage agent: 150-day slope over 20 bars, ±1% counts as flat
  const prev = s150[i - 60] != null ? s150[i - 40] / s150[i - 60] - 1 : 0, flat = Math.abs(slope150) <= 0.01, above = close > s150[i];
  const stage = slope150 > 0.01 && above ? 2 : slope150 < -0.01 && !above ? 4 : flat && !above && prev > 0 ? 3 : flat && prev < 0 ? 1 : flat ? (close >= s150[i] ? 1 : 3) : slope150 > 0 ? 3 : 1;
  const parts = [
    close > s50[i] ? 0.2 : -0.2,
    close > s200[i] ? 0.2 : -0.2,
    slope50 > 0.002 ? 0.15 : slope50 < -0.002 ? -0.15 : 0,
    stage === 2 ? 0.15 : stage === 4 ? -0.15 : stage === 3 ? -0.05 : 0,
    clamp(r21 / 0.05, -1, 1) * 0.2,
    clamp((dd + 0.03) / 0.12, -1, 0) * 0.1, // nothing within 3% of the high, full -0.10 at 15% down
  ];
  const score = clamp(parts.reduce((a, b) => a + b, 0), -1, 1);
  return { t: bars[i].t, close, above50: close > s50[i], above200: close > s200[i], sma50: s50[i], sma200: s200[i], slope50: r4(slope50), stage, r21: r4(r21), dd: r4(dd), score: r4(score) };
}

function describe(x) {
  const bits = [`${x.above50 ? 'above' : 'below'} its 50-day`, `${x.above200 ? 'above' : 'below'} its 200-day average`, `Stage ${x.stage}`, `${x.r21 >= 0 ? '+' : ''}${(x.r21 * 100).toFixed(1)}% in a month`];
  if (x.dd < -0.03) bits.push(`${(-x.dd * 100).toFixed(1)}% below its 1-year high`);
  return `${x.name} ${bits.join(', ')}`;
}

// indexes: [{ticker, name, bars}] -> regime for the latest bar (or null when no index has enough data)
export function marketRegime(indexes) {
  const list = [];
  for (const ix of indexes) {
    const s = indexState(ix.bars);
    if (s) list.push({ ticker: ix.ticker, name: ix.name, ...s });
  }
  if (!list.length) return null;
  const score = r4(list.reduce((a, x) => a + x.score, 0) / list.length);
  const [, label, meaning] = regimeLabel(score);
  return {
    score, label, meaning, asOf: list.map(x => x.t).sort().pop(),
    indexes: list.map(x => ({ ...x, text: describe(x) })),
    text: `Market regime ${label.toLowerCase()} (${score >= 0 ? '+' : ''}${score.toFixed(2)}): ${list.map(describe).join('; ')}.`,
  };
}

// regime score for every date the indexes share (for the weekly 5-year check)
export function regimeByDate(indexes) {
  const per = indexes.filter(ix => ix.bars?.length > 220).map(ix => {
    const m = new Map();
    for (let i = 200; i < ix.bars.length; i++) { const s = indexState(ix.bars, i); if (s) m.set(s.t, s.score); }
    return m;
  });
  const out = new Map();
  if (!per.length) return out;
  for (const [t] of per[0]) {
    const v = per.map(m => m.get(t)).filter(x => x != null);
    if (v.length === per.length) out.set(t, v.reduce((a, b) => a + b, 0) / v.length);
  }
  return out;
}

// How did stocks do over the next h days in each regime? (5-year history, all names)
// samples: buildDataset output ({t, y, r, ex}); upCall(s) marks the samples the model would call "Uptrend"
export function regimeCheck(samples, regimes, upCall = () => false) {
  const B = Object.fromEntries(REGIME_BANDS.map(([, l]) => [l, { days: new Set(), n: 0, up: 0, r: 0, calls: 0, callUp: 0, callR: 0 }]));
  for (const s of samples) {
    const g = regimes.get(s.t);
    if (g == null) continue;
    const b = B[regimeLabel(g)[1]];
    b.days.add(s.t); b.n++; b.up += s.y; b.r += s.r;
    if (upCall(s)) { b.calls++; b.callUp += s.y; b.callR += s.r; }
  }
  return REGIME_BANDS.map(([, l]) => {
    const b = B[l];
    return { regime: l, days: b.days.size, samples: b.n, priceUp: b.n ? r4(b.up / b.n) : null, avgRet: b.n ? r4(b.r / b.n) : null,
      upCalls: b.calls, upCallPriceUp: b.calls ? r4(b.callUp / b.calls) : null, upCallAvgRet: b.calls ? r4(b.callR / b.calls) : null };
  });
}
