#!/usr/bin/env node
// Bursa Malaysia orchestrator — same agents, applied to the 30 FBM KLCI stocks.
//   * universe = FBM KLCI constituents (Wikipedia, last good copy in data/lists/klci.json)
//   * data = Yahoo daily bars for "<stock code>.KL"; today's bar is ignored while Bursa is still trading
//   * prices in RM; liquidity = 50-day average volume x price > RM1M a day
//   * regime = the KLCI index (^KLSE)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './engine.js';
import { loadKLCI, cachedList, yahooHistory } from './data.js';
import { buildReport, writeOutputs } from './run.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const BURSA_CONFIG = { ...CONFIG, currency: 'RM' };

// Yahoo's short names are the names Bursa uses (MAYBANK, TENAGA, PBBANK…); fall back to the stock code.
export function renameBursa(universe, history, meta) {
  const uni = [], hist = {}, used = new Set();
  for (const u of universe) {
    const m = meta[u.ticker] || {};
    let t = (m.shortName || '').toUpperCase().replace(/[^A-Z0-9&-]/g, '') || u.code;
    if (used.has(t)) t = u.code;
    used.add(t);
    uni.push({ ...u, ticker: t, name: `${m.longName || u.name} (${u.code})` });
    if (history[u.ticker]) hist[t] = history[u.ticker];
  }
  if (history.KLCI) hist.KLCI = history.KLCI;
  return { universe: uni, history: hist };
}

async function main() {
  log('Universe agent: FBM KLCI constituents');
  const klci = await cachedList(path.join(root, 'data/lists/klci.json'), loadKLCI, log);
  log(`  ${klci.length} stocks`);
  log('Market-data agent: Yahoo daily bars (.KL)');
  const meta = {};
  const raw = await yahooHistory([...klci, { ticker: 'KLCI', yahoo: '^KLSE' }], { log, meta, dropOpen: true, concurrency: 3 });
  const { universe, history } = renameBursa(klci, raw, meta);
  log(`  history for ${Object.keys(history).length} tickers`);
  const { report, lookup } = buildReport(universe, history, 'yahoo', { cfg: BURSA_CONFIG, regimeTicker: 'KLCI', market: 'bursa' });
  log(`Ranking agent: ${report.upPassed} valid long setups, ${report.downPassed} valid short setups (as of ${report.asOf})`);
  writeOutputs(path.join(root, 'docs/bursa/data'), report, lookup);
  for (const [label, arr] of [['UP', report.up], ['DOWN', report.down]]) log(`Top ${label}: ` + arr.map(p => `${p.ticker}(${p.score.total}${p.tier === 'watch' ? ',watch' : ''})`).join(' '));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(e); process.exit(1); });
}
