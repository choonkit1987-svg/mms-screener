#!/usr/bin/env node
// Daily crypto orchestrator — same agents as the stock scanner, tuned for coins:
//   * universe = top 100 coins by market cap (CoinGecko), stables/wrapped removed
//   * daily candles close at 00:00 UTC; the still-open candle is dropped
//   * volume is already in USD, so liquidity = 50-day average volume
//   * regime = Bitcoin's stage
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './engine.js';
import { loadCoinUniverse, cryptoHistory } from './crypto.js';
import { buildReport } from './run.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const CRYPTO_CONFIG = { ...CONFIG, volumeInQuote: true, stage1MinSidewaysBars: 182 };

async function main() {
  log('Universe agent: top coins by market cap (CoinGecko)');
  const universe = await loadCoinUniverse(100);
  log(`  ${universe.length} coins after removing stablecoins and wrapped tokens`);
  log('Market-data agent: Yahoo daily candles');
  const { history, notes } = await cryptoHistory(universe, { log });
  const { report, lookup } = buildReport(universe, history, 'yahoo+coingecko', { cfg: CRYPTO_CONFIG, regimeTicker: 'BTC', market: 'crypto' });
  report.dataNotes = notes;
  log(`Ranking agent: ${report.upPassed} valid long setups, ${report.downPassed} valid short setups (as of ${report.asOf})`);
  const dataDir = path.join(root, 'docs/crypto/data');
  fs.mkdirSync(path.join(dataDir, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'latest.json'), JSON.stringify(report));
  fs.writeFileSync(path.join(dataDir, 'all.json'), JSON.stringify(lookup));
  fs.writeFileSync(path.join(dataDir, 'archive', `${report.asOf}.json`), JSON.stringify(report));
  const idxFile = path.join(dataDir, 'index.json');
  const idx = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : [];
  if (!idx.includes(report.asOf)) idx.push(report.asOf);
  fs.writeFileSync(idxFile, JSON.stringify(idx.sort().reverse()));
  for (const [label, arr] of [['UP', report.up], ['DOWN', report.down]]) log(`Top ${label}: ` + arr.map(p => `${p.ticker}(${p.score.total}${p.tier === 'watch' ? ',watch' : ''})`).join(' '));
}

main().catch(e => { console.error(e); process.exit(1); });
