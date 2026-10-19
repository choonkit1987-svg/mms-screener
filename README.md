# MMS Daily Screener

A multi-agent screener that applies the **Market Maker Strategy (MMS) 2026** course rules every day to five markets, each with its own page (tabs at the top of every page):

| Page | Universe | Market regime | Runs |
|---|---|---|---|
| `/` | S&P 500 | SPY | 22:30 UTC Mon–Fri (6:30 am MYT) |
| `/nasdaq/` | Nasdaq-100 | QQQ | same US run |
| `/dow/` | Dow Jones 30 | DIA | same US run |
| `/bursa/` | FBM KLCI 30 (Bursa Malaysia) | KLCI index | 10:15 UTC Mon–Fri (6:15 pm MYT) |
| `/china/` | CSI 300 (China A-shares, Shanghai + Shenzhen) | CSI 300 index | 08:15 UTC Mon–Fri (4:15 pm MYT) |
| `/crypto/` | Top 100 coins | Bitcoin | 02:30 UTC daily (10:30 am MYT) |
| `/watch/` | Your own US tickers (`watchlist.txt`) | SPY | same US run |

For each market it picks:

- **Top 5 uptrend stocks**: Stage 2 names with a valid contraction (VCP) buy setup near its trigger
- **Top 5 downtrend stocks**: Stage 4 names with the same structure mirrored for shorting

Results are published as a web dashboard (GitHub Pages) with candlestick charts, the 50/150/200-day MAs, contraction boxes, and entry, stop and target levels for each pick.

## The agents

| Agent | Course chapter | Job |
|---|---|---|
| Universe agent | – | Downloads the current index members (S&P 500 from GitHub datasets; Nasdaq-100, Dow 30, FBM KLCI and CSI 300 from Wikipedia) |
| Market-data agent | – | Daily OHLCV, 2 years (Massive/Polygon grouped-daily with a free key, or Yahoo) |
| Stage agent | Ch.1 Stage 1–4 | 150-day MA slope + price position → Stage 1/2/3/4 and strength |
| Contraction agent | Ch.2 Contraction, Base | Finds C1…C6 from the highest high since the 150/200 cross; checks tightening, rising lows, last contraction < 10%, breakout zone |
| Volume agent | Ch.3 Volume | Big up vs big down candles above the 50-day volume average; US$1M/day liquidity |
| Risk agent | Ch.4–6 Buffer, Stop, Breakeven, Amount | Entry = C high +1%, stop = C low −1%, target 1:2, breakeven at 1:1.5, size 6.25% |
| Ranking agent | – | Scores 0–100 (MMS score v3, a profile per market, see below) and picks the top 5 each side |

Full rule mapping: [RULES.md](RULES.md).

## Set up (about 10 minutes, free)

1. **Create a GitHub account** if you don't have one, then create a new **private or public repository** (e.g. `mms-screener`) and upload every file from this folder, keeping the folder structure (including `.github/workflows`).
2. **Get a free Massive API key** (Massive is the new name of Polygon.io): sign up at massive.com → Dashboard → API Keys.
3. In the repo: **Settings → Secrets and variables → Actions → New repository secret**
   Name: `MASSIVE_API_KEY`, Value: your key.
   *(Skip this to use Yahoo Finance with no key.)*
4. **Settings → Pages** → Source: *Deploy from a branch* → Branch `main`, folder `/docs` → Save.
   Your dashboard will be at `https://<your-username>.github.io/<repo>/`.
   (GitHub Pages on a private repo needs a paid plan; use a public repo on the free plan.)
5. **Actions tab → Daily MMS scan → Run workflow** once. The first Massive run back-fills history and takes about 70 minutes because of the free 5-calls-per-minute limit; after that each daily run takes a minute or two.

From then on it runs automatically at 22:30 UTC Monday–Friday (6:30 am Malaysia time) and the dashboard updates itself. Past days are kept in `docs/data/archive/` and appear in the History menu.

## Live scorecard

Each page has a **Live scorecard**: every pick the page shows (valid setups and early alerts) is recorded on the day it appears and followed with the real prices that come afterwards, using the course rules — the buy-stop/sell-stop order stays for 15 trading days ("not triggered" if price never reaches it), stop loss = −1 R, 1:2 target = +2 R, stop moved to entry at 1:1.5 ("breakeven", 0 R), closed at the 40th day's price otherwise. It shows the hit rate (target first, of closed trades), the average R per closed trade, R per 100 picks and the latest 40 picks. The records are kept in each page's `data/scorecard.json` and recomputed from prices on every run.

## Data sources and failed runs

| Market | Sources, in order |
|---|---|
| S&P 500, Nasdaq-100, Dow, watchlist | Massive (with your key), then Yahoo |
| Crypto | Binance market data, then OKX, then Yahoo (coin list: CoinGecko, last good copy in `data/lists/crypto.json`) |
| China A-shares | Eastmoney, then Tencent, then Yahoo |
| Bursa Malaysia | Yahoo (query1, then query2) |

Yahoo often refuses requests from cloud servers. A source that fails 8 times in a row is switched off for the rest of the run, so a blocked source costs seconds, not the whole run. If fewer than 60% of a page's symbols get fresh prices, the run **keeps yesterday's page**, writes `data/status.json` with the reason, and the page shows a yellow "The last update failed" bar. The workflow run is then marked failed (GitHub emails you) but still commits the status file.

To see which sources work from GitHub's servers, run **Actions → Check data sources → Run workflow**; the table is on the run's summary page.

## How picks are ranked (MMS score v3)

Only setups that pass the course rules (Stage 2/4, valid contractions, liquid, not broken or more than 5% past the trigger) can be picks. Among those, the score (0–100) decides the order. Version 3 (October 2026) was rebuilt **separately for each market** from a 5-year backtest (late 2022 – Sep 2026) of every Stage 2 signal: enter at the buy-stop, stop loss, 1:2 target, stop moved to entry at 1:1.5. A trait is used for a market only if it pointed the same way in both halves of the period (2022–24 and 2024–26). Each trait scores between the market's 10th and 90th percentile; the score is the average × 100. Ranges live in `SCORE_V3` in `src/engine.js`.

| Market | Traits that count (better =) | Confidence |
|---|---|---|
| S&P 500, Nasdaq-100, Dow 30, watchlist | closer to the 150-day MA, smaller 6-month gain, deeper first pullback, more room for the stop, more contractions, more big down-volume days in the base | medium |
| China A-shares | closer to the 150 and 50-day MAs, gentler 150 MA, smaller 6-month and 1-month gains, nearer the 52-week high, shallower first pullback, higher breakout zone, lower volatility, buy-stop not yet reached | good |
| Crypto | closer to the 150-day MA, gentler slope, smaller 6-month gain, shallower first pullback, fewer contractions, higher breakout zone, fewer big-volume days, lower volatility, buy-stop not yet reached | low |
| Bursa Malaysia | further above the 150 and 50-day MAs, stronger last month, more room for the stop, fewer contractions, higher breakout zone, few big down-volume days | very low (30 stocks) |

Backtest of the daily top 5 among valid setups (R per 100 signals; R = one unit of risk):

| Market | Test | No ranking | Score v2 | Score v3 |
|---|---|---|---|---|
| S&P 500 | traits chosen on 2022–24, tested on 2024–26 | −3.6 | +2.3 | **+3.5** |
| China | same | +10.0 | +13.1 | **+20.6** |
| Crypto | traits chosen on 2022–mid 2024, tested after | +2.3 | +3.0 | **+3.6** |
| Bursa | same | −17.3 | −17.3 | −17.3 (about 1 valid setup a day, so the order rarely matters) |

Valid S&P and China setups scoring 60+ did clearly better than those below 60 in the test half (S&P +10.5 vs −6.4; China +22.6 vs +1.5). For crypto and Bursa the 60+ split did not hold up, so treat their scores as a tie-breaker only. The lists are today's index members, so the backtest leaves out companies that dropped out of the index (survivorship bias), and past results are no guarantee.

## Early alerts (Stage 1 → 2 and Stage 3 → 4)

The 150-day MA reacts slowly: after a long fall it can take 6–8 weeks to turn up, so a stock can already have a valid C1/C2 base while it is still officially Stage 1. Example: BBY had a valid two-contraction base with a buy-stop of 77.85 on 23–24 June 2026, but only became Stage 2 on 16 July, when it was at 84 and too extended to buy.

Each page therefore has an **Early alerts** list under the main uptrend and downtrend lists. A stock appears there when **all** of these hold:

- Stage 1 (for buys) or Stage 3 (for shorts);
- price is above both the 50- and 150-day MAs and the 50-day MA is rising (mirrored for shorts);
- the 150-day MA's 20-day slope is improving (turning up) compared with the 20 days before;
- at least 3 big up-volume candles above the 50-day volume average since the low of the base, and more than big down-volume candles (mirrored for shorts);
- the contraction agent finds a valid setup (C2–C6, tightening, last contraction under 10%), liquid, not broken and not more than 5% past the trigger.

These entries come earlier and with less confirmation than the course's Stage 2 rule, so treat them as a heads-up: many traders wait for the stock to reach Stage 2, or use a smaller first position. Set `earlyMinBigVol` in `CONFIG` to change the volume requirement.

## My watchlist

`watchlist.txt` in the repo root lists extra US stocks to scan on the **My watchlist** tab — for example stocks that aren't in any index (Tempus AI) or new listings (SpaceX). One per line, `TICKER, optional name`; `#` starts a comment. Edit it on GitHub (pencil icon → commit) and the next US run picks it up. New listings are shown as "not analysed yet" until they have about 220 trading days of history.

## Analyse a stock (or coin)

Below the market summary there is a search box. Type any ticker or company name from that page's index (on the crypto page: any top-100 coin; on the Bursa page: short name, company name or stock code) and the page shows the agents' verdict for that one name:

- **Direction:** Uptrend (Stage 2), Downtrend (Stage 4), Topping (Stage 3, leaning down) or Basing (Stage 1, no trend yet)
- **Levels:** buy-stop (uptrend) or sell-stop (downtrend), stop loss, 1:2 target, risk to stop, breakeven point
- **Whether it's a trade:** a valid setup near its trigger, already triggered, too extended to chase, or no valid setup yet (with the rule it fails)
- a chart with the 50/150/200-day MAs and the contractions the agents counted, plus each agent's notes

Every daily run analyses every name and saves the results in each page's `data/all.json`, so the answer appears instantly and needs no API key. Only the latest day is kept for lookups. Link straight to a name with `#TICKER`, e.g. `https://<you>.github.io/mms-screener/#AAPL`.

## Nasdaq-100, Dow Jones and Bursa Malaysia pages

- **Member lists** come from Wikipedia's "List of NASDAQ-100 companies", "List of Dow Jones Industrial Average companies" and "FTSE Bursa Malaysia KLCI" tables. Each run saves the list to `data/lists/`; if Wikipedia is down or the table changes, the run uses the saved copy instead of failing.
- **Nasdaq-100 and Dow** are scanned in the same run as the S&P 500 (one download covers all three). Their market regime is QQQ and DIA.
- **Bursa Malaysia** has its own workflow, `.github/workflows/bursa-scan.yml`, which runs at 6:15 pm Malaysia time after Bursa closes. Data is Yahoo's `<stock code>.KL` daily bars; if it is run while Bursa is still trading, today's unfinished bar is ignored. Stocks are shown by their Bursa short name (MAYBANK, TENAGA…); the lookup box also accepts the 4-digit stock code. Prices are in RM and the liquidity rule is RM1M a day.

## China A-shares page

- **Universe:** the CSI 300 (Wikipedia's "CSI 300 Index" constituents table, saved to `data/lists/csi300.json`). Shanghai codes map to Yahoo `<code>.SS`, Shenzhen codes to `<code>.SZ`; stocks are shown by their 6-digit code, and the lookup box accepts the code or the company name.
- **Schedule:** `.github/workflows/china-scan.yml` runs at 4:15 pm Malaysia time, after the 3:00 pm close. During Chinese holidays (e.g. Golden Week) the page simply keeps the last trading day.
- **Prices** are in CNY (¥); liquidity = ¥1M a day. The regime is the CSI 300 ETF 510300, because Yahoo has almost no history for the index itself (000300.SS).
- **Shorting:** short selling A-shares is restricted for most investors, so treat the downtrend list as stocks to avoid or exit. Daily price limits (±10%, ±20% on ChiNext/STAR) can also make a stop fill later than planned.
- Wikipedia's list is updated by volunteers and can lag the June/December index reviews by a few weeks.

## Crypto page

`docs/crypto/` is a second dashboard (link at the top of each page) with the same agents tuned for coins:

- **Universe:** top 100 coins by market cap from CoinGecko (free, no key). Stablecoins, wrapped/staked/bridged tokens and tokenised funds are removed.
- **Data:** Yahoo daily candles, which close at 00:00 UTC. Today's still-open candle is ignored. If Yahoo hasn't filled in yesterday's candle yet, it is rebuilt from hourly candles, with volume set to the 50-day average so it never counts as a big-volume day.
- **Symbols:** when Yahoo uses a numbered symbol (SUI → SUI20947-USD), it is found by search and checked against CoinGecko's price.
- **Data quality:** coins with broken or too-coarse price history are skipped (e.g. SHIB and PEPE, whose Yahoo prices are rounded so heavily that most days show no movement).
- **Rules:** the same as stocks. Volume is already in USD, so liquidity = 50-day average volume > US$1M. Bitcoin's stage is shown as the market regime.
- **Schedule:** `.github/workflows/crypto-scan.yml` runs every day at 02:30 UTC (10:30 am Malaysia time). No secret needed.

Crypto pullbacks are often deeper than the course's 10% buying-contraction limit, so on many days few coins pass every rule; the rest of the list is then filled with liquid "Watch" names showing why they fail.

## Run it on your own computer

Needs Node.js 18 or newer, no packages to install.

```bash
node test/engine.test.js                     # unit tests
DATA_PROVIDER=yahoo node src/run.js          # stocks (or: MASSIVE_API_KEY=xxx node src/run.js)
node src/run-crypto.js                       # crypto
node src/run-bursa.js                        # Bursa Malaysia (FBM KLCI)
node src/run-china.js                        # China A-shares (CSI 300)
node src/build.js                            # rebuild docs/index.html
npx serve docs                               # open http://localhost:3000
```

## Tuning

All thresholds are in `CONFIG` at the top of `src/engine.js` (slope that counts as "flat", 10% contraction limit, 1% buffer, 1:2 target, 6.25% size). Change a value, commit, and the next run uses it.

## Limits

- This applies the course rules mechanically. It does not know about earnings dates, news or your account, and it is not financial advice. Check every chart yourself before trading.
- The course teaches entries on the long side and says to short in Stage 4; the short setups here mirror the long rules (rallies that tighten inside a falling 150 MA, sell-stop at the rally low −1%).
- Contraction swings are found with a volatility-scaled ZigZag, so a contraction you draw by eye may be split or merged slightly differently.
- Yahoo's endpoint is unofficial and can rate-limit; Massive is the more reliable source.
