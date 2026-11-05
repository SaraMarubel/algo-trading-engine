/* =========================================================================
   Live news panel
   Real headlines from Finnhub's company-news endpoint, filtered to the
   tickers you are exposed to in the simulation: anything you hold shares
   in, plus anything with its Algo switch on. Prices stay simulated; only
   the headlines are real.
   Relies on globals from app.js (TICKERS, state).
   ========================================================================= */

(function () {
  const API = "https://finnhub.io/api/v1/company-news";
  const TTL_MS = 5 * 60 * 1000;        // re-fetch a ticker's news at most every 5 minutes
  const LOOKBACK_DAYS = 3;
  const PER_SYMBOL = 5;                // articles kept per ticker
  const MAX_SHOWN = 14;
  const BACKOFF_MS = 60 * 1000;        // pause after a rate-limit response

  // Finnhub tags broad market stories (many from Yahoo) with every ticker they
  // loosely touch, so a headline only counts for a ticker if it actually names
  // the company or one of its products.
  const RELEVANCE = {
    MSFT: /\b(microsoft|msft|azure|copilot)\b/i,
    AAPL: /\b(apple|aapl|iphone)\b/i,
    GOOGL: /\b(alphabet|google|googl|waymo|youtube)\b/i,
    AMZN: /\b(amazon|amzn|aws)\b/i,
    NVDA: /\b(nvidia|nvda)\b/i,
    META: /\b(meta|facebook|instagram|whatsapp)\b/i,
  };

  const cache = {};                    // symbol -> { fetchedAt, articles }
  const inflight = new Set();
  let blockedUntil = 0;
  let lastError = null;

  const listEl = document.getElementById("newsList");
  const statusEl = document.getElementById("newsStatus");
  const chipsEl = document.getElementById("newsChips");
  if (!listEl) return;

  const key = (window.NEWS_CONFIG && window.NEWS_CONFIG.finnhubKey || "").trim();

  function exposedSymbols() {
    return TICKERS
      .filter(t => state.holdings[t.symbol] > 0 || t.algoEnabled)
      .map(t => ({ symbol: t.symbol, held: state.holdings[t.symbol] > 0 }));
  }

  function isoDay(d) { return d.toISOString().slice(0, 10); }

  function timeAgo(unixSec) {
    const mins = Math.max(0, Math.round((Date.now() / 1000 - unixSec) / 60));
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  function safeUrl(u) {
    try {
      const p = new URL(u);
      return p.protocol === "https:" || p.protocol === "http:" ? p.href : null;
    } catch (e) { return null; }
  }

  async function fetchSymbol(symbol) {
    if (inflight.has(symbol) || Date.now() < blockedUntil) return;
    const cached = cache[symbol];
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return;

    inflight.add(symbol);
    const to = new Date();
    const from = new Date(to.getTime() - LOOKBACK_DAYS * 86400000);
    const url = `${API}?symbol=${encodeURIComponent(symbol)}&from=${isoDay(from)}&to=${isoDay(to)}&token=${encodeURIComponent(key)}`;
    try {
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) {
        lastError = "Finnhub rejected the API key. Check it in config.js.";
        cache[symbol] = { fetchedAt: Date.now(), articles: [] };
      } else if (res.status === 429) {
        lastError = "Finnhub rate limit reached. Pausing for a minute.";
        blockedUntil = Date.now() + BACKOFF_MS;
      } else if (!res.ok) {
        lastError = `Finnhub returned an error (${res.status}).`;
      } else {
        const data = await res.json();
        const articles = (Array.isArray(data) ? data : [])
          .filter(a => a && a.headline && a.datetime)
          .filter(a => !RELEVANCE[symbol] || RELEVANCE[symbol].test(a.headline))
          .sort((a, b) => b.datetime - a.datetime)
          .slice(0, PER_SYMBOL)
          .map(a => ({
            symbol,
            headline: a.headline,
            source: a.source || "",
            url: safeUrl(a.url),
            datetime: a.datetime,
          }));
        cache[symbol] = { fetchedAt: Date.now(), articles };
        lastError = null;
      }
    } catch (e) {
      lastError = "Couldn't reach Finnhub. Check your connection.";
    } finally {
      inflight.delete(symbol);
      render();
    }
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", !!isError);
  }

  function showMessage(html) {
    listEl.replaceChildren();
    const p = document.createElement("div");
    p.className = "news-empty";
    p.innerHTML = html;
    listEl.appendChild(p);
  }

  function render() {
    const exposed = exposedSymbols();

    chipsEl.replaceChildren();
    exposed.forEach(e => {
      const c = document.createElement("span");
      c.className = "news-chip" + (e.held ? " held" : "");
      c.textContent = e.symbol;
      c.title = e.held ? "You hold shares" : "Algo is on";
      chipsEl.appendChild(c);
    });

    if (!key) {
      setStatus("Not connected", true);
      showMessage('Add a free Finnhub key in <code>config.js</code> to turn on live headlines. See the README for the 2-minute setup.');
      return;
    }
    if (exposed.length === 0) {
      setStatus("Waiting", false);
      showMessage("Buy a stock or switch its Algo on, and its news will appear here.");
      return;
    }

    const articles = exposed
      .flatMap(e => (cache[e.symbol] ? cache[e.symbol].articles : []))
      .sort((a, b) => b.datetime - a.datetime)
      .slice(0, MAX_SHOWN);

    if (lastError) setStatus(lastError, true);
    else setStatus("Live · refreshes every 5 min", false);

    if (articles.length === 0) {
      const pending = exposed.some(e => !cache[e.symbol]);
      showMessage(pending ? "Loading headlines…" : "No recent headlines for these tickers.");
      return;
    }

    listEl.replaceChildren();
    articles.forEach(a => {
      const row = document.createElement(a.url ? "a" : "div");
      row.className = "news-item";
      if (a.url) { row.href = a.url; row.target = "_blank"; row.rel = "noopener noreferrer"; }

      const tag = document.createElement("span");
      tag.className = "news-tag";
      tag.textContent = a.symbol;

      const body = document.createElement("span");
      body.className = "news-body";
      const head = document.createElement("span");
      head.className = "news-headline";
      head.textContent = a.headline;
      const meta = document.createElement("span");
      meta.className = "news-meta";
      meta.textContent = `${a.source} · ${timeAgo(a.datetime)}`;
      body.append(head, meta);

      row.append(tag, body);
      listEl.appendChild(row);
    });
  }

  function refresh() {
    if (key) exposedSymbols().forEach(e => fetchSymbol(e.symbol));
    render();
  }

  refresh();
  setInterval(refresh, 5000);          // cheap: only hits the network when a ticker's cache is stale
})();
