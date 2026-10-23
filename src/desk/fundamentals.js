// Agent Desk — Financial-report decoder (Fundamentals agent).
//
// Reads the XBRL numbers a US company files with the SEC (10-Q quarterly and 10-K annual
// reports, via the free data.sec.gov "companyfacts" API), rebuilds clean quarterly
// figures (Q4 is derived as annual minus the first nine months), and decodes them into
// plain-English findings plus a 0-100 health score and A-F grade.
//
// decodeFacts() is pure (testable with a saved filing); fetchFundamentals() does the I/O.

const TAGS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet', 'SalesRevenueGoodsNet', 'RevenuesNetOfInterestExpense', 'TotalRevenuesAndOtherIncome'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'],
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  currentAssets: ['AssetsCurrent'],
  currentLiabilities: ['LiabilitiesCurrent'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash'],
  longDebt: ['LongTermDebtNoncurrent', 'LongTermDebt', 'LongTermDebtAndCapitalLeaseObligations'],
  shortDebt: ['LongTermDebtCurrent', 'DebtCurrent', 'ShortTermBorrowings'],
};
const DAY = 864e5;
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY + 1;

// all usable facts for one concept, latest filing wins for each period
function facts(gaap, tag, unitPrefer) {
  const c = gaap?.[tag];
  if (!c) return [];
  const unitKey = Object.keys(c.units || {}).find(u => u === unitPrefer) || Object.keys(c.units || {})[0];
  const seen = new Map();
  for (const f of c.units[unitKey] || []) {
    if (!/^10-[QK]/.test(f.form || '')) continue;
    const key = (f.start || '') + '|' + f.end;
    const prev = seen.get(key);
    if (!prev || (f.filed || '') > (prev.filed || '')) seen.set(key, f);
  }
  return [...seen.values()];
}

// Discrete quarters (end date -> value) from 3-month, year-to-date and annual facts.
export function quarterSeries(list) {
  const q = new Map(), cum = []; // cum = every duration fact (3-month, year-to-date, annual)
  for (const f of list) {
    if (!f.start) continue;
    const d = days(f.start, f.end);
    if (d < 80 || d > 380) continue;
    cum.push({ start: f.start, end: f.end, val: f.val, d });
    if (d <= 100) q.set(f.end, f.val);
  }
  cum.sort((a, b) => a.end.localeCompare(b.end) || a.d - b.d);
  // derive missing quarters, repeating until nothing changes:
  //   year-to-date(end) - year-to-date(the quarter before, same fiscal-year start), or
  //   annual - the three quarters inside it
  for (let changed = true; changed;) {
    changed = false;
    for (const f of cum) {
      if (q.has(f.end) || f.d <= 100) continue;
      const prior = cum.filter(g => g.start === f.start && g.end < f.end).sort((a, b) => b.end.localeCompare(a.end))[0];
      if (prior && days(prior.end, f.end) >= 80 && days(prior.end, f.end) <= 101) { q.set(f.end, f.val - prior.val); changed = true; continue; }
      if (f.d >= 350) {
        const inside = [...q.entries()].filter(([e]) => e > f.start && e < f.end);
        if (inside.length === 3) { q.set(f.end, f.val - inside.reduce((s, [, v]) => s + v, 0)); changed = true; }
      }
    }
  }
  return [...q.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([end, val]) => ({ end, val }));
}

function pickFlow(gaap, names, unit = 'USD') {
  // Companies switch labels over the years (and sometimes between quarters), so start from the
  // label with the most recent quarter and fill any missing quarters from the other labels.
  const series = names.map(t => quarterSeries(facts(gaap, t, unit))).filter(s => s.length)
    .sort((a, b) => b.at(-1).end.localeCompare(a.at(-1).end) || b.length - a.length);
  const merged = new Map();
  for (const s of series) for (const x of s) if (!merged.has(x.end)) merged.set(x.end, x.val);
  return [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([end, val]) => ({ end, val }));
}
function pickStock(gaap, names, unit = 'USD') {
  let best = null;
  for (const t of names) {
    const f = facts(gaap, t, unit).filter(x => !x.start).sort((a, b) => a.end.localeCompare(b.end));
    if (f.length && (!best || f.at(-1).end > best.at(-1).end)) best = f;
  }
  return best || [];
}
// sum of the last 4 consecutive quarters ending at series[idx]
function ttmAt(s, idx) {
  if (idx < 3) return null;
  const w = s.slice(idx - 3, idx + 1);
  if (days(w[0].end, w[3].end) > 300) return null;
  return w.reduce((a, x) => a + x.val, 0);
}
const ttm = s => ttmAt(s, s.length - 1);
const ttmYearAgo = s => {
  if (s.length < 5) return null;
  const last = s.at(-1).end, target = Date.parse(last) - 365 * DAY;
  const idx = s.findIndex(x => Math.abs(Date.parse(x.end) - target) < 20 * DAY);
  return idx >= 0 ? ttmAt(s, idx) : null;
};
const qYoY = s => {
  if (s.length < 5) return null;
  const last = s.at(-1), target = Date.parse(last.end) - 365 * DAY;
  const prev = s.find(x => Math.abs(Date.parse(x.end) - target) < 20 * DAY);
  return prev && prev.val !== 0 ? (last.val - prev.val) / Math.abs(prev.val) : null;
};
const growth = (a, b) => (a != null && b != null && b !== 0 ? (a - b) / Math.abs(b) : null);
const pct = x => (x == null ? 'n/a' : (x >= 0 ? '+' : '') + (x * 100).toFixed(1) + '%');
const money = x => {
  if (x == null) return 'n/a';
  const a = Math.abs(x), s = x < 0 ? '-' : '';
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(0)}M` : `${s}$${a.toFixed(0)}`;
};

export function decodeFacts(cf, { sector = '' } = {}) {
  const gaap = cf?.facts?.['us-gaap'];
  if (!gaap) return { ok: false, note: 'No US-GAAP figures in the SEC filings (foreign filer, fund or trust).' };
  const rev = pickFlow(gaap, TAGS.revenue), ni = pickFlow(gaap, TAGS.netIncome), gp = pickFlow(gaap, TAGS.grossProfit), op = pickFlow(gaap, TAGS.operatingIncome);
  const eps = pickFlow(gaap, TAGS.eps, 'USD/shares'), ocf = pickFlow(gaap, TAGS.ocf), capex = pickFlow(gaap, TAGS.capex);
  const last = k => pickStock(gaap, TAGS[k]).at(-1)?.val ?? null;
  const shares = facts(cf.facts?.dei, 'EntityCommonStockSharesOutstanding', 'shares').filter(f => f.end).sort((a, b) => a.end.localeCompare(b.end));
  const sharesNow = shares.at(-1)?.val ?? null;
  const sharesYA = sharesNow != null ? shares.filter(f => Date.parse(f.end) <= Date.parse(shares.at(-1).end) - 330 * DAY).at(-1)?.val ?? null : null;

  const revT = ttm(rev), niT = ttm(ni), gpT = ttm(gp), opT = ttm(op), epsT = ttm(eps), ocfT = ttm(ocf), capT = ttm(capex);
  const m = {
    periodEnd: rev.at(-1)?.end || ni.at(-1)?.end || null,
    revenueTTM: revT, revenueGrowth: growth(revT, ttmYearAgo(rev)) ?? qYoY(rev), revenueQoQYoY: qYoY(rev),
    netIncomeTTM: niT, epsTTM: epsT, epsGrowth: growth(epsT, ttmYearAgo(eps)) ?? qYoY(eps), epsQYoY: qYoY(eps),
    grossMargin: revT && gpT != null ? gpT / revT : null, operatingMargin: revT && opT != null ? opT / revT : null,
    netMargin: revT && niT != null ? niT / revT : null,
    fcfTTM: ocfT != null ? ocfT - (capT || 0) : null, ocfTTM: ocfT,
    cash: last('cash'), debt: (last('longDebt') || 0) + (last('shortDebt') || 0),
    equity: last('equity'), assets: last('assets'), liabilities: last('liabilities'),
    currentRatio: last('currentAssets') && last('currentLiabilities') ? last('currentAssets') / last('currentLiabilities') : null,
    shareChange: growth(sharesNow, sharesYA),
  };
  m.debtToEquity = m.equity > 0 ? m.debt / m.equity : null;
  m.roe = m.equity > 0 && niT != null ? niT / m.equity : null;
  if (![revT, niT, ocfT, m.equity].some(v => v != null)) return { ok: false, note: 'SEC filings found, but not enough standard figures to decode.', metrics: m };
  return { ok: true, entity: cf.entityName, ...scoreMetrics(m, { sector }) };
}

// Turn decoded figures into plain-English checks, a 0-100 score and an A-F grade.
// Kept separate so the cache stores only numbers and the wording can improve later.
export function scoreMetrics(m, { sector = '' } = {}) {
  // banks and insurers: deposits and borrowing are the business, so cash-flow and debt checks mislead
  const financial = /financ|bank|insur/i.test(sector);
  const revT = m.revenueTTM, niT = m.netIncomeTTM;

  // ---- score: 7 checks, each 0..1 ----
  const checks = [];
  const add = (name, score, good, bad, value) => checks.push({ name, score: Math.max(0, Math.min(1, score)), text: score >= 0.5 ? good : bad, value });
  if (m.revenueGrowth != null) add('Sales growth', 0.5 + m.revenueGrowth * 2.5, `Sales are growing: ${pct(m.revenueGrowth)} year on year (${money(revT)} over the last 12 months).`, `Sales are ${m.revenueGrowth < 0 ? 'shrinking' : 'barely growing'}: ${pct(m.revenueGrowth)} year on year (${money(revT)} over the last 12 months).`, pct(m.revenueGrowth));
  if (m.netMargin != null) add('Profitability', m.netMargin <= 0 ? 0 : 0.4 + m.netMargin * 3, `Profitable: keeps ${(m.netMargin * 100).toFixed(0)} cents of profit from every $1 of sales.`, m.netMargin <= 0 ? `Loss-making: lost ${money(-niT)} over the last 12 months.` : `Thin profit: only ${(m.netMargin * 100).toFixed(1)} cents from every $1 of sales.`, pct(m.netMargin));
  if (m.epsGrowth != null) {
    if (m.epsTTM != null && m.epsTTM < 0) add('Earnings growth', m.epsGrowth > 0 ? 0.35 : 0.05, '', m.epsGrowth > 0 ? `Still losing money per share (EPS ${m.epsTTM.toFixed(2)} over 12 months), though the loss narrowed ${pct(m.epsGrowth)} year on year.` : `Losses per share widened ${pct(-Math.abs(m.epsGrowth))} year on year (EPS ${m.epsTTM.toFixed(2)}).`, pct(m.epsGrowth));
    else add('Earnings growth', 0.5 + m.epsGrowth * 1.5, `Earnings per share rose ${pct(m.epsGrowth)} year on year (EPS ${m.epsTTM?.toFixed(2)}).`, `Earnings per share fell ${pct(m.epsGrowth)} year on year (EPS ${m.epsTTM?.toFixed(2)}).`, pct(m.epsGrowth));
  }
  if (m.fcfTTM != null && !financial) add('Cash generation', m.fcfTTM > 0 ? 0.6 + (revT ? Math.min(0.4, (m.fcfTTM / revT) * 2) : 0.2) : 0.1, `Generates real cash: ${money(m.fcfTTM)} free cash flow after investment over 12 months.`, `Burns cash: free cash flow was ${money(m.fcfTTM)} over 12 months.`, money(m.fcfTTM));
  if (!financial && (m.debtToEquity != null || (m.equity != null && m.equity <= 0))) {
    const de = m.equity <= 0 ? 9 : m.debtToEquity;
    add('Debt load', 1 - de / 2.5, `Manageable debt: ${de.toFixed(2)}× equity${m.cash ? `, with ${money(m.cash)} cash` : ''}.`, m.equity <= 0 ? 'Shareholders\' equity is negative (liabilities exceed assets) — check why (buybacks or losses).' : `Heavy debt: ${de.toFixed(2)}× equity.`, m.equity <= 0 ? 'neg. equity' : de.toFixed(2) + '×');
  }
  if (m.currentRatio != null) add('Short-term safety', (m.currentRatio - 0.6) / 1.2, `Can cover bills due within a year: current ratio ${m.currentRatio.toFixed(2)}.`, `Tight short-term cash: current ratio ${m.currentRatio.toFixed(2)} (below 1 means short-term debts exceed short-term assets).`, m.currentRatio.toFixed(2));
  if (m.shareChange != null) add('Share count', 1 - Math.max(0, m.shareChange) * 12, m.shareChange <= 0 ? `Share count ${m.shareChange < -0.005 ? 'shrinking (buybacks)' : 'stable'}: ${pct(m.shareChange)} in a year.` : `Mild dilution: shares outstanding ${pct(m.shareChange)} in a year.`, `Dilution: ${pct(m.shareChange)} more shares in a year, so each share owns less.`, pct(m.shareChange));
  if (!checks.length) return { score: null, grade: null, checks, flags: [], summary: 'Not enough figures to grade.', metrics: m };
  const score = Math.round((checks.reduce((a, c) => a + c.score, 0) / checks.length) * 100);
  const grade = score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : score >= 35 ? 'D' : 'F';
  const flags = checks.filter(c => c.score < 0.3).map(c => c.name);
  return { score, grade, metrics: m, checks, flags,
    summary: `${grade} (${score}/100). ` + (checks.filter(c => c.score >= 0.5).map(c => c.name).join(', ') || 'No clear strengths') + (flags.length ? `; weak: ${flags.join(', ')}` : '') + '.' };
}

// Latest 10-Q/10-K filing date and an estimate of the next report (~3 months later).
export function filingDates(submissions) {
  const r = submissions?.filings?.recent;
  if (!r) return null;
  for (let i = 0; i < r.form.length; i++) {
    if (r.form[i] === '10-Q' || r.form[i] === '10-K') {
      const filed = r.filingDate[i], next = new Date(Date.parse(filed) + 91 * DAY).toISOString().slice(0, 10);
      return { lastForm: r.form[i], lastFiled: filed, reportDate: r.reportDate[i], nextReportEst: next };
    }
  }
  return null;
}

// ---------- I/O (Node 18+ / GitHub Actions) ----------
// The SEC asks every script to identify itself with a name and contact e-mail:
// set the repository variable SEC_USER_AGENT, e.g. "Your Name you@example.com".
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function secJSON(url, ua) {
  for (let k = 0; k < 3; k++) {
    const res = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate' } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    await sleep(1500 * (k + 1));
  }
  throw new Error(`SEC ${url} failed`);
}

export async function loadCikMap(ua) {
  const j = await secJSON('https://www.sec.gov/files/company_tickers.json', ua);
  const map = {};
  for (const r of Object.values(j || {})) map[r.ticker.toUpperCase().replace('-', '.')] = String(r.cik_str).padStart(10, '0');
  return map;
}

// Refreshes stale entries of `cache` ({ TICKER: {at, ...decoded} }) in place.
export async function refreshFundamentals(tickers, cache, { ua, maxFetch = 700, staleDays = 7, sectors = {}, log = console.log } = {}) {
  if (!ua) { log('  fundamentals: SEC_USER_AGENT not set — skipping SEC download (set it in repo Settings → Variables)'); return { fetched: 0 }; }
  const cik = await loadCikMap(ua);
  // spread refreshes over the week: each ticker's own stale age is 5-9 days
  const age = t => (cache[t]?.at ? (Date.now() - Date.parse(cache[t].at)) / DAY : Infinity);
  const jitter = t => 5 + ([...t].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 5);
  const todo = tickers.filter(t => cik[t] && age(t) > Math.min(staleDays, jitter(t))).slice(0, maxFetch);
  log(`  fundamentals: ${todo.length} of ${tickers.length} to refresh from SEC EDGAR`);
  let n = 0;
  for (const t of todo) {
    try {
      const [cf, sub] = await Promise.all([
        secJSON(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik[t]}.json`, ua),
        secJSON(`https://data.sec.gov/submissions/CIK${cik[t]}.json`, ua),
      ]);
      const d = cf ? decodeFacts(cf, { sector: sectors?.[t] }) : { ok: false, note: 'No XBRL financial data on file at the SEC.' };
      cache[t] = { at: new Date().toISOString(), cik: cik[t], ok: d.ok, entity: d.entity, note: d.note, metrics: d.metrics, filing: filingDates(sub) }; // numbers only; graded on use
    } catch (e) { log(`  fundamentals: ${t} ${e.message}`); }
    if (++n % 50 === 0) log(`  fundamentals: ${n}/${todo.length}`);
    await sleep(250); // two requests per ticker, well under the SEC's 10 requests/second
  }
  for (const t of tickers) if (!cik[t] && !cache[t]) cache[t] = { at: new Date().toISOString(), ok: false, note: 'Not found in the SEC company list (ETF, foreign listing or recent ticker change).' };
  return { fetched: n };
}
