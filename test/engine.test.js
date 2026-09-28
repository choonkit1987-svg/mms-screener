import assert from 'node:assert/strict';
import { analyzeTicker, rankAll, sma, zigzag, invertBars } from '../src/engine.js';

// deterministic pseudo-random
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function day(i) { const d = new Date(Date.UTC(2025, 0, 1)); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); }
function fromPath(path, vol = 2e6) {
  return path.map((c, i) => {
    const prev = i ? path[i - 1] : c;
    const o = prev, h = Math.max(o, c) * (1 + 0.004 * rnd()), l = Math.min(o, c) * (1 - 0.004 * rnd());
    return { t: day(i), o, h, l, c, v: vol * (0.7 + 0.6 * rnd()) * (c > o ? 1.4 : 0.8) };
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
const dn = fromPath(path([[0, 100], [200, 98], [300, 50], [320, 60], [345, 52], [360, 56.5], [380, 53], [392, 55], [400, 53.5]]));
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
console.log('ALL TESTS PASSED');
