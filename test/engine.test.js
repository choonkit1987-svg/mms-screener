import assert from 'node:assert/strict';
import { analyzeTicker, rankAll, sma, zigzag, invertBars } from '../src/engine.js';

// deterministic pseudo-random
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function day(i) { const d = new Date(Date.UTC(2025, 0, 1)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); }
function fromPath(path, vol = 2e6, favourUp = true) {
  return path.map((c, i) => {
    const prev = i ? path[i - 1] : c;
    const o = prev, h = Math.max(o, c) * (1 + 0.004 * rnd()), l = Math.min(o, c) * (1 - 0.004 * rnd());
    return { t: day(i), o, h, l, c, v: vol * (0.7 + 0.6 * rnd()) * ((c > o) === favourUp ? 1.4 : 0.8) };
  });
}
// piecewise-linear price path through waypoints
function path(points) {
  const out = [];
  for (let k = 1; k < points.length; k++) {
    const [i0, p0] = points[k - 1], [i1, p1] = points[k];
    for (let i = i0; i < i1; i++) out.push(p0 + (p1 - p0) * (i - i0) / (i1 - i0) * (1 + 0.002 * (rnd() - 0.5)));
  }
  return out;
}

// 1) sma
assert.deepEqual(sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);

// 2) VCP uptrend: base 50 for 200 bars, rally to 100, then contractions 18% -> 9% -> 4%, now just under pivot
const up = fromPath(path([[0, 50], [200, 52], [300, 100], [320, 82], [345, 97], [360, 88.3], [380, 95], [392, 91.2], [400, 94]]));
const a = analyzeTicker({ ticker: 'VCP', name: 'Test VCP', sector: 'Test' }, up);
assert.equal(a.stage, 2, 'uptrend should be Stage 2');
const st = a.long.setup;
console.log('VCP contractions:', st.contractions.map(c => (c.depth * 100).toFixed(1) + '%').join(' -> '), '| status', st.status, '| valid', st.valid, st.reason, '| zone', st.zone);
assert.ok(st.count >= 3, 'should find >= 3 contractions');
assert.ok(st.contractions[0].depth > 0.15 && st.contractions[st.count - 1].depth < 0.06);
assert.equal(st.valid, true);
assert.equal(st.status, 'SETUP');
const r = a.long.risk;
assert.ok(Math.abs(r.entry - st.contractions[st.count - 1].hi * 1.01) < 1e-9, 'entry = C high + 1%');
assert.ok(Math.abs(r.stop - st.contractions[st.count - 1].lo * 0.99) < 1e-9, 'stop = C low - 1%');
assert.ok(Math.abs((r.target - r.entry) - 2 * (r.entry - r.stop)) < 1e-9, 'target 1:2');

// 3) Stage 4 downtrend with tightening rallies (bear VCP)
const dn = fromPath(path([[0, 100], [200, 98], [300, 50], [320, 60], [345, 52], [360, 56.5], [380, 53], [392, 55], [400, 53.5]]), 2e6, false);
const b = analyzeTicker({ ticker: 'BEAR', name: 'Test Bear', sector: 'Test' }, dn);
assert.equal(b.stage, 4, 'downtrend should be Stage 4');
const sb = b.short.setup;
console.log('Bear rallies:', sb.contractions.map(c => (c.depth * 100).toFixed(1) + '%').join(' -> '), '| status', sb.status, '| valid', sb.valid, sb.reason);
assert.ok(sb.count >= 2);
assert.ok(b.short.risk.entry < b.close && b.short.risk.stop > b.close, 'short entry below price, stop above');
assert.ok(b.short.risk.target < b.short.risk.entry);

// 3b) widening contractions must be rejected (L11: bands must shrink, bottoms rise)
import { tighteningCheck } from '../src/engine.js';
const mk = (ds, lows) => ds.map((d, i) => ({ depth: d, lo: lows[i] }));
assert.equal(tighteningCheck(mk([0.07, 0.10, 0.20, 0.07], [90, 91, 85, 92])).ok, false, 'C1 not widest');
assert.equal(tighteningCheck(mk([0.11, 0.08, 0.11, 0.08], [90, 92, 91, 93])).ok, false, 'widens again');
assert.equal(tighteningCheck(mk([0.20, 0.10, 0.05], [80, 85, 90])).ok, true);
assert.equal(tighteningCheck(mk([0.20, 0.10, 0.05], [80, 78, 76])).ok, false, 'lows falling');

// 4) invert round trip
const inv = invertBars(invertBars(up.slice(0, 5)));
assert.ok(Math.abs(inv[3].h - up[3].h) < 1e-9 && Math.abs(inv[3].l - up[3].l) < 1e-9);

// 5) ranking returns picks with tiers
const flat = fromPath(path([[0, 40], [400, 41]]));
const res = rankAll([a, b, analyzeTicker({ ticker: 'FLAT' }, flat)], 5);
assert.equal(res.up.top[0].a.ticker, 'VCP');
assert.equal(res.up.top[0].tier, 'setup');
assert.equal(res.down.top[0].a.ticker, 'BEAR');
console.log('stage counts', res.stageCounts, '| VCP score', res.up.top[0].s, '| BEAR score', res.down.top[0].s);
// 6) lookup records: every ticker gets a direction and levels
import { lookupTable } from '../src/engine.js';
const rows = lookupTable([a, b, analyzeTicker({ ticker: 'FLAT' }, flat), { ticker: 'SHORT', skip: 'only 100 daily bars of history' }]);
const [ru, rd, rf, rs] = rows;
assert.equal(ru.dir, 'up'); assert.equal(ru.side, 'long'); assert.match(ru.action, /Valid buy setup/);
assert.ok(ru.lv.e > ru.close && ru.lv.s < ru.close && ru.lv.tg > ru.lv.e, 'long levels: stop < price < buy-stop < target');
assert.equal(rd.dir, 'down'); assert.equal(rd.side, 'short'); assert.match(rd.action, /Valid short setup/);
assert.ok(rd.lv.e < rd.close && rd.lv.s > rd.close && rd.lv.tg < rd.lv.e, 'short levels: target < sell-stop < price < stop');
assert.equal(rf.dir, 'neutral'); assert.ok(['long', 'short'].includes(rf.side));
assert.match(rs.skip, /daily bars/);
assert.equal(ru.ch.c.length, 120); assert.equal(ru.ch.d[0], 0);
assert.ok(JSON.stringify(ru).length < 5200, 'lookup record stays compact: ' + JSON.stringify(ru).length);
console.log('lookup:', ru.t, ru.head, ru.lv, '|', rd.t, rd.head, rd.lv, '|', rf.t, rf.head, rf.action);
// 7) index member lists (Wikipedia table parser) and Bursa renaming
import { parseWikiTable } from '../src/data.js';
import { renameBursa } from '../src/run-bursa.js';
const html = '<table class="wikitable"><tr><th>Year</th><th>Close</th></tr><tr><td>2025</td><td>1</td></tr></table>'
  + '<table class="wikitable sortable" id="constituents"><tr><th>Company</th><th>Symbol<sup>[1]</sup></th><th>Sector</th></tr>'
  + '<tr><th><a href="/x">Alphabet</a><br />(Class A)</th><td><a>GOOGL</a>\n</td><td>Communication Services</td></tr>'
  + '<tr><th>Johnson &amp; Johnson</th><td>JNJ</td><td>Health Care</td></tr></table>';
const wt = parseWikiTable(html, /symbol/i);
assert.equal(wt.length, 2); assert.equal(wt[0].symbol, 'GOOGL'); assert.equal(wt[0].company, 'Alphabet (Class A)'); assert.equal(wt[1].company, 'Johnson & Johnson');
assert.throws(() => parseWikiTable(html, /stock code/i));
const rn = renameBursa([{ ticker: '1155', code: '1155', name: 'Malayan Banking Berhad' }, { ticker: '9999', code: '9999', name: 'No Meta Bhd' }],
  { 1155: [1], 9999: [2], KLCI: [3] }, { 1155: { shortName: 'MAYBANK', longName: 'Malayan Banking Berhad' } });
assert.deepEqual(rn.universe.map(u => u.ticker), ['MAYBANK', '9999']);
assert.equal(rn.universe[0].name, 'Malayan Banking Berhad (1155)');
assert.deepEqual(Object.keys(rn.history).sort(), ['9999', 'KLCI', 'MAYBANK']);
import { tidyNames } from '../src/run-china.js';
assert.deepEqual(tidyNames([{ ticker: '601059', name: 'CINDA SECURITIES' }, { ticker: '600519', name: 'Kweichow Moutai' }], { 601059: { longName: 'Cinda Securities Co., Ltd.' } }).map(u => u.name), ['Cinda Securities Co., Ltd.', 'Kweichow Moutai']);
// 8) early-turn agent: BBY on 24 Jun 2026 (Stage 1, valid C1/C2) must be flagged before it turns Stage 2 on 16 Jul
import fs from 'node:fs';
import { rankAll as rankAll2 } from '../src/engine.js';
const bbyBars = JSON.parse(fs.readFileSync(new URL('./fixtures/bby-2026.json', import.meta.url))).BBY.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }));
const upTo = d => bbyBars.filter(b => b.t <= d);
import { CONFIG } from '../src/engine.js';
const classic = { ...CONFIG, rules: 'classic' };
const bby = analyzeTicker({ ticker: 'BBY' }, upTo('2026-06-24'), classic);
assert.equal(bby.stage, 1); assert.equal(bby.early?.side, 'long'); assert.ok(bby.leanS.setup.valid);
assert.ok(Math.abs(bby.leanS.risk.entry - 77.85) < 0.05, 'BBY buy-stop ' + bby.leanS.risk.entry);
const rk = rankAll2([bby]);
assert.equal(rk.up.early.length, 1); assert.equal(rk.up.early[0].tier, 'early'); assert.equal(rk.up.top.length, 0);
assert.equal(analyzeTicker({ ticker: 'BBY' }, upTo('2026-05-27'), classic).early, undefined, 'no alert while still in Stage 4');
// 2026 rules: BBY's June dips lasted only 2 candles, so they are not qualified contractions yet
const bby2 = analyzeTicker({ ticker: 'BBY' }, upTo('2026-06-24'));
assert.equal(bby2.leanS.setup.valid, false); assert.match(bby2.leanS.setup.reason, /qualified contraction/);
assert.equal(rankAll2([bby2]).up.early.length, 0);
// 8b) 2026 contraction building blocks
import { candleType, downRun, alignedAt, lastAlignment, baseCount, contractionAgent, computeIndicators } from '../src/engine.js';
assert.equal(candleType({ o: 10, h: 11.1, l: 9.9, c: 11 }), 'up');
assert.equal(candleType({ o: 11, h: 11.1, l: 9.9, c: 10 }), 'down');
assert.equal(candleType({ o: 10, h: 11, l: 9, c: 10.2 }), 'doji', 'wicks larger than body = indecision');
const cb = (o, c, w = 0.05) => ({ o, c, h: Math.max(o, c) + w, l: Math.min(o, c) - w });
assert.equal(downRun([cb(10, 11), cb(11, 10), cb(10, 9), cb(9, 10), cb(10, 9), cb(9, 8.95, 0.5), cb(8.9, 8.5)], 0, 6), 3, 'down, indecision and down in a row = 3; an up candle resets the run');
const ind3 = { sma50: [3, 3, 1, 3, 3], sma150: [2, 2, 2, 2, 2], sma200: [1, 1, 1, 1, 1] };
assert.equal(alignedAt(ind3, 0), true); assert.equal(alignedAt(ind3, 2), false); assert.equal(lastAlignment(ind3), 3);
assert.equal(lastAlignment({ sma50: [1, 1], sma150: [2, 2], sma200: [3, 3] }), -1);
assert.equal(lastAlignment({ sma50: [1, 1], sma150: [2, 2], sma200: [3, 3] }, false), 0);
// base counting: run up, pull back to the 50 MA (base 1), break out, pull back again (base 2)
const bc = [14, 15, 11, 16, 17, 12.5].map((c, i) => ({ t: String(i), o: c, h: c, l: c, c }));
assert.equal(baseCount(bc, { sma50: Array(6).fill(13) }, 0), 2);
assert.equal(baseCount(bc.slice(0, 2), { sma50: [10, 10] }, 0), 0, 'no pullback to the 50 MA yet');
// the VCP fixture still passes the 2026 rules: it lines up, C1 reaches the 50 MA, each pullback has 3+ down candles
assert.equal(a.long.setup.rules, 'scv'); assert.ok(a.long.setup.contractions.every(c => c.run >= 3)); assert.equal(a.long.setup.base, 1);
assert.equal(a.long.S, true); assert.equal(a.long.vol.volOk, true);
// a 2-candle dip is folded into the next swing instead of counting as its own contraction
const dip = fromPath(path([[0, 50], [200, 52], [300, 100], [320, 82], [345, 97], [347, 95], [349, 97.5], [362, 88.3], [380, 95], [392, 91.2], [400, 94]]));
const dipA = analyzeTicker({ ticker: 'DIP' }, dip);
assert.ok(!dipA.long.setup.contractions.some(c => c.hiT === dip[345].t && c.loT === dip[347].t), 'the 2-candle dip is not a contraction');
// MAs never lined up -> no Stage 2 setup under the 2026 rules
const noAlign = contractionAgent(up, computeIndicators(up), -1, CONFIG, { requireAlign: true });
assert.equal(noAlign.valid, false); assert.match(noAlign.reason, /lined up/);
// 9) watchlist parser
import { parseWatchlist } from '../src/data.js';
assert.deepEqual(parseWatchlist('# my list\nTEM, Tempus AI\n spcx \nTEM\n\nbrk.b ; Berkshire\n').map(u => [u.ticker, u.name]), [['TEM', 'Tempus AI'], ['SPCX', 'SPCX'], ['BRK.B', 'Berkshire']]);
// 10) score v3: per-market profiles; on US stocks a stock near its 150 MA with a modest run and room for the stop wins
import { scoreSide, SCORE_V3 } from '../src/engine.js';
const mkS = (o, profile) => ({ profile, long: { risk: { riskPct: o.risk }, vol: { upBig: 1, downBig: o.down }, setup: { contractions: Array.from({ length: o.n }, () => ({ depth: o.c1 })), zonePos: 0.8, distToEntry: 0.03 } },
  dist150: o.d150, slope150: 0.03, dist50: 0.02, ret126: o.r126, ret21: 0.02, offHigh: 0.05, offLow: 0.5, atr20: 0.025 });
const calmS = scoreSide(mkS({ d150: 0.04, r126: 0.08, risk: 0.12, c1: 0.12, n: 5, down: 5 }, 'stocks'), 'long', 0.5);
const hotS = scoreSide(mkS({ d150: 0.35, r126: 0.8, risk: 0.05, c1: 0.03, n: 1, down: 0 }, 'stocks'), 'long', 0.5);
assert.equal(calmS.v, 3); assert.equal(calmS.parts.length, Object.keys(SCORE_V3.stocks).length);
assert.ok(calmS.total > 75 && hotS.total < 10, `calm ${calmS.total} hot ${hotS.total}`);
// Bursa rewards the opposite (trend strength) on 150 MA distance
const bz = p => scoreSide(mkS(p, 'bursa'), 'long', 0.5).parts.find(x => /150-day/.test(x[0]));
assert.ok(bz({ d150: 0.28, r126: 0.2, risk: 0.08, c1: 0.1, n: 2, down: 1 })[1] > bz({ d150: 0.03, r126: 0.2, risk: 0.08, c1: 0.1, n: 2, down: 1 })[1]);
// 11) live scorecard: fill, breakeven, target, stop, expiry, shorts, de-duplication
import os from 'node:os';
import { evaluate, summarize, updateScorecard } from '../src/scorecard.js';
const bar = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });
const days = n => Array.from({ length: n }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
const L0 = { d: '2026-10-31', side: 'long', e: 100, s: 95, tg: 110, be: 107.5 };
const flatB = n => days(n).map(t => bar(t, 99, 99.5, 98.5, 99));
// fills on day 3, reaches 1:1.5 on day 4, then falls back to entry -> breakeven (0 R)
let bs = flatB(2).concat([bar('2026-11-03', 99, 101, 98, 100.5), bar('2026-11-04', 101, 108, 100.5, 107), bar('2026-11-05', 106, 106, 99, 99.5)]);
let ev = evaluate(L0, bs); assert.equal(ev.status, 'breakeven'); assert.equal(ev.R, 0); assert.equal(ev.fd, '2026-11-03');
// straight to target
ev = evaluate(L0, flatB(1).concat([bar('2026-11-02', 101, 103, 100.5, 102), bar('2026-11-03', 103, 111, 102, 110)]));
assert.equal(ev.status, 'target'); assert.ok(Math.abs(ev.R - 1.8) < 1e-9, 'gap fill at 101 then +9 on 5 risk = 1.8R: ' + ev.R);
// stop
ev = evaluate(L0, [bar('2026-11-01', 99, 100.2, 98, 100), bar('2026-11-02', 99, 99, 94, 94.5)]); assert.equal(ev.status, 'stop'); assert.equal(ev.R, -1);
// never reaches the buy-stop within 15 days
ev = evaluate(L0, flatB(16)); assert.equal(ev.status, 'expired'); assert.equal(ev.R, 0);
ev = evaluate(L0, flatB(5)); assert.equal(ev.status, 'waiting');
// short side mirrored
ev = evaluate({ d: '2026-10-31', side: 'short', e: 50, s: 52, tg: 46, be: 47 }, [bar('2026-11-01', 51, 51, 49.5, 49.8), bar('2026-11-02', 49, 49.2, 45.5, 46)]);
assert.equal(ev.status, 'target'); assert.equal(ev.R, 2);
const sm = summarize([{ status: 'target', R: 2, fd: 'x', d: 'a' }, { status: 'stop', R: -1, fd: 'x', d: 'b' }, { status: 'expired', R: 0, d: 'c' }, { status: 'open', R: 0.5, fd: 'x', d: 'd' }]);
assert.equal(sm.closed, 2); assert.equal(sm.hitRate, 0.5); assert.equal(sm.avgR, 0.5); assert.equal(sm.rPer100, 33.3);
// recording: same pick on two days is tracked once
const tmp = fs.mkdtempSync(os.tmpdir() + '/sc-');
const pick = asOf => ({ ticker: 'TST', name: 'Test', tier: 'setup', asOf, risk: { entry: 100, stop: 95, target: 110, breakeven: 107.5 }, score: { total: 70 } });
updateScorecard(tmp, { market: 'stocks', asOf: '2026-10-30', up: [pick('2026-10-30')], down: [] }, { TST: flatB(1) });
const sc2 = updateScorecard(tmp, { market: 'stocks', asOf: '2026-10-31', up: [pick('2026-10-31'), { ...pick('2026-10-31'), ticker: 'W', tier: 'watch' }], down: [] }, { TST: flatB(2) });
assert.equal(sc2.summary.signals, 1); assert.equal(sc2.recent[0].status, 'waiting');
// 12) data sources: parsers and coverage
import { parseBinance, parseOkx, parseEastmoney, parseTencent, coverage } from '../src/sources.js';
const bn = parseBinance([[1792195200000, '81615.9', '81770.0', '80819.6', '81491.0', '7038.8', 1792281599999, '573731477.3'], [1792281600000, '1', '2', '0.5', '1.5', '1', Date.now() + 1e7, '5']]);
assert.equal(bn.length, 1); assert.equal(bn[0].t, '2026-10-17'); assert.equal(bn[0].v, 573731477.3);
const ok = parseOkx([['1792368000000', '82109.3', '82880', '82009', '82675.4', '1', '2', '92582983.0', '0'], ['1792281600000', '81489.5', '82291.1', '80680.5', '82109.3', '1', '2', '277723115.6', '1']]);
assert.equal(ok.length, 1); assert.equal(ok[0].c, 82109.3);
const em = parseEastmoney({ data: { klines: ['2026-10-15,1286.00,1312.97,1317.76,1282.00,57677,7537706224.00'] } });
assert.deepEqual(em[0], { t: '2026-10-15', o: 1286, h: 1317.76, l: 1282, c: 1312.97, v: 5767700 });
const tc = parseTencent({ data: { sh600519: { qfqday: [['2026-10-15', '1286.000', '1312.970', '1317.760', '1282.000', '57677.000']] } } }, 'sh600519');
assert.deepEqual(tc[0], em[0]);
const cov = coverage([{ ticker: 'A' }, { ticker: 'B' }, { ticker: 'C' }], { A: [{ t: '2026-10-16' }], B: [{ t: '2026-09-01' }] });
assert.equal(cov.fresh, 1); assert.equal(cov.total, 3);
// 13) US Stocks = S&P 500 + Nasdaq-100 + Dow 30, each stock once with its indices
import { combineUS, mergeLegacyScorecards } from '../src/run.js';
const usu = combineUS([{ ticker: 'AAPL', name: 'Apple', sector: 'Information Technology' }, { ticker: 'JPM', name: 'JPMorgan', sector: 'Financials' }],
  [{ ticker: 'AAPL', name: 'Apple Inc.', sector: 'Technology' }, { ticker: 'ASML', name: 'ASML', sector: 'Technology' }], [{ ticker: 'AAPL' }, { ticker: 'JPM' }]);
assert.deepEqual(usu.map(u => [u.ticker, u.idx.join('+')]), [['AAPL', 'S&P 500+Nasdaq-100+Dow 30'], ['JPM', 'S&P 500+Dow 30'], ['ASML', 'Nasdaq-100']]);
assert.equal(usu[0].sector, 'Information Technology', 'S&P sector wins');
const ua = analyzeTicker({ ticker: 'VCP', idx: ['Nasdaq-100'] }, up);
assert.deepEqual(lookupTable([ua])[0].ix, ['Nasdaq-100']);
// old Nasdaq/Dow scorecards fold into the US one exactly once
import nodePath from 'node:path';
const sd = fs.mkdtempSync(os.tmpdir() + '/us-'), nd = fs.mkdtempSync(os.tmpdir() + '/nq-');
fs.writeFileSync(nodePath.join(sd, 'scorecard.json'), JSON.stringify({ market: 'stocks', entries: [{ id: '2026-10-16:AAPL:long', d: '2026-10-16', t: 'AAPL', side: 'long', status: 'open' }] }));
fs.writeFileSync(nodePath.join(nd, 'scorecard.json'), JSON.stringify({ market: 'nasdaq', entries: [{ id: '2026-10-16:AAPL:long', d: '2026-10-16', t: 'AAPL', side: 'long', status: 'open' }, { id: '2026-10-16:FAST:long', d: '2026-10-16', t: 'FAST', side: 'long', status: 'waiting' }] }));
mergeLegacyScorecards(sd, [[nd, 'Nasdaq-100']], () => {});
mergeLegacyScorecards(sd, [[nd, 'Nasdaq-100']], () => {});
const merged = JSON.parse(fs.readFileSync(nodePath.join(sd, 'scorecard.json'), 'utf8')).entries;
assert.deepEqual(merged.map(e => e.t), ['AAPL', 'FAST']); assert.equal(merged[1].from, 'Nasdaq-100');
assert.ok(fs.existsSync(nodePath.join(nd, 'scorecard.merged.json')) && !fs.existsSync(nodePath.join(nd, 'scorecard.json')));
console.log('ALL TESTS PASSED');
