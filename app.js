const WS_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
const TRADE_THRESHOLD = 75;
const WINDOW = 120;

const state = {
  ws: null,
  connected: false,
  symbols: [],
  selected: new Set(),
  ticks: new Map(),
  frozen: []
};

const $ = id => document.getElementById(id);
const feedBadge = $("feedBadge");
const feedMessage = $("feedMessage");
const marketsEl = $("markets");
const resultsEl = $("results");
const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const scanBtn = $("scanBtn");

function setFeedStatus(online, message) {
  state.connected = online;
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
  if (state.ws) state.ws.close();
  state.ws = new WebSocket(WS_URL);
  feedMessage.textContent = "Connecting to Deriv public market data…";
  state.ws.onopen = () => {
    setFeedStatus(true, "Connected. Loading available synthetic markets…");
    send({ active_symbols: "brief", req_id: 1 });
  };
  state.ws.onmessage = event => handleMessage(JSON.parse(event.data));
  state.ws.onerror = () => setFeedStatus(false, "WebSocket error. Check the browser/network connection and try again.");
  state.ws.onclose = () => {
    if (state.connected) setFeedStatus(false, "Market feed disconnected.");
  };
}

function disconnect() {
  if (state.ws) state.ws.close();
  state.ws = null;
  setFeedStatus(false, "Disconnected.");
}

function handleMessage(data) {
  if (data.error) {
    setFeedStatus(false, data.error.message || "Deriv returned an error.");
    return;
  }
  if (data.msg_type === "active_symbols") {
    const list = (data.active_symbols || [])
      .filter(s => /volatility|jump/i.test(s.display_name || ""))
      .sort((a,b) => (a.display_name || "").localeCompare(b.display_name || ""));
    state.symbols = list;
    renderMarkets();
    list.forEach(s => {
      state.ticks.set(s.underlying_symbol, []);
      send({ ticks: s.underlying_symbol, subscribe: 1 });
    });
    setFeedStatus(true, list.length ? "Live market feed connected." : "Connected, but no matching synthetic markets were returned.");
  }
  if (data.msg_type === "tick" && data.tick) {
    const symbol = data.tick.symbol;
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
    $("tickCount").textContent = [...state.ticks.values()].reduce((n,a)=>n+a.length,0) + " ticks";
  }
}

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
    const symbol = s.underlying_symbol;
    const name = s.underlying_symbol_name || symbol;
    const checked = state.selected.has(symbol) ? "checked" : "";
    return '<label class="market"><input type="checkbox" data-symbol="' + escapeHtml(symbol) + '" ' + checked + '> <span>' + escapeHtml(name) + '</span></label>';
  }).join("");
  marketsEl.querySelectorAll("input").forEach(input => input.addEventListener("change", e => {
    const symbol = e.target.dataset.symbol;
    if (e.target.checked) state.selected.add(symbol); else state.selected.delete(symbol);
    scanBtn.disabled = !state.connected || state.selected.size === 0;
  }));
}

function scan() {
  const selected = [...state.selected];
  const generated = selected.map(symbol => {
    const sample = state.ticks.get(symbol) || [];
    if (sample.length < 30) return { symbol, insufficient: true, count: sample.length };
    return buildSignal(symbol, sample);
  }).filter(Boolean);

  state.frozen = generated;
  renderResults();
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
    sampleSize: total,
    generatedAt: new Date().toISOString()
  };
}

function renderResults() {
  if (!state.frozen.length) {
    resultsEl.innerHTML = '<div class="empty">No signal generated.</div>';
    return;
  }
  resultsEl.innerHTML = state.frozen.map(r => {
    if (r.insufficient) return '<div class="result wait"><strong>' + escapeHtml(r.symbol) + '</strong><p>Collecting ticks: ' + r.count + '/30</p></div>';
    const trade = r.action === "TRADE NOW";
    return '<article class="result ' + (trade ? "trade" : "wait") + '">' +
      '<div class="result-top"><div><strong>' + escapeHtml(r.symbol) + '</strong><div class="digit">MATCH ' + r.digit + '</div></div>' +
      '<div class="' + (trade ? "trade-label" : "wait-label") + '">' + r.action + '</div></div>' +
      '<div class="metrics"><div class="metric"><small>Strength</small><strong>' + r.strength + '%</strong></div>' +
      '<div class="metric"><small>Evidence</small><strong>' + r.evidence + '%</strong></div>' +
      '<div class="metric"><small>Recent</small><strong>' + r.recentEvidence + '%</strong></div></div>' +
      '<p class="note">Frozen ' + new Date(r.generatedAt).toLocaleTimeString() + ' • ' + r.sampleSize + ' ticks</p>' +
      '</article>';
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

connectBtn.addEventListener("click", connect);
disconnectBtn.addEventListener("click", disconnect);
scanBtn.addEventListener("click", scan);
$("selectAllBtn").addEventListener("click", () => {
  state.symbols.forEach(s => state.selected.add(s.underlying_symbol));
  renderMarkets();
  scanBtn.disabled = !state.connected || state.selected.size === 0;
});