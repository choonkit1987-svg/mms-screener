# Rules the agents apply

Short summaries of the MMS / SCV method (Stage, Contraction, Volume) as coded in `src/engine.js`,
updated for the 2026 student portal. These are paraphrased rule summaries for the code, not course material.

## Chart set-up
- Daily chart with 50, 150 and 200-day simple MAs and a 50-day volume average.

## Stage (S)
- Stage is read from the 150-day MA only.
- Stage 1: 150 MA flat, price moving sideways around it, quiet volume.
- Stage 2 (buy): 150 MA rising, price above it.
- Stage 3: 150 MA flattening after a rise, price slipping below it.
- Stage 4 (short): 150 MA falling, price below it.
- Before a buy: price above all three MAs and the 150 MA above the 200 MA (mirrored for shorts).

## Candles
- Up or down candle: body bigger than both wicks together. Otherwise it is an indecision candle.

## Contraction (C)
- Look for contractions only after the MAs line up: 50 above 150 above 200 (reverse order for shorts).
- A contraction is a clear high, then at least 3 down or indecision candles in a row, then a clear low. Shorter dips do not count.
- C1 must pull back to the 50-day MA or below.
- C2 to C6: each one shallower than the one before, each low higher.
- Base: C1's high broken and at least 2 contractions. Only the 1st to 3rd base of a trend is traded.
- Breakout zone: where the buying contraction sits inside C1's range (top third Pivot, middle Cheat, bottom Low Cheat).

## Volume (V)
- Up-candle volume must outweigh down-candle volume since C1 (reverse for shorts).
- Big-volume candles (above the 50-day volume average) count in favour; bars below the average are ignored.
- Liquidity: 50-day average volume × price above US$1M a day (RM1M on Bursa).

## Entry
- Buy only when the latest contraction is under 10% deep.
- Buy-stop at that contraction's high plus a buffer: 1% on the daily chart, 0.5% hourly, 0.25% on minute charts.

## Exits
- Stop loss: that contraction's low minus the same buffer.
- Breakeven: with a 1:2 target, move the stop to entry once price reaches 1:1.5. Also when the 50-day MA rises above entry.
- Active profit: fixed target at 1:2 (or 1:1.5).
- Passive profit: trail the stop at the 50-day MA minus 1%.

## Position size
- First trade 6.25% of capital, then 12.5% and 25% after winning trades.

## Crypto signal (portal SCV Signal, for reference)
- The portal's live crypto signal runs on the 1-hour chart, long only, for liquid USDT perpetuals (turnover of at least 1M USDT), and requires daily Stage 2 as well. This screener runs crypto on the daily chart.
