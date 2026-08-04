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
const TICKS_PER_CANDLE = 8;    // a new candle finalizes every 8 ticks (smooths out noise the strategy would otherwise whipsaw on)
const SPARK_HISTORY = 40;      // points kept for portfolio sparklines
const CANDLE_HISTORY = 2000;   // candles kept per ticker (supports full-session backfill)

const DEMO_BACKFILL_HOURS = 2;      // "Demo" mode: always pretend the session opened this long ago
const OPEN_MIN = 9 * 60 + 30;       // NYSE open, minutes after midnight ET (9:30)
const CLOSE_MIN = 16 * 60;          // NYSE close (16:00)
const MAX_BACKFILL_SECONDS = (CLOSE_MIN - OPEN_MIN) * 60; // cap backfill at one full session

const DEFAULT_PARAMS = {
  smaFast: 9,
  smaSlow: 21,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  stopLossPct: 3,
  takeProfitPct: 5,
  allocationPct: 20,
  cooldownSec: 25,
  twapSlices: 8,
  twapInterval: 3,
};

function loadParams() {
  try {
    const saved = JSON.parse(localStorage.getItem("mtt_params"));
    if (saved) return { ...DEFAULT_PARAMS, ...saved };
  } catch (e) { /* ignore malformed storage */ }
  return { ...DEFAULT_PARAMS };
}
let params = loadParams();
let mode = localStorage.getItem("mtt_mode") || "demo"; // "demo" | "live"

const TICKERS = [
  { symbol: "MSFT", name: "Microsoft Corp.", price: 468.35, volatility: 0.0022 },
  { symbol: "AAPL", name: "Apple Inc.",      price: 231.10, volatility: 0.0020 },
  { symbol: "GOOGL", name: "Alphabet Inc.",  price: 192.40, volatility: 0.0024 },
  { symbol: "AMZN", name: "Amazon.com",      price: 218.75, volatility: 0.0026 },
  { symbol: "NVDA", name: "NVIDIA Corp.",    price: 146.20, volatility: 0.0035 },
  { symbol: "META", name: "Meta Platforms",  price: 594.60, volatility: 0.0028 },
];

TICKERS.forEach(t => {
  t.sessionOpen = t.price;
  t.history = [t.price];
  t.candles = [];
  t.currentCandle = null;
  t.closes = [];
  t.prevSmaFast = null;
  t.prevSmaSlow = null;
  t.position = { open: false, entryPrice: 0, qty: 0 };
  t.algoEnabled = t.symbol === "MSFT";
  t.replayed = false;
  t.lastExitAt = null;
  t.markers = [];
  t.tickCount = 0;
});

let selectedSymbol = null;

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const state = {
  cash: STARTING_CASH,
  holdings: Object.fromEntries(TICKERS.map(t => [t.symbol, 0])),
  avgCost: Object.fromEntries(TICKERS.map(t => [t.symbol, 0])),
  trades: [],
  algoRunning: true,
};

// ---------------------------------------------------------------------
// Chart setup (lightweight-charts) — single chart, shows whichever
// ticker is currently selected in the portfolio panel.
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
// NYSE market hours (real time, America/New_York) — used both for the
// clock widget and (in "Live" mode) to gate when the algorithm may act.
// ---------------------------------------------------------------------
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function getNYParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return { hour: +parts.hour, minute: +parts.minute, second: +parts.second, weekday: parts.weekday };
}

function nyMarketInfo(date) {
  const p = getNYParts(date);
  const dow = WEEKDAY_INDEX[p.weekday];
  const minuteOfDay = p.hour * 60 + p.minute + p.second / 60;
  const nowMOW = dow * 1440 + minuteOfDay;
  const isWeekday = dow >= 1 && dow <= 5;

  let status = "closed";
  if (isWeekday) {
    if (minuteOfDay < OPEN_MIN) status = "pre";
    else if (minuteOfDay < CLOSE_MIN) status = "open";
    else status = "after";
  }

  let nextOpenMOW = null, nextCloseMOW = null;
  for (let addDay = 0; addDay < 14 && (nextOpenMOW === null || nextCloseMOW === null); addDay++) {
    const dayIndex = dow + addDay;
    const day = dayIndex % 7;
    if (day < 1 || day > 5) continue;
    const base = dayIndex * 1440;
    const openCand = base + OPEN_MIN, closeCand = base + CLOSE_MIN;
    if (nextOpenMOW === null && openCand > nowMOW) nextOpenMOW = openCand;
    if (nextCloseMOW === null && closeCand > nowMOW) nextCloseMOW = closeCand;
  }

  const nyLabel = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(Math.floor(p.second)).padStart(2, "0")}`;
  return {
    status, minuteOfDay,
    minutesToOpen: nextOpenMOW - nowMOW,
    minutesToClose: status === "open" ? nextCloseMOW - nowMOW : null,
    nyLabel,
  };
}

function marketActiveNow() {
  if (mode === "demo") return true;
  return nyMarketInfo(new Date()).status === "open";
}

function fmtCountdown(mins) {
  const h = Math.floor(mins / 60), m = Math.floor(mins % 60);
  return `${h}h ${m}m`;
}

function updateMarketClock() {
  const info = nyMarketInfo(new Date());
  const labels = { open: "NYSE: OPEN", pre: "NYSE: PRE-MARKET", after: "NYSE: AFTER-HOURS", closed: "NYSE: CLOSED" };
  const badge = document.getElementById("marketBadge");
  badge.textContent = labels[info.status];
  badge.className = "market-badge " + info.status;
  document.getElementById("marketTime").textContent = info.nyLabel + " ET";
  document.getElementById("marketCountdown").textContent = info.status === "open"
    ? "Closes in " + fmtCountdown(info.minutesToClose)
    : "Opens in " + fmtCountdown(info.minutesToOpen);
}

// ---------------------------------------------------------------------
// Price simulation
// ---------------------------------------------------------------------
function stepPrice(t) {
  const meanReversion = (t.sessionOpen - t.price) * 0.0006;
  const shock = (Math.random() - 0.5) * 2 * t.volatility;
  const changePct = shock + meanReversion / t.price;
  t.price = Math.max(0.5, t.price * (1 + changePct));
  t.history.push(t.price);
  if (t.history.length > SPARK_HISTORY) t.history.shift();
}

// Advances one ticker by a single tick: price, candle building, and (if
// its algo switch is on) a strategy check on every finalized candle.
// Used for both live ticking and historical backfill — `liveGate` decides
// whether the pause button / real market hours can suppress a trade
// (true for live ticks; false for backfill/replay, which reconstruct
// what the algorithm *would* have done during a past window).
function advanceTicker(t, virtualTime, liveGate) {
  stepPrice(t);
  const p = t.price;
  const timeSec = Math.floor(virtualTime.getTime() / 1000);

  if (!t.currentCandle || t.tickCount % TICKS_PER_CANDLE === 0) {
    if (t.currentCandle) {
      const finalized = t.currentCandle;
      t.candles.push(finalized);
      if (t.candles.length > CANDLE_HISTORY) t.candles.shift();
      t.closes.push(finalized.close);
      if (t.closes.length > CANDLE_HISTORY) t.closes.shift();
      if (t.algoEnabled) {
        evaluateStrategy(t, t.closes, finalized.close, virtualTime, finalized.time, liveGate);
      }
    }
    t.currentCandle = { time: timeSec, open: p, high: p, low: p, close: p };
  } else {
    const c = t.currentCandle;
    c.high = Math.max(c.high, p);
    c.low = Math.min(c.low, p);
    c.close = p;
    c.time = timeSec;
  }
  t.tickCount++;
}

// ---------------------------------------------------------------------
// Strategy engine
// See the in-app "Strategy Settings" panel for a fuller writeup of the
// technique names this is based on (moving-average crossover, Wilder's
// RSI, fixed-fractional sizing).
// ---------------------------------------------------------------------
function evaluateStrategy(t, closesSlice, closePrice, atTime, candleTime, liveGate) {
  const fast = sma(closesSlice, params.smaFast);
  const slow = sma(closesSlice, params.smaSlow);
  const currentRsi = rsi(closesSlice, params.rsiPeriod);

  const prevFast = t.prevSmaFast, prevSlow = t.prevSmaSlow;
  t.prevSmaFast = fast;
  t.prevSmaSlow = slow;
  if (fast === null || slow === null) return;

  if (liveGate) {
    if (!state.algoRunning) return;
    if (!marketActiveNow()) return;
  }
  if (prevFast === null || prevSlow === null) return;

  const bullishCross = prevFast <= prevSlow && fast > slow;
  const bearishCross = prevFast >= prevSlow && fast < slow;
  const pos = t.position;

  if (pos.open) {
    const changeFromEntry = (closePrice - pos.entryPrice) / pos.entryPrice;
    if (changeFromEntry <= -params.stopLossPct / 100) {
      autoSell(t, closePrice, `Stop-loss (${fmtPct(changeFromEntry * 100)})`,
        `Price fell ${Math.abs(changeFromEntry * 100).toFixed(2)}% from the ${fmtMoney(pos.entryPrice)} entry, past the ${params.stopLossPct}% stop-loss threshold — the algorithm exits automatically to cap downside rather than hope for a recovery.`,
        atTime, candleTime);
      return;
    }
    if (changeFromEntry >= params.takeProfitPct / 100) {
      autoSell(t, closePrice, `Take-profit (${fmtPct(changeFromEntry * 100)})`,
        `Price rose ${(changeFromEntry * 100).toFixed(2)}% from the ${fmtMoney(pos.entryPrice)} entry, past the ${params.takeProfitPct}% take-profit target — the algorithm locks in the gain rather than risk giving it back.`,
        atTime, candleTime);
      return;
    }
    if (bearishCross) {
      autoSell(t, closePrice, `SMA(${params.smaFast}) crossed below SMA(${params.smaSlow})`,
        `The ${params.smaFast}-period moving average dropped below the ${params.smaSlow}-period average (a "death cross") — short-term momentum has turned bearish relative to the intermediate trend, so the algorithm exits the long position.`,
        atTime, candleTime);
      return;
    }
    if (currentRsi !== null && currentRsi > params.rsiOverbought) {
      autoSell(t, closePrice, `RSI overbought (${currentRsi.toFixed(1)})`,
        `RSI(${params.rsiPeriod}) rose above ${params.rsiOverbought}, a level conventionally read as overbought — the move looks statistically extended, so the algorithm takes profit rather than risk mean reversion.`,
        atTime, candleTime);
      return;
    }
  } else {
    const cooledDown = !t.lastExitAt || (atTime - t.lastExitAt) / 1000 >= params.cooldownSec;
    if (bullishCross && cooledDown && (currentRsi === null || currentRsi < params.rsiOverbought)) {
      autoBuy(t, closePrice, `SMA(${params.smaFast}) crossed above SMA(${params.smaSlow})`,
        `The ${params.smaFast}-period moving average rose above the ${params.smaSlow}-period average (a "golden cross") — short-term momentum has turned bullish relative to the intermediate trend, and RSI wasn't already overbought, so the algorithm opens a long position sized at ${params.allocationPct}% of available cash.`,
        atTime, candleTime);
    }
  }
}

function autoBuy(t, price, reason, detail, atTime, candleTime) {
  const budget = state.cash * (params.allocationPct / 100);
  const qty = Math.floor(budget / price);
  if (qty < 1) return;
  const cost = qty * price;
  state.cash -= cost;
  state.holdings[t.symbol] += qty;
  state.avgCost[t.symbol] = price;
  t.position = { open: true, entryPrice: price, qty };
  logTrade(t.symbol, "BUY", qty, price, reason, true, detail, atTime);
  addMarker(t, candleTime, "belowBar", "arrowUp", "#26d67f", "BUY");
}

function autoSell(t, price, reason, detail, atTime, candleTime) {
  const qty = state.holdings[t.symbol];
  if (qty < 1) { t.position = { open: false, entryPrice: 0, qty: 0 }; return; }
  state.cash += qty * price;
  state.holdings[t.symbol] = 0;
  t.position = { open: false, entryPrice: 0, qty: 0 };
  t.lastExitAt = atTime;
  logTrade(t.symbol, "SELL", qty, price, reason, true, detail, atTime);
  addMarker(t, candleTime, "aboveBar", "arrowDown", "#ff4d5e", "SELL");
}

function addMarker(t, time, position, shape, color, text) {
  t.markers.push({ time, position, color, shape, text });
  if (t.markers.length > 80) t.markers.shift();
}

// Replays the crossover/RSI/stop logic over a ticker's already-built
// candle history, as if its algo switch had been on the whole time —
// used when the user turns algo trading on for a ticker after the fact.
function replayStrategyOnHistory(t) {
  t.prevSmaFast = null;
  t.prevSmaSlow = null;
  t.position = { open: false, entryPrice: 0, qty: 0 };
  t.markers = [];
  for (let i = 0; i < t.candles.length; i++) {
    const slice = t.closes.slice(0, i + 1);
    const atTime = new Date(t.candles[i].time * 1000);
    evaluateStrategy(t, slice, t.closes[i], atTime, t.candles[i].time, false);
  }
}

// ---------------------------------------------------------------------
// Historical backfill — builds candle history for every ticker (so any
// of them can be selected with a real-looking chart) from either the
// real NYSE open (Live mode) or a rolling window (Demo mode), and lets
// the algorithm trade through it for whichever tickers start enabled.
// ---------------------------------------------------------------------
function sessionBounds() {
  const now = new Date();
  if (mode === "demo") {
    return { from: new Date(now.getTime() - DEMO_BACKFILL_HOURS * 3600 * 1000), to: now };
  }
  const info = nyMarketInfo(now);
  if (info.status === "pre" || info.status === "closed") return { from: null, to: null };
  const minutesSinceOpen = info.minuteOfDay - OPEN_MIN;
  const cappedMinutes = Math.min(minutesSinceOpen, MAX_BACKFILL_SECONDS / 60);
  return { from: new Date(now.getTime() - cappedMinutes * 60 * 1000), to: now };
}

function runBackfill() {
  const { from, to } = sessionBounds();
  if (!from) return;
  const totalSeconds = Math.min(Math.floor((to - from) / 1000), MAX_BACKFILL_SECONDS);
  const startMs = to.getTime() - totalSeconds * 1000;
  for (let i = 0; i < totalSeconds; i++) {
    const virtualTime = new Date(startMs + i * 1000);
    TICKERS.forEach(t => advanceTicker(t, virtualTime, false));
  }
  TICKERS.forEach(t => { if (t.algoEnabled) t.replayed = true; });
}

// ---------------------------------------------------------------------
// TWAP order execution ("Dump Position" / "Accumulate") — splits a
// large manual order into slices executed a few seconds apart instead
// of routing it all at once, to reduce market impact/slippage.
// ---------------------------------------------------------------------
function twapDump(t, pct) {
  const totalQty = Math.floor(state.holdings[t.symbol] * (pct / 100));
  if (totalQty < 1) { flashInsufficientFunds(t.symbol); return; }
  const slices = params.twapSlices;
  const base = Math.floor(totalQty / slices);
  let remainder = totalQty - base * slices;
  let i = 0;
  function fire() {
    i++;
    let qty = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    qty = Math.min(qty, state.holdings[t.symbol]);
    if (qty > 0) {
      const price = t.price;
      state.cash += qty * price;
      state.holdings[t.symbol] -= qty;
      if (state.holdings[t.symbol] === 0) t.position = { open: false, entryPrice: 0, qty: 0 };
      logTrade(t.symbol, "SELL", qty, price, `TWAP dump — slice ${i}/${slices}`, false,
        `Part of a TWAP (Time-Weighted Average Price) sell of ${totalQty} shares, split into ${slices} slices about ${params.twapInterval}s apart so the order doesn't hit the book all at once and move the price against you — the classic technique real desks use to unwind a large position quietly.`);
    }
    if (i < slices) setTimeout(fire, params.twapInterval * 1000);
  }
  fire();
}

function twapBuy(t, dollarAmount) {
  if (!dollarAmount || dollarAmount < 1 || dollarAmount > state.cash) { flashInsufficientFunds(t.symbol); return; }
  const slices = params.twapSlices;
  const sliceDollars = dollarAmount / slices;
  let i = 0;
  function fire() {
    i++;
    const price = t.price;
    const qty = Math.min(Math.floor(sliceDollars / price), Math.floor(state.cash / price));
    if (qty > 0) {
      const cost = qty * price;
      state.cash -= cost;
      const prevQty = state.holdings[t.symbol];
      const prevCost = state.avgCost[t.symbol] * prevQty;
      state.holdings[t.symbol] += qty;
      state.avgCost[t.symbol] = (prevCost + cost) / state.holdings[t.symbol];
      t.position = { open: true, entryPrice: state.avgCost[t.symbol], qty: state.holdings[t.symbol] };
      logTrade(t.symbol, "BUY", qty, price, `TWAP accumulate — slice ${i}/${slices}`, false,
        `Part of a TWAP buy deploying ${fmtMoney(dollarAmount)}, split into ${slices} slices about ${params.twapInterval}s apart so the order doesn't chase the price up against itself while filling.`);
    }
    if (i < slices) setTimeout(fire, params.twapInterval * 1000);
  }
  fire();
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
    t.position = { open: true, entryPrice: state.avgCost[symbol], qty: state.holdings[symbol] };
  } else {
    const sellQty = Math.min(qty, state.holdings[symbol]);
    if (sellQty < 1) return;
    state.cash += sellQty * price;
    state.holdings[symbol] -= sellQty;
    if (state.holdings[symbol] === 0) t.position = { open: false, entryPrice: 0, qty: 0 };
    qty = sellQty;
  }
  logTrade(symbol, side, qty, price, "Manual order", false, "You placed this order directly — it wasn't generated by the algorithm.");
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
function logTrade(symbol, side, qty, price, reason, auto, detail, atTime) {
  state.trades.unshift({ time: atTime || new Date(), symbol, side, qty, price, reason, auto, detail });
  if (state.trades.length > 400) state.trades.pop();
  renderBlotter();
}

function renderBlotter() {
  const body = document.getElementById("blotterBody");
  document.getElementById("blotterCount").textContent = `${state.trades.length} trade${state.trades.length === 1 ? "" : "s"}`;
  if (state.trades.length === 0) {
    body.innerHTML = `<tr class="blotter-empty"><td colspan="7">No trades yet — waiting on a signal…</td></tr>`;
    return;
  }
  body.innerHTML = state.trades.slice(0, 60).map((tr, idx) => `
    <tr data-idx="${idx}">
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
// Hover tooltip (trade blotter rows + ⓘ info dots)
// ---------------------------------------------------------------------
const tooltipEl = document.getElementById("hoverTooltip");
function showTooltip(x, y, text) {
  if (!text) return;
  tooltipEl.textContent = text;
  tooltipEl.style.left = Math.min(x + 14, window.innerWidth - 300) + "px";
  tooltipEl.style.top = (y + 14) + "px";
  tooltipEl.classList.add("visible");
}
function hideTooltip() { tooltipEl.classList.remove("visible"); }

document.addEventListener("mousemove", (e) => {
  const row = e.target.closest("#blotterBody tr[data-idx]");
  if (row) {
    const tr = state.trades[parseInt(row.dataset.idx, 10)];
    showTooltip(e.clientX, e.clientY, tr ? tr.detail : null);
    return;
  }
  const infoDot = e.target.closest(".info-dot");
  if (infoDot) { showTooltip(e.clientX, e.clientY, infoDot.dataset.tooltip); return; }
  hideTooltip();
});

// ---------------------------------------------------------------------
// Rendering: header, portfolio grid, selected-ticker chart
// ---------------------------------------------------------------------
function renderSpark(history, positive) {
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

function buildTickerGrid() {
  const grid = document.getElementById("tickerGrid");
  grid.innerHTML = TICKERS.map(t => `
    <div class="ticker-card" data-symbol="${t.symbol}">
      <div class="sym-block">
        <span class="sym">${t.symbol}</span>
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
        <button class="algo-toggle" data-symbol="${t.symbol}">Algo: OFF</button>
      </div>
    </div>`).join("");

  grid.addEventListener("click", (e) => {
    const card = e.target.closest(".ticker-card");
    if (!card) return;
    const symbol = card.dataset.symbol;

    const algoBtn = e.target.closest(".algo-toggle");
    if (algoBtn) { toggleAlgoForTicker(symbol); return; }

    const btn = e.target.closest("button[data-action]");
    if (btn) {
      const side = btn.dataset.action === "buy" ? "BUY" : "SELL";
      const qtyInput = grid.querySelector(`input[data-qty="${symbol}"]`);
      const qty = parseInt(qtyInput.value, 10) || 1;
      manualTrade(symbol, side, qty);
      return;
    }

    if (e.target.closest("input")) return; // editing qty shouldn't change selection
    selectTicker(symbol);
  });
}

function toggleAlgoForTicker(symbol) {
  const t = TICKERS.find(x => x.symbol === symbol);
  t.algoEnabled = !t.algoEnabled;
  if (t.algoEnabled && !t.replayed) {
    replayStrategyOnHistory(t);
    t.replayed = true;
  }
  updateTickerGrid();
  if (selectedSymbol === symbol) { updateSelectedHeader(); renderSelectedChart(); }
}

function updateTickerGrid() {
  TICKERS.forEach(t => {
    const change = ((t.price - t.sessionOpen) / t.sessionOpen) * 100;
    const positive = change >= 0;
    const held = state.holdings[t.symbol];

    document.getElementById(`spark-${t.symbol}`).innerHTML = renderSpark(t.history, positive);
    document.getElementById(`price-${t.symbol}`).textContent = fmtMoney(t.price);

    const changeEl = document.getElementById(`change-${t.symbol}`);
    changeEl.textContent = fmtPct(change);
    changeEl.className = "change " + (positive ? "positive" : "negative");

    document.getElementById(`holding-${t.symbol}`).textContent =
      held > 0 ? held + " sh · " + fmtMoney(held * t.price) : "—";

    const card = document.querySelector(`.ticker-card[data-symbol="${t.symbol}"]`);
    card.classList.toggle("selected", t.symbol === selectedSymbol);
    const algoBtn = card.querySelector(".algo-toggle");
    algoBtn.textContent = t.algoEnabled ? "Algo: ON" : "Algo: OFF";
    algoBtn.classList.toggle("on", t.algoEnabled);
  });
}

function selectTicker(symbol) {
  selectedSymbol = symbol;
  updateTickerGrid();
  updateSelectedHeader();
  renderSelectedChart();
}

function renderSelectedChart() {
  const t = TICKERS.find(x => x.symbol === selectedSymbol);
  if (!t) return;
  const allCandles = t.currentCandle ? [...t.candles, t.currentCandle] : [...t.candles];
  candleSeries.setData(allCandles);

  const closesWithCurrent = t.currentCandle ? [...t.closes, t.currentCandle.close] : [...t.closes];
  const times = allCandles.map(c => c.time);
  const fastSeries = [], slowSeries = [];
  for (let i = 0; i < closesWithCurrent.length; i++) {
    const upto = closesWithCurrent.slice(0, i + 1);
    const f = sma(upto, params.smaFast);
    const s = sma(upto, params.smaSlow);
    if (f !== null) fastSeries.push({ time: times[i], value: f });
    if (s !== null) slowSeries.push({ time: times[i], value: s });
  }
  smaFastLine.setData(fastSeries);
  smaSlowLine.setData(slowSeries);
  candleSeries.setMarkers(t.markers);

  const rsiNow = rsi(closesWithCurrent, params.rsiPeriod);
  document.getElementById("rsiValue").textContent = rsiNow !== null ? rsiNow.toFixed(1) : "--";
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
}

function updateSelectedHeader() {
  const t = TICKERS.find(x => x.symbol === selectedSymbol);
  if (!t) return;
  const change = ((t.price - t.sessionOpen) / t.sessionOpen) * 100;
  document.getElementById("selSymbol").textContent = t.symbol;
  document.getElementById("selName").textContent = t.name;
  document.getElementById("selPrice").textContent = fmtMoney(t.price);
  const chEl = document.getElementById("selChange");
  chEl.textContent = fmtPct(change);
  chEl.className = "ticker-change " + (change >= 0 ? "positive" : "negative");

  const pill = document.getElementById("selAlgoPill");
  pill.textContent = t.algoEnabled ? "ALGO ON" : "ALGO OFF";
  pill.classList.toggle("on", t.algoEnabled);

  document.getElementById("strategyNote").textContent =
    `Strategy: SMA(${params.smaFast}/${params.smaSlow}) crossover with RSI(${params.rsiPeriod}) filter, ${params.stopLossPct}% stop-loss, ${params.takeProfitPct}% take-profit. Position size: ${params.allocationPct}% of available cash per entry. ` +
    (t.algoEnabled ? `Auto-trading ${t.symbol} now.` : `Algo is off for ${t.symbol} — flip its switch in the portfolio panel to let the strategy trade it too.`);
}

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------
function tick() {
  if (marketActiveNow()) {
    TICKERS.forEach(t => advanceTicker(t, new Date(), true));
  }
  renderHeader();
  updateTickerGrid();
  updateSelectedHeader();
  renderSelectedChart();
  updateMarketClock();
}

// ---------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------
const settingsModal = document.getElementById("settingsModal");

function populateParamForm() {
  document.getElementById("paramSmaFast").value = params.smaFast;
  document.getElementById("paramSmaSlow").value = params.smaSlow;
  document.getElementById("paramRsiPeriod").value = params.rsiPeriod;
  document.getElementById("paramRsiOversold").value = params.rsiOversold;
  document.getElementById("paramRsiOverbought").value = params.rsiOverbought;
  document.getElementById("paramStopLoss").value = params.stopLossPct;
  document.getElementById("paramTakeProfit").value = params.takeProfitPct;
  document.getElementById("paramAllocation").value = params.allocationPct;
  document.getElementById("paramCooldown").value = params.cooldownSec;
  document.getElementById("paramTwapSlices").value = params.twapSlices;
  document.getElementById("paramTwapInterval").value = params.twapInterval;
}

function clampInt(id, min, max, fallback) {
  const v = parseInt(document.getElementById(id).value, 10);
  return isNaN(v) ? fallback : Math.min(max, Math.max(min, v));
}
function clampFloat(id, min, max, fallback) {
  const v = parseFloat(document.getElementById(id).value);
  return isNaN(v) ? fallback : Math.min(max, Math.max(min, v));
}

function refreshLegend() {
  document.getElementById("legendFast").textContent = params.smaFast;
  document.getElementById("legendSlow").textContent = params.smaSlow;
  document.getElementById("legendRsiPeriod").textContent = params.rsiPeriod;
}

document.getElementById("settingsBtn").addEventListener("click", () => {
  populateParamForm();
  settingsModal.classList.add("visible");
});
document.getElementById("settingsClose").addEventListener("click", () => settingsModal.classList.remove("visible"));
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.classList.remove("visible"); });

document.getElementById("paramsApply").addEventListener("click", () => {
  params = {
    smaFast: clampInt("paramSmaFast", 2, 50, DEFAULT_PARAMS.smaFast),
    smaSlow: clampInt("paramSmaSlow", 3, 200, DEFAULT_PARAMS.smaSlow),
    rsiPeriod: clampInt("paramRsiPeriod", 2, 50, DEFAULT_PARAMS.rsiPeriod),
    rsiOversold: clampInt("paramRsiOversold", 1, 49, DEFAULT_PARAMS.rsiOversold),
    rsiOverbought: clampInt("paramRsiOverbought", 51, 99, DEFAULT_PARAMS.rsiOverbought),
    stopLossPct: clampFloat("paramStopLoss", 0.5, 50, DEFAULT_PARAMS.stopLossPct),
    takeProfitPct: clampFloat("paramTakeProfit", 0.5, 100, DEFAULT_PARAMS.takeProfitPct),
    allocationPct: clampInt("paramAllocation", 1, 100, DEFAULT_PARAMS.allocationPct),
    cooldownSec: clampInt("paramCooldown", 0, 600, DEFAULT_PARAMS.cooldownSec),
    twapSlices: clampInt("paramTwapSlices", 2, 20, DEFAULT_PARAMS.twapSlices),
    twapInterval: clampInt("paramTwapInterval", 1, 30, DEFAULT_PARAMS.twapInterval),
  };
  localStorage.setItem("mtt_params", JSON.stringify(params));
  refreshLegend();
  updateSelectedHeader();
  renderSelectedChart();
  settingsModal.classList.remove("visible");
});

document.getElementById("paramsResetDefaults").addEventListener("click", () => {
  const defaults = { ...DEFAULT_PARAMS };
  document.getElementById("paramSmaFast").value = defaults.smaFast;
  document.getElementById("paramSmaSlow").value = defaults.smaSlow;
  document.getElementById("paramRsiPeriod").value = defaults.rsiPeriod;
  document.getElementById("paramRsiOversold").value = defaults.rsiOversold;
  document.getElementById("paramRsiOverbought").value = defaults.rsiOverbought;
  document.getElementById("paramStopLoss").value = defaults.stopLossPct;
  document.getElementById("paramTakeProfit").value = defaults.takeProfitPct;
  document.getElementById("paramAllocation").value = defaults.allocationPct;
  document.getElementById("paramCooldown").value = defaults.cooldownSec;
  document.getElementById("paramTwapSlices").value = defaults.twapSlices;
  document.getElementById("paramTwapInterval").value = defaults.twapInterval;
});

// ---------------------------------------------------------------------
// TWAP command buttons
// ---------------------------------------------------------------------
document.getElementById("twapDumpBtn").addEventListener("click", () => {
  const t = TICKERS.find(x => x.symbol === selectedSymbol);
  const pct = parseFloat(document.getElementById("twapDumpPct").value) || 100;
  twapDump(t, Math.min(100, Math.max(1, pct)));
});
document.getElementById("twapBuyBtn").addEventListener("click", () => {
  const t = TICKERS.find(x => x.symbol === selectedSymbol);
  const amt = parseFloat(document.getElementById("twapBuyAmount").value) || 0;
  twapBuy(t, amt);
});

// ---------------------------------------------------------------------
// Mode toggle (Demo vs Live NYSE hours) + pause/resume + reset
// ---------------------------------------------------------------------
document.getElementById("modeToggle").addEventListener("click", () => {
  mode = mode === "demo" ? "live" : "demo";
  localStorage.setItem("mtt_mode", mode);
  location.reload();
});

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
  if (!confirm("Reset cash, holdings, and trade history back to $100,000? (Your strategy settings and mode stay as configured.)")) return;
  location.reload();
});

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
document.getElementById("modeToggle").textContent = "Mode: " + (mode === "demo" ? "Demo" : "Live NYSE Hours");
refreshLegend();
buildTickerGrid();
runBackfill();
selectTicker("MSFT");
renderBlotter();
renderHeader();
updateTickerGrid();
updateMarketClock();
setInterval(tick, TICK_MS);
tick();
