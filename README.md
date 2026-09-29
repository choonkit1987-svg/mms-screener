# MMS Daily Screener

A multi-agent screener that applies the **Market Maker Strategy (MMS) 2026** course rules to the **S&P 500** every trading day and to the **top 100 crypto coins** every day. For each market it picks:

- **Top 5 uptrend stocks**: Stage 2 names with a valid contraction (VCP) buy setup near its trigger
- **Top 5 downtrend stocks**: Stage 4 names with the same structure mirrored for shorting

Results are published as a web dashboard (GitHub Pages) with candlestick charts, the 50/150/200-day MAs, contraction boxes, and entry, stop and target levels for each pick.

## The agents

| Agent | Course chapter | Job |
|---|---|---|
| Universe agent | – | Downloads the current S&P 500 list |
| Market-data agent | – | Daily OHLCV, 2 years (Massive/Polygon grouped-daily with a free key, or Yahoo) |
| Stage agent | Ch.1 Stage 1–4 | 150-day MA slope + price position → Stage 1/2/3/4 and strength |
| Contraction agent | Ch.2 Contraction, Base | Finds C1…C6 from the highest high since the 150/200 cross; checks tightening, rising lows, last contraction < 10%, breakout zone |
| Volume agent | Ch.3 Volume | Big up vs big down candles above the 50-day volume average; US$1M/day liquidity |
| Risk agent | Ch.4–6 Buffer, Stop, Breakeven, Amount | Entry = C high +1%, stop = C low −1%, target 1:2, breakeven at 1:1.5, size 6.25% |
| Ranking agent | – | Scores 0–100 and picks the top 5 each side |

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
