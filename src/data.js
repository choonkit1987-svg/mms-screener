// Data agents: S&P 500 universe + daily OHLCV history.
// Provider "massive" (formerly Polygon.io, free key) uses the grouped-daily endpoint:
//   one call returns every US stock for one day, so the free 5-calls/minute limit is enough.
//   History is cached in data/history.json.gz and only new days are fetched each run.
// Provider "yahoo" needs no key (unofficial endpoint; used as a fallback).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const UNIVERSE_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseCSV(text) {
  const rows = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const cells = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur); rows.push(cells);
  }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// ---------- Index member lists (Wikipedia API, no key) ----------
// Each list page has a "wikitable" of constituents. The last good list is kept in data/lists/
// so a Wikipedia outage or page edit never stops the daily run.
const cleanCell = x => x.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#160;|&nbsp;/g, ' ')
  .replace(/&#91;[^&]*&#93;|\[[^\]]*\]/g, '').replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim();

// Returns the rows of the first wikitable whose header matches `headerRe`, as objects keyed by lower-case header.
export function parseWikiTable(html, headerRe) {
  for (const t of html.match(/<table[^>]*wikitable[\s\S]*?<\/table>/gi) || []) {
    const rows = [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(r => [...r[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => cleanCell(c[1])));
    if (!rows.length || !headerRe.test(rows[0].join('|'))) continue;
    const head = rows.shift().map(h => h.toLowerCase());
    return rows.filter(r => r.length >= head.length - 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] || ''])));
  }
  throw new Error('constituents table not found');
}
async function wikiPage(page) {
  const url = 'https://en.wikipedia.org/w/api.php?action=parse&redirects=1&prop=text&format=json&formatversion=2&origin=*&page=' + encodeURIComponent(page);
  const res = await fetch(url, { headers: { 'User-Agent': 'mms-screener (github actions)' } });
  if (!res.ok) throw new Error(`${page}: HTTP ${res.status}`);
  const j = await res.json();
  if (!j.parse) throw new Error(`${page}: ${j.error?.info || 'page not found'}`);
  return j.parse.text;
}
const pick = (row, re) => { const k = Object.keys(row).find(h => re.test(h)); return k ? row[k] : ''; };
const titleCase = s => s.toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\b(Bhd|Berhad)\b/g, m => m === 'Bhd' ? 'Bhd' : 'Berhad');

export async function loadNasdaq100() {
  const rows = parseWikiTable(await wikiPage('List of NASDAQ-100 companies'), /ticker/i);
  const out = rows.map(r => ({ ticker: pick(r, /ticker|symbol/).replace(/\s+/g, ''), name: pick(r, /company|security/), sector: pick(r, /industry|sector/) })).filter(u => /^[A-Z.]+$/.test(u.ticker));
  if (out.length < 95) throw new Error(`Nasdaq-100 table has only ${out.length} rows`);
  return out;
}
export async function loadDow30() {
  const rows = parseWikiTable(await wikiPage('List of Dow Jones Industrial Average companies'), /symbol/i);
  const out = rows.map(r => ({ ticker: pick(r, /symbol|ticker/).replace(/\s+/g, ''), name: pick(r, /company/), sector: pick(r, /sector|industry/) })).filter(u => /^[A-Z.]+$/.test(u.ticker));
  if (out.length < 28) throw new Error(`Dow table has only ${out.length} rows`);
  return out;
}
// FBM KLCI: Bursa stock codes -> Yahoo symbols "<code>.KL". The display ticker becomes the Bursa
// short name (MAYBANK, TENAGA…) once Yahoo returns it.
export async function loadKLCI() {
  const rows = parseWikiTable(await wikiPage('FTSE Bursa Malaysia KLCI'), /stock code/i);
  const out = rows.map(r => { const code = pick(r, /code/).replace(/\D/g, ''); return { ticker: code, code, yahoo: code + '.KL', name: titleCase(pick(r, /name/)), sector: pick(r, /sector/) }; })
    .filter(u => /^\d{4}$/.test(u.code));
  if (out.length < 28) throw new Error(`KLCI table has only ${out.length} rows`);
  return out;
}
// Runs a list loader; saves the result, or falls back to the last saved list if the loader fails.
export async function cachedList(file, loader, log = console.log) {
  try {
    const list = await loader();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 1));
    return list;
  } catch (e) {
    if (fs.existsSync(file)) { log(`  ${path.basename(file)}: live list unavailable (${e.message}) — using the saved copy`); return JSON.parse(fs.readFileSync(file, 'utf8')); }
    throw e;
  }
}

export async function loadUniverse() {
  const res = await fetch(UNIVERSE_URL);
  if (!res.ok) throw new Error('universe download failed: ' + res.status);
  return parseCSV(await res.text()).map(r => ({ ticker: r.Symbol, name: r.Security, sector: r['GICS Sector'] }));
}

async function getJSON(url, tries = 4) {
  for (let k = 0; k < tries; k++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 mms-screener' } });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) { await sleep(15000 * (k + 1)); continue; }
    throw new Error(`${res.status} ${url.replace(/apiKey=[^&]+/, 'apiKey=***')}`);
  }
  throw new Error('gave up after retries: ' + url.replace(/apiKey=[^&]+/, 'apiKey=***'));
}

// ---------- Yahoo (no key) ----------
export async function yahooHistory(universe, { range = '2y', concurrency = 4, log = console.log, dropToday = false, dropOpen = false, meta = null } = {}) {
  const todayUTC = new Date().toISOString().slice(0, 10);
  const out = {};
  let idx = 0, done = 0;
  async function worker() {
    while (idx < universe.length) {
      const u = universe[idx++];
      const sym = u.yahoo || u.ticker.replace('.', '-');
      try {
        const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&events=split`);
        const r = j.chart.result[0], q = r.indicators.quote[0];
        if (meta) meta[u.ticker] = { shortName: r.meta.shortName, longName: r.meta.longName, currency: r.meta.currency };
        const adj = r.indicators.adjclose?.[0]?.adjclose;
        const bars = [];
        const off = r.meta.gmtoffset || 0, reg = r.meta.currentTradingPeriod?.regular;
        // dropOpen: skip today's bar while the exchange session is still trading (15 min grace after the close)
        const openFrom = dropOpen && reg && Date.now() / 1000 < reg.end + 900 ? reg.start : Infinity;
        r.timestamp.forEach((ts, i) => {
          if (q.close[i] == null || q.open[i] == null || ts >= openFrom) return;
          const f = adj && adj[i] ? adj[i] / q.close[i] : 1; // split/dividend-adjust OHLC
          bars.push({ t: new Date((ts + off) * 1000).toISOString().slice(0, 10), o: q.open[i] * f, h: q.high[i] * f, l: q.low[i] * f, c: q.close[i] * f, v: q.volume[i] || 0 });
        });
        // crypto trades 24/7: today's candle is still open, so only use completed days
        out[u.ticker] = dropToday ? bars.filter(b => b.t < todayUTC) : bars;
      } catch (e) { log(`  ${u.ticker}: ${e.message}`); }
      if (++done % 50 === 0) log(`  yahoo: ${done}/${universe.length}`);
      await sleep(250);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

// ---------- Massive / Polygon grouped daily (free key) ----------
function tradingDaysBack(fromDate, count) {
  const days = []; const d = new Date(fromDate + 'T00:00:00Z');
  while (days.length < count) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return days.reverse();
}

export async function massiveHistory(universe, { apiKey, cacheFile, days = 320, fullRefreshDays = 7, log = console.log } = {}) {
  if (!apiKey) throw new Error('MASSIVE_API_KEY is not set');
  const base = process.env.MASSIVE_BASE_URL || 'https://api.massive.com';
  let cache = { byDate: {}, fetchedAt: null, full: null };
  if (cacheFile && fs.existsSync(cacheFile)) cache = JSON.parse(zlib.gunzipSync(fs.readFileSync(cacheFile)).toString());
  // Periodic full re-download keeps old bars correctly split-adjusted.
  if (!cache.full || (Date.now() - Date.parse(cache.full)) / 864e5 > fullRefreshDays) { cache.byDate = {}; cache.full = new Date().toISOString(); log('  massive: full history refresh'); }
  const want = new Set(universe.map(u => u.ticker)); for (const t of ['SPY', 'QQQ', 'DIA']) want.add(t);
  const today = new Date().toISOString().slice(0, 10);
  const dates = tradingDaysBack(today, days);
  const todo = dates.filter(d => !(d in cache.byDate) || d >= dates[dates.length - 3]); // always refresh the last few days
  log(`  massive: ${todo.length} day(s) to fetch (free tier: 5 calls/min)`);
  let n = 0;
  for (const d of todo) {
    let j;
    try { j = await getJSON(`${base}/v2/aggs/grouped/locale/us/market/stocks/${d}?adjusted=true&apiKey=${apiKey}`); }
    catch (e) {
      // free plans cannot read the current session before it is final — skip, try again next run
      if (/^403/.test(e.message) && d >= dates[dates.length - 2]) { log(`  massive: ${d} not available yet (${e.message.slice(0, 3)})`); continue; }
      throw e;
    }
    const day = {};
    for (const r of j.results || []) if (want.has(r.T)) day[r.T] = [r.o, r.h, r.l, r.c, r.v];
    cache.byDate[d] = Object.keys(day).length ? day : null; // null = market holiday
    if (++n % 25 === 0) log(`  massive: ${n}/${todo.length}`);
    if (n < todo.length) await sleep(12500); // stay under 5 calls/minute
  }
  cache.fetchedAt = new Date().toISOString();
  if (cacheFile) { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, zlib.gzipSync(JSON.stringify(cache))); }
  const out = {};
  for (const d of Object.keys(cache.byDate).sort()) {
    const day = cache.byDate[d]; if (!day) continue;
    for (const [t, [o, h, l, c, v]] of Object.entries(day)) (out[t] ||= []).push({ t: d, o, h, l, c, v });
  }
  return out;
}
