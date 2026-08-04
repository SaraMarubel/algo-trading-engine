# MSFT Algo Trader — Paper Trading Terminal

A browser-based **paper trading** dashboard that runs an algorithmic
strategy on Microsoft (MSFT) and, optionally, any of a broader "Big Tech"
portfolio (AAPL, GOOGL, AMZN, NVDA, META) — with real NYSE market hours,
a strategy you can inspect and tune from the UI, and order-execution
commands modeled on how real desks work large orders.

**Everything is simulated.** Prices are generated client-side by a random
walk model (not a real market data feed), and every "trade" is a paper
trade against a virtual $100,000 cash balance. No brokerage, no real
money, no live data — this is a demo/learning project, not a financial
tool.

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
- **Algorithmic trading on any ticker, not just MSFT.** Every ticker in
  the portfolio panel has its own "Algo: ON/OFF" switch. Flip one on and
  the strategy starts trading it — including replaying what it *would*
  have done earlier in the session.
- **The strategy, in brief** (see the in-app "Strategy Settings" panel
  for the full writeup): a moving-average crossover (golden/death cross)
  filtered by RSI, fixed-fractional position sizing, a stop-loss/
  take-profit bracket, and a re-entry cooldown to avoid whipsawing on
  noise. Every parameter — SMA periods, RSI thresholds, stop-loss/
  take-profit %, position size, cooldown, TWAP slice count/interval — is
  editable from that panel and persists across reloads.
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
- **Account summary** — cash, equity, total P&L, and return %, updated
  every tick.
- Pause/resume the algorithm, or reset the account back to $100,000 at
  any time, all from the header controls.

## Model & simplifications

- Prices are a client-side random walk with mild mean reversion, not a
  real feed.
- The strategy's parameters are commonly-cited technical-analysis
  defaults (9/21 SMA, RSI(14) with 30/70 thresholds), not a claim that
  they're optimal — the Strategy Settings panel explains the reasoning
  behind each and lets you change them.
- "Live NYSE Hours" mode uses a simple weekday + 9:30–16:00 ET check —
  it doesn't account for market holidays.

## Running it locally

No build step, no dependencies to install — it's plain HTML/CSS/JS and
pulls the charting library from a CDN.

```bash
cd trading-algorithm-portfolio
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser. (Or just open
`index.html` directly — it works without a server too, since nothing is
fetched from disk.)

## Project structure

```
index.html   Page layout (chart, portfolio grid, blotter, settings modal)
style.css    Dark trading-terminal theme
app.js       Price simulation, backfill, strategy engine, TWAP execution,
             market-hours logic, rendering
```

## Tech stack

Vanilla JavaScript, HTML, and CSS — no framework, no bundler. Charting via
the `lightweight-charts` CDN build.

## Disclaimer

This project is for educational/demo purposes only. It does not connect
to any real exchange or brokerage, does not use real market data, and
does not constitute financial advice. Do not use this code to make real
trading decisions.
