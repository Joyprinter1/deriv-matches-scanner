const WS_URL="wss://api.derivws.com/trading/v1/options/ws/public";
const TRADE_THRESHOLD=75,WINDOW=120,SCAN_SECONDS=25;
let MARKETS=[];
const FALLBACK_MARKETS=[
["1HZ10V","Volatility 10 (1s)"],["1HZ15V","Volatility 15 (1s)"],["1HZ25V","Volatility 25 (1s)"],["1HZ30V","Volatility 30 (1s)"],
["1HZ50V","Volatility 50 (1s)"],["1HZ75V","Volatility 75 (1s)"],["1HZ90V","Volatility 90 (1s)"],["1HZ100V","Volatility 100 (1s)"],
["R_10","Volatility 10"],["R_25","Volatility 25"],["R_50","Volatility 50"],["R_75","Volatility 75"],["R_100","Volatility 100"],
["JD10","Jump 10"],["JD25","Jump 25"],["JD50","Jump 50"],["JD75","Jump 75"],["JD100","Jump 100"]];
const $=id=>document.getElementById(id);
const state={ws:null,connected:false,selected:new Set(),ticks:new Map(),scanning:false,apiWs:null,contracts:new Set()};
const feedBadge=$("feedBadge"),feedMessage=$("feedMessage"),connectBtn=$("connectBtn"),disconnectBtn=$("disconnectBtn"),scanBtn=$("scanBtn");
const marketsEl=$("markets"),marketsWrap=$("marketsWrap"),toggleMarketsBtn=$("toggleMarketsBtn"),selectAllBtn=$("selectAllBtn"),clearAllBtn=$("clearAllBtn");
const scanProgress=$("scanProgress"),scanSeconds=$("scanSeconds"),progressBar=$("progressBar"),scanState=$("scanState");
const apiConnectBtn=$("apiConnectBtn"),apiDisconnectBtn=$("apiDisconnectBtn");

function setFeed(on,msg){
 state.connected=on;
 feedBadge.textContent=on?"LIVE":"OFFLINE";
 feedBadge.className="live-pill "+(on?"online":"offline");
 $("marketStatus").textContent=on?"Connected":"Disconnected";
 $("marketStatus2").textContent=on?"ONLINE":"OFFLINE";
 $("marketStatus2").className=on?"online":"";
 feedMessage.textContent=msg;
 connectBtn.disabled=on; disconnectBtn.disabled=!on;
 scanBtn.disabled=!on||!state.selected.size;
}
function send(o){if(state.ws&&state.ws.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify(o));}
function connect(){
 if(state.ws)try{state.ws.close()}catch(e){}
 state.connected=false;
 feedMessage.textContent="Connecting to Deriv live market data…";
 connectBtn.disabled=true;
 state.ws=new WebSocket(WS_URL);
 state.ws.onopen=()=>{
   setFeed(true,"Connected. Loading available Volatility and Jump markets…");
   send({active_symbols:"brief",req_id:1});
 };
 state.ws.onmessage=e=>{try{handle(JSON.parse(e.data))}catch(err){feedMessage.textContent="Market-data message could not be read.";}}
 state.ws.onerror=()=>{feedMessage.textContent="WebSocket error. Check browser/network WebSocket access, then tap Connect again.";};
 state.ws.onclose=ev=>{
   const wasConnected=state.connected;
   state.connected=false;
   connectBtn.disabled=false;
   setFeed(false,wasConnected?"Market connection closed. Tap Connect to retry.":"WebSocket could not establish a live connection (code "+(ev.code||"unknown")+").");
 };
}
function disconnect(){if(state.ws)try{state.ws.close()}catch(e){}state.ws=null;setFeed(false,"Disconnected.");}
function loadMarkets(list){
 const found=list.filter(x=>{
   const name=String(x.underlying_symbol_name||"");
   const sym=String(x.underlying_symbol||"");
   return /volatility|jump/i.test(name)||/^(1HZ|R_|JD)/.test(sym);
 }).map(x=>[String(x.underlying_symbol),String(x.underlying_symbol_name||x.underlying_symbol)]);
 const merged=[...found,...FALLBACK_MARKETS].filter((x,i,a)=>a.findIndex(y=>y[0]===x[0])===i);
 MARKETS=merged;
 state.selected=new Set(MARKETS.map(x=>x[0]));
 MARKETS.forEach(([s])=>state.ticks.set(s,[]));
 renderMarkets();
 $("marketSummary").textContent=MARKETS.length+" ready";
 $("feedMessage").textContent="Markets loaded. Collecting live ticks…";
 MARKETS.forEach(([s],i)=>{
   send({ticks_history:s,count:WINDOW,end:"latest",style:"ticks",req_id:1000+i});
   send({ticks:s,subscribe:1,req_id:2000+i});
 });
}
function handle(d){
 if(d.error){feedMessage.textContent=d.error.message||"Deriv market-data error";return;}
 if(d.msg_type==="active_symbols"&&Array.isArray(d.active_symbols)){loadMarkets(d.active_symbols);return;}
 if(d.msg_type==="history"&&d.history){
   const s=d.echo_req?.ticks_history||d.echo_req?.symbol;
   const p=d.history.prices||[],t=d.history.times||[];
   if(s){state.ticks.set(String(s),p.map((v,i)=>({digit:lastDigit(v),quote:Number(v),epoch:t[i]})).slice(-WINDOW));updateTicks();}
 }
 if(d.msg_type==="tick"&&d.tick){
   const s=String(d.tick.underlying_symbol||d.tick.symbol||"");
   const q=Number(d.tick.quote);
   if(!s||!Number.isFinite(q))return;
   const a=state.ticks.get(s)||[];
   a.push({digit:lastDigit(q),quote:q,epoch:d.tick.epoch});
   if(a.length>WINDOW)a.splice(0,a.length-WINDOW);
   state.ticks.set(s,a);updateTicks();
 }
}
function lastDigit(v){
 const s=String(v);
 const x=s.includes(".")?s.split(".")[1]:"";
 return Number((x||s).replace(/\D/g,"").slice(-1));
}
function updateTicks(){
 const total=[...state.ticks.values()].reduce((n,a)=>n+a.length,0);
 $("tickCount").textContent=total+" ticks";
 const ready=[...state.ticks.values()].filter(a=>a.length>=30).length;
 $("marketSummary").textContent=ready+" ready";
}
function renderMarkets(){
 marketsEl.innerHTML=MARKETS.map(([s,n])=>'<label class="market"><input type="checkbox" data-s="'+s+'" '+(state.selected.has(s)?"checked":"")+'> '+n+'</label>').join("");
 marketsEl.querySelectorAll("input").forEach(x=>x.onchange=()=>{
   x.checked?state.selected.add(x.dataset.s):state.selected.delete(x.dataset.s);
   scanBtn.disabled=!state.connected||!state.selected.size;
 });
}
function chooseResult(){
 let best=null;
 for(const s of state.selected){
   const a=state.ticks.get(s)||[]; if(a.length<30)continue;
   const counts=Array(10).fill(0);a.forEach(x=>counts[x.digit]++);
   const ranked=counts.map((c,d)=>({d,c})).sort((x,y)=>y.c-x.c||x.d-y.d);
   const top=ranked[0],second=ranked[1],recent=a.slice(-30);
   const recentShare=recent.filter(x=>x.digit===top.d).length/30,share=top.c/a.length,dominance=share-second.c/a.length;
   const strength=Math.min(95,Math.round(50+dominance*120+Math.max(0,recentShare-.1)*80));
   const r={symbol:s,name:MARKETS.find(x=>x[0]===s)?.[1]||s,digit:top.d,strength,evidence:+(share*100).toFixed(2),recent:+(recentShare*100).toFixed(2),sample:a.length,counts,generated:new Date()};
   if(!best||r.strength>best.strength)best=r;
 }
 return best;
}
async function scan(){
 if(state.scanning||!state.connected||!state.selected.size)return;
 state.scanning=true;scanBtn.disabled=true;scanProgress.classList.remove("hidden");scanState.textContent="SCANNING";scanState.className="state scanning";
 const start=Date.now();
 await new Promise(res=>{const id=setInterval(()=>{const e=Math.min(SCAN_SECONDS*1000,Date.now()-start);scanSeconds.textContent=Math.max(0,Math.ceil((SCAN_SECONDS*1000-e)/1000))+"s";progressBar.style.width=Math.round(e/(SCAN_SECONDS*10))+"%";if(e>=SCAN_SECONDS*1000){clearInterval(id);res();}},250)});
 const r=chooseResult();scanProgress.classList.add("hidden");scanState.textContent=r?"FROZEN":"NO SIGNAL";scanState.className="state";renderSignal(r);state.scanning=false;scanBtn.disabled=!state.connected||!state.selected.size;
}
function renderSignal(r){
 if(!r){$("mainDigit").textContent="—";$("mainStrength").textContent="—%";$("mainMarket").textContent="Not enough live ticks";$("tradeState").textContent="WAIT";$("tradeState").className="trade-state wait";$("frozenText").textContent="No signal was generated.";return;}
 const trade=r.strength>=TRADE_THRESHOLD;
 $("mainDigit").textContent=r.digit;$("mainStrength").textContent=r.strength+"%";$("mainMarket").textContent=r.name;
 $("statStrength").textContent=r.strength+"%";$("statEvidence").textContent=r.evidence+"%";$("statRecent").textContent=r.recent+"%";$("statSample").textContent=r.sample;
 $("tradeState").textContent=trade?"TRADE NOW ≥ 75%":"WAIT";$("tradeState").className="trade-state "+(trade?"trade":"wait");
 $("distributionMarket").textContent=r.name;$("frozenAt").textContent=r.generated.toLocaleTimeString();$("frozenText").textContent="MATCH "+r.digit+" • "+(trade?"TRADE NOW":"WAIT")+" • Frozen";renderBoard(r.counts);
}
function renderBoard(c){
 const total=c.reduce((a,b)=>a+b,0);
 const rank=c.map((n,d)=>({d,n})).sort((a,b)=>b.n-a.n||a.d-b.d),top=rank[0].d,second=rank[1].d,low=rank[9].d,secondLow=rank[8].d;
 $("digitBoard").innerHTML=c.map((n,d)=>{
   let cl="",m="";
   if(d===top){cl="top";m="💚"}else if(d===second){cl="second";m="💙"}else if(d===low){cl="low";m="❤️"}else if(d===secondLow){cl="second-low";m="🧡"}
   const pct=total?((n/total)*100).toFixed(1):"0.0";
   return '<div class="digit-tile '+cl+'"><span class="digit-mark">'+m+'</span><div class="num">'+d+'</div><small>'+n+'× • '+pct+'%</small></div>';
 }).join("");
}
async function connectApi(){
 const token=$("token").value.trim(),app=$("appId").value.trim(),acct=$("accountId").value.trim();
 if(!token||!app||!acct){$("apiMessage").textContent="Enter token, App ID and Account ID.";return;}
 $("apiMessage").textContent="Authenticating…";apiConnectBtn.disabled=true;
 try{
   const r=await fetch("https://api.derivws.com/trading/v1/options/accounts/"+encodeURIComponent(acct)+"/otp",{method:"POST",headers:{"Authorization":"Bearer "+token,"Deriv-App-ID":app}});
   const d=await r.json();if(!r.ok||!d?.data?.url)throw Error(d?.error?.message||"Authentication failed");
   state.apiWs=new WebSocket(d.data.url);
   state.apiWs.onopen=()=>{$("apiStatus").textContent="CONNECTED";$("apiStatus").className="status-badge online";$("apiStatus2").textContent="ONLINE";$("apiStatus2").className="online";$("botStatus").textContent="Connected to Deriv Bot";$("botStatus").className="online";$("apiMessage").textContent="Connected to Deriv Bot monitor. Waiting for contracts opened manually in Deriv Bot.";apiDisconnectBtn.disabled=false;state.apiWs.send(JSON.stringify({portfolio:1}));state.apiWs.send(JSON.stringify({transaction:1,subscribe:1}));};
   state.apiWs.onmessage=e=>{try{apiMessage(JSON.parse(e.data))}catch(_){}};state.apiWs.onclose=()=>disconnectApi();state.apiWs.onerror=()=>{$("apiMessage").textContent="Deriv Bot monitor WebSocket error.";};
 }catch(e){$("apiMessage").textContent=e.message||"API connection failed";apiConnectBtn.disabled=false;}
}
function apiMessage(d){
 if(d.error){$("apiMessage").textContent=d.error.message;return;}
 if(d.msg_type==="portfolio")(d.portfolio?.contracts||[]).forEach(c=>watchContract(c));
 if(d.msg_type==="transaction"&&d.transaction?.action==="buy"){
   const id=String(d.transaction.contract_id||d.transaction.contract_id||"");
   if(id)watchContract({contract_id:id,underlying_symbol:d.transaction.underlying_symbol});
 }
 if(d.msg_type==="proposal_open_contract"){
   const p=d.proposal_open_contract||{};
   $("botStatus").textContent="Connected to Deriv Bot • "+(p.status||"OPEN");
 }
}
function watchContract(c){
 const id=String(c.contract_id||"");if(!id||state.contracts.has(id))return;
 state.contracts.add(id);
 if(state.apiWs&&state.apiWs.readyState===WebSocket.OPEN)state.apiWs.send(JSON.stringify({proposal_open_contract:1,contract_id:id,subscribe:1}));
}
function disconnectApi(){
 $("apiStatus").textContent="NOT CONNECTED";$("apiStatus").className="status-badge";$("apiStatus2").textContent="OFFLINE";$("apiStatus2").className="";$("botStatus").textContent="OFFLINE";$("botStatus").className="";apiConnectBtn.disabled=false;apiDisconnectBtn.disabled=true;
 if(state.apiWs)try{state.apiWs.close()}catch(e){}state.apiWs=null;
}
function init(){
 MARKETS=[...FALLBACK_MARKETS];state.selected=new Set(MARKETS.map(x=>x[0]));renderMarkets();
 toggleMarketsBtn.onclick=()=>{marketsWrap.classList.toggle("hidden");toggleMarketsBtn.textContent=marketsWrap.classList.contains("hidden")?"Show markets":"Hide markets"};
 selectAllBtn.onclick=()=>{state.selected=new Set(MARKETS.map(x=>x[0]));renderMarkets();scanBtn.disabled=!state.connected};
 clearAllBtn.onclick=()=>{state.selected.clear();renderMarkets();scanBtn.disabled=true};
 connectBtn.onclick=connect;disconnectBtn.onclick=disconnect;scanBtn.onclick=scan;apiConnectBtn.onclick=connectApi;apiDisconnectBtn.onclick=disconnectApi;
 setTimeout(connect,500);
}
document.readyState==="loading"?document.addEventListener("DOMContentLoaded",init):init();