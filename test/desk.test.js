// Agent Desk tests: indicators, SEC decoding (incl. derived Q4), forecast plumbing, full pipeline.
//   node test/desk.test.js
import assert from 'node:assert/strict';
import { sma, ema, rsi, atr, macd } from '../src/desk/indicators.js';
import { quarterSeries, decodeFacts, filingDates, scoreMetrics } from '../src/desk/fundamentals.js';
import { buildDataset, trainAndTest, FEATURES } from '../src/desk/forecast.js';
import { DESK, analyzeDesk, rankDesk } from '../src/desk/agents.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok', name); };

test('sma / ema / rsi basics', () => {
  assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[2], 2); assert.ok(Math.abs(e[4] - 4) < 1e-9);
  const up = Array.from({ length: 30 }, (_, i) => 10 + i);
  assert.equal(rsi(up, 14).at(-1), 100);
});

test('atr and macd lengths line up with bars', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({ t: String(i), o: 10, h: 11, l: 9, c: 10 + (i % 2), v: 100 }));
  const a = atr(bars, 14); assert.equal(a.length, 60); assert.equal(a[13], null); assert.ok(a[14] > 0);
  const m = macd(bars.map(b => b.c)); assert.equal(m.hist.length, 60); assert.ok(m.hist.at(-1) != null);
});

// ---- SEC: Q1-Q3 as 3-month facts, Q4 only inside the annual 10-K ----
const q = (start, end, val, form = '10-Q', filed = end) => ({ start, end, val, form, filed });
const facts = {
  entityName: 'Test Co',
  facts: {
    'us-gaap': {
      Revenues: { units: { USD: [
        q('2024-01-01', '2024-03-31', 100), q('2024-04-01', '2024-06-30', 110), q('2024-07-01', '2024-09-30', 120), q('2024-01-01', '2024-12-31', 460, '10-K', '2025-02-15'),
        q('2025-01-01', '2025-03-31', 125), q('2025-04-01', '2025-06-30', 135), q('2025-01-01', '2025-06-30', 260), q('2025-07-01', '2025-09-30', 145),
      ] } },
      NetIncomeLoss: { units: { USD: [
        q('2024-01-01', '2024-03-31', 10), q('2024-04-01', '2024-06-30', 11), q('2024-07-01', '2024-09-30', 12), q('2024-01-01', '2024-12-31', 50, '10-K', '2025-02-15'),
        q('2025-01-01', '2025-03-31', 14), q('2025-04-01', '2025-06-30', 15), q('2025-07-01', '2025-09-30', 16),
      ] } },
      NetCashProvidedByUsedInOperatingActivities: { units: { USD: [
        q('2024-01-01', '2024-03-31', 20), q('2024-01-01', '2024-06-30', 40), q('2024-01-01', '2024-09-30', 60), q('2024-01-01', '2024-12-31', 90, '10-K'),
        q('2025-01-01', '2025-03-31', 25), q('2025-01-01', '2025-06-30', 50), q('2025-01-01', '2025-09-30', 75),
      ] } },
      StockholdersEquity: { units: { USD: [{ end: '2025-09-30', val: 400, form: '10-Q', filed: '2025-10-30' }] } },
      LongTermDebtNoncurrent: { units: { USD: [{ end: '2025-09-30', val: 200, form: '10-Q', filed: '2025-10-30' }] } },
      AssetsCurrent: { units: { USD: [{ end: '2025-09-30', val: 300, form: '10-Q', filed: '2025-10-30' }] } },
      LiabilitiesCurrent: { units: { USD: [{ end: '2025-09-30', val: 150, form: '10-Q', filed: '2025-10-30' }] } },
    },
  },
};

test('quarterSeries derives Q4 from the annual report and quarters from year-to-date', () => {
  const rev = quarterSeries(facts.facts['us-gaap'].Revenues.units.USD);
  assert.deepEqual(rev.map(x => x.val), [100, 110, 120, 130, 125, 135, 145]); // Q4 2024 = 460 - 330
  const ocf = quarterSeries(facts.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD);
  assert.deepEqual(ocf.map(x => x.val), [20, 20, 20, 30, 25, 25, 25]);
});

test('decodeFacts: 12-month figures, growth, margins, grade', () => {
  const d = decodeFacts(facts);
  assert.equal(d.ok, true);
  assert.equal(d.metrics.revenueTTM, 130 + 125 + 135 + 145);       // 535
  assert.ok(Math.abs(d.metrics.revenueGrowth - (145 - 120) / 120) < 1e-9); // no full year-ago TTM, so latest quarter vs a year earlier
  assert.equal(d.metrics.netIncomeTTM, 17 + 14 + 15 + 16);          // Q4'24 derived: 50 - (10+11+12)
  assert.ok(Math.abs(d.metrics.debtToEquity - 0.5) < 1e-9);
  assert.equal(d.metrics.currentRatio, 2);
  assert.match(d.grade, /^[A-F]$/);
  assert.ok(d.checks.find(c => c.name === 'Sales growth').text.startsWith('Sales are growing'));
});

test('scoreMetrics: loss-making companies are not praised for "EPS growth"', () => {
  const g = scoreMetrics({ revenueTTM: 100, revenueGrowth: 0.05, netIncomeTTM: -20, netMargin: -0.2, epsTTM: -2, epsGrowth: 0.5 });
  const e = g.checks.find(c => c.name === 'Earnings growth');
  assert.ok(e.score < 0.5 && /Still losing money/.test(e.text));
  const bank = scoreMetrics({ revenueTTM: 100, revenueGrowth: 0.1, netIncomeTTM: 30, netMargin: 0.3, fcfTTM: -50, debtToEquity: 3, equity: 10 }, { sector: 'Financials' });
  assert.ok(!bank.checks.some(c => c.name === 'Cash generation' || c.name === 'Debt load'));
});

test('filingDates estimates the next report ~3 months after the last 10-Q/10-K', () => {
  const f = filingDates({ filings: { recent: { form: ['8-K', '10-Q'], filingDate: ['2026-08-10', '2026-08-01'], reportDate: ['', '2026-06-30'] } } });
  assert.equal(f.lastForm, '10-Q'); assert.equal(f.nextReportEst, '2026-10-31');
});

// ---- synthetic market: half the stocks trend up, half down ----
function series(seed, drift, n = 420) {
  let c = 100, s = seed; const out = [];
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  for (let i = 0; i < n; i++) {
    const o = c; c = Math.max(1, c * (1 + drift + rnd() * 0.03));
    const d = new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10);
    out.push({ t: d, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, v: 1e6 + (s % 1000) * 1e3 });
  }
  return out;
}
const hist = {};
for (let k = 0; k < 24; k++) hist['S' + k] = series(1000 + k * 7, k % 2 ? 0.002 : -0.002);
const bench = series(42, 0.0005);

test('buildDataset + trainAndTest produce a model and honest test stats', () => {
  const { samples, today } = buildDataset(hist, bench, 10);
  assert.ok(samples.length > 3000); assert.equal(Object.keys(today).length, 24);
  assert.equal(samples[0].x.length, FEATURES.length);
  const r = trainAndTest(samples, 10, { testDays: 40, epochs: 80 });
  assert.equal(r.model.w.length, FEATURES.length);
  assert.ok(samples.every(s => s.yr === 0 || s.yr === 1) && samples.some(s => s.yr === 1));
  const r2 = trainAndTest(samples, 10, { testDays: 30, folds: 2, label: 'yr', epochs: 60 });
  assert.equal(r2.folds.length, 2); assert.ok(r2.folds[0].to < r2.folds[1].from);
  assert.ok(r.test.accuracyAll > 0.5, 'learns the planted trend'); // trends persist in this toy market
  assert.ok(r.test.from > r.from);
});

test('analyzeDesk runs every agent and rankDesk sorts calls', () => {
  const { samples } = buildDataset(hist, bench, 10);
  const rel = trainAndTest(samples, 10, { testDays: 40, epochs: 80, label: 'yr' }), abs = trainAndTest(samples, 10, { testDays: 40, epochs: 80 });
  const models = { rel: { model: rel.model, margin: rel.margin }, abs: { model: abs.model, margin: abs.margin } };
  const cfg = { ...DESK.us, minDollarVol: 1e6 };
  const rows = Object.keys(hist).map(t => analyzeDesk({ ticker: t, name: t }, hist[t], { cfg, models, bench: undefined, benchBars: bench, fund: null, mms: null, lastDate: hist[t].at(-1).t }));
  for (const row of rows) {
    assert.ok(!row.skip, row.skip);
    assert.ok(['Buy', 'Overweight', 'Hold', 'Underweight', 'Sell'].includes(row.pm.rating));
    assert.ok(['Low', 'Medium', 'High'].includes(row.risk.level));
    if (row.risk.plan) {
      const p = row.risk.plan;
      assert.ok(p.side === 'long' ? p.stop < p.entry && p.target > p.entry : p.stop > p.entry && p.target < p.entry);
      assert.ok(p.views.aggressive.size >= p.views.neutral.size);
    }
  }
  const rank = rankDesk(rows, 5);
  assert.ok(rank.up.length + rank.down.length > 0);
  const pUp = rank.up.map(t => rows.find(x => x.t === t).tech.p);
  assert.deepEqual(pUp, [...pUp].sort((a, b) => b - a));
});

console.log(`desk tests passed: ${n}`);
