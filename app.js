const WS_URL = "wss://ws.binaryws.com/websockets/v3";
const OTP_URL = "https://api.derivws.com/trading/v1/options/accounts";
const TRADE_THRESHOLD = 75;
const WINDOW = 120;

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
  if (state.ws) state.ws.close();
  state.ws = new WebSocket(WS_URL);
  feedMessage.textContent = "Connecting to Deriv public market data…";
  state.ws.onopen = () => {
    setFeedStatus(true, "Connected. Loading available synthetic markets…");
    send({ active_symbols: "brief", product_type: "basic", req_id: 1 });
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
      .filter(s => {
        const name = String(s.underlying_symbol_name || s.display_name || "").toLowerCase();
        const symbol = String(s.underlying_symbol || s.symbol || "").toLowerCase();
        return /volatility|jump/.test(name) ||
          /^(r_10|r_25|r_50|r_75|r_100|1hz\d+v|jd\d+)/i.test(symbol);
      })
      .sort((a,b) => String(a.underlying_symbol_name || a.display_name || a.underlying_symbol || "")
        .localeCompare(String(b.underlying_symbol_name || b.display_name || b.underlying_symbol || "")));
    state.symbols = list;
    marketSummary.textContent = list.length + " synthetic markets available";
    renderMarkets();
    list.forEach(s => {
      const symbol = s.underlying_symbol || s.symbol;
      state.ticks.set(symbol, []);
      send({ ticks: symbol, subscribe: 1 });
    });
    setFeedStatus(true, list.length ? "Live market feed connected." : "Connected, but no matching synthetic markets were returned.");
  }
  if (data.msg_type === "tick" && data.tick) {
    const symbol = data.tick.underlying_symbol || data.tick.symbol;
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
    const symbol = s.underlying_symbol || s.symbol;
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

toggleMarketsBtn.addEventListener("click", () => {
  const hidden = marketsWrap.classList.toggle("hidden");
  toggleMarketsBtn.textContent = hidden ? "Show markets" : "Hide markets";
});
clearAllBtn.addEventListener("click", () => {
  state.selected.clear();
  renderMarkets();
  scanBtn.disabled = !state.connected || state.selected.size === 0;
});

async function connectApi() {
  const token = $("token").value.trim(), appId = $("appId").value.trim(), accountId = $("accountId").value.trim();
  if (!token || !appId || !accountId) { apiStatus.textContent = "Enter token, App ID and Account ID"; return; }
  apiConnectBtn.disabled = true;
  apiStatus.textContent = "Authenticating…";
  try {
    const res = await fetch(OTP_URL + "/" + encodeURIComponent(accountId) + "/otp", {method:"POST",headers:{"Authorization":"Bearer "+token,"Deriv-App-ID":appId}});
    const data = await res.json();
    if (!res.ok || !data?.data?.url) throw new Error(data?.error?.message || "Authentication failed");
    state.apiWs = new WebSocket(data.data.url);
    state.apiWs.onopen = () => {
      apiStatus.textContent = "Connected"; apiStatus.className="online";
      botStatus.textContent = "Connected — monitoring"; botStatus.className="online";
      apiDisconnectBtn.disabled=false;
      state.apiWs.send(JSON.stringify({portfolio:1,req_id:101}));
      state.apiPoll=setInterval(()=>{if(state.apiWs?.readyState===WebSocket.OPEN)state.apiWs.send(JSON.stringify({portfolio:1,req_id:Date.now()%1000000}));},4000);
    };
    state.apiWs.onmessage=e=>handleApiMessage(JSON.parse(e.data));
    state.apiWs.onerror=()=>{apiStatus.textContent="Connection error";apiStatus.className="";};
    state.apiWs.onclose=()=>disconnectApi(false);
  } catch(e) { apiStatus.textContent=e.message||"Authentication failed"; apiStatus.className=""; apiConnectBtn.disabled=false; }
}
function handleApiMessage(data) {
  if(data.error){apiStatus.textContent=data.error.message||"API error";apiStatus.className="";return;}
  if(data.msg_type==="portfolio") (data.portfolio?.contracts||[]).forEach(c=>{
    const id=String(c.contract_id||""); if(!id||state.monitoredContracts.has(id))return;
    state.monitoredContracts.add(id);
    state.apiWs.send(JSON.stringify({proposal_open_contract:1,contract_id:id,subscribe:1,req_id:Date.now()%1000000}));
  });
  if(data.msg_type==="proposal_open_contract" && data.proposal_open_contract?.status) botStatus.textContent="Connected — contract "+data.proposal_open_contract.status;
}
function disconnectApi(update=true) {
  if(state.apiPoll)clearInterval(state.apiPoll); state.apiPoll=null;
  if(state.apiWs && state.apiWs.readyState!==WebSocket.CLOSED)state.apiWs.close(); state.apiWs=null;
  apiStatus.textContent="Not connected"; apiStatus.className="";
  botStatus.textContent="Not connected"; botStatus.className="";
  apiConnectBtn.disabled=false; apiDisconnectBtn.disabled=true;
}
apiConnectBtn.addEventListener("click",connectApi);
apiDisconnectBtn.addEventListener("click",()=>disconnectApi());
