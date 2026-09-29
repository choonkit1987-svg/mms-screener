#!/usr/bin/env node
// Daily orchestrator: Universe agent -> Market-data agent -> per-stock agents
// (Stage, Contraction, Volume, Risk) -> Ranking agent -> dashboard data.
//
//   DATA_PROVIDER=massive MASSIVE_API_KEY=xxx node src/run.js
//   DATA_PROVIDER=yahoo node src/run.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTicker, rankAll, explain, stageAgent, computeIndicators, lookupTable, CONFIG } from './engine.js';
import { loadUniverse, loadNasdaq100, loadDow30, cachedList, yahooHistory, massiveHistory } from './data.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export const MARKET_LABELS = { stocks: 'S&P 500', nasdaq: 'Nasdaq-100', dow: 'Dow Jones 30', bursa: 'FBM KLCI 30', crypto: 'Top 100 coins' };

export function buildReport(universe, history, provider, { cfg = CONFIG, regimeTicker = 'SPY', market = 'stocks' } = {}) {
  const analyses = universe.map(u => analyzeTicker(u, history[u.ticker], cfg));
  const ranked = rankAll(analyses, 5);
  const spy = history[regimeTicker];
  let regime = null;
  if (spy && spy.length > 220) {
    const s = stageAgent(spy, computeIndicators(spy), cfg);
    regime = { ticker: regimeTicker, stage: s.stage, slope150: s.slope, dist150: s.dist, close: spy[spy.length - 1].c };
  }
  const pack = (x, side) => {
    const a = x.a, S = side === 'long' ? a.long : a.short;
    return {
      ticker: a.ticker, name: a.name, sector: a.sector, tier: x.tier, score: x.s,
      stage: a.stage, close: a.close, asOf: a.asOf, slope150: a.slope150, dist150: a.dist150, ret126: a.ret126,
      status: S.setup.status, valid: S.setup.valid, reason: S.setup.reason, zone: S.setup.zone,
      contractions: (S.setup.contractions || []).map(c => ({ hi: c.hi, lo: c.lo, hiT: c.hiT, loT: c.loT, depth: c.depth, open: !!c.open })),
      risk: S.risk, volume: S.vol, notes: explain(a, side), chart: a.chart,
    };
  };
  const asOf = analyses.filter(a => !a.skip).map(a => a.asOf).sort().pop();
  const lookup = { asOf, market, generatedAt: new Date().toISOString(), rows: lookupTable(analyses) };
  return { lookup, report: {
    generatedAt: new Date().toISOString(), asOf, provider, market,
    universe: MARKET_LABELS[market] || market, universeSize: universe.length, scanned: ranked.scanned,
    skipped: analyses.filter(a => a.skip).map(a => a.ticker),
    stageCounts: ranked.stageCounts, regime,
    up: ranked.up.top.map(x => pack(x, 'long')), upPassed: ranked.up.passedCount, upCandidates: ranked.up.total,
    down: ranked.down.top.map(x => pack(x, 'short')), downPassed: ranked.down.passedCount, downCandidates: ranked.down.total,
    config: cfg,
  } };
}

async function main() {
  const provider = (process.env.DATA_PROVIDER || (process.env.MASSIVE_API_KEY ? 'massive' : 'yahoo')).toLowerCase();
  log('Universe agent: loading S&P 500 constituents');
  const universe = await loadUniverse();
  log(`  ${universe.length} tickers`);
  // Nasdaq-100 and Dow 30 member lists come from Wikipedia; the last good copy is kept in data/lists/
  const lists = {};
  for (const [key, file, loader] of [['nasdaq', 'nasdaq100', loadNasdaq100], ['dow', 'dow30', loadDow30]]) {
    try { lists[key] = await cachedList(path.join(root, `data/lists/${file}.json`), loader, log); log(`  ${MARKET_LABELS[key]}: ${lists[key].length} tickers`); }
    catch (e) { lists[key] = []; log(`  ${MARKET_LABELS[key]} list unavailable (${e.message}) — skipping that page today`); }
  }
  // one download for every index (most Nasdaq-100 and all Dow names are also in the S&P 500)
  const all = [...new Map([...universe, ...lists.nasdaq, ...lists.dow].map(u => [u.ticker, u])).values()];
  const extra = [{ ticker: 'SPY' }, { ticker: 'QQQ' }, { ticker: 'DIA' }];
  log(`Market-data agent: provider = ${provider}`);
  let history;
  if (provider === 'massive') {
    try {
      history = await massiveHistory(all, { apiKey: process.env.MASSIVE_API_KEY, cacheFile: path.join(root, 'data/history.json.gz'), log });
    } catch (e) {
      log('  massive failed (' + e.message + ') — falling back to yahoo');
      history = await yahooHistory([...all, ...extra], { log });
    }
  } else history = await yahooHistory([...all, ...extra], { log });
  log(`  history for ${Object.keys(history).length} tickers`);

  log('Stage / Contraction / Volume / Risk agents: analysing');
  const pages = [['S&P 500', universe, 'docs/data', { regimeTicker: 'SPY', market: 'stocks' }]];
  if (lists.nasdaq.length) pages.push(['Nasdaq-100', lists.nasdaq, 'docs/nasdaq/data', { regimeTicker: 'QQQ', market: 'nasdaq' }]);
  if (lists.dow.length) pages.push(['Dow Jones 30', lists.dow, 'docs/dow/data', { regimeTicker: 'DIA', market: 'dow' }]);
  for (const [label, uni, dir, opts] of pages) {
    const { report, lookup } = buildReport(uni, history, provider, opts);
    log(`${label} — ranking agent: ${report.upPassed} valid long setups, ${report.downPassed} valid short setups (as of ${report.asOf})`);
    writeOutputs(path.join(root, dir), report, lookup);
    for (const [side, arr] of [['UP', report.up], ['DOWN', report.down]]) {
      log(`  Top ${side}: ` + arr.map(p => `${p.ticker}(${p.score.total}${p.tier === 'watch' ? ',watch' : ''})`).join(' '));
    }
  }
}

export function writeOutputs(dataDir, report, lookup) {
  fs.mkdirSync(path.join(dataDir, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'latest.json'), JSON.stringify(report));
  fs.writeFileSync(path.join(dataDir, 'all.json'), JSON.stringify(lookup)); // every name, for the lookup box (latest only, not archived)
  fs.writeFileSync(path.join(dataDir, 'archive', `${report.asOf}.json`), JSON.stringify(report));
  const idxFile = path.join(dataDir, 'index.json');
  const idx = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : [];
  if (!idx.includes(report.asOf)) idx.push(report.asOf);
  fs.writeFileSync(idxFile, JSON.stringify(idx.sort().reverse()));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(e); process.exit(1); });
}
