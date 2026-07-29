# MSFT Algo Trader — Paper Trading Terminal

A browser-based **paper trading** dashboard that runs a simple algorithmic
strategy on Microsoft (MSFT) in real time, while tracking a broader "Big
Tech" portfolio (AAPL, GOOGL, AMZN, NVDA, META) alongside it.

**Everything is simulated.** Prices are generated client-side by a random
walk model (not a real market data feed), and every "trade" is a paper
trade against a virtual $100,000 cash balance. No brokerage, no real
money, no live data — this is a demo/learning project, not a financial
tool.

## What it does

- **Live candlestick chart** for MSFT (via [TradingView Lightweight
  Charts](https://github.com/tradingview/lightweight-charts)) with
  overlaid SMA(9) / SMA(21) lines and buy/sell markers.
- **An algorithm that trades MSFT automatically** based on a dual moving
  average crossover:
  - **Buy** when the 9-period SMA crosses above the 21-period SMA, as
    long as RSI(14) is below 70 (not overbought) and the account is flat.
  - **Sell** when any of these trigger while holding a position:
    - the 9-period SMA crosses back below the 21-period SMA,
    - RSI(14) rises above 75 (overbought),
    - price falls 3% below the entry price (stop-loss),
    - price rises 5% above the entry price (take-profit).
  - Position size is 20% of available cash per entry.
- **A tech portfolio view** — MSFT plus AAPL, GOOGL, AMZN, NVDA, and META,
  each with a live price, % change, and sparkline. You can also place
  manual paper buy/sell orders on any of the six tickers.
- **Trade blotter** logging every fill (auto and manual) with the reason
  the algorithm acted.
- **Account summary** — cash, equity, total P&L, and return %, updated
  every tick.
- Pause/resume the algorithm, or reset the account back to $100,000 at
  any time, all from the header controls.

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
index.html   Page layout (chart, portfolio grid, blotter, header)
style.css    Dark trading-terminal theme
app.js       Price simulation, SMA/RSI strategy, trade execution, rendering
```

## Tech stack

Vanilla JavaScript, HTML, and CSS — no framework, no bundler. Charting via
the `lightweight-charts` CDN build.

## Disclaimer

This project is for educational/demo purposes only. It does not connect
to any real exchange or brokerage, does not use real market data, and
does not constitute financial advice. Do not use this code to make real
trading decisions.
