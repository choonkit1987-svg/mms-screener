// Agent Desk — orchestration and file I/O.
//   runDesk()   : called at the end of the daily stock scan (src/run.js) and crypto scan
//                 (src/run-crypto.js) with the price history they already downloaded.
//   trainModel(): called by the weekly training job (src/desk/train.js) on 5 years of data.
// Outputs: docs/agents/data/{us,crypto}.json  (read by docs/agents/index.html)
//          data/desk/model-{us,crypto}.json    (trained weights + honest test results)
//          data/desk/fundamentals.json.gz      (decoded SEC filings, refreshed weekly per ticker)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DESK, analyzeDesk, rankDesk } from './agents.js';
import { FEATURES, buildDataset, trainAndTest, benchContext } from './forecast.js';
import { refreshFundamentals, scoreMetrics } from './fundamentals.js';
import { dataQuality } from '../engine.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const modelFile = m => path.join(ROOT, `data/desk/model-${m}.json`);
const fundFile = path.join(ROOT, 'data/desk/fundamentals.json.gz');

const pctS = x => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
export function trainModel(market, histories, benchBars, { testDays = 120, folds = 4, epochs, log = console.log } = {}) {
  const h = DESK[market].h;
  // leave out series the MMS data-quality check flags (re-based prices, wrong token behind a symbol, ...)
  const clean = Object.fromEntries(Object.entries(histories).filter(([, b]) => b?.length && !dataQuality(b)));
  if (Object.keys(clean).length < Object.keys(histories).length) log(`  desk model (${market}): skipped ${Object.keys(histories).length - Object.keys(clean).length} symbols with broken price history`);
  histories = clean;
  const { samples } = buildDataset(histories, benchBars, h);
  log(`  desk model (${market}): ${samples.length} training samples from ${Object.keys(histories).length} symbols`);
  const out = { market, h, features: FEATURES.map(f => f[1]), trainedOn: samples.length, trainedAt: new Date().toISOString() };
  for (const [key, label] of [['rel', 'yr'], ['abs', 'y']]) {
    const r = trainAndTest(samples, h, { testDays, folds, label, epochs });
    out.from = r.from; out.to = r.to;
    out[key] = { w: r.model.w, b: r.model.b, scaler: r.model.scaler, margin: r.margin, test: r.test, folds: r.folds };
    for (const f of r.folds) log(`  ${key} ${f.from}→${f.to}: up calls ${pctS(f.upCallHit)} right (${f.upCalls}), down calls ${pctS(f.downCallHit)} (${f.downCalls}), base ${pctS(f.baseUp)}, top-10% ${pctS(f.topDecileEx)} vs bottom-10% ${pctS(f.bottomDecileEx)} vs average`);
  }
  return out;
}

export function saveModel(model) {
  fs.mkdirSync(path.dirname(modelFile(model.market)), { recursive: true });
  fs.writeFileSync(modelFile(model.market), JSON.stringify(model));
}
function loadModel(market) {
  try { return JSON.parse(fs.readFileSync(modelFile(market), 'utf8')); } catch { return null; }
}
function loadMms(dirs) {
  const map = new Map();
  for (const d of dirs) {
    try { for (const r of JSON.parse(fs.readFileSync(path.join(ROOT, d, 'all.json'), 'utf8')).rows) if (!map.has(r.t)) map.set(r.t, r); } catch { /* page not built yet */ }
  }
  return map;
}

export async function runDesk({ market, universe, history, benchTicker, log = console.log }) {
  const cfg = DESK[market];
  const benchBars = history[benchTicker];
  let model = loadModel(market), provisional = false;
  if (!model || model.h !== cfg.h || model.rel?.w?.length !== FEATURES.length) {
    log(`  desk: no weekly model for ${market} yet — training a provisional one on the history at hand`);
    const sub = Object.fromEntries(universe.map(u => [u.ticker, history[u.ticker]]).filter(([, b]) => b));
    model = trainModel(market, sub, benchBars, { testDays: 40, folds: 1, log });
    provisional = true;
  }
  const pack = k => ({ model: { w: model[k].w, b: model[k].b, scaler: model[k].scaler }, margin: model[k].margin });
  // reliability = share of unseen test periods in which the ranking worked (uptrend calls beat the
  // average name AND the top 10% beat the bottom 10%); the portfolio manager scales its conviction by it
  const folds = model.rel.folds?.length ? model.rel.folds : [model.rel.test];
  const reliability = folds.filter(f => f.upCallHit > 0.5 && (f.topDecileEx ?? 0) > (f.bottomDecileEx ?? 0)).length / folds.length;
  const models = { rel: pack('rel'), abs: model.abs ? pack('abs') : null };
  const bench = benchContext(benchBars);

  // Fundamentals (stocks only): decoded SEC filings, cached in the repo
  let funds = {};
  if (market === 'us') {
    try { funds = JSON.parse(zlib.gunzipSync(fs.readFileSync(fundFile)).toString()); } catch { funds = {}; }
    try {
      await refreshFundamentals(universe.map(u => u.ticker), funds, { ua: process.env.SEC_USER_AGENT, sectors: Object.fromEntries(universe.map(u => [u.ticker, u.sector || ''])), log });
      fs.mkdirSync(path.dirname(fundFile), { recursive: true });
      fs.writeFileSync(fundFile, zlib.gzipSync(JSON.stringify(funds)));
    } catch (e) { log(`  desk: SEC download failed (${e.message}) — using cached fundamentals`); }
  }
  const mms = loadMms(market === 'us' ? ['docs/data', 'docs/nasdaq/data', 'docs/dow/data', 'docs/watch/data'] : ['docs/crypto/data']);
  const lastDate = Object.values(history).map(b => b?.at(-1)?.t).filter(Boolean).sort().pop();

  // grade the cached figures (numbers only in the cache, so wording/score fixes apply to old entries too)
  const graded = t => { const f = funds[t]; if (!f) return undefined; if (!f.ok || !f.metrics) return f; const u = universe.find(x => x.ticker === t); return { ...f, ...scoreMetrics(f.metrics, { sector: u?.sector }) }; };
  const rows = universe.map(u => analyzeDesk(u, history[u.ticker], { cfg, models, reliability, bench, benchBars, fund: market === 'us' ? graded(u.ticker) : undefined, mms: mms.get(u.ticker), lastDate }));
  const rank = rankDesk(rows, 10);
  const asOf = rows.filter(r => !r.skip).map(r => r.asOf).sort().pop();
  let regime = null;
  if (benchBars?.length > 200) {
    const c = benchBars.map(b => b.c), n = c.length, s200 = c.slice(-200).reduce((a, b) => a + b, 0) / 200;
    regime = { ticker: benchTicker, close: c[n - 1], above200: c[n - 1] > s200, r21: c[n - 1] / c[n - 22] - 1 };
  }
  const out = {
    market, asOf, generatedAt: new Date().toISOString(), horizon: cfg.h, horizonLabel: market === 'us' ? '10 trading days' : '14 days',
    model: { provisional, reliability, source: model.source || null, trainedAt: model.trainedAt, from: model.from, to: model.to, trainedOn: model.trainedOn,
      margin: model.rel.margin, test: model.rel.test, folds: model.rel.folds, abs: { margin: model.abs?.margin, test: model.abs?.test, folds: model.abs?.folds },
      weights: FEATURES.map((f, j) => ({ label: f[1], w: Math.round(model.rel.w[j] * 1e3) / 1e3 })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)) },
    regime, rank, config: { ...cfg }, rows,
  };
  const dir = path.join(ROOT, 'docs/agents/data');
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${market}.json`), JSON.stringify(out));
  // small daily archive of the calls (for checking them later)
  const arch = { asOf, up: rank.up.map(t => ({ t, p: rows.find(r => r.t === t).tech.p, c: rows.find(r => r.t === t).close })), down: rank.down.map(t => ({ t, p: rows.find(r => r.t === t).tech.p, c: rows.find(r => r.t === t).close })) };
  fs.writeFileSync(path.join(dir, 'archive', `${market}-${asOf}.json`), JSON.stringify(arch));
  log(`Agent Desk (${market}): ${rank.passed}/${rank.total} passed the filter; ${rank.calls.up} uptrend, ${rank.calls.down} downtrend, ${rank.calls.none} no clear trend`);
  log(`  top up: ${rank.up.join(' ')} | top down: ${rank.down.join(' ')}`);
  return out;
}
