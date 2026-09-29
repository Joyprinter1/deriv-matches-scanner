const WS_URL="wss://api.derivws.com/trading/v1/options/ws/public";
const TRADE_THRESHOLD=75,WINDOW=120,SCAN_SECONDS=25;
let MARKETS=[];
const FALLBACK_MARKETS=[
["1HZ10V","Volatility 10 (1s)"],["1HZ15V","Volatility 15 (1s)"],["1HZ25V","Volatility 25 (1s)"],["1HZ30V","Volatility 30 (1s)"],
["1HZ50V","Volatility 50 (1s)"],["1HZ75V","Volatility 75 (1s)"],["1HZ90V","Volatility 90 (1s)"],["1HZ100V","Volatility 100 (1s)"],
["R_10","Volatility 10"],["R_25","Volatility 25"],["R_50","Volatility 50"],["R_75","Volatility 75"],["R_100","Volatility 100"],
["JD10","Jump 10"],["JD25","Jump 25"],["JD50","Jump 50"],["JD75","Jump 75"],["JD100","Jump 100"]];
const $=id=>document.getElementById(id);
const state={ws:null,connected:false,selected:new Set(),ticks:new Map(),scanning:false,apiWs:null,contracts:new Set(),frozen:null,distributionSymbol:null,botArmed:false,armedSignal:null,pendingContracts:new Map(),apiEnvironment:"—"};
const activateBotBtn=$("activateBotBtn"),deactivateBotBtn=$("deactivateBotBtn");
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

 // Keep the distribution LIVE even after a signal is frozen.
 // The frozen signal remains unchanged, while this board follows incoming ticks.
 const symbol=state.distributionSymbol||state.frozen?.symbol||[...state.selected][0];
 if(symbol){
   state.distributionSymbol=symbol;
   const live=state.ticks.get(symbol)||[];
   const marketName=MARKETS.find(x=>x[0]===symbol)?.[1]||symbol;
   $("distributionMarket").textContent=marketName+" • LIVE";
   renderBoard(live.map(x=>x.digit));
   const stream=live.slice(-9).map(x=>x.digit).join("");
   $("liveDigitStream").textContent=stream||"—";
   $("liveDigitCount").textContent=live.length+" ticks in window";
 }
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
   const a=state.ticks.get(s)||[]; if(a.length<60)continue;
   const counts=Array(10).fill(0);a.forEach(x=>counts[x.digit]++);
   const recent=a.slice(-20);
   const prior=a.slice(-60,-20);
   const lastDigit=a[a.length-1]?.digit;
   const candidates=counts.map((n,d)=>{
     const overall=n/a.length;
     const recentCount=recent.filter(x=>x.digit===d).length;
     const priorCount=prior.filter(x=>x.digit===d).length;
     const recentShare=recentCount/20;
     const priorShare=priorCount/40;
     const momentum=recentShare-priorShare;
     const positions=[];
     for(let i=a.length-1;i>=0&&positions.length<8;i--) if(a[i].digit===d) positions.push(a.length-1-i);
     const gap=positions.length?positions[0]:60;
     const avgGap=positions.length>1?positions.slice(1).reduce((sum,v,i)=>sum+(v-positions[i]),0)/(positions.length-1):gap;
     const gapFit=Math.max(0,1-Math.abs(gap-Math.max(1,avgGap))/Math.max(5,avgGap));
     const notRepeat=d!==lastDigit?1:0;
     // Candidate score is deliberately NOT a frequency ranking.
     // Frequency is only 15%; recency/momentum, spacing and non-repeat contribute separately.
     const score=overall*0.15+recentShare*0.35+Math.max(0,momentum)*0.25+gapFit*0.20+notRepeat*0.05;
     return {d,n,overall,recentShare,momentum,gap,gapFit,score};
   }).sort((x,y)=>y.score-x.score||y.momentum-x.momentum||y.gapFit-x.gapFit);
   const top=candidates[0],second=candidates[1];
   const strength=Math.min(95,Math.max(50,Math.round(50+(top.score-second.score)*100)));
   const r={symbol:s,name:MARKETS.find(x=>x[0]===s)?.[1]||s,digit:top.d,strength,
     evidence:+(top.overall*100).toFixed(2),recent:+(top.recentShare*100).toFixed(2),
     sample:a.length,counts,generated:new Date(),
     method:"Composite candidate score (frequency 15%, recent 35%, momentum 25%, spacing 20%, non-repeat 5%)"};
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
 state.frozen=r||null;
 if(!r){$("mainDigit").textContent="—";$("mainStrength").textContent="—%";$("mainMarket").textContent="Not enough live ticks";$("tradeState").textContent="WAIT";$("tradeState").className="trade-state wait";$("frozenText").textContent="No signal was generated.";return;}
 const trade=r.strength>=TRADE_THRESHOLD;
 $("mainDigit").textContent=r.digit;$("mainStrength").textContent=r.strength+"%";$("mainMarket").textContent=r.name;
 $("statStrength").textContent=r.strength+"%";$("statEvidence").textContent=r.evidence+"%";$("statRecent").textContent=r.recent+"%";$("statSample").textContent=r.sample;
 $("tradeState").textContent=trade?"TRADE NOW ≥ 75%":"WAIT";$("tradeState").className="trade-state "+(trade?"trade":"wait");
 $("distributionMarket").textContent=r.name+" • LIVE";$("frozenAt").textContent=r.generated.toLocaleTimeString();$("frozenText").textContent="MATCH "+r.digit+" • "+(trade?"TRADE NOW":"WAIT")+" • Frozen";renderBoard((state.ticks.get(r.symbol)||[]).map(x=>x.digit));
 setBotUi();
}
function renderBoard(data){
 // The board is ALWAYS exactly digits 0–9.
 // Accept either a 10-item count array or a live array of digit values.
 let counts;
 if(Array.isArray(data)&&data.length===10){
   counts=data.map(Number);
 }else{
   counts=Array(10).fill(0);
   (data||[]).forEach(v=>{
     const d=Number(v);
     if(Number.isInteger(d)&&d>=0&&d<=9)counts[d]++;
   });
 }
 const total=counts.reduce((a,b)=>a+b,0);
 const rank=counts.map((n,d)=>({d,n})).sort((a,b)=>b.n-a.n||a.d-b.d);
 const top=rank[0].d,second=rank[1].d,low=rank[9].d,secondLow=rank[8].d;
 $("digitBoard").innerHTML=counts.map((n,d)=>{
   let cl="",m="";
   if(d===top){cl="top";m="💚"}else if(d===second){cl="second";m="💙"}else if(d===low){cl="low";m="❤️"}else if(d===secondLow){cl="second-low";m="🧡"}
   const pct=total?((n/total)*100).toFixed(1):"0.0";
   return '<div class="digit-tile '+cl+'"><span class="digit-mark">'+m+'</span><div class="num">'+d+'</div><small>'+n+'× • '+pct+'%</small></div>';
 }).join("");
}
function maskAccount(v){
 const s=String(v||"");
 return s.length>6?s.slice(0,3)+"•••"+s.slice(-3):s||"—";
}
function setApiDiagnostic(event,contractId){
 if(event!==undefined)$("apiLastEvent").textContent=event;
 if(contractId!==undefined)$("apiLastContract").textContent=contractId||"—";
}
function setBotUi(){
 const r=state.frozen;
 const canArm=!!r&&r.strength>=TRADE_THRESHOLD&&!state.botArmed;
 $("botMarket").textContent=r?.name||"—";
 $("botDigit").textContent=r?String(r.digit):"—";
 $("botStrength").textContent=r?r.strength+"%":"—";
 $("botDuration").textContent="1 tick";
 $("botSyncStatus").textContent=state.botArmed?"ARMED":"NOT ARMED";
 $("botSyncStatus").className="status-badge "+(state.botArmed?"online":"");
 $("activateBotBtn").disabled=!canArm;
 $("deactivateBotBtn").disabled=!state.botArmed;
 $("botInstruction").textContent=state.botArmed
   ? "ARMED. Open Deriv Bot manually with DIGITMATCH, this market, digit "+r.digit+", and your chosen duration. Then press Run."
   : (r?(r.strength>=TRADE_THRESHOLD?"Ready to arm the frozen TRADE NOW signal.":"Signal is below the 75% TRADE NOW threshold; keep it unarmed."):"Generate a frozen signal first. This panel never places a trade.");
}
function activateBot(){
 const r=state.frozen;
 if(!r||r.strength<TRADE_THRESHOLD)return;
 state.botArmed=true;
 state.armedSignal={...r,armedAt:new Date()};
 state.pendingContracts.clear();
 $("botResult").textContent="BOT SYNC ARMED • Waiting for a manual Deriv Bot contract.";
 setBotUi();
}
function deactivateBot(){
 state.botArmed=false;
 state.armedSignal=null;
 state.pendingContracts.clear();
 $("botResult").textContent="Bot sync stopped. No trade was placed by the analyzer.";
 setBotUi();
}
function describeContract(p){
 const type=String(p.contract_type||"");
 const symbol=String(p.underlying_symbol||p.symbol||"");
 const barrier=p.barrier??p.barrier_value??"";
 const duration=p.duration??"";
 return {type,symbol,barrier:barrier===""?null:String(barrier),duration};
}
function verifyContract(p){
 const s=state.armedSignal;
 if(!s)return {status:"UNARMED",detail:"No frozen signal was armed when the contract was detected."};
 const c=describeContract(p);
 const checks=[
   ["TYPE",c.type==="DIGITMATCH",c.type||"not exposed"],
   ["MARKET",c.symbol===s.symbol,c.symbol||"not exposed"],
   ["DIGIT",c.barrier!==null&&String(c.barrier)===String(s.digit),c.barrier===null?"not exposed":c.barrier]
 ];
 const failed=checks.filter(x=>x[1]===false&&x[2]!=="not exposed");
 const unknown=checks.filter(x=>x[2]==="not exposed");
 if(failed.length)return {status:"CONTRACT MISMATCH",detail:failed.map(x=>x[0]+"="+x[2]).join(" • ")};
 if(unknown.length)return {status:"PARTIAL VERIFY",detail:"Type/market/digit could not all be confirmed from the available contract fields: "+unknown.map(x=>x[0]).join(", ")};
 return {status:"VERIFIED",detail:"DIGITMATCH • "+s.name+" • digit "+s.digit};
}
async function connectApi(){
 const token=$("token").value.trim(),app=$("appId").value.trim(),acct=$("accountId").value.trim();
 if(!token||!app||!acct){$("apiMessage").textContent="Enter token, App ID and Account ID.";return;}
 $("apiMessage").textContent="Authenticating…";apiConnectBtn.disabled=true;
 try{
   const r=await fetch("https://api.derivws.com/trading/v1/options/accounts/"+encodeURIComponent(acct)+"/otp",{method:"POST",headers:{"Authorization":"Bearer "+token,"Deriv-App-ID":app}});
   const d=await r.json();if(!r.ok||!d?.data?.url)throw Error(d?.error?.message||"Authentication failed");
   const wsUrl=String(d.data.url);
   state.apiEnvironment=/\/real(?:\?|$)/i.test(wsUrl)?"REAL":/\/demo(?:\?|$)/i.test(wsUrl)?"DEMO":"UNKNOWN";
   $("apiEnvironment").textContent=state.apiEnvironment;
   $("apiAccount").textContent=maskAccount(acct);
   setApiDiagnostic("OTP accepted");
   state.apiWs=new WebSocket(wsUrl);
   state.apiWs.onopen=()=>{
     $("apiStatus").textContent="CONNECTED";$("apiStatus").className="status-badge online";
     $("apiStatus2").textContent="ONLINE";$("apiStatus2").className="online";
     $("botStatus").textContent="Connected • "+state.apiEnvironment;$("botStatus").className="online";
     $("apiMessage").textContent="Authenticated monitor connected. Waiting for manual Deriv Bot contracts.";
     $("apiDiagnostic").textContent="Authenticated "+state.apiEnvironment+" account. No trade is placed by this connection.";
     apiConnectBtn.disabled=true;apiDisconnectBtn.disabled=false;
     state.apiWs.send(JSON.stringify({portfolio:1}));
     state.apiWs.send(JSON.stringify({transaction:1,subscribe:1}));
     state.apiWs.send(JSON.stringify({balance:1,subscribe:1}));
   };
   state.apiWs.onmessage=e=>{try{apiMessage(JSON.parse(e.data))}catch(_){setApiDiagnostic("Unreadable API message");}};
   state.apiWs.onclose=()=>disconnectApi();
   state.apiWs.onerror=()=>{$("apiMessage").textContent="Deriv Bot monitor WebSocket error.";setApiDiagnostic("WebSocket error");};
 }catch(e){
   $("apiMessage").textContent=e.message||"API connection failed";
   $("apiEnvironment").textContent="—";$("apiAccount").textContent="—";apiConnectBtn.disabled=false;
 }
}
function apiMessage(d){
 if(d.error){$("apiMessage").textContent=d.error.message||"Deriv API error";setApiDiagnostic("API error");return;}
 if(d.msg_type==="balance"){
   const b=d.balance||{};
   const cur=b.currency||"";
   const amount=b.balance!==undefined?String(b.balance):"";
   $("apiDiagnostic").textContent="Authenticated "+state.apiEnvironment+" • balance stream active"+(amount?" • "+amount+" "+cur:"");
   return;
 }
 if(d.msg_type==="portfolio"){
   const cs=d.portfolio?.contracts||[];
   cs.forEach(c=>watchContract(c));
   setApiDiagnostic("Portfolio received",cs[0]?.contract_id?String(cs[0].contract_id):undefined);
   return;
 }
 if(d.msg_type==="transaction"){
   const t=d.transaction||{};
   const id=String(t.contract_id||"");
   setApiDiagnostic((t.action||"transaction").toUpperCase(),id||undefined);
   $("apiDiagnostic").textContent="Transaction received from authenticated account.";
   if(t.action==="buy"&&id){
     $("botResult").textContent="CONTRACT DETECTED • ID "+id;
     state.pendingContracts.set(id,{detectedAt:new Date(),transaction:t});
     watchContract({contract_id:id,underlying_symbol:t.underlying_symbol});
   }
   return;
 }
 if(d.msg_type==="proposal_open_contract"){
   const p=d.proposal_open_contract||{};
   const id=String(p.contract_id||"");
   const isPending=id&&state.pendingContracts.has(id);
   const verification=verifyContract(p);
   $("botStatus").textContent="Connected • "+state.apiEnvironment+" • "+(p.status||"OPEN");
   $("botStatus").className="online";
   if(isPending&&state.botArmed){
     state.pendingContracts.set(id,{...(state.pendingContracts.get(id)||{}),contract:p,verification});
     $("botResult").textContent=verification.status+" • "+verification.detail;
     if(p.status==="won"||p.status==="lost"||p.is_sold===1){
       const profit=p.profit!==undefined?String(p.profit):"";
       $("botResult").textContent=verification.status+" • SETTLED "+(p.status||"")+" "+(profit?("• P/L "+profit):"");
     }
   }
 }
}
function watchContract(c){
 const id=String(c.contract_id||"");if(!id)return;
 if(state.apiWs&&state.apiWs.readyState===WebSocket.OPEN){
   state.apiWs.send(JSON.stringify({proposal_open_contract:1,contract_id:id,subscribe:1}));
 }
}
function disconnectApi(){
 $("apiStatus").textContent="NOT CONNECTED";$("apiStatus").className="status-badge";
 $("apiStatus2").textContent="OFFLINE";$("apiStatus2").className="";
 $("botStatus").textContent="OFFLINE";$("botStatus").className="";
 $("apiMessage").textContent="API monitor disconnected.";
 $("apiDiagnostic").textContent="No authenticated account event received.";
 $("apiEnvironment").textContent="—";$("apiAccount").textContent="—";
 setApiDiagnostic("Disconnected","—");
 apiConnectBtn.disabled=false;apiDisconnectBtn.disabled=true;
 if(state.apiWs)try{state.apiWs.close()}catch(e){}state.apiWs=null;
}
function init(){
 MARKETS=[...FALLBACK_MARKETS];state.selected=new Set(MARKETS.map(x=>x[0]));renderMarkets();
 toggleMarketsBtn.onclick=()=>{marketsWrap.classList.toggle("hidden");toggleMarketsBtn.textContent=marketsWrap.classList.contains("hidden")?"Show markets":"Hide markets"};
 selectAllBtn.onclick=()=>{state.selected=new Set(MARKETS.map(x=>x[0]));renderMarkets();scanBtn.disabled=!state.connected};
 clearAllBtn.onclick=()=>{state.selected.clear();renderMarkets();scanBtn.disabled=true};
 connectBtn.onclick=connect;disconnectBtn.onclick=disconnect;scanBtn.onclick=scan;apiConnectBtn.onclick=connectApi;apiDisconnectBtn.onclick=disconnectApi;activateBotBtn.onclick=activateBot;deactivateBotBtn.onclick=deactivateBot;
 setBotUi();setTimeout(connect,500);
}
document.readyState==="loading"?document.addEventListener("DOMContentLoaded",init):init();