// Cross-check agent: a stock is "confirmed" when the MMS screener and the Agent Desk agree.
//   Uptrend:   valid MMS Stage 2 buy setup  AND  Agent Desk rating Buy, fundamentals grade A or B, Low risk
//   Downtrend: valid MMS Stage 4 short setup AND  Agent Desk rating Underweight or Sell, fundamentals grade C, D or F
// Confirmed stocks are shown automatically on the "My watchlist" page (Uptrend / Downtrend Stocks panels).
export const CONFIRM_RULES = {
  up: { ratings: ['Buy'], grades: ['A', 'B'], risk: ['Low'] },
  down: { ratings: ['Underweight', 'Sell'], grades: ['C', 'D', 'F'], risk: null },
};

const live = r => r && !r.skip && r.valid && !['EXTENDED', 'BROKEN'].includes(r.status);

// mmsRows: US Stocks lookup rows (engine.lookupRecord); deskRows: Agent Desk US rows (desk/agents.js)
export function confirmMatches(mmsRows = [], deskRows = [], rules = CONFIRM_RULES) {
  const desk = new Map(deskRows.map(r => [r.t, r]));
  const out = { up: [], down: [], checked: { up: [], down: [] } };
  for (const [side, stage, mmsSide] of [['up', 2, 'long'], ['down', 4, 'short']]) {
    const R = rules[side];
    for (const m of mmsRows.filter(r => live(r) && r.st === stage && r.side === mmsSide)) {
      const d = desk.get(m.t);
      const info = d && !d.skip ? { rating: d.pm?.rating ?? null, grade: d.fund?.ok ? d.fund.grade : null, risk: d.risk?.level ?? null, p: d.tech?.p ?? null, call: d.tech?.call ?? null } : null;
      const miss = [];
      if (!info) miss.push('not analysed by the Agent Desk');
      else {
        if (!R.ratings.includes(info.rating)) miss.push(`rating ${info.rating || 'n/a'} (needs ${R.ratings.join(' or ')})`);
        if (!R.grades.includes(info.grade)) miss.push(`fundamentals ${info.grade || 'n/a'} (needs ${R.grades.join(', ')})`);
        if (R.risk && !R.risk.includes(info.risk)) miss.push(`${info.risk || 'n/a'} risk (needs ${R.risk.join(' or ')})`);
      }
      out.checked[side].push({ t: m.t, n: m.n || '', desk: info, ok: !miss.length, miss });
      if (!miss.length) out[side].push({ t: m.t, desk: info });
    }
  }
  return out;
}
