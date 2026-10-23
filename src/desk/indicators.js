// Agent Desk — technical indicators (pure functions, no I/O).
// The same indicator set the TradingAgents "Market Analyst" chooses from:
// 50/200 SMA, 10 EMA, MACD (line / signal / histogram), RSI, Bollinger Bands, ATR, VWMA.
// Every series is aligned with `bars` (null until there is enough history).

export function sma(x, n) {
  const out = new Array(x.length).fill(null);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function ema(x, n) {
  const out = new Array(x.length).fill(null), k = 2 / (n + 1);
  let e = null, s = 0;
  for (let i = 0; i < x.length; i++) {
    if (i < n - 1) { s += x[i]; continue; }
    if (i === n - 1) { s += x[i]; e = s / n; } else e = x[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

// Wilder RSI
export function rsi(c, n = 14) {
  const out = new Array(c.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function macd(c, fast = 12, slow = 26, sig = 9) {
  const f = ema(c, fast), s = ema(c, slow);
  const line = c.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const start = line.findIndex(v => v != null);
  const sigRaw = start < 0 ? [] : ema(line.slice(start), sig);
  const signal = line.map((_, i) => (i >= start && start >= 0 ? sigRaw[i - start] : null));
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

export function bollinger(c, n = 20, k = 2) {
  const mid = sma(c, n), ub = new Array(c.length).fill(null), lb = new Array(c.length).fill(null);
  for (let i = n - 1; i < c.length; i++) {
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / n);
    ub[i] = mid[i] + k * sd; lb[i] = mid[i] - k * sd;
  }
  return { mid, ub, lb };
}

// Wilder ATR (absolute price units)
export function atr(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  let a = 0;
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].c, b = bars[i];
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i <= n) { a += tr; if (i === n) { a /= n; out[i] = a; } continue; }
    a = (a * (n - 1) + tr) / n; out[i] = a;
  }
  return out;
}

export function vwma(bars, n = 20) {
  const out = new Array(bars.length).fill(null);
  let pv = 0, v = 0;
  for (let i = 0; i < bars.length; i++) {
    pv += bars[i].c * bars[i].v; v += bars[i].v;
    if (i >= n) { pv -= bars[i - n].c * bars[i - n].v; v -= bars[i - n].v; }
    if (i >= n - 1) out[i] = v > 0 ? pv / v : null;
  }
  return out;
}

// Everything the technical agent needs, computed once per ticker.
export function indicatorSet(bars) {
  const c = bars.map(b => b.c), v = bars.map(b => b.v);
  return {
    c, v,
    sma20: sma(c, 20), sma50: sma(c, 50), sma150: sma(c, 150), sma200: sma(c, 200), ema10: ema(c, 10),
    macd: macd(c), rsi: rsi(c, 14), boll: bollinger(c, 20, 2), atr: atr(bars, 14), vwma: vwma(bars, 20),
    vol20: sma(v, 20), vol50: sma(v, 50),
  };
}
