// Agent Desk — per-ticker agent pipeline (pure functions, no I/O).
//
//   Filter agent  ->  Fundamentals agent (SEC decode, stocks only)  ->  Technical agent (2-week call)
//   ->  Bull & Bear researchers + Research manager  ->  Risk team (Aggressive / Neutral / Conservative)
//   ->  Portfolio manager (Buy / Overweight / Hold / Underweight / Sell)
//
// Mirrors the roles of the TradingAgents pipeline, but every agent here is a rule or a
// trained model, so the same input always gives the same answer and every call can be
// checked against history. The optional AI chat on the dashboard reads these outputs.
import { indicatorSet } from './indicators.js';
import { featureRow, predict, contributions } from './forecast.js';

export const DESK = {
  us: { unit: 'stock', h: 10, minPrice: 5, minDollarVol: 20e6, minBars: 260, risk: { aggressive: 0.02, neutral: 0.01, conservative: 0.005 }, cap: { aggressive: 0.25, neutral: 0.15, conservative: 0.08 }, stopAtr: 1.5, rr: 2, annual: 252, bench: 'S&P 500 (SPY)' },
  crypto: { unit: 'coin', h: 14, volumeInQuote: true, minPrice: 0, minDollarVol: 10e6, minBars: 260, risk: { aggressive: 0.015, neutral: 0.0075, conservative: 0.004 }, cap: { aggressive: 0.15, neutral: 0.08, conservative: 0.04 }, stopAtr: 1.5, rr: 2, annual: 365, bench: 'Bitcoin' },
};

const f2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const pct = (x, d = 1) => (x == null ? 'n/a' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%');
export const fmtP = x => (x == null ? 'n/a' : x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(3) : x.toPrecision(4));

// ---------- Filter agent ----------
export function filterAgent(bars, ind, cfg, lastDate) {
  const n = bars.length, i = n - 1, reasons = [];
  if (n < cfg.minBars) reasons.push(`only ${n} days of history (needs ${cfg.minBars})`);
  const c = bars[i].c, dv = ind.vol50[i] != null ? ind.vol50[i] * (cfg.volumeInQuote ? 1 : c) : 0;
  if (c < cfg.minPrice) reasons.push(`price ${fmtP(c)} is below $${cfg.minPrice}`);
  if (dv < cfg.minDollarVol) reasons.push(`trades only $${(dv / 1e6).toFixed(1)}M a day (needs $${cfg.minDollarVol / 1e6}M)`);
  if (lastDate && (Date.parse(lastDate) - Date.parse(bars[i].t)) / 864e5 > 5) reasons.push(`no trades since ${bars[i].t}`);
  return { passed: reasons.length === 0, reasons, dollarVol: dv };
}

// ---------- Technical agent ----------
// models = { rel: {model, margin}, abs: {model, margin} } (see forecast.js)
export function technicalAgent(bars, ind, models, bench, cfg) {
  const n = bars.length, i = n - 1, c = ind.c[i];
  const x = featureRow(bars, ind, i, bench);
  if (!x || !models?.rel) return null;
  const p = predict(models.rel.model, x);                       // chance to beat the average name
  const pAbs = models.abs ? predict(models.abs.model, x) : null; // chance the price itself is higher
  const margin = models.rel.margin;
  const call = p >= 0.5 + margin ? 'Uptrend' : p <= 0.5 - margin ? 'Downtrend' : 'No clear trend';
  // realised volatility -> 1-sigma 2-week range
  let s = 0, k = 0;
  for (let j = Math.max(1, i - 19); j <= i; j++) { const r = Math.log(ind.c[j] / ind.c[j - 1]); s += r * r; k++; }
  const dailyVol = Math.sqrt(s / Math.max(1, k)), move = dailyVol * Math.sqrt(cfg.h);
  const m = ind.macd, rsi = ind.rsi[i], pb = (c - ind.boll.lb[i]) / ((ind.boll.ub[i] - ind.boll.lb[i]) || 1);
  const readings = [
    ['Trend', c > ind.sma50[i] && ind.sma50[i] > ind.sma200[i] ? 'up' : c < ind.sma50[i] && ind.sma50[i] < ind.sma200[i] ? 'down' : 'mixed',
      `Price ${fmtP(c)} is ${c > ind.sma50[i] ? 'above' : 'below'} the 50-day (${fmtP(ind.sma50[i])}) and ${c > ind.sma200[i] ? 'above' : 'below'} the 200-day (${fmtP(ind.sma200[i])}) average; 50-day is ${ind.sma50[i] > ind.sma200[i] ? 'above' : 'below'} the 200-day (${ind.sma50[i] > ind.sma200[i] ? 'golden' : 'death'}-cross side).`],
    ['MACD', m.line[i] > m.signal[i] ? 'up' : 'down',
      `MACD ${m.line[i] > m.signal[i] ? 'above' : 'below'} its signal line; histogram ${m.hist[i] > m.hist[i - 1] ? 'rising' : 'falling'} (${m.hist[i] > 0 ? 'positive' : 'negative'}).`],
    ['RSI', rsi > 70 ? 'hot' : rsi < 30 ? 'cold' : rsi >= 50 ? 'up' : 'down',
      `RSI ${rsi.toFixed(0)} — ${rsi > 70 ? 'overbought, pullback risk' : rsi < 30 ? 'oversold, bounce possible' : rsi >= 50 ? 'buyers in control' : 'sellers in control'}.`],
    ['Bollinger', pb > 1 ? 'hot' : pb < 0 ? 'cold' : pb >= 0.5 ? 'up' : 'down',
      `Price sits at ${(pb * 100).toFixed(0)}% of the Bollinger band (0% = lower, 100% = upper)${pb > 1 ? ' — riding above the upper band' : pb < 0 ? ' — below the lower band' : ''}.`],
    // direction comes from where the volume went (VWMA vs plain average); activity level is context only
    ['Volume', ind.vwma[i] > ind.sma20[i] * 1.002 ? 'up' : ind.vwma[i] < ind.sma20[i] * 0.998 ? 'down' : 'mixed',
      `${ind.vwma[i] > ind.sma20[i] ? 'Heavier volume on up days' : 'Heavier volume on down days'} (volume-weighted average ${ind.vwma[i] > ind.sma20[i] ? 'above' : 'below'} the plain 20-day average); trading activity is ${pct(ind.vol20[i] / ind.vol50[i] - 1, 0)} vs its 50-day norm.`],
    ['Volatility', null, `ATR ${(ind.atr[i] / c * 100).toFixed(1)}% a day; a typical 2-week move is about ±${(move * 100).toFixed(1)}%.`],
  ];
  const drivers = contributions(models.rel.model, x).slice(0, 5).map(d => ({ label: d.label, dir: d.v > 0 ? 'up' : 'down', w: f2(d.v) }));
  return { p: f2(p), pAbs: f2(pAbs), call, confidence: f2(Math.abs(p - 0.5) * 2), margin: f2(margin), absMargin: f2(models.abs?.margin), move: f2(move), atr: ind.atr[i], atrPct: f2(ind.atr[i] / c),
    rsi: f2(rsi), readings, drivers, low: c * (1 - move), high: c * (1 + move) };
}

// ---------- Risk team ----------
export function riskAgent(bars, ind, tech, fund, benchBars, cfg, mms) {
  const n = bars.length, i = n - 1, c = ind.c[i];
  const rets = [];
  for (let j = Math.max(1, n - 120); j < n; j++) rets.push(ind.c[j] / ind.c[j - 1] - 1);
  const sd = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / Math.max(1, rets.length));
  const annVol = sd * Math.sqrt(cfg.annual);
  let peak = 0, dd = 0;
  for (let j = Math.max(0, n - 252); j < n; j++) { peak = Math.max(peak, ind.c[j]); dd = Math.min(dd, ind.c[j] / peak - 1); }
  // beta vs the benchmark over 120 bars
  let beta = null;
  if (benchBars?.length > 130) {
    const bm = new Map(benchBars.map((b, j) => [b.t, j])), xs = [], ys = [];
    for (let j = Math.max(1, n - 120); j < n; j++) {
      const k = bm.get(bars[j].t), k0 = bm.get(bars[j - 1].t);
      if (k == null || k0 == null) continue;
      xs.push(benchBars[k].c / benchBars[k0].c - 1); ys.push(ind.c[j] / ind.c[j - 1] - 1);
    }
    if (xs.length > 60) {
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
      let cov = 0, vx = 0;
      for (let j = 0; j < xs.length; j++) { cov += (xs[j] - mx) * (ys[j] - my); vx += (xs[j] - mx) ** 2; }
      beta = vx ? cov / vx : null;
    }
  }
  const flags = [];
  const nextReport = fund?.filing?.nextReportEst;
  const daysToReport = nextReport ? Math.round((Date.parse(nextReport) - Date.parse(bars[i].t)) / 864e5) : null;
  const eventRisk = daysToReport != null && daysToReport >= -7 && daysToReport <= Math.round(cfg.h * 1.5);
  if (eventRisk) flags.push(`Earnings report likely within the 2-week window (around ${nextReport}, estimated from the last filing) — prices can gap past stops.`);
  if (annVol > (cfg.annual === 365 ? 1.0 : 0.55)) flags.push(`High volatility: ${(annVol * 100).toFixed(0)}% a year.`);
  if (dd < -0.35) flags.push(`Fell ${Math.round(-dd * 100)}% from its 1-year peak at the worst point.`);
  if (beta != null && beta > 1.6) flags.push(`Moves ${beta.toFixed(1)}× as much as the ${cfg.bench}.`);
  if (tech?.rsi > 75 && tech.call === 'Uptrend') flags.push('RSI above 75: chasing an overbought move.');
  if (tech?.rsi < 25 && tech.call === 'Downtrend') flags.push('RSI below 25: shorting into an oversold market risks a sharp bounce.');
  for (const f of fund?.flags || []) flags.push(`Weak fundamentals: ${f.toLowerCase()}.`);
  // 0-100 risk score
  const volScore = Math.min(1, annVol / (cfg.annual === 365 ? 1.4 : 0.8));
  const score = Math.round(100 * Math.min(1, 0.45 * volScore + 0.2 * Math.min(1, -dd / 0.6) + 0.15 * (beta != null ? Math.min(1, Math.max(0, beta - 0.5) / 1.5) : 0.5) + (eventRisk ? 0.15 : 0) + Math.min(0.15, (fund?.flags?.length || 0) * 0.05)));
  const level = score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low';

  // trade plan for the 2-week call: MMS levels when its setup points the same way, else ATR-based
  let plan = null;
  const side = tech?.call === 'Uptrend' ? 'long' : tech?.call === 'Downtrend' ? 'short' : null;
  if (side) {
    const mmsSame = mms && mms.valid && mms.lv && mms.side === side;
    const entry = mmsSame ? mms.lv.e : c;
    const stop = mmsSame ? mms.lv.s : side === 'long' ? c - cfg.stopAtr * tech.atr : c + cfg.stopAtr * tech.atr;
    const R = Math.abs(entry - stop), stopPct = R / entry;
    const target = side === 'long' ? entry + cfg.rr * R : entry - cfg.rr * R;
    const be = side === 'long' ? entry + 1.5 * R : entry - 1.5 * R;
    const views = {};
    for (const who of ['aggressive', 'neutral', 'conservative']) {
      const size = Math.min(cfg.cap[who], cfg.risk[who] / stopPct);
      let take = true, why = '';
      if (who === 'neutral' && level === 'High') { take = false; why = 'risk level is High'; }
      if (who === 'conservative') {
        if (level !== 'Low' && (tech.confidence < 0.25)) { take = false; why = 'signal is not strong enough for the risk'; }
        if (level === 'High') { take = false; why = 'risk level is High'; }
        if (eventRisk) { take = false; why = 'an earnings report falls inside the window'; }
        if (side === 'short') { take = false; why = 'conservative accounts do not short'; }
      }
      views[who] = { take, size: take ? f2(size) : 0, riskPct: cfg.risk[who], why: take ? `Risk ${(cfg.risk[who] * 100).toFixed(1)}% of capital → position ${(size * 100).toFixed(1)}% of capital` : `Stand aside: ${why}` };
    }
    plan = { side, entry, stop, target, breakeven: be, stopPct: f2(stopPct), source: mmsSame ? 'MMS setup levels' : `${cfg.stopAtr}×ATR stop, 1:${cfg.rr} target`, triggered: mmsSame ? mms.status : null, views };
  }
  return { score, level, annVol: f2(annVol), maxDD: f2(dd), beta: f2(beta), dollarVol: null, eventRisk, nextReport, daysToReport, flags, plan };
}

// ---------- Bull & Bear researchers + Research manager ----------
export function researchTeam(tech, fund, risk, mms, ind, i) {
  const bull = [], bear = [];
  const add = (arr, w, text) => arr.push({ w, text });
  if (tech) {
    const abs = tech.pAbs == null ? '' : ` and a ${(tech.pAbs * 100).toFixed(0)}% chance its price is higher`;
    if (tech.p > 0.5) add(bull, Math.min(3, (tech.p - 0.5) * 20), `Model gives a ${(tech.p * 100).toFixed(0)}% chance of beating the average ${tech.unit} over 2 weeks${abs}.`);
    else add(bear, Math.min(3, (0.5 - tech.p) * 20), `Model gives only a ${(tech.p * 100).toFixed(0)}% chance of beating the average ${tech.unit} over 2 weeks${abs}.`);
    for (const [name, dir, text] of tech.readings) {
      if (dir === 'up') add(bull, 1, `${name}: ${text}`);
      else if (dir === 'down') add(bear, 1, `${name}: ${text}`);
      else if (dir === 'hot') add(bear, 0.7, `${name}: ${text}`);
      else if (dir === 'cold') add(bull, 0.7, `${name}: ${text}`);
    }
  }
  if (mms?.st === 2) add(bull, 1.5, `MMS Stage 2 uptrend (150-day average rising, price above it)${mms.valid && mms.side === 'long' ? ` with a valid ${mms.status?.toLowerCase()} contraction setup` : ''}.`);
  if (mms?.st === 4) add(bear, 1.5, `MMS Stage 4 downtrend (150-day average falling, price below it)${mms.valid && mms.side === 'short' ? ` with a valid ${mms.status?.toLowerCase()} short setup` : ''}.`);
  if (mms?.st === 3) add(bear, 0.8, 'MMS Stage 3: the uptrend is stalling (topping).');
  if (fund?.ok) {
    for (const c of fund.checks) (c.score >= 0.6 ? bull : c.score <= 0.35 ? bear : []).push({ w: 0.8, text: `${c.name}: ${c.text}` });
  }
  for (const f of risk?.flags || []) if (!/^Weak fundamentals/.test(f)) add(bear, 0.6, `Risk: ${f}`);
  bull.sort((a, b) => b.w - a.w); bear.sort((a, b) => b.w - a.w);
  const sb = bull.reduce((a, x) => a + x.w, 0), sr = bear.reduce((a, x) => a + x.w, 0);
  const lean = sb + sr ? (sb - sr) / (sb + sr) : 0;
  const verdict = lean > 0.2 ? 'Bull case is stronger' : lean < -0.2 ? 'Bear case is stronger' : 'Bull and bear cases are balanced';
  return { bull: bull.slice(0, 6), bear: bear.slice(0, 6), bullWeight: f2(sb), bearWeight: f2(sr), lean: f2(lean), verdict };
}

// ---------- Portfolio manager ----------
export function portfolioManager(tech, fund, risk, research, reliability = 1) {
  if (!tech) return { rating: 'Hold', score: 0, why: 'Not enough data for a call.' };
  let s = (tech.p - 0.5) / Math.max(0.02, tech.margin); // 1.0 = at the confidence margin
  s = Math.max(-2.5, Math.min(2.5, s));
  if (tech.pAbs != null) s += Math.max(-1, Math.min(1, (tech.pAbs - 0.5) / Math.max(0.02, tech.absMargin || 0.05))) * 0.4;
  if (fund?.ok) s += ((fund.score - 50) / 50) * 0.5;
  s += (research?.lean || 0) * 0.5;
  if (s < 0) s *= 0.6;               // 5-year tests: downtrend calls were much weaker than uptrend calls
  s *= Math.max(0.3, reliability);   // a model that failed its own tests gets little say
  if (risk?.level === 'High') s *= 0.6;
  if (risk?.eventRisk) s *= 0.8;
  let rating = s >= 1.6 ? 'Buy' : s >= 0.8 ? 'Overweight' : s <= -1.6 ? 'Sell' : s <= -0.8 ? 'Underweight' : 'Hold';
  if (risk?.level === 'High') rating = rating === 'Buy' ? 'Overweight' : rating === 'Sell' ? 'Underweight' : rating; // never full conviction on a high-risk name
  const parts = [`Technical agent: ${tech.call.toLowerCase()} (${(tech.p * 100).toFixed(0)}% chance to beat the average ${tech.unit}${tech.pAbs != null ? `, ${(tech.pAbs * 100).toFixed(0)}% chance of a higher price` : ''} in 2 weeks).`];
  if (fund?.ok) parts.push(`Fundamentals ${fund.grade} (${fund.score}/100).`);
  else if (fund) parts.push('No usable financial reports — judged on price action only.');
  parts.push(`${research.verdict}.`, `Risk ${risk.level.toLowerCase()} (${risk.score}/100)${risk.eventRisk ? ', earnings inside the window' : ''}.`);
  if (reliability < 0.5) parts.push(`Conviction cut: the ${tech.unit} model held up in only ${Math.round(reliability * 100)}% of its test periods.`);
  const action = { Buy: 'Enter long on the plan below, sized by your risk profile.', Overweight: 'Lean long: smaller size or wait for the entry trigger.', Hold: 'No edge either way: wait for a clearer signal.', Underweight: 'Lean bearish: reduce or avoid longs; shorts only for aggressive accounts.', Sell: 'Exit or avoid longs; short only with the stop below.' }[rating];
  return { rating, score: f2(s), why: parts.join(' '), action };
}

// ---------- run the whole desk for one ticker ----------
export function analyzeDesk(meta, bars, ctx) {
  const { cfg, models, bench, benchBars, fund, mms, lastDate, reliability = 1 } = ctx;
  if (!bars || bars.length < 210) return { t: meta.ticker, n: meta.name, skip: `only ${bars?.length || 0} days of price history` };
  const ind = indicatorSet(bars), i = bars.length - 1;
  const filter = filterAgent(bars, ind, cfg, lastDate);
  const tech = technicalAgent(bars, ind, models, bench, cfg);
  if (tech) tech.unit = cfg.unit;
  if (!tech) return { t: meta.ticker, n: meta.name, skip: 'indicators not ready', filter };
  const risk = riskAgent(bars, ind, tech, fund, benchBars, cfg, mms);
  risk.dollarVol = filter.dollarVol;
  const research = researchTeam(tech, fund, risk, mms, ind, i);
  const pm = portfolioManager(tech, fund, risk, research, reliability);
  return {
    t: meta.ticker, n: meta.name, sec: meta.sector, asOf: bars[i].t, close: bars[i].c,
    chg5: f2(bars[i].c / bars[i - 5].c - 1), chg21: f2(bars[i].c / bars[i - 21].c - 1),
    spark: bars.slice(-60).map(b => +b.c.toPrecision(6)),
    filter, tech, fund: fund ? compactFund(fund) : null, research, risk, pm,
    mms: mms ? { st: mms.st, head: mms.head, status: mms.status, valid: mms.valid, side: mms.side, zone: mms.zone, lv: mms.lv, score: mms.score?.total } : null,
  };
}

function compactFund(f) {
  if (!f.ok || f.score == null) return { ok: false, note: f.note || 'Not enough figures to grade.', filing: f.filing || null };
  const m = f.metrics, r = x => (x == null ? null : Math.round(x * 1e4) / 1e4);
  // the SEC's machine-readable figures can lag the filing itself by a quarter
  const lagging = f.filing?.reportDate && m.periodEnd && f.filing.reportDate > m.periodEnd;
  return { ok: true, grade: f.grade, score: f.score, summary: f.summary, flags: f.flags, filing: f.filing || null, periodEnd: m.periodEnd, lagging,
    checks: f.checks.map(c => ({ name: c.name, score: r(c.score), text: c.text, value: c.value })),
    m: { revenueTTM: m.revenueTTM, revenueGrowth: r(m.revenueGrowth), netIncomeTTM: m.netIncomeTTM, epsTTM: r(m.epsTTM), epsGrowth: r(m.epsGrowth),
      grossMargin: r(m.grossMargin), operatingMargin: r(m.operatingMargin), netMargin: r(m.netMargin), fcfTTM: m.fcfTTM, cash: m.cash, debt: m.debt,
      debtToEquity: r(m.debtToEquity), currentRatio: r(m.currentRatio), roe: r(m.roe), shareChange: r(m.shareChange) } };
}

// ---------- Ranking: top 2-week up and down calls among names that passed the filter ----------
export function rankDesk(rows, topN = 10) {
  const ok = rows.filter(r => !r.skip && r.filter?.passed);
  const up = ok.filter(r => r.tech.call === 'Uptrend').sort((a, b) => b.tech.p - a.tech.p || b.pm.score - a.pm.score).slice(0, topN);
  const down = ok.filter(r => r.tech.call === 'Downtrend').sort((a, b) => a.tech.p - b.tech.p || a.pm.score - b.pm.score).slice(0, topN);
  const count = k => ok.filter(r => r.tech.call === k).length;
  const ratings = {};
  for (const r of ok) ratings[r.pm.rating] = (ratings[r.pm.rating] || 0) + 1;
  return { up: up.map(r => r.t), down: down.map(r => r.t), passed: ok.length, total: rows.length, calls: { up: count('Uptrend'), down: count('Downtrend'), none: count('No clear trend') }, ratings };
}
