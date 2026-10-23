#!/usr/bin/env node
// Daily crypto orchestrator — same agents as the stock scanner, tuned for coins:
//   * universe = top 100 coins by market cap (CoinGecko), stables/wrapped removed; last good list kept in data/lists/crypto.json
//   * daily candles (UTC close) from Binance, then OKX, then Yahoo; the still-open candle is dropped
//   * volume is in USD/USDT, so liquidity = 50-day average volume
//   * regime = Bitcoin's stage
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './engine.js';
import { loadCoinUniverse, cryptoHistory } from './crypto.js';
import { cachedList } from './data.js';
import { makeHealth } from './sources.js';
import { buildReport, writeOutputs, enoughData } from './run.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const CRYPTO_CONFIG = { ...CONFIG, volumeInQuote: true, stage1MinSidewaysBars: 182 };

async function main() {
  log('Universe agent: top coins by market cap (CoinGecko)');
  let fresh = true;
  const universe = await cachedList(path.join(root, 'data/lists/crypto.json'), () => loadCoinUniverse(100), (...a) => { fresh = false; log(...a); });
  if (!fresh) universe.forEach(u => { u.cgPrice = null; }); // saved list: its prices are old, skip the price check
  log(`  ${universe.length} coins after removing stablecoins and wrapped tokens`);
  log('Market-data agent: Binance -> OKX -> Yahoo daily candles');
  const health = makeHealth(log);
  const { history, notes } = await cryptoHistory(universe, { log, health });
  log(`  sources used: ${JSON.stringify(notes.sources)}`);
  const dataDir = path.join(root, 'docs/crypto/data');
  const check = enoughData('crypto', universe, history, dataDir, health, log);
  if (!check.ok) return;
  const { report, lookup } = buildReport(universe, history, 'exchange+coingecko', { cfg: CRYPTO_CONFIG, regimeTicker: 'BTC', market: 'crypto' });
  report.dataNotes = notes;
  log(`Ranking agent: ${report.upPassed} valid long setups, ${report.downPassed} valid short setups (as of ${report.asOf})`);
  writeOutputs(dataDir, report, lookup, history, check);
  for (const [label, arr] of [['UP', report.up], ['DOWN', report.down]]) log(`Top ${label}: ` + arr.map(p => `${p.ticker}(${p.score.total}${p.tier === 'watch' ? ',watch' : ''})`).join(' '));
  // Agent Desk for coins (no financial reports, so the decoder step is skipped)
  try {
    const { runDesk } = await import('./desk/run-desk.js');
    await runDesk({ market: 'crypto', universe, history, benchTicker: 'BTC', log });
  } catch (e) { log('Agent Desk failed: ' + (e.stack || e.message)); }
}

main().catch(e => { console.error(e); process.exit(1); });
