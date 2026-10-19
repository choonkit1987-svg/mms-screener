#!/usr/bin/env node
// Checks which market-data sources answer from this machine (run it on GitHub via the "Check data sources" workflow).
import fs from 'node:fs';
import { yahooBars, binanceBars, okxBars, eastmoneyBars, tencentBars, fetchJSON } from './sources.js';

const tests = [
  ['Yahoo (S&P 500, Bursa, fallback)', 'AAPL', () => yahooBars('AAPL', { range: '1mo' })],
  ['Yahoo — Bursa Malaysia', 'MAYBANK 1155.KL', () => yahooBars('1155.KL', { range: '1mo' })],
  ['Binance (crypto)', 'BTC', () => binanceBars('BTC', { limit: 30 })],
  ['OKX (crypto)', 'BTC', () => okxBars('BTC', { pages: 1 })],
  ['Eastmoney (China)', '600519', () => eastmoneyBars('600519', { days: 30 })],
  ['Tencent (China)', '600519', () => tencentBars('600519', { days: 30 })],
  ['CoinGecko (coin list)', 'top coins', () => fetchJSON('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=5&page=1').then(j => j.map(x => ({ t: x.symbol })))],
  ['Wikipedia (index lists)', 'CSI 300 page', () => fetchJSON('https://en.wikipedia.org/w/api.php?action=parse&page=CSI_300_Index&prop=sections&format=json&origin=*').then(j => j.parse.sections)],
];
const rows = [];
for (const [name, sym, fn] of tests) {
  const t0 = Date.now();
  try {
    const r = await fn(); const bars = Array.isArray(r) ? r : r.bars;
    rows.push([name, sym, bars?.length ? 'OK' : 'EMPTY', `${bars?.length || 0} rows${bars?.at?.(-1)?.t ? ', last ' + bars.at(-1).t : ''}`, Date.now() - t0]);
  } catch (e) { rows.push([name, sym, 'FAILED', e.message, Date.now() - t0]); }
}
const md = ['| Source | Test | Result | Detail | ms |', '|---|---|---|---|---|', ...rows.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Data source check\n\n' + md + '\n');
