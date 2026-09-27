const WS_URLS = ["wss://api.derivws.com/trading/v1/options/ws/public","wss://ws.binaryws.com/websockets/v3"];
let wsAttempt = 0;
const OTP_URL = "https://api.derivws.com/trading/v1/options/accounts";
const TRADE_THRESHOLD = 75;
const WINDOW = 120;
const SYNTHETIC_MARKETS = [
  ["1HZ10V","Volatility 10 (1s)"],["1HZ15V","Volatility 15 (1s)"],["1HZ25V","Volatility 25 (1s)"],
  ["1HZ30V","Volatility 30 (1s)"],["1HZ50V","Volatility 50 (1s)"],["1HZ75V","Volatility 75 (1s)"],
  ["1HZ90V","Volatility 90 (1s)"],["1HZ100V","Volatility 100 (1s)"],
  ["R_10","Volatility 10"],["R_25","Volatility 25"],["R_50","Volatility 50"],["R_75","Volatility 75"],["R_100","Volatility 100"],
  ["JD10","Jump 10"],["JD25","Jump 25"],["JD50","Jump 50"],["JD75","Jump 75"],["JD100","Jump 100"]
];

const state = {
  ws: null,
  connected: false,
  symbols: [],
  selected: new Set(),
  ticks: new Map(),
  frozen: [],
  scanning: false,
  apiWs: null,
  apiPoll: null,
  monitoredContracts: new Set()
};

const $ = id => document.getElementById(id);
const feedBadge = $("feedBadge");
const feedMessage = $("feedMessage");
const marketsEl = $("markets");
const resultsEl = $("results");
const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const scanBtn = $("scanBtn");
const toggleMarketsBtn = $("toggleMarketsBtn");
const marketsWrap = $("marketsWrap");
const marketSummary = $("marketSummary");
const clearAllBtn = $("clearAllBtn");
const scanProgress = $("scanProgress");
const scanSeconds = $("scanSeconds");
const progressBar = $("progressBar");
const marketStatus = $("marketStatus");
const apiStatus = $("apiStatus");
const botStatus = $("botStatus");
const apiConnectBtn = $("apiConnectBtn");
const apiDisconnectBtn = $("apiDisconnectBtn");

function setFeedStatus(online, message) {
  state.connected = online;
  marketStatus.textContent = online ? "Connected" : "Disconnected";
  marketStatus.className = online ? "online" : "";
  feedBadge.textContent = online ? "Feed online" : "Feed offline";
  feedBadge.className = "badge " + (online ? "online" : "offline");
  feedMessage.textContent = message;
  connectBtn.disabled = online;
  disconnectBtn.disabled = !online;
  scanBtn.disabled = !online || state.selected.size === 0;
}

function send(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function connect() {
  if (state.ws) { try { state.ws.close(); } catch (_) {} }
  const url = WS_URLS[wsAttempt % WS_URLS.length];
  feedMessage.textContent = "Connecting to Deriv public market data…";
  connectBtn.disabled = true;
  state.ws = new WebSocket(url);
  state.ws.onopen = () => {
    wsAttempt = 0;
    const list = SYNTHETIC_MARKETS.map(([symbol, name]) => ({underlying_symbol:symbol, underlying_symbol_name:name}));
    state.symbols = list;
    state.selected = new Set(list.map(s => s.underlying_symbol));
    marketSummary.textContent = list.length + " Matches markets ready";
    renderMarkets();
    list.forEach((s,i) => {
      const symbol=s.underlying_symbol; state.ticks.set(symbol,[]);
      send({ticks_history:symbol,count:WINDOW,end:"latest",style:"ticks",req_id:1000+i});
      send({ticks:symbol,subscribe:1,req_id:2000+i});
    });
    setFeedStatus(true,"Live Matches market data connected. Loading ticks…");
  };
  state.ws.onmessage = event => { try { handleMessage(JSON.parse(event.data)); } catch (_) {} };
  state.ws.onerror = () => { try { state.ws.close(); } catch (_) {} };
  state.ws.onclose = () => {
    if (state.connected) { setFeedStatus(false,"Connection closed."); return; }
    if (wsAttempt < WS_URLS.length-1) {
      wsAttempt++; feedMessage.textContent="Trying the backup Deriv market connection…";
      setTimeout(connect,400);
    } else {
      wsAttempt=0; setFeedStatus(false,"Unable to open Deriv market data from this browser/network.");
      connectBtn.disabled=false;
    }
  };
}
function disconnect() {
  if (state.ws) state.ws.close();
  state.ws = null;
  setFeedStatus(false, "Disconnected.");
}

function handleMessage(data) {
  if (data.error) {
    feedMessage.textContent = data.error.message || "Deriv returned a market-data message error.";
    // Keep the WebSocket online if the error was only for the optional symbol-list request.
    return;
  }
  if (data.msg_type === "active_symbols") {
    const active = data.active_symbols || [];
    const available = new Map(active.map(s => [
      s.underlying_symbol || s.symbol,
      s.underlying_symbol_name || s.display_name
    ]));
    const list = SYNTHETIC_MARKETS
      .filter(([symbol]) => !active.length || available.has(symbol) || /^(1HZ|R_|JD)/i.test(symbol))
      .map(([symbol, fallbackName]) => ({
        underlying_symbol: symbol,
        underlying_symbol_name: available.get(symbol) || fallbackName
      }));
    state.symbols = list;
    state.selected = new Set(list.map(s => s.underlying_symbol));
    marketSummary.textContent = list.length + " Matches markets ready";
    renderMarkets();
    list.forEach(s => {
      const symbol = s.underlying_symbol;
      state.ticks.set(symbol, []);
      send({ ticks_history: symbol, count: WINDOW, end: "latest", style: "ticks", req_id: 1000 + list.indexOf(s) });
      send({ ticks: symbol, subscribe: 1, req_id: 2000 + list.indexOf(s) });
    });
    setFeedStatus(true, list.length ? "Live Matches markets connected. Ticks are loading…" : "No synthetic markets available.");
  }
  if (data.msg_type === "history" && data.history) {
    const symbol = data.echo_req?.ticks_history;
    const prices = data.history.prices || [];
    const times = data.history.times || [];
    if (symbol && prices.length) {
      const digits = [];
      prices.forEach((price,i) => {
        const quote = Number(price);
        if (!Number.isFinite(quote)) return;
        const text = String(price);
        const decimals = text.includes(".") ? text.split(".")[1].length : 0;
        digits.push({digit:Number(text.replace(/\D/g,"").slice(-1)),epoch:times[i],quote});
      });
      state.ticks.set(symbol,digits.slice(-WINDOW));
      updateTickCount();
    }
  }
  if (data.msg_type === "tick" && data.tick) {
    const symbol = data.tick.symbol || data.tick.underlying_symbol;
    const quote = Number(data.tick.quote);
    if (!Number.isFinite(quote)) return;
    const digits = state.ticks.get(symbol) || [];
    const pipSize = Number.isFinite(Number(data.tick.pip_size))
      ? Number(data.tick.pip_size)
      : inferPipSize(quote);
    const digit = extractLastDigit(quote, pipSize);
    digits.push({ digit, epoch: data.tick.epoch, quote });
    if (digits.length > WINDOW) digits.splice(0, digits.length - WINDOW);
    state.ticks.set(symbol, digits);
    updateTickCount();
  }
}

function updateTickCount() { $("tickCount").textContent = [...state.ticks.values()].reduce((n,a)=>n+a.length,0) + " ticks"; }

function inferPipSize(quote) {
  const text = String(quote);
  const decimals = text.includes(".") ? text.split(".")[1].length : 0;
  return decimals;
}

function extractLastDigit(quote, pipSize) {
  const fixed = Number(quote).toFixed(Math.max(0, pipSize));
  const digits = fixed.replace(/\D/g, "");
  return Number(digits.slice(-1));
}

function renderMarkets() {
  if (!state.symbols.length) {
    marketsEl.innerHTML = '<div class="empty">No Volatility/Jump markets were returned.</div>';
    return;
  }
  marketsEl.innerHTML = state.symbols.map(s => {
    const symbol = s.underlying_symbol || s.symbol;
    const name = s.underlying_symbol_name || s.display_name || symbol;
    const checked = state.selected.has(symbol) ? "checked" : "";
    return '<label class="market"><input type="checkbox" data-symbol="' + escapeHtml(symbol) + '" ' + checked + '> <span>' + escapeHtml(name) + '</span></label>';
  }).join("");
  marketsEl.querySelectorAll("input").forEach(input => input.addEventListener("change", e => {
    const symbol = e.target.dataset.symbol;
    if (e.target.checked) state.selected.add(symbol); else state.selected.delete(symbol);
    scanBtn.disabled = !state.connected || state.selected.size === 0;
  }));
}

async function scan() {
  if (state.scanning || !state.connected || state.selected.size === 0) return;
  state.scanning = true;
  scanBtn.disabled = true;
  scanProgress.classList.remove("hidden");
  resultsEl.innerHTML = '<div class="empty">Scanning markets…</div>';
  const started = Date.now();
  await new Promise(resolve => {
    const timer = setInterval(() => {
      const elapsed = Math.min(25000, Date.now() - started);
      const left = Math.max(0, Math.ceil((25000 - elapsed) / 1000));
      scanSeconds.textContent = left + "s";
      progressBar.style.width = Math.round(elapsed / 250) + "%";
      if (elapsed >= 25000) { clearInterval(timer); resolve(); }
    }, 250);
  });
  const generated = [...state.selected].map(symbol => {
    const sample = state.ticks.get(symbol) || [];
    return sample.length < 30 ? {symbol, insufficient:true, count:sample.length} : buildSignal(symbol,sample);
  });
  state.frozen = generated;
  scanProgress.classList.add("hidden");
  renderResults();
  state.scanning = false;
  scanBtn.disabled = !state.connected || state.selected.size === 0;
}
function buildSignal(symbol, sample) {
  const counts = Array(10).fill(0);
  sample.forEach(x => counts[x.digit]++);
  const ranked = counts.map((count,digit)=>({digit,count})).sort((a,b)=>b.count-a.count || a.digit-b.digit);
  const candidate = ranked[0];
  const total = sample.length;
  const share = candidate.count / total;
  const second = ranked[1].count / total;
  const dominance = Math.max(0, share - second);
  const recent = sample.slice(-30);
  const recentCount = recent.filter(x => x.digit === candidate.digit).length;
  const recentShare = recentCount / recent.length;

  // Transparent scanner score: historical frequency + recent consistency.
  // It is a signal-strength score, not a probability of winning the next tick.
  const strength = Math.min(95, Math.round(50 + dominance * 120 + Math.max(0, recentShare - 0.10) * 80));
  const action = strength >= TRADE_THRESHOLD ? "TRADE NOW" : "WAIT";

  return {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(),
    symbol, digit: candidate.digit, strength, action,
    evidence: Math.round(share * 10000) / 100,
    recentEvidence: Math.round(recentShare * 10000) / 100,
    distribution: counts,
    sampleSize: total,
    generatedAt: new Date().toISOString()
  };
}

function renderResults() {
  if (!state.frozen.length) {
    resultsEl.innerHTML = '<div class="empty">No frozen signal yet.</div>';
    return;
  }
  resultsEl.innerHTML = state.frozen.map(r => {
    if (r.insufficient) return '<div class="result wait"><strong>' + escapeHtml(r.symbol) + '</strong><p>Collecting ticks: ' + r.count + '/30</p></div>';
    const trade = r.action === "TRADE NOW";
    const ranked = r.distribution.map((count,digit)=>({digit,count}))
      .sort((a,b)=>b.count-a.count || a.digit-b.digit);
    const top = ranked[0].digit, second = ranked[1].digit;
    const low = ranked[ranked.length-1].digit, secondLow = ranked[ranked.length-2].digit;
    const board = r.distribution.map((count,digit) => {
      let cls = "", mark = "";
      if (digit === top) { cls = "top"; mark = "💚"; }
      else if (digit === second) { cls = "second"; mark = "💙"; }
      else if (digit === low) { cls = "low"; mark = "❤️"; }
      else if (digit === secondLow) { cls = "second-low"; mark = "🧡"; }
      return '<div class="digit-tile ' + cls + '"><span class="digit-mark">' + mark + '</span><div class="num">' + digit + '</div><small>' + count + '×</small></div>';
    }).join("");
    return '<article class="result ' + (trade ? "trade" : "wait") + '">' +
      '<div class="result-top"><div><strong>' + escapeHtml(r.symbol) + '</strong><div class="digit">MATCH ' + r.digit + '</div></div>' +
      '<div class="' + (trade ? "trade-label" : "wait-label") + '">' + r.action + '</div></div>' +
      '<div class="distribution-title"><strong>Digit distribution</strong><span class="note">' + r.sampleSize + ' ticks</span></div>' +
      '<div class="digit-board">' + board + '</div>' +
      '<div class="legend"><span>💚 Most</span><span>💙 2nd highest</span><span>❤️ Least</span><span>🧡 2nd least</span></div>' +
      '<div class="metrics"><div class="metric"><small>Strength</small><strong>' + r.strength + '%</strong></div>' +
      '<div class="metric"><small>Evidence</small><strong>' + r.evidence + '%</strong></div>' +
      '<div class="metric"><small>Recent</small><strong>' + r.recentEvidence + '%</strong></div></div>' +
      '<p class="note">Frozen ' + new Date(r.generatedAt).toLocaleTimeString() + '</p>' +
      '</article>';
  }).join("");
};

function initScanner() {
  toggleMarketsBtn.addEventListener("click", () => {
    const hidden = marketsWrap.classList.toggle("hidden");
    toggleMarketsBtn.textContent = hidden ? "Show markets" : "Hide markets";
  });
  clearAllBtn.addEventListener("click", () => {
    state.selected.clear(); renderMarkets();
    scanBtn.disabled = !state.connected || state.selected.size === 0;
  });
  apiConnectBtn.addEventListener("click", connectApi);
  apiDisconnectBtn.addEventListener("click", () => disconnectApi());
  connectBtn.addEventListener("click", connect);
  disconnectBtn.addEventListener("click", disconnect);
  scanBtn.addEventListener("click", scan);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initScanner, {once:true});
else initScanner();
