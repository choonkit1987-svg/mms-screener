#!/usr/bin/env node
// Weekly Agent Desk training job (GitHub Actions, Sundays):
//   node src/desk/train.js us      — 5 years of daily S&P 500 + Nasdaq-100 bars from Yahoo
//   node src/desk/train.js crypto  — ~800 days of daily candles for the top 100 coins
// Re-fits the 2-week direction model, tests it on the most recent 6 months it did not
// train on, and saves weights + test results to data/desk/model-<market>.json.
import fs from 'node:fs';
import path from 'node:path';
import { trainModel, saveModel, ROOT } from './run-desk.js';
import { loadUniverse, cachedList, loadNasdaq100, yahooHistory } from '../data.js';
import { loadCoinUniverse, cryptoHistory } from '../crypto.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const market = process.argv[2] || 'us';
  let histories, bench;
  if (market === 'us') {
    const sp = await loadUniverse();
    const nq = await cachedList(path.join(ROOT, 'data/lists/nasdaq100.json'), loadNasdaq100, log).catch(() => []);
    const uni = [...new Map([...sp, ...nq].map(u => [u.ticker, u])).values()];
    log(`training universe: ${uni.length} stocks, 5 years of daily bars`);
    histories = await yahooHistory([...uni, { ticker: 'SPY' }], { range: '5y', concurrency: 6, log });
    bench = histories.SPY;
  } else {
    const uni = await cachedList(path.join(ROOT, 'data/lists/crypto.json'), () => loadCoinUniverse(100), log);
    log(`training universe: ${uni.length} coins`);
    ({ history: histories } = await cryptoHistory(uni, { log }));
    bench = histories.BTC;
  }
  if (!bench || bench.length < 400) throw new Error('benchmark history missing — not saving a model');
  const model = trainModel(market, histories, bench, { testDays: 120, log });
  if (!(model.rel.test.samples > 1000)) throw new Error('too few test samples — not saving a model');
  saveModel(model);
  log(`saved data/desk/model-${market}.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
