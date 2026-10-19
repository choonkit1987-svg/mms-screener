// Market-data sources with automatic fallback.
// Yahoo is free but often refuses requests from cloud servers such as GitHub Actions (HTTP 429),
// so every market has a chain of sources. A source that keeps failing is switched off for the
// rest of the run (circuit breaker), so a blocked source costs seconds instead of the whole run.
//
//   crypto : Binance market data (data-api.binance.vision) -> OKX -> Yahoo
//   china  : Eastmoney -> Tencent -> Yahoo
//   bursa  : Yahoo (query1 -> query2)          (no free Bursa feed without a key)
//   US     : Massive (key) -> Yahoo            (handled in data.js)
//
// Every function returns daily bars [{t:'YYYY-MM-DD', o, h, l, c, v}] oldest first, completed days only.

const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export class SourceError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

export async function fetchJSON(url, { tries = 3, timeout = 20000, headers = {} } = {}) {
  let last;
  for (let k = 0; k < tries; k++) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json,text/plain,*/*', ...headers }, signal: ac.signal });
      if (res.ok) return await res.json();
      last = new SourceError(`HTTP ${res.status}`, res.status);
      if (res.status === 404 || res.status === 400) throw last; // no such symbol: do not retry
    } catch (e) {
      if (e instanceof SourceError && (e.status === 404 || e.status === 400)) throw e;
      last = e.name === 'AbortError' ? new SourceError('timeout') : e instanceof SourceError ? e : new SourceError(e.message);
    } finally { clearTimeout(timer); }
    await sleep(1500 * (k + 1));
  }
  throw last;
}

// ---------- health / circuit breaker ----------
export function makeHealth(log = console.log) {
  const h = { stats: {}, dead: new Set() };
  h.ok = s => { const x = (h.stats[s] ||= { ok: 0, fail: 0, streak: 0, lastError: '' }); x.ok++; x.streak = 0; };
  h.fail = (s, e) => {
    const x = (h.stats[s] ||= { ok: 0, fail: 0, streak: 0, lastError: '' });
    x.fail++; x.streak++; x.lastError = e?.message || String(e);
    // 404/400 = symbol not listed there, not a sign the source is blocked
    if (!(e?.status === 404 || e?.status === 400) && x.streak >= 8 && !h.dead.has(s)) { h.dead.add(s); log(`  ${s}: ${x.streak} failures in a row (${x.lastError}) — switching it off for this run`); }
  };
  h.summary = () => Object.fromEntries(Object.entries(h.stats).map(([s, x]) => [s, { ok: x.ok, fail: x.fail, off: h.dead.has(s), lastError: x.lastError }]));
  return h;
}

// Try each source in order; the first that returns enough bars wins.
export async function firstWorking(chain, health, minBars = 60) {
  const errors = [];
  for (const [name, fn] of chain) {
    if (health.dead.has(name)) continue;
    try {
      const r = await fn();
      const bars = Array.isArray(r) ? r : r.bars;
      if (bars && bars.length >= minBars) { health.ok(name); return { ...(Array.isArray(r) ? { bars } : r), source: name }; }
      health.fail(name, new SourceError(`only ${bars?.length || 0} bars`, 404));
    } catch (e) { health.fail(name, e); errors.push(`${name}: ${e.message}`); }
  }
  return { bars: null, source: null, errors };
}

const day = ms => new Date(ms).toISOString().slice(0, 10);

// ---------- Yahoo ----------
const YHOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
export function parseYahoo(j, { dropOpen = false } = {}) {
  const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp) return { bars: [] };
  const q = r.indicators.quote[0], adj = r.indicators.adjclose?.[0]?.adjclose, off = r.meta.gmtoffset || 0, reg = r.meta.currentTradingPeriod?.regular;
  const openFrom = dropOpen && reg && Date.now() / 1000 < reg.end + 900 ? reg.start : Infinity;
  const bars = [];
  r.timestamp.forEach((ts, i) => {
    if (q.close[i] == null || q.open[i] == null || ts >= openFrom) return;
    const f = adj && adj[i] ? adj[i] / q.close[i] : 1;
    bars.push({ t: day((ts + off) * 1000), o: q.open[i] * f, h: q.high[i] * f, l: q.low[i] * f, c: q.close[i] * f, v: q.volume[i] || 0 });
  });
  return { bars, meta: { shortName: r.meta.shortName, longName: r.meta.longName, currency: r.meta.currency } };
}
export async function yahooBars(sym, { range = '2y', dropOpen = false, dropToday = false } = {}) {
  let last;
  for (const host of YHOSTS) {
    try {
      const j = await fetchJSON(`${host}/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&events=split`, { tries: 2 });
      const out = parseYahoo(j, { dropOpen });
      if (dropToday) { const today = day(Date.now()); out.bars = out.bars.filter(b => b.t < today); }
      return out;
    } catch (e) { last = e; if (e.status === 404) throw e; }
  }
  throw last;
}

// ---------- Binance (public market data mirror, no key) ----------
// kline: [openTime, open, high, low, close, baseVol, closeTime, quoteVol, ...]; volume reported in USDT (quote)
export function parseBinance(rows, now = Date.now()) {
  return (rows || []).filter(k => k[6] < now).map(k => ({ t: day(k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] }));
}
export async function binanceBars(base, { limit = 800 } = {}) {
  const j = await fetchJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${base.toUpperCase()}USDT&interval=1d&limit=${limit}`, { tries: 2 });
  return parseBinance(j);
}

// ---------- OKX (public, no key) ----------
// candle: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]; newest first, 100 per page
export function parseOkx(rows) {
  return (rows || []).filter(k => k[8] === '1').map(k => ({ t: day(+k[0]), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[7] })).reverse();
}
export async function okxBars(base, { pages = 8 } = {}) {
  let after = '', out = [];
  for (let p = 0; p < pages; p++) {
    const j = await fetchJSON(`https://www.okx.com/api/v5/market/history-candles?instId=${base.toUpperCase()}-USDT&bar=1Dutc&limit=100${after ? '&after=' + after : ''}`, { tries: 2 });
    if (j.code !== '0') throw new SourceError(j.msg || 'okx error', 404);
    if (!j.data?.length) break;
    out = parseOkx(j.data).concat(out);
    after = j.data[j.data.length - 1][0];
    if (j.data.length < 100) break;
    await sleep(120);
  }
  return out;
}

// ---------- China A-shares ----------
// Shanghai codes start with 6/5/9 (market 1 / "sh"), Shenzhen with 0/3 (market 0 / "sz"). Volume comes in lots of 100 shares.
const isSH = code => /^[569]/.test(code);
function chinaDropOpen(bars) {
  // drop today's bar while Shanghai/Shenzhen are still trading (close 15:00 Beijing = 07:00 UTC)
  const bj = new Date(Date.now() + 8 * 3600e3), today = bj.toISOString().slice(0, 10);
  const open = bj.getUTCHours() * 60 + bj.getUTCMinutes() < 15 * 60 + 10;
  return open ? bars.filter(b => b.t < today) : bars;
}
export function parseEastmoney(j) {
  return (j?.data?.klines || []).map(s => { const [t, o, c, h, l, v] = s.split(','); return { t, o: +o, h: +h, l: +l, c: +c, v: +v * 100 }; });
}
export async function eastmoneyBars(code, { days = 520 } = {}) {
  const j = await fetchJSON(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${isSH(code) ? 1 : 0}.${code}&klt=101&fqt=1&lmt=${days}&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57`, { tries: 2 });
  if (!j?.data) throw new SourceError('no data', 404);
  return chinaDropOpen(parseEastmoney(j));
}
export function parseTencent(j, key) {
  const d = j?.data?.[key];
  return (d?.qfqday || d?.day || []).map(r => ({ t: r[0], o: +r[1], c: +r[2], h: +r[3], l: +r[4], v: +r[5] * 100 }));
}
export async function tencentBars(code, { days = 520 } = {}) {
  const key = (isSH(code) ? 'sh' : 'sz') + code;
  const j = await fetchJSON(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${key},day,,,${days},qfq`, { tries: 2 });
  const bars = parseTencent(j, key);
  if (!bars.length) throw new SourceError('no data', 404);
  return chinaDropOpen(bars);
}

// ---------- coverage check ----------
// A run is "good" when most of the universe has fresh bars. Otherwise the caller keeps yesterday's page
// and writes status.json so the dashboard can say the update failed and why.
export function coverage(universe, history, maxStaleDays = 6) {
  const lasts = universe.map(u => history[u.ticker]?.at(-1)?.t).filter(Boolean).sort();
  const newest = lasts.at(-1);
  if (!newest) return { share: 0, fresh: 0, total: universe.length, newest: null };
  const cut = day(Date.parse(newest) - maxStaleDays * 864e5);
  const fresh = lasts.filter(t => t >= cut).length;
  return { share: fresh / Math.max(1, universe.length), fresh, total: universe.length, newest };
}

// run a list of jobs with limited concurrency
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
