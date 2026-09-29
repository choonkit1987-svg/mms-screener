// Crypto agents.
//  * Universe agent: top coins by market cap from CoinGecko (free, no key), with stablecoins,
//    wrapped / staked / bridged tokens and tokenised funds removed.
//  * Market-data agent: Yahoo daily candles (UTC close). Handles two Yahoo quirks:
//      1. coins whose plain symbol is taken get a numbered symbol (SUI -> SUI20947-USD); found via search
//      2. yesterday's daily candle is sometimes still blank shortly after 00:00 UTC; rebuilt from hourly candles
const CG = 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1';
const YF = 'https://query1.finance.yahoo.com';

const EXCLUDE_SYMBOLS = new Set(('usdt usdc dai fdusd tusd usde usds pyusd usdd frax usd0 usdy rlusd usdtb susds susde sfrax ' +
  'usd1 gho lusd crvusd usdx usdg usdf usdb eurc eurs eurt xaut paxg buidl ousg usyc syrupusdc ustb jaaa jtrsy a7a5 ' +
  'eursafo bcap xsgd brz bidr wbtc weth steth wsteth weeth cbbtc lbtc reth cbeth meth ezeth rseth solvbtc tbtc jitosol ' +
  'msol bnsol bbsol oseth sweth clbtc ebtc pumpbtc fbtc wbeth wbnb whype stkaave jupsol hbtc btcb kbtc unibtc').split(/\s+/));
const EXCLUDE_NAME = /wrapped|staked|bridged|binance-peg|restaked|liquid staking|tokeni[sz]ed|\bgold\b|treasur|money market|\bfund\b|\busd\b|\beur\b|ruble/i;

export function filterCoins(rows, n = 100) {
  const out = [];
  for (const r of rows) {
    const sym = (r.symbol || '').toLowerCase();
    if (!/^[a-z0-9]+$/.test(sym)) continue; // non-Latin tickers are not listed on Yahoo
    if (EXCLUDE_SYMBOLS.has(sym) || EXCLUDE_NAME.test(r.name || '')) continue;
    if (/usd|eur/.test(sym) && Math.abs((r.current_price || 0) - 1) < 0.05) continue; // dollar / euro pegs
    if (Math.abs((r.current_price || 0) - 1) < 0.01 && Math.abs(r.price_change_percentage_24h || 0) < 0.3) continue; // unnamed stables
    out.push({ ticker: sym.toUpperCase(), name: r.name, sector: 'Crypto', yahoo: sym.toUpperCase() + '-USD', cgPrice: r.current_price, cgId: r.id, rank: r.market_cap_rank });
    if (out.length >= n) break;
  }
  return out;
}

export async function loadCoinUniverse(n = 100) {
  for (let k = 0; k < 4; k++) {
    const res = await fetch(CG, { headers: { accept: 'application/json', 'User-Agent': 'mms-screener' } });
    if (res.ok) return filterCoins(await res.json(), n);
    await new Promise(r => setTimeout(r, 20000 * (k + 1)));
  }
  throw new Error('CoinGecko coin list unavailable');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function yjson(path) {
  for (let k = 0; k < 3; k++) {
    const res = await fetch(YF + path, { headers: { 'User-Agent': 'Mozilla/5.0 mms-screener' } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    await sleep(5000 * (k + 1));
  }
  return null;
}

function parseChart(j) {
  const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp) return [];
  const q = r.indicators.quote[0];
  const out = [];
  r.timestamp.forEach((ts, i) => {
    if (q.close[i] == null || q.open[i] == null) return;
    out.push({ t: new Date(ts * 1000).toISOString().slice(0, 10), ts, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  return out;
}

// Rebuild completed UTC days that the daily feed has not filled yet from hourly candles.
// Hourly volumes do not add up to Yahoo's daily volume, so the rebuilt day's volume is set to the
// 50-day average: it then never counts as a "big volume" day for the volume agent.
export function patchMissingDays(daily, hourly, todayUTC) {
  const have = new Set(daily.map(b => b.t));
  const byDay = {};
  for (const h of hourly) {
    if (h.t >= todayUTC || have.has(h.t)) continue;
    const b = byDay[h.t];
    if (!b) byDay[h.t] = { t: h.t, o: h.o, h: h.h, l: h.l, c: h.c, n: 1 };
    else { b.h = Math.max(b.h, h.h); b.l = Math.min(b.l, h.l); b.c = h.c; b.n++; }
  }
  const added = Object.values(byDay).filter(b => b.n >= 20); // need most of the day's hours
  if (!added.length) return { bars: daily, rebuilt: [] };
  const last50 = daily.slice(-50);
  const avgV = last50.reduce((s, b) => s + b.v, 0) / Math.max(1, last50.length);
  const bars = [...daily, ...added.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: avgV, rebuilt: true }))].sort((a, b) => (a.t < b.t ? -1 : 1));
  return { bars, rebuilt: added.map(b => b.t) };
}

async function resolveSymbol(u) {
  // Yahoo search: plain ticker first, then "TICKER-USD", then the coin's name (finds e.g. ARB11841-USD for Arbitrum)
  const found = [];
  for (const q of [u.ticker, `${u.ticker}-USD`, `${u.name} USD`, u.name]) {
    const s = await yjson(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0`);
    for (const x of s?.quotes || []) {
      if (x.quoteType === 'CRYPTOCURRENCY' && /-USD$/.test(x.symbol) && x.symbol.startsWith(u.ticker) && !found.includes(x.symbol)) found.push(x.symbol);
    }
  }
  return found;
}

// Keep a coin only if Yahoo's last close is within 25% of CoinGecko's live price
// (guards against a Yahoo symbol that belongs to a different token).
const priceOk = (bars, cgPrice) => bars.length && (!cgPrice || Math.abs(bars[bars.length - 1].c / cgPrice - 1) <= 0.25);

export async function cryptoHistory(universe, { log = console.log, concurrency = 3 } = {}) {
  const todayUTC = new Date().toISOString().slice(0, 10);
  const out = {}, notes = { renamed: [], dropped: [], rebuilt: 0 };
  let idx = 0;
  async function worker() {
    while (idx < universe.length) {
      const u = universe[idx++];
      try {
        const candidates = [u.yahoo];
        let daily = parseChart(await yjson(`/v8/finance/chart/${u.yahoo}?range=2y&interval=1d`));
        if (!priceOk(daily, u.cgPrice)) {
          daily = [];
          for (const sym of await resolveSymbol(u)) {
            if (candidates.includes(sym)) continue;
            candidates.push(sym);
            const d = parseChart(await yjson(`/v8/finance/chart/${sym}?range=2y&interval=1d`));
            if (priceOk(d, u.cgPrice)) { daily = d; u.yahoo = sym; notes.renamed.push(`${u.ticker}→${sym}`); break; }
          }
        }
        if (!daily.length) { notes.dropped.push(u.ticker); continue; }
        daily = daily.filter(b => b.t < todayUTC); // today's candle is still open
        const hourly = parseChart(await yjson(`/v8/finance/chart/${u.yahoo}?range=5d&interval=1h`));
        const p = patchMissingDays(daily, hourly, todayUTC);
        if (p.rebuilt.length) notes.rebuilt++;
        out[u.ticker] = p.bars.map(({ ts, ...b }) => b);
      } catch (e) { notes.dropped.push(u.ticker); log(`  ${u.ticker}: ${e.message}`); }
      await sleep(200);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (notes.renamed.length) log(`  numbered Yahoo symbols used: ${notes.renamed.join(', ')}`);
  if (notes.dropped.length) log(`  no matching Yahoo data for: ${notes.dropped.join(', ')}`);
  if (notes.rebuilt) log(`  ${notes.rebuilt} coin(s) had yesterday's candle rebuilt from hourly data`);
  return { history: out, notes };
}
