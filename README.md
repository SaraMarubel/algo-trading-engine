# Quant Momentum Engine

A browser-based systematic trading simulator: a rule-based long-only
momentum strategy (SMA crossover + trend filter + RSI, with layered
risk controls — hard stop-loss, trailing stop, take-profit, and a
re-entry cooldown) trading a 6-name tech universe from market open,
with TWAP-sliced execution for manual orders and a full parameter panel
for reconfiguring the strategy live.

**Everything is simulated.** Prices are generated client-side by a random
walk model (not a real market data feed), and every "trade" is a paper
trade against a virtual $100,000 cash balance. No brokerage, no real
money, no live data — this is a demo/portfolio project, not a financial
tool or investment advice.

## What it does

- **Trades from market open, not from when you load the page.** On load,
  the app backfills each ticker's candle history (and, for whichever
  tickers have their algo switch on, replays the strategy over that
  history) from the session open to now, so the chart and trade blotter
  already look like a session in progress.
- **Live candlestick chart** (via [TradingView Lightweight
  Charts](https://github.com/tradingview/lightweight-charts)) with
  SMA(fast)/SMA(slow) overlays and buy/sell markers — click any ticker in
  the portfolio panel to view its chart instead.
- **Algorithmic trading on any ticker, not just MSFT** — every ticker has
  its own Algo ON/OFF switch, and **which ones are enabled is remembered
  across sessions** (`localStorage`), including a replay of what the
  strategy would have done earlier in the session the first time you
  flip a ticker on.
- **The strategy, in brief** (full writeup in the in-app "Strategy
  Settings" panel): an SMA crossover (golden/death cross) gated by a
  longer-period trend filter and an RSI regime filter, fixed-fractional
  position sizing, and a layered exit stack — hard stop-loss, a trailing
  stop that activates once a trade is meaningfully in profit, a
  take-profit ceiling, and a re-entry cooldown to reduce overtrading.
  Every parameter is editable and persists across reloads.
- **A "Today's Performance" panel** summarizing the algorithm's realized
  results for the session — win rate, round-trips, average win/loss,
  best/worst trade, open positions — recomputed on a 3-hour cadence (plus
  a manual refresh) rather than jittering on every fill.
- **TWAP order commands** — "Dump Position" and "Accumulate," which slice
  a large manual order into smaller pieces executed a few seconds apart
  instead of routing it all at once, the same market-impact-reduction
  technique real trading desks use. Hover the ⓘ next to each for the
  explanation.
- **A real NYSE market clock** — current time in America/New_York, live
  OPEN/PRE-MARKET/AFTER-HOURS/CLOSED status, and a countdown to the next
  open or close. A **Demo / Live NYSE Hours** mode toggle controls
  whether the algorithm actually obeys that clock: Demo mode (the
  default) keeps the simulation running around the clock so the
  dashboard is always live for anyone visiting; Live mode freezes prices
  and trading outside real market hours, like an actual desk.
- **Trade blotter** logging every fill (auto, manual, and TWAP slices) —
  hover any row for a plain-language explanation of why the algorithm
  made that specific decision.

## Model & simplifications

- Prices are a client-side random walk with mild mean reversion, not a
  real feed — this is a strategy/execution-logic demo, not a backtest
  against historical data.
- The strategy's default parameters are commonly-cited technical-analysis
  values (9/21 SMA, 50-period trend filter, RSI(14) with 30/70
  thresholds), not a claim that they're optimized — the Strategy Settings
  panel explains the reasoning behind each and lets you change them.
- "Live NYSE Hours" mode uses a simple weekday + 9:30–16:00 ET check —
  it doesn't account for market holidays.

## Running it locally

No build step, no dependencies to install — it's plain HTML/CSS/JS and
pulls the charting library and fonts from a CDN.

```bash
cd quant-momentum-engine
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser. (Or just open
`index.html` directly — it works without a server too, since nothing is
fetched from disk.)

## Project structure

```
index.html   Page layout (chart, portfolio grid, performance panel,
             blotter, settings modal)
style.css    Dark, institutional trading-terminal theme
app.js       Price simulation, backfill, strategy engine, TWAP execution,
             market-hours logic, performance summary, rendering
```

## Tech stack

Vanilla JavaScript, HTML, and CSS — no framework, no bundler. Charting via
the `lightweight-charts` CDN build; Inter/JetBrains Mono via Google Fonts.

## Disclaimer

This project is for educational/portfolio purposes only. It does not
connect to any real exchange or brokerage, does not use real market data,
and does not constitute financial advice. Do not use this code to make
real trading decisions.
