const WS_URL="wss://api.derivws.com/trading/v1/options/ws/public";
const TRADE_THRESHOLD=75,WINDOW=120,SCAN_SECONDS=25;
let MARKETS=[];
const FALLBACK_MARKETS=[
["1HZ10V","Volatility 10 (1s)"],["1HZ15V","Volatility 15 (1s)"],["1HZ25V","Volatility 25 (1s)"],["1HZ30V","Volatility 30 (1s)"],
["1HZ50V","Volatility 50 (1s)"],["1HZ75V","Volatility 75 (1s)"],["1HZ90V","Volatility 90 (1s)"],["1HZ100V","Volatility 100 (1s)"],
["R_10","Volatility 10"],["R_25","Volatility 25"],["R_50","Volatility 50"],["R_75","Volatility 75"],["R_100","Volatility 100"],
["JD10","Jump 10"],["JD25","Jump 25"],["JD50","Jump 50"],["JD75","Jump 75"],["JD100","Jump 100"]];
const $=id=>document.getElementById(id);
const state={ws:null,connected:false,selected:new Set(),ticks:new Map(),scanning:false,apiWs:null,contracts:new Set(),frozen:null,distributionSymbol:null,botArmed:false,armedSignal:null,pendingContracts:new Map(),apiEnvironment:"—",apiCreds:null,apiManualDisconnect:false,apiReconnectTimer:null,marketReconnectTimer:null,marketManualDisconnect:false,apiConnecting:false,marketConnecting:false};
const activateBotBtn=$("activateBotBtn"),deactivateBotBtn=$("deactivateBotBtn");
const feedBadge=$("feedBadge"),feedMessage=$("feedMessage"),connectBtn=$("connectBtn"),disconnectBtn=$("disconnectBtn"),scanBtn=$("scanBtn");
const marketsEl=$("markets"),marketsWrap=$("marketsWrap"),toggleMarketsBtn=$("toggleMarketsBtn"),selectAllBtn=$("selectAllBtn"),clearAllBtn=$("clearAllBtn");
const scanProgress=$("scanProgress"),scanSeconds=$("scanSeconds"),progressBar=$("progressBar"),scanState=$("scanState");
const apiConnectBtn=$("apiConnectBtn"),apiDisconnectBtn=$("apiDisconnectBtn"),findAccountsBtn=$("findAccountsBtn"),accountSelect=$("accountSelect");

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
 if(state.marketConnecting||state.connected)return;
 state.marketConnecting=true;
 state.marketManualDisconnect=false;
 if(state.marketReconnectTimer){clearTimeout(state.marketReconnectTimer);state.marketReconnectTimer=null;}
 if(state.ws)try{state.ws.close()}catch(e){}
 state.connected=false;
 feedMessage.textContent="Connecting to Deriv live market data…";
 connectBtn.disabled=true;
 state.ws=new WebSocket(WS_URL);
 state.ws.onopen=()=>{
   state.marketConnecting=false;
   setFeed(true,"Connected. Loading available Volatility and Jump markets…");
   send({active_symbols:"brief",req_id:1});
 };
 state.ws.onmessage=e=>{try{handle(JSON.parse(e.data))}catch(err){feedMessage.textContent="Market-data message could not be read.";}}
 state.ws.onerror=()=>{feedMessage.textContent="WebSocket error. Check browser/network WebSocket access, then tap Connect again.";};
 state.ws.onclose=ev=>{
   state.marketConnecting=false;
   const wasConnected=state.connected;
   state.connected=false;
   connectBtn.disabled=false;
   setFeed(false,wasConnected?"Market connection closed. Tap Connect to retry.":"WebSocket could not establish a live connection (code "+(ev.code||"unknown")+").");
 };
}
function disconnect(){state.marketManualDisconnect=true;state.marketConnecting=false;if(state.marketReconnectTimer){clearTimeout(state.marketReconnectTimer);state.marketReconnectTimer=null;}if(state.ws)try{state.ws.close()}catch(e){}state.ws=null;setFeed(false,"Disconnected.");}
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
 $("tickCount").textContent=total+" ticks in rolling window";
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
function clamp01(x){return Math.max(0,Math.min(1,x));}
function chooseResult(){
 let best=null;
 for(const s of state.selected){
   const a=state.ticks.get(s)||[]; if(a.length<60)continue;
   const windows=[120,60,30,15].map(n=>Math.min(n,a.length));
   const candidates=Array.from({length:10},(_,d)=>{
     const rates=windows.map(n=>{
       const slice=a.slice(-n);
       const hits=slice.reduce((sum,x)=>sum+(x.digit===d?1:0),0);
       // Light Bayesian smoothing keeps small samples from producing extreme scores.
       return (hits+1)/(n+10);
     });
     const [p120,p60,p30,p15]=rates;
     const blended=p120*0.30+p60*0.30+p30*0.25+p15*0.15;
     const mean=rates.reduce((x,y)=>x+y,0)/rates.length;
     const variance=rates.reduce((x,y)=>x+(y-mean)**2,0)/rates.length;
     const consistency=clamp01(1-Math.sqrt(variance)/0.08);
     const recencyLift=clamp01((p15-p120+0.03)/0.08);
     const baseLift=clamp01((blended-0.10)/0.08);
     return {d,p120,p60,p30,p15,blended,consistency,recencyLift,baseLift,score:blended};
   }).sort((x,y)=>y.score-x.score||y.consistency-x.consistency);
   const top=candidates[0],second=candidates[1];
   const separation=clamp01((top.blended-second.blended)/0.06);
   // Calibrated quality score:
   // 65% smoothed multi-window evidence, 15% cross-window consistency,
   // 10% recent lift, 10% separation from the runner-up.
   const quality=clamp01(
     top.baseLift*0.65+
     top.consistency*0.15+
     top.recencyLift*0.10+
     separation*0.10
   );
   // 75% now corresponds to a meaningful but reachable signal quality,
   // rather than requiring an unusually large raw score gap.
   const strength=Math.min(95,Math.max(50,Math.round(55+30*quality)));
   const counts=Array(10).fill(0);a.forEach(x=>counts[x.digit]++);
   const r={
     symbol:s,
     name:MARKETS.find(x=>x[0]===s)?.[1]||s,
     digit:top.d,
     strength,
     evidence:+(top.p120*100).toFixed(2),
     recent:+(top.p30*100).toFixed(2),
     sample:a.length,
     counts,
     generated:new Date(),
     method:"Calibrated score: 65% smoothed evidence + 15% consistency + 10% recent lift + 10% candidate separation"
   };
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
 const canArm=!state.botArmed;
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
 if(!r){$("botResult").textContent="No frozen signal yet. Tap Analyze Matches first.";return;}
 if(r.strength<TRADE_THRESHOLD){$("botResult").textContent="Signal is below 75%. Bot Sync will not arm until a TRADE NOW signal is generated.";return;}
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
async function discoverAccounts(){
  const token=$("token").value.trim(),app=$("appId").value.trim();
  if(!token||!app){$("accountListMessage").textContent="Enter your PAT token and App ID first.";return;}
  findAccountsBtn.disabled=true;
  accountSelect.disabled=true;
  accountSelect.innerHTML="<option>Checking Deriv…</option>";
  $("accountListMessage").textContent="Reading your Options accounts from Deriv…";
  try{
    const r=await fetch("https://api.derivws.com/trading/v1/options/accounts",{
      method:"GET",
      headers:{"Authorization":"Bearer "+token,"Deriv-App-ID":app}
    });
    const d=await r.json();
    if(!r.ok)throw Error(d?.errors?.[0]?.message||d?.error?.message||("Account lookup failed ("+r.status+")"));
    const raw=Array.isArray(d?.data)?d.data:(Array.isArray(d?.data?.accounts)?d.data.accounts:Object.values(d?.data||{}).filter(x=>x&&typeof x==="object"));
    const accounts=raw.map(x=>({
      id:String(x.account_id||x.loginid||x.accountId||""),
      type:String(x.account_type||x.type||"").toLowerCase(),
      status:String(x.status||"")
    })).filter(x=>x.id);
    if(!accounts.length)throw Error("Deriv returned no Options accounts for this token.");
    accountSelect.innerHTML=accounts.map(x=>'<option value="'+x.id+'">'+(x.type==="real"?"REAL":"DEMO")+' • '+x.id+(x.status?(" • "+x.status):"")+'</option>').join("");
    accountSelect.disabled=false;
    const real=accounts.find(x=>x.type==="real");
    const chosen=real||accounts[0];
    accountSelect.value=chosen.id;
    $("accountId").value=chosen.id;
    $("accountListMessage").textContent=accounts.length+" Options account"+(accounts.length===1?"":"s")+" found. "+(real?"Your REAL account is available.":"No REAL Options account was returned; only the accounts shown are available to this token.") ;
    $("apiEnvironment").textContent=chosen.type==="real"?"REAL":chosen.type==="demo"?"DEMO":"—";
    $("apiAccount").textContent=maskAccount(chosen.id);
  }catch(e){
    accountSelect.innerHTML='<option value="">Could not load accounts</option>';
    $("accountListMessage").textContent=e.message||"Account lookup failed.";
    $("apiMessage").textContent="Account discovery failed: "+(e.message||"unknown error");
  }finally{
    findAccountsBtn.disabled=false;
  }
}
async function connectApi(opts={}){
 if(state.apiConnecting)return;
 if(state.apiWs&&state.apiWs.readyState===WebSocket.OPEN)return;
 state.apiConnecting=true;
 const token=opts.token||$("token").value.trim(),app=opts.app||$("appId").value.trim(),acct=opts.acct||accountSelect?.value||$("accountId").value.trim()||"";
 if(!token||!app||!acct){$("apiMessage").textContent="Enter token, App ID and Account ID.";return;}
 state.apiCreds={token,app,acct};
 state.apiManualDisconnect=false;
 if(!token||!app||!acct){$("apiMessage").textContent="Enter token, App ID and Account ID.";return;}
 $("apiMessage").textContent="Authenticating…";apiConnectBtn.disabled=true;
 try{
   const r=await fetch("https://api.derivws.com/trading/v1/options/accounts/"+encodeURIComponent(acct)+"/otp",{method:"POST",headers:{"Authorization":"Bearer "+token,"Deriv-App-ID":app}});
   const d=await r.json();if(!r.ok||!d?.data?.url)throw Error(d?.errors?.[0]?.message||d?.error?.message||("Authentication failed ("+r.status+")"));
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
   state.apiWs.onclose=()=>{
     state.apiWs=null;
     if(state.apiManualDisconnect){disconnectApi(true);return;}
     $("apiStatus").textContent="RECONNECTING…";$("apiStatus").className="status-badge";
     $("apiStatus2").textContent="RECONNECTING…";$("apiStatus2").className="";
     $("botStatus").textContent="Reconnecting authenticated monitor…";$("botStatus").className="";
     $("apiMessage").textContent=document.hidden?"Monitor paused while app was in background. It will reconnect when you return.":"Authenticated monitor lost. Reconnecting…";
     setApiDiagnostic("WebSocket disconnected — reconnect pending");
     clearTimeout(state.apiReconnectTimer);
     if(!document.hidden)state.apiReconnectTimer=setTimeout(()=>{if(state.apiCreds&&!state.apiManualDisconnect)connectApi(state.apiCreds)},3000);
   };
   state.apiWs.onerror=()=>{$("apiMessage").textContent="Deriv Bot monitor WebSocket error. Reconnect will be attempted automatically.";setApiDiagnostic("WebSocket error");};
 }catch(e){
   $("apiMessage").textContent=e.message||"API connection failed";
   $("apiEnvironment").textContent="—";$("apiAccount").textContent="—";apiConnectBtn.disabled=false;
 } finally {
   state.apiConnecting=false;
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
function disconnectApi(fromSocket=false){
 state.apiConnecting=false;
 if(!fromSocket)state.apiManualDisconnect=true;
 if(state.apiReconnectTimer){clearTimeout(state.apiReconnectTimer);state.apiReconnectTimer=null;}
 if(!fromSocket)state.apiCreds=null;
 $("apiStatus").textContent="NOT CONNECTED";$("apiStatus").className="status-badge";
 $("apiStatus2").textContent="OFFLINE";$("apiStatus2").className="";
 $("botStatus").textContent="OFFLINE";$("botStatus").className="";
 $("apiMessage").textContent="API monitor disconnected.";
 $("apiDiagnostic").textContent="No authenticated account event received.";
 $("apiEnvironment").textContent="—";$("apiAccount").textContent="—";
 setApiDiagnostic("Disconnected","—");
 apiConnectBtn.disabled=false;apiDisconnectBtn.disabled=true;
 if(state.apiWs){const w=state.apiWs;state.apiWs=null;try{w.close()}catch(e){}}
}
function resumeConnections(){
 if(document.hidden)return;
 // Android/Chrome may suspend either WebSocket while Deriv Bot is in the foreground.
 // On return, reuse the in-memory credentials and obtain a fresh authenticated WS OTP.
 $("apiMessage").textContent=state.apiCreds?"Checking API monitor…":$("apiMessage").textContent;
 if(state.marketManualDisconnect===false && (!state.ws||state.ws.readyState!==WebSocket.OPEN)){
   clearTimeout(state.marketReconnectTimer);state.marketReconnectTimer=setTimeout(()=>connect(),250);
 }
 if(state.apiCreds && (!state.apiWs||state.apiWs.readyState!==WebSocket.OPEN)){
   clearTimeout(state.apiReconnectTimer);
   $("apiMessage").textContent="Returning to analyzer. Re-authenticating API monitor…";
   state.apiReconnectTimer=setTimeout(()=>connectApi(state.apiCreds),250);
 }
}
function pauseConnections(){
 if(state.marketReconnectTimer){clearTimeout(state.marketReconnectTimer);state.marketReconnectTimer=null;}
 if(state.apiReconnectTimer){clearTimeout(state.apiReconnectTimer);state.apiReconnectTimer=null;}
 if(state.ws&&state.ws.readyState===WebSocket.OPEN){try{state.ws.close()}catch(e){}}
 if(state.apiWs&&state.apiWs.readyState===WebSocket.OPEN){try{state.apiWs.close()}catch(e){}}
 if(state.apiCreds)$("apiMessage").textContent="API monitor paused while analyzer is in the background. It will reconnect when you return.";
 if(state.connected)feedMessage.textContent="Market feed paused in background. It will reconnect when you return.";
}
function init(){
 MARKETS=[...FALLBACK_MARKETS];state.selected=new Set(MARKETS.map(x=>x[0]));renderMarkets();
 toggleMarketsBtn.onclick=()=>{marketsWrap.classList.toggle("hidden");toggleMarketsBtn.textContent=marketsWrap.classList.contains("hidden")?"Show markets":"Hide markets"};
 selectAllBtn.onclick=()=>{state.selected=new Set(MARKETS.map(x=>x[0]));renderMarkets();scanBtn.disabled=!state.connected};
 clearAllBtn.onclick=()=>{state.selected.clear();renderMarkets();scanBtn.disabled=true};
 connectBtn.onclick=connect;disconnectBtn.onclick=disconnect;scanBtn.onclick=scan;findAccountsBtn.onclick=discoverAccounts;accountSelect.onchange=()=>{$("accountId").value=accountSelect.value;};apiConnectBtn.onclick=connectApi;apiDisconnectBtn.onclick=disconnectApi;activateBotBtn.onclick=activateBot;deactivateBotBtn.onclick=deactivateBot;
 setBotUi();
 document.addEventListener("visibilitychange",()=>document.hidden?pauseConnections():resumeConnections());
 window.addEventListener("pageshow",resumeConnections);
 window.addEventListener("focus",resumeConnections);
 setTimeout(connect,500);
}
document.readyState==="loading"?document.addEventListener("DOMContentLoaded",init):init();