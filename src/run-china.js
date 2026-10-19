#!/usr/bin/env node
// China A-shares orchestrator — same agents, applied to the CSI 300 (Shanghai + Shenzhen).
//   * universe = CSI 300 constituents (Wikipedia, last good copy in data/lists/csi300.json)
//   * data = Eastmoney daily bars, then Tencent, then Yahoo ("<code>.SS" / "<code>.SZ"); today's bar is ignored while the market is still trading
//   * prices in CNY (¥); liquidity = 50-day average volume x price > ¥1M a day
//   * regime = the CSI 300 ETF 510300.SS (Yahoo's 000300.SS index series has almost no history)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './engine.js';
import { loadCSI300, cachedList } from './data.js';
import { eastmoneyBars, tencentBars, yahooBars, firstWorking, makeHealth, pool } from './sources.js';
import { buildReport, writeOutputs, enoughData } from './run.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const CHINA_CONFIG = { ...CONFIG, currency: '¥' };

// Some Wikipedia names are in capitals ("CINDA SECURITIES"); use Yahoo's company name for those.
export function tidyNames(list, meta) {
  return list.map(u => (u.name && u.name !== u.name.toUpperCase()) ? u : { ...u, name: meta[u.ticker]?.longName || u.name });
}

async function main() {
  log('Universe agent: CSI 300 constituents');
  const csi = await cachedList(path.join(root, 'data/lists/csi300.json'), loadCSI300, log);
  log(`  ${csi.length} stocks`);
  log('Market-data agent: Eastmoney -> Tencent -> Yahoo daily bars');
  const health = makeHealth(log), meta = {}, history = {}, used = {};
  const items = [...csi, { ticker: 'CSI300', code: '510300', yahoo: '510300.SS' }];
  await pool(items, 4, async u => {
    const r = await firstWorking([
      ['eastmoney', () => eastmoneyBars(u.code)],
      ['tencent', () => tencentBars(u.code)],
      ['yahoo', () => yahooBars(u.yahoo, { dropOpen: true })],
    ], health);
    if (r.bars) { history[u.ticker] = r.bars; used[r.source] = (used[r.source] || 0) + 1; if (r.meta) meta[u.ticker] = r.meta; }
  });
  log(`  history for ${Object.keys(history).length} tickers; sources used: ${JSON.stringify(used)}`);
  const universe = tidyNames(csi, meta);
  const dataDir = path.join(root, 'docs/china/data');
  const check = enoughData('CSI 300', universe, history, dataDir, health, log);
  if (!check.ok) return;
  const { report, lookup } = buildReport(universe, history, 'eastmoney/tencent/yahoo', { cfg: CHINA_CONFIG, regimeTicker: 'CSI300', market: 'china' });
  log(`Ranking agent: ${report.upPassed} valid long setups, ${report.downPassed} valid short setups (as of ${report.asOf})`);
  writeOutputs(dataDir, report, lookup, history, check);
  for (const [label, arr] of [['UP', report.up], ['DOWN', report.down]]) log(`Top ${label}: ` + arr.map(p => `${p.ticker}(${p.score.total}${p.tier === 'watch' ? ',watch' : ''})`).join(' '));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error(e); process.exit(1); });
}
