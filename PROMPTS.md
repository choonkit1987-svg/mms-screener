# Agent Desk — prompts that get the best answers

The **Ask the agents** box sends your question to Claude together with the agents' data:
a one-line summary of every stock or coin, plus the full six-agent report for each ticker
you name. The AI is told to answer **only from that data**, so the best questions point it
at tickers, filters and numbers the agents have produced.

## Five habits

1. **Name the tickers** (`NVDA`, `$AAPL`, or the company name). Each named ticker attaches its full report; without names the AI only sees the one-line summaries.
2. **State your capital and risk profile** (aggressive / neutral / conservative). The risk team has a position size for each; the AI turns that into an amount and a maximum loss.
3. **Ask for a table** when comparing two or more names.
4. **Ask "what would change your mind?"** to make it surface the bear case, the stop and any earnings date.
5. **Ask it to quote the agents' numbers**: it then cites the chance, grade, stop and test results instead of general opinions.

## Copy-paste prompts

### Find opportunities
- Which 5 stocks have an Uptrend call AND fundamentals grade A or B? Rank them and give one line on why each.
- List every name rated Buy or Overweight with Low or Medium risk, grouped by sector, with both chances for each.
- Which Uptrend stocks have NO earnings report in the next 2 weeks and a stop less than 6% away?
- Which coins have an Uptrend call with Low or Medium risk? Rank them and explain why. *(crypto page)*

### Understand one name
- Decode NVDA's latest financial report in plain English: is the business getting stronger or weaker, and why?
- Give me the bull case and the bear case for TSLA from the agents, then say which side the evidence favours and why.
- What could make the 2-week call on AAPL wrong? List the biggest risks and the exact stop level.
- Why is META rated Hold even though its trend is up? Walk through each agent's input.

### Plan a trade
- I have $10,000 and a conservative risk profile. How much MSFT should I buy (or should I skip it), where is my stop, and what is my maximum loss?
- Compare AMD and NVDA across all six agents in a table, then tell me which is the better 2-week trade.
- Which stocks have an earnings report inside the next 2 weeks? Should I avoid them or size down?
- For SNDK, what would the aggressive, neutral and conservative risk analysts each do, and why do they disagree?

### Check the system
- How reliable is the 2-week call? Explain the test results for each test period in simple terms and how I should use them.
- Which model inputs matter most right now, and what is the overall market regime telling us?
- Which Downtrend calls also have weak fundamentals (grade D or F)? Are those better short candidates than the rest?

## "Run AI debate"

On any stock's report, **Run AI debate** replays the TradingAgents-style discussion on
the desk's data: Bull researcher → Bear researcher → Research manager → Trader →
Aggressive / Neutral / Conservative risk analysts → Portfolio manager (about 7 calls).
Use it when the agents are split (for example a Hold with a strong bull *and* bear case).

## What the AI cannot do

- It has no news, no prices after the "as of" date and no names outside the page's list. It will say so rather than guess.
- It does not change the agents' calls; it explains and combines them.
- It is a research aid, not financial advice. The 2-week model gives a modest statistical edge in *ranking* names (see the test results on the page), not certainty about the market's direction.
