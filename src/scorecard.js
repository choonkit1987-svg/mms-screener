// Live scorecard: every pick the dashboard shows is recorded on the day it appears, then followed with
// the real daily bars that come afterwards, using the same rules as the backtest:
//   * the order is a buy-stop (long) / sell-stop (short) valid for 15 trading days; not reached -> "expired" (0 R)
//   * once filled: stop loss = -1 R, target = +2 R; when price reaches 1:1.5 the stop moves to entry ("breakeven", 0 R)
//   * still open after 40 trading days -> "timeout", valued at that day's close
// The result is recomputed from the bars on every run, so it is the same whichever day you look.
import fs from 'node:fs';
import path from 'node:path';

export const SC_RULES = { fillDays: 15, maxDays: 40 };
const OPEN = new Set(['waiting', 'open']);

// Follow one recorded pick through the bars that came after its signal day.
export function evaluate(e, bars, rules = SC_RULES) {
  const after = (bars || []).filter(b => b.t > e.d);
  const long = e.side === 'long', risk = Math.abs(e.e - e.s);
  const out = { ...e, status: 'waiting', fd: null, fp: null, xd: null, R: null, days: after.length };
  delete out.live;
  const R = px => +((long ? px - out.fp : out.fp - px) / risk).toFixed(2);
  let f = -1;
  for (let i = 0; i < Math.min(after.length, rules.fillDays); i++) {
    const b = after[i];
    if (long ? b.h >= e.e : b.l <= e.e) { f = i; out.fd = b.t; out.fp = long ? Math.max(b.o, e.e) : Math.min(b.o, e.e); break; }
  }
  if (f < 0) {
    if (after.length >= rules.fillDays) { out.status = 'expired'; out.R = 0; out.xd = after[rules.fillDays - 1].t; }
    return out;
  }
  out.status = 'open';
  let stop = e.s, armed = false;
  for (let i = f; i < after.length; i++) {
    const b = after[i];
    if (long ? b.l <= stop : b.h >= stop) {
      out.status = armed ? 'breakeven' : 'stop'; out.xd = b.t; out.R = R(stop); return out;
    }
    if (long ? b.h >= e.tg : b.l <= e.tg) { out.status = 'target'; out.xd = b.t; out.R = R(e.tg); return out; }
    if (!armed && (long ? b.h >= e.be : b.l <= e.be)) armed = true;
    if (armed) stop = e.e; // from the next bar on
    if (i - f + 1 >= rules.maxDays) { out.status = 'timeout'; out.xd = b.t; out.R = R(b.c); return out; }
  }
  out.R = R(after.at(-1).c); // open trade: current value, not counted as closed
  out.live = true;
  return out;
}

export function summarize(entries) {
  const count = s => entries.filter(e => e.status === s).length;
  const closed = entries.filter(e => ['target', 'stop', 'breakeven', 'timeout'].includes(e.status));
  const resolved = entries.filter(e => !OPEN.has(e.status)); // includes expired (0 R)
  const filled = entries.filter(e => e.fd);
  const sum = a => a.reduce((x, e) => x + (e.R || 0), 0);
  return {
    signals: entries.length, waiting: count('waiting'), open: count('open'), expired: count('expired'),
    target: count('target'), stop: count('stop'), breakeven: count('breakeven'), timeout: count('timeout'),
    filled: filled.length, closed: closed.length,
    hitRate: closed.length ? +(count('target') / closed.length).toFixed(3) : null,
    avgR: closed.length ? +(sum(closed) / closed.length).toFixed(3) : null,
    rPer100: resolved.length ? +(100 * sum(resolved) / resolved.length).toFixed(1) : null,
    since: entries.map(e => e.d).sort()[0] || null,
  };
}

// Add today's picks, re-evaluate everything, save scorecard.json and return what the page shows.
export function updateScorecard(dataDir, report, history, { recentN = 40 } = {}) {
  const file = path.join(dataDir, 'scorecard.json');
  const book = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { market: report.market, entries: [] };
  const picks = [...(report.up || []).map(p => [p, 'long']), ...(report.down || []).map(p => [p, 'short']),
    ...(report.earlyUp || []).map(p => [p, 'long']), ...(report.earlyDown || []).map(p => [p, 'short'])]
    .filter(([p]) => (p.tier === 'setup' || p.tier === 'early') && p.risk);
  for (const [p, side] of picks) {
    const busy = book.entries.some(e => e.t === p.ticker && e.side === side && (OPEN.has(e.status) || e.d === p.asOf));
    if (busy) continue;
    const r = p.risk, x = v => +(+v).toPrecision(6);
    book.entries.push({ id: `${p.asOf}:${p.ticker}:${side}`, d: p.asOf, t: p.ticker, n: p.name || '', side, tier: p.tier,
      e: x(r.entry), s: x(r.stop), tg: x(r.target), be: x(r.breakeven), score: p.score?.total ?? null, status: 'waiting' });
  }
  book.entries = book.entries.map(e => (history[e.t] ? evaluate(e, history[e.t]) : e)); // no fresh bars today: keep last state
  book.updated = report.asOf;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(book));
  const byTier = t => summarize(book.entries.filter(e => e.tier === t));
  return {
    summary: summarize(book.entries), setup: byTier('setup'), early: byTier('early'), rules: SC_RULES,
    recent: [...book.entries].sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)).slice(0, recentN)
      .map(({ id, ...e }) => e),
  };
}
