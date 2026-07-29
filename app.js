/* =========================================================================
   MSFT Algo Trader — Paper Trading Terminal
   100% simulated prices + simulated (paper) trades. No real market data,
   no brokerage connection, no real money. Everything runs client-side.
   ========================================================================= */

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------
const STARTING_CASH = 100000;
const TICK_MS = 1000;          // one simulated price tick per second
const TICKS_PER_CANDLE = 4;    // a new MSFT candle finalizes every 4 ticks
const SPARK_HISTORY = 40;      // points kept for portfolio sparklines
const CANDLE_HISTORY = 180;    // candles kept on the main chart

const SMA_FAST = 9;
const SMA_SLOW = 21;
const RSI_PERIOD = 14;
const RSI_OVERBOUGHT = 75;
const STOP_LOSS_PCT = 0.03;
const TAKE_PROFIT_PCT = 0.05;
const ALLOCATION_PCT = 0.20;   // % of cash risked per auto-entry

const TICKERS = [
  { symbol: "MSFT", name: "Microsoft Corp.", price: 468.35, volatility: 0.0022, tradedByAlgo: true },
  { symbol: "AAPL", name: "Apple Inc.",      price: 231.10, volatility: 0.0020 },
  { symbol: "GOOGL", name: "Alphabet Inc.",  price: 192.40, volatility: 0.0024 },
  { symbol: "AMZN", name: "Amazon.com",      price: 218.75, volatility: 0.0026 },
  { symbol: "NVDA", name: "NVIDIA Corp.",    price: 146.20, volatility: 0.0035 },
  { symbol: "META", name: "Meta Platforms",  price: 594.60, volatility: 0.0028 },
];

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const state = {
  cash: STARTING_CASH,
  holdings: Object.fromEntries(TICKERS.map(t => [t.symbol, 0])),
  avgCost: Object.fromEntries(TICKERS.map(t => [t.symbol, 0])),
  trades: [],
  algoRunning: true,
  tickCount: 0,
  msftCandles: [],       // finalized candles {time, open, high, low, close}
  msftCurrentCandle: null,
  msftCloses: [],        // finalized close prices, used for SMA/RSI
  smaFastSeries: [],
  smaSlowSeries: [],
  prevSmaFast: null,
  prevSmaSlow: null,
  msftPosition: { open: false, entryPrice: 0, qty: 0 },
  markers: [],
};

TICKERS.forEach(t => {
  t.sessionOpen = t.price;
  t.history = [t.price];
});

// ---------------------------------------------------------------------
// Chart setup (lightweight-charts)
// ---------------------------------------------------------------------
const chartEl = document.getElementById("chart");
const chart = LightweightCharts.createChart(chartEl, {
  layout: {
    background: { color: "transparent" },
    textColor: "#8b93a3",
    fontFamily: "SF Mono, Menlo, Consolas, monospace",
  },
  grid: {
    vertLines: { color: "#1a1f29" },
    horzLines: { color: "#1a1f29" },
  },
  rightPriceScale: { borderColor: "#232935" },
  timeScale: { borderColor: "#232935", timeVisible: true, secondsVisible: true },
  crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
});

const candleSeries = chart.addCandlestickSeries({
  upColor: "#26d67f",
  downColor: "#ff4d5e",
  borderVisible: false,
  wickUpColor: "#26d67f",
  wickDownColor: "#ff4d5e",
});

const smaFastLine = chart.addLineSeries({ color: "#ffb454", lineWidth: 1, priceLineVisible: false });
const smaSlowLine = chart.addLineSeries({ color: "#4da3ff", lineWidth: 1, priceLineVisible: false });

new ResizeObserver(entries => {
  const { width, height } = entries[0].contentRect;
  chart.resize(width, height);
}).observe(chartEl);

// ---------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------
function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(arr.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsi(arr, period) {
  if (arr.length < period + 1) return null;
  const slice = arr.slice(arr.length - period - 1);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
}

function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "$" + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n) {
  return (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
}

// ---------------------------------------------------------------------
// Price simulation
// ---------------------------------------------------------------------
function stepPrice(t) {
  // mild mean-reversion toward session open + random walk
  const meanReversion = (t.sessionOpen - t.price) * 0.0006;
  const shock = (Math.random() - 0.5) * 2 * t.volatility;
  const changePct = shock + meanReversion / t.price;
  t.price = Math.max(0.5, t.price * (1 + changePct));
  t.history.push(t.price);
  if (t.history.length > SPARK_HISTORY) t.history.shift();
}

function updateMsftCandle() {
  const p = TICKERS[0].price;
  const nowSec = Math.floor(Date.now() / 1000);

  if (!state.msftCurrentCandle || state.tickCount % TICKS_PER_CANDLE === 0) {
    // finalize previous candle
    if (state.msftCurrentCandle) {
      state.msftCandles.push(state.msftCurrentCandle);
      if (state.msftCandles.length > CANDLE_HISTORY) state.msftCandles.shift();
      state.msftCloses.push(state.msftCurrentCandle.close);
      if (state.msftCloses.length > CANDLE_HISTORY) state.msftCloses.shift();
      evaluateStrategy(state.msftCurrentCandle.close);
    }
    state.msftCurrentCandle = { time: nowSec, open: p, high: p, low: p, close: p };
  } else {
    const c = state.msftCurrentCandle;
    c.high = Math.max(c.high, p);
    c.low = Math.min(c.low, p);
    c.close = p;
    c.time = nowSec;
  }

  const allCandles = [...state.msftCandles, state.msftCurrentCandle];
  candleSeries.setData(allCandles);

  const closesForIndicators = [...state.msftCloses, state.msftCurrentCandle.close];
  const fast = sma(closesForIndicators, SMA_FAST);
  const slow = sma(closesForIndicators, SMA_SLOW);
  if (fast !== null) smaFastLine.update({ time: nowSec, value: fast });
  if (slow !== null) smaSlowLine.update({ time: nowSec, value: slow });

  const currentRsi = rsi(closesForIndicators, RSI_PERIOD);
  document.getElementById("rsiValue").textContent = currentRsi !== null ? currentRsi.toFixed(1) : "--";
}

// ---------------------------------------------------------------------
// Strategy engine — evaluated once per finalized MSFT candle
// ---------------------------------------------------------------------
function evaluateStrategy(closePrice) {
  const fast = sma(state.msftCloses, SMA_FAST);
  const slow = sma(state.msftCloses, SMA_SLOW);
  const currentRsi = rsi(state.msftCloses, RSI_PERIOD);
  if (fast === null || slow === null) return;

  const prevFast = state.prevSmaFast;
  const prevSlow = state.prevSmaSlow;
  state.prevSmaFast = fast;
  state.prevSmaSlow = slow;

  if (!state.algoRunning) return;
  if (prevFast === null || prevSlow === null) return;

  const bullishCross = prevFast <= prevSlow && fast > slow;
  const bearishCross = prevFast >= prevSlow && fast < slow;
  const pos = state.msftPosition;

  // --- Exit checks take priority ---
  if (pos.open) {
    const changeFromEntry = (closePrice - pos.entryPrice) / pos.entryPrice;
    if (changeFromEntry <= -STOP_LOSS_PCT) {
      autoSell(closePrice, `Stop-loss triggered (${fmtPct(changeFromEntry * 100)})`);
      return;
    }
    if (changeFromEntry >= TAKE_PROFIT_PCT) {
      autoSell(closePrice, `Take-profit triggered (${fmtPct(changeFromEntry * 100)})`);
      return;
    }
    if (bearishCross) {
      autoSell(closePrice, "SMA(9) crossed below SMA(21) — bearish signal");
      return;
    }
    if (currentRsi !== null && currentRsi > RSI_OVERBOUGHT) {
      autoSell(closePrice, `RSI overbought (${currentRsi.toFixed(1)})`);
      return;
    }
  } else {
    if (bullishCross && (currentRsi === null || currentRsi < 70)) {
      autoBuy(closePrice, "SMA(9) crossed above SMA(21) — bullish signal");
    }
  }
}

function autoBuy(price, reason) {
  const budget = state.cash * ALLOCATION_PCT;
  const qty = Math.floor(budget / price);
  if (qty < 1) return;
  const cost = qty * price;
  state.cash -= cost;
  state.holdings.MSFT += qty;
  state.avgCost.MSFT = price;
  state.msftPosition = { open: true, entryPrice: price, qty };
  logTrade("MSFT", "BUY", qty, price, reason, true);
  addMarker(state.msftCurrentCandle.time, "belowBar", "arrowUp", "#26d67f", "BUY");
}

function autoSell(price, reason) {
  const qty = state.holdings.MSFT;
  if (qty < 1) { state.msftPosition = { open: false, entryPrice: 0, qty: 0 }; return; }
  state.cash += qty * price;
  state.holdings.MSFT = 0;
  state.msftPosition = { open: false, entryPrice: 0, qty: 0 };
  logTrade("MSFT", "SELL", qty, price, reason, true);
  addMarker(state.msftCurrentCandle.time, "aboveBar", "arrowDown", "#ff4d5e", "SELL");
}

function addMarker(time, position, shape, color, text) {
  state.markers.push({ time, position, color, shape, text });
  if (state.markers.length > 60) state.markers.shift();
  candleSeries.setMarkers(state.markers);
}

// ---------------------------------------------------------------------
// Manual trading (any ticker)
// ---------------------------------------------------------------------
function manualTrade(symbol, side, qty) {
  const t = TICKERS.find(x => x.symbol === symbol);
  if (!t || !qty || qty < 1) return;
  const price = t.price;

  if (side === "BUY") {
    const cost = qty * price;
    if (cost > state.cash) { flashInsufficientFunds(symbol); return; }
    state.cash -= cost;
    const prevQty = state.holdings[symbol];
    const prevCost = state.avgCost[symbol] * prevQty;
    state.holdings[symbol] += qty;
    state.avgCost[symbol] = (prevCost + cost) / state.holdings[symbol];
    if (symbol === "MSFT") state.msftPosition = { open: true, entryPrice: state.avgCost.MSFT, qty: state.holdings.MSFT };
  } else {
    const sellQty = Math.min(qty, state.holdings[symbol]);
    if (sellQty < 1) return;
    state.cash += sellQty * price;
    state.holdings[symbol] -= sellQty;
    if (symbol === "MSFT" && state.holdings.MSFT === 0) {
      state.msftPosition = { open: false, entryPrice: 0, qty: 0 };
    }
    qty = sellQty;
  }
  logTrade(symbol, side, qty, price, "Manual order", false);
}

function flashInsufficientFunds(symbol) {
  const card = document.querySelector(`[data-symbol="${symbol}"]`);
  if (!card) return;
  card.style.outline = "1px solid var(--red)";
  setTimeout(() => { card.style.outline = "none"; }, 400);
}

// ---------------------------------------------------------------------
// Trade log
// ---------------------------------------------------------------------
function logTrade(symbol, side, qty, price, reason, auto) {
  state.trades.unshift({ time: new Date(), symbol, side, qty, price, reason, auto });
  if (state.trades.length > 200) state.trades.pop();
  renderBlotter();
}

function renderBlotter() {
  const body = document.getElementById("blotterBody");
  document.getElementById("blotterCount").textContent = `${state.trades.length} trade${state.trades.length === 1 ? "" : "s"}`;
  if (state.trades.length === 0) {
    body.innerHTML = `<tr class="blotter-empty"><td colspan="7">No trades yet — waiting on a signal…</td></tr>`;
    return;
  }
  body.innerHTML = state.trades.slice(0, 60).map(tr => `
    <tr>
      <td>${tr.time.toLocaleTimeString()}</td>
      <td>${tr.symbol}</td>
      <td class="side-${tr.side.toLowerCase()}">${tr.side}${tr.auto ? '<span class="auto-tag">AUTO</span>' : ""}</td>
      <td>${tr.qty}</td>
      <td>${fmtMoney(tr.price)}</td>
      <td>${fmtMoney(tr.qty * tr.price)}</td>
      <td>${tr.reason}</td>
    </tr>
  `).join("");
}

// ---------------------------------------------------------------------
// Rendering: header, portfolio grid
// ---------------------------------------------------------------------
function renderSpark(svgId, history, positive) {
  const w = 100, h = 32, pad = 2;
  const min = Math.min(...history), max = Math.max(...history);
  const range = max - min || 1;
  const points = history.map((v, i) => {
    const x = pad + (i / (history.length - 1 || 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = positive ? "#26d67f" : "#ff4d5e";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" />
  </svg>`;
}

// Card skeletons are built once; only their text/spark content is patched
// on every tick so in-flight qty inputs and button listeners never get
// wiped out mid-interaction.
function buildTickerGrid() {
  const grid = document.getElementById("tickerGrid");
  grid.innerHTML = TICKERS.map(t => `
    <div class="ticker-card" data-symbol="${t.symbol}">
      <div class="sym-block">
        <span class="sym">${t.symbol}${t.tradedByAlgo ? " ⚙" : ""}</span>
        <span class="name">${t.name}</span>
      </div>
      <div class="spark-container" id="spark-${t.symbol}"></div>
      <div class="price-block">
        <span class="price" id="price-${t.symbol}">${fmtMoney(t.price)}</span>
        <span class="change" id="change-${t.symbol}">0.00%</span>
        <span class="holding" id="holding-${t.symbol}">—</span>
      </div>
      <div class="trade-controls">
        <div class="row">
          <input type="number" class="qty-input" min="1" value="1" data-qty="${t.symbol}" />
        </div>
        <div class="row">
          <button class="btn btn-buy btn-sm" data-action="buy" data-symbol="${t.symbol}">Buy</button>
          <button class="btn btn-sell btn-sm" data-action="sell" data-symbol="${t.symbol}">Sell</button>
        </div>
      </div>
    </div>`).join("");

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const symbol = btn.dataset.symbol;
    const side = btn.dataset.action === "buy" ? "BUY" : "SELL";
    const qtyInput = grid.querySelector(`input[data-qty="${symbol}"]`);
    const qty = parseInt(qtyInput.value, 10) || 1;
    manualTrade(symbol, side, qty);
  });
}

function updateTickerGrid() {
  TICKERS.forEach(t => {
    const change = ((t.price - t.sessionOpen) / t.sessionOpen) * 100;
    const positive = change >= 0;
    const held = state.holdings[t.symbol];

    document.getElementById(`spark-${t.symbol}`).innerHTML = renderSpark(t.symbol, t.history, positive);
    document.getElementById(`price-${t.symbol}`).textContent = fmtMoney(t.price);

    const changeEl = document.getElementById(`change-${t.symbol}`);
    changeEl.textContent = fmtPct(change);
    changeEl.className = "change " + (positive ? "positive" : "negative");

    document.getElementById(`holding-${t.symbol}`).textContent =
      held > 0 ? held + " sh · " + fmtMoney(held * t.price) : "—";
  });
}

function computeEquity() {
  return state.cash + TICKERS.reduce((sum, t) => sum + state.holdings[t.symbol] * t.price, 0);
}

function renderHeader() {
  const equity = computeEquity();
  const pnl = equity - STARTING_CASH;
  const pnlPct = (pnl / STARTING_CASH) * 100;

  document.getElementById("statCash").textContent = fmtMoney(state.cash);
  document.getElementById("statEquity").textContent = fmtMoney(equity);

  const pnlEl = document.getElementById("statPnl");
  pnlEl.textContent = fmtMoney(pnl);
  pnlEl.className = "stat-value " + (pnl >= 0 ? "positive" : "negative");

  const retEl = document.getElementById("statReturn");
  retEl.textContent = fmtPct(pnlPct);
  retEl.className = "stat-value " + (pnlPct >= 0 ? "positive" : "negative");

  const msft = TICKERS[0];
  const msftChangePct = ((msft.price - msft.sessionOpen) / msft.sessionOpen) * 100;
  document.getElementById("msftPrice").textContent = fmtMoney(msft.price);
  const chEl = document.getElementById("msftChange");
  chEl.textContent = fmtPct(msftChangePct);
  chEl.className = "ticker-change " + (msftChangePct >= 0 ? "positive" : "negative");
}

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------
function tick() {
  state.tickCount++;
  TICKERS.forEach(stepPrice);
  updateMsftCandle();
  renderHeader();
  updateTickerGrid();
}

buildTickerGrid();
setInterval(tick, TICK_MS);
tick();
renderBlotter();

// ---------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------
document.getElementById("toggleAlgo").addEventListener("click", () => {
  state.algoRunning = !state.algoRunning;
  const statusEl = document.getElementById("algoStatus");
  const btn = document.getElementById("toggleAlgo");
  if (state.algoRunning) {
    statusEl.classList.remove("paused");
    statusEl.innerHTML = '<span class="pulse-dot"></span> ALGO RUNNING';
    btn.textContent = "Pause Algo";
  } else {
    statusEl.classList.add("paused");
    statusEl.innerHTML = '<span class="pulse-dot"></span> ALGO PAUSED';
    btn.textContent = "Resume Algo";
  }
});

document.getElementById("resetAccount").addEventListener("click", () => {
  if (!confirm("Reset cash, holdings, and trade history back to $100,000?")) return;
  state.cash = STARTING_CASH;
  TICKERS.forEach(t => { state.holdings[t.symbol] = 0; state.avgCost[t.symbol] = 0; });
  state.trades = [];
  state.msftPosition = { open: false, entryPrice: 0, qty: 0 };
  state.markers = [];
  candleSeries.setMarkers([]);
  renderBlotter();
  renderHeader();
  updateTickerGrid();
});
