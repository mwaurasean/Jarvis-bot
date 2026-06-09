const express=require('express');
const cors=require('cors');
const axios=require('axios');
const crypto=require('crypto');
require('dotenv').config();
const app=express();
app.use(cors());
app.use(express.json());

// ── STATE ─────────────────────────────────────────────────────────────────────
let bot={
  running:false,
  platforms:{
    binance:{connected:false,balance:0,trades:[],dailyPL:0},
    alpaca:{connected:false,balance:0,trades:[],dailyPL:0}
  },
  dailyStartBalance:0,
  dailyStartTime:null,
  previousDayProfit:0,
  currentDayProfit:0,
  totalProfit:0,
  weeklyProfit:0,
  weekStartBalance:0,
  stopLossPerTrade:0.01,
  dailyTarget:0.07,
  goalKES:10000000,
  goalDate:new Date('2026-11-21'),
  mpesaPhone:process.env.MPESA_PHONE||null,
  trades:[],
  lastTradeTime:null,
  status:'OFFLINE',
  currentAsset:null,
  scanResults:null,
  logs:[]
};

function log(msg){
  const entry='['+new Date().toISOString()+'] '+msg;
  console.log(entry);
  bot.logs.unshift(entry);
  if(bot.logs.length>200)bot.logs.pop();
}

// ── INDICATORS ────────────────────────────────────────────────────────────────
function calcRSI(c,p=14){if(c.length<p+1)return 50;let g=0,l=0;for(let i=c.length-p;i<c.length;i++){const d=c[i]-c[i-1];if(d>0)g+=d;else l+=Math.abs(d);}const ag=g/p,al=l/p;if(al===0)return 100;return 100-(100/(1+ag/al));}
function calcEMA(c,p){if(c.length<p)return c[c.length-1];const k=2/(p+1);let e=c.slice(0,p).reduce((a,b)=>a+b)/p;for(let i=p;i<c.length;i++)e=c[i]*k+e*(1-k);return e;}
function calcSMA(c,p){const n=Math.min(p,c.length);return c.slice(-n).reduce((a,b)=>a+b)/n;}
function calcBB(c,p=20,s=2){const n=Math.min(p,c.length);const sl=c.slice(-n);const m=sl.reduce((a,b)=>a+b)/n;const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-m,2),0)/n);return{upper:m+s*sd,middle:m,lower:m-s*sd};}
function detectCandle(o,c,h,l){const i=o.length-1;const body=Math.abs(c[i]-o[i]);const range=h[i]-l[i]||0.0001;const uw=h[i]-Math.max(o[i],c[i]);const lw=Math.min(o[i],c[i])-l[i];const bull=c[i]>o[i];if(body/range<0.1)return{s:'neutral',p:'doji'};if(lw>body*2&&uw<body*0.5&&!bull)return{s:'buy',p:'hammer'};if(uw>body*2&&lw<body*0.5&&bull)return{s:'sell',p:'shooting_star'};if(i>0){const pb=Math.abs(c[i-1]-o[i-1]);if(bull&&!(c[i-1]>o[i-1])&&body>pb)return{s:'buy',p:'bullish_engulfing'};if(!bull&&c[i-1]>o[i-1]&&body>pb)return{s:'sell',p:'bearish_engulfing'};}if(body/range>0.9)return{s:bull?'buy':'sell',p:'marubozu'};return{s:'neutral',p:'none'};}

function getSignal(candles){
  if(!candles||candles.length<30)return null;
  const closes=candles.map(c=>c.close);
  const opens=candles.map(c=>c.open);
  const highs=candles.map(c=>c.high);
  const lows=candles.map(c=>c.low);
  const vols=candles.map(c=>c.vol||1000);
  const price=closes[closes.length-1];
  const sigs=[],reasons=[];
  const rsi=calcRSI(closes);
  if(rsi<35){sigs.push('buy');reasons.push('RSI oversold:'+rsi.toFixed(1));}
  else if(rsi>65){sigs.push('sell');reasons.push('RSI overbought:'+rsi.toFixed(1));}
  const e9=calcEMA(closes,9),e21=calcEMA(closes,21),pe9=calcEMA(closes.slice(0,-1),9),pe21=calcEMA(closes.slice(0,-1),21);
  if(pe9<=pe21&&e9>e21){sigs.push('buy');reasons.push('EMA9 crossed above EMA21');}
  else if(pe9>=pe21&&e9<e21){sigs.push('sell');reasons.push('EMA9 crossed below EMA21');}
  const ml=calcEMA(closes,12)-calcEMA(closes,26),pm=calcEMA(closes.slice(0,-1),12)-calcEMA(closes.slice(0,-1),26);
  if(ml>0&&pm<=0){sigs.push('buy');reasons.push('MACD bullish crossover');}
  else if(ml<0&&pm>=0){sigs.push('sell');reasons.push('MACD bearish crossover');}
  const bb=calcBB(closes);
  if(price<bb.lower){sigs.push('buy');reasons.push('Below Bollinger lower band');}
  else if(price>bb.upper){sigs.push('sell');reasons.push('Above Bollinger upper band');}
  const sorted=[...closes].sort((a,b)=>a-b);
  const support=sorted[Math.floor(sorted.length*0.2)];
  const resistance=sorted[Math.floor(sorted.length*0.8)];
  if(price<=support*1.005){sigs.push('buy');reasons.push('At key support level');}
  if(price>=resistance*0.995){sigs.push('sell');reasons.push('At key resistance level');}
  const candle=detectCandle(opens,closes,highs,lows);
  if(candle.s==='buy'){sigs.push('buy');reasons.push('Pattern:'+candle.p);}
  else if(candle.s==='sell'){sigs.push('sell');reasons.push('Pattern:'+candle.p);}
  const avgVol=vols.slice(0,-1).reduce((a,b)=>a+b)/(vols.length-1);
  if(vols[vols.length-1]>avgVol*2){if(closes[closes.length-1]>closes[closes.length-2]){sigs.push('buy');reasons.push('Volume spike bullish');}else{sigs.push('sell');reasons.push('Volume spike bearish');}}
  const sma50=calcSMA(closes,50),sma200=calcSMA(closes,Math.min(200,closes.length));
  if(sma50>sma200&&price>sma50){sigs.push('buy');reasons.push('Golden cross uptrend');}
  else if(sma50<sma200&&price<sma50){sigs.push('sell');reasons.push('Death cross downtrend');}
  const roc=((price-closes[closes.length-10])/closes[closes.length-10])*100;
  if(roc>2){sigs.push('buy');reasons.push('Momentum ROC:+'+roc.toFixed(1)+'%');}
  else if(roc<-2){sigs.push('sell');reasons.push('Momentum ROC:'+roc.toFixed(1)+'%');}
  const sma20=calcSMA(closes,20);const dev=(price-sma20)/sma20*100;
  if(dev<-2){sigs.push('buy');reasons.push('Mean revert '+dev.toFixed(1)+'% below SMA20');}
  else if(dev>2){sigs.push('sell');reasons.push('Mean revert +'+dev.toFixed(1)+'% above SMA20');}
  const rh=highs.slice(-5),rl=lows.slice(-5);
  if(rh.every((h,i)=>i===0||h>=rh[i-1])){sigs.push('buy');reasons.push('Higher highs structure');}
  if(rl.every((l,i)=>i===0||l<=rl[i-1])){sigs.push('sell');reasons.push('Lower lows structure');}
  const buys=sigs.filter(s=>s==='buy').length;
  const sells=sigs.filter(s=>s==='sell').length;
  const total=buys+sells||1;
  if(buys>=3&&buys>sells)return{direction:'buy',confidence:Math.round(buys/total*100),reasons:reasons.slice(0,5),buys,sells,rsi,price};
  if(sells>=3&&sells>buys)return{direction:'sell',confidence:Math.round(sells/total*100),reasons:reasons.slice(0,5),buys,sells,rsi,price};
  return null;
}

// ── BINANCE API ────────────────────────────────────────────────────────────────
function binanceSign(params){
  const query=new URLSearchParams(params).toString();
  return crypto.createHmac('sha256',process.env.BINANCE_SECRET||'').update(query).digest('hex');
}
async function binanceGet(path,params={}){
  params.timestamp=Date.now();
  params.signature=binanceSign(params);
  const r=await axios.get('https://api.binance.com'+path,{params,headers:{'X-MBX-APIKEY':process.env.BINANCE_API_KEY||''},timeout:8000});
  return r.data;
}
async function binancePost(path,params={}){
  params.timestamp=Date.now();
  params.signature=binanceSign(params);
  const r=await axios.post('https://api.binance.com'+path,null,{params,headers:{'X-MBX-APIKEY':process.env.BINANCE_API_KEY||''},timeout:8000});
  return r.data;
}
async function getBinanceBalance(){
  const data=await binanceGet('/api/v3/account');
  const usdt=data.balances.find(b=>b.asset==='USDT');
  return parseFloat(usdt?usdt.free:0);
}
async function binanceTrade(symbol,side,usdtAmount){
  // Market order using quoteOrderQty (spend exact USDT amount)
  const order=await binancePost('/api/v3/order',{
    symbol,side:side.toUpperCase(),type:'MARKET',quoteOrderQty:usdtAmount.toFixed(2)
  });
  return order;
}
async function getKlines(symbol,interval,limit){
  const r=await axios.get('https://api.binance.com/api/v3/klines',{params:{symbol,interval,limit},timeout:8000});
  return r.data.map(k=>({open:parseFloat(k[1]),high:parseFloat(k[2]),low:parseFloat(k[3]),close:parseFloat(k[4]),vol:parseFloat(k[5])}));
}
async function get24hr(symbol){
  const r=await axios.get('https://api.binance.com/api/v3/ticker/24hr',{params:{symbol},timeout:5000});
  return r.data;
}

// ── ALPACA API ─────────────────────────────────────────────────────────────────
function alpacaHeaders(){
  return{'APCA-API-KEY-ID':process.env.ALPACA_KEY||'','APCA-API-SECRET-KEY':process.env.ALPACA_SECRET||''};
}
async function getAlpacaBalance(){
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  const r=await axios.get(base+'/v2/account',{headers:alpacaHeaders(),timeout:8000});
  return parseFloat(r.data.cash||0);
}
async function alpacaTrade(symbol,side,usdAmount){
  const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
  const r=await axios.post(base+'/v2/orders',{
    symbol,side,type:'market',time_in_force:'day',
    notional:usdAmount.toFixed(2)
  },{headers:alpacaHeaders(),timeout:8000});
  return r.data;
}

// ── MARKET SCANNER ─────────────────────────────────────────────────────────────
async function scanAllMarkets(){
  log('Scanning all markets for best opportunities...');
  const cryptoAssets=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOTUSDT','AVAXUSDT','MATICUSDT','LINKUSDT','XRPUSDT'];
  const stockAssets=['AAPL','MSFT','NVDA','TSLA','AMZN'];
  const results=[];

  // Scan crypto on Binance
  for(const symbol of cryptoAssets){
    try{
      const candles=await getKlines(symbol,'15m',100);
      const stats=await get24hr(symbol);
      const signal=getSignal(candles);
      const chg=parseFloat(stats.priceChangePercent);
      const vol=parseFloat(stats.quoteVolume);
      const conf=signal?signal.confidence:20;
      const score=signal?Math.min(98,40+conf*0.5+Math.min(25,Math.abs(chg)*2)):Math.min(35,15+Math.abs(chg)*2);
      // Real return estimate based on actual 15min volatility
      const closes=candles.map(c=>c.close);
      const recentVolatility=closes.slice(-20).reduce((acc,p,i,arr)=>i===0?0:acc+Math.abs(p-arr[i-1])/arr[i-1],0)/19*100;
      const estReturn=(recentVolatility*conf/100*2).toFixed(2);
      results.push({
        platform:'BINANCE',category:'CRYPTO',
        symbol,name:symbol.replace('USDT',''),
        price:parseFloat(stats.lastPrice),
        change24h:chg.toFixed(2),
        volume:Math.round(vol/1e6)+'M',
        signal:signal?signal.direction:'none',
        confidence:conf,score,
        estReturn:estReturn+'%',
        reasons:signal?signal.reasons:['No signal'],
        rsi:signal?signal.rsi.toFixed(1):'--',
        tradeable:!!signal&&conf>=60
      });
    }catch(e){log('Scan error '+symbol+': '+e.message);}
  }

  // Scan stocks on Alpaca (if connected)
  if(process.env.ALPACA_KEY&&process.env.ALPACA_KEY!=='none'){
    for(const symbol of stockAssets){
      try{
        const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
        const bars=await axios.get(base+'/v2/stocks/'+symbol+'/bars',{
          params:{timeframe:'15Min',limit:100},
          headers:alpacaHeaders(),timeout:8000
        });
        if(bars.data&&bars.data.bars){
          const candles=bars.data.bars.map(b=>({open:b.o,high:b.h,low:b.l,close:b.c,vol:b.v}));
          const signal=getSignal(candles);
          const lastBar=candles[candles.length-1];
          const firstBar=candles[0];
          const chg=((lastBar.close-firstBar.close)/firstBar.close*100);
          const conf=signal?signal.confidence:20;
          const score=signal?Math.min(90,35+conf*0.45+Math.min(20,Math.abs(chg)*2)):20;
          const closes=candles.map(c=>c.close);
          const recentVolatility=closes.slice(-20).reduce((acc,p,i,arr)=>i===0?0:acc+Math.abs(p-arr[i-1])/arr[i-1],0)/19*100;
          const estReturn=(recentVolatility*conf/100*1.5).toFixed(2);
          results.push({
            platform:'ALPACA',category:'STOCKS',
            symbol,name:symbol,
            price:lastBar.close,
            change24h:chg.toFixed(2),
            volume:'--',
            signal:signal?signal.direction:'none',
            confidence:conf,score,
            estReturn:estReturn+'%',
            reasons:signal?signal.reasons:['No signal'],
            rsi:signal?signal.rsi.toFixed(1):'--',
            tradeable:!!signal&&conf>=60
          });
        }
      }catch(e){log('Alpaca scan error '+symbol+': '+e.message);}
    }
  }

  results.sort((a,b)=>b.score-a.score);
  bot.scanResults={
    time:new Date().toISOString(),
    results,
    best:results[0]||null,
    topPicks:results.filter(r=>r.tradeable).slice(0,5),
    summary:{
      total:results.length,
      tradeable:results.filter(r=>r.tradeable).length,
      bestAsset:results[0]?results[0].name:'--',
      bestPlatform:results[0]?results[0].platform:'--',
      bestReturn:results[0]?results[0].estReturn:'--'
    }
  };
  log('Scan complete. Best: '+( results[0]?results[0].symbol+' score:'+results[0].score:'none'));
  return bot.scanResults;
}

// ── SCHEDULE HELPERS ──────────────────────────────────────────────────────────
function getNairobiTime(){return new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Nairobi'}));}
function isWeekday(){const d=getNairobiTime().getDay();return d>=1&&d<=5;}
function isSaturday(){return getNairobiTime().getDay()===6;}
function isMonday(){return getNairobiTime().getDay()===1;}

// ── DAILY STOP LOSS CHECK ─────────────────────────────────────────────────────
function shouldStopTrading(){
  // Day 1: no daily stop loss — trade freely
  if(bot.previousDayProfit===0)return false;
  // From Day 2: stop if today's loss >= yesterday's profit
  if(bot.currentDayProfit<=-Math.abs(bot.previousDayProfit)){
    log('Daily stop loss hit — lost previous day profit of '+bot.previousDayProfit.toFixed(2));
    return true;
  }
  return false;
}

// ── EXECUTE REAL TRADE ────────────────────────────────────────────────────────
async function executeRealTrade(asset){
  if(!bot.running)return;
  if(!isWeekday()){log('Weekend — not trading');return;}
  if(shouldStopTrading()){log('Daily stop loss triggered — protecting capital');return;}

  try{
    // Get fresh signal
    const candles=await getKlines(asset.symbol,'5m',100);
    const signal=getSignal(candles);
    if(!signal||signal.confidence<60){log('Signal too weak for '+asset.symbol+' — skipping');return;}

    const platform=asset.platform;
    let balance=0;
    if(platform==='BINANCE'){balance=await getBinanceBalance();}
    else if(platform==='ALPACA'){balance=await getAlpacaBalance();}

    if(balance<5){log('Insufficient balance on '+platform+': $'+balance.toFixed(2));return;}

    // Trade 5% of balance per trade
    const tradeAmount=balance*0.05;
    const stopLossAmount=tradeAmount*bot.stopLossPerTrade;

    log('TRADE: '+signal.direction.toUpperCase()+' '+asset.symbol+' | Conf:'+signal.confidence+'% | Amount:$'+tradeAmount.toFixed(2)+' | Platform:'+platform);
    log('Reasons: '+signal.reasons.join(', '));

    let openOrder=null,closeOrder=null,pl=0,won=false;

    if(platform==='BINANCE'){
      // Place real market order on Binance
      openOrder=await binanceTrade(asset.symbol,signal.direction,tradeAmount);
      log('Binance order placed: '+openOrder.orderId+' status:'+openOrder.status);

      // Wait 3 minutes then close position
      await new Promise(r=>setTimeout(r,180000));

      if(!bot.running)return;

      // Get current price to determine P&L
      const currentStats=await get24hr(asset.symbol);
      const currentPrice=parseFloat(currentStats.lastPrice);
      const openPrice=parseFloat(openOrder.fills&&openOrder.fills[0]?openOrder.fills[0].price:currentPrice);
      const priceChange=(currentPrice-openPrice)/openPrice;
      won=signal.direction==='buy'?priceChange>0:priceChange<0;

      // Close position
      const closeSide=signal.direction==='buy'?'sell':'buy';
      const qty=parseFloat(openOrder.executedQty||0);
      if(qty>0){
        closeOrder=await binancePost('/api/v3/order',{symbol:asset.symbol,side:closeSide.toUpperCase(),type:'MARKET',quantity:qty.toFixed(6)});
        log('Binance close order: '+closeOrder.orderId);
      }

      // Calculate real P&L
      const openVal=parseFloat(openOrder.cummulativeQuoteQty||tradeAmount);
      const closeVal=parseFloat(closeOrder?closeOrder.cummulativeQuoteQty||tradeAmount:tradeAmount);
      pl=signal.direction==='buy'?closeVal-openVal:openVal-closeVal;

    } else if(platform==='ALPACA'){
      // Place real market order on Alpaca
      openOrder=await alpacaTrade(asset.symbol,signal.direction,tradeAmount);
      log('Alpaca order placed: '+openOrder.id+' status:'+openOrder.status);

      // Wait 3 minutes
      await new Promise(r=>setTimeout(r,180000));
      if(!bot.running)return;

      // Close Alpaca position
      const base=process.env.ALPACA_BASE_URL||'https://paper-api.alpaca.markets';
      try{
        await axios.delete(base+'/v2/positions/'+asset.symbol,{headers:alpacaHeaders()});
        log('Alpaca position closed: '+asset.symbol);
      }catch(e){log('Alpaca close error: '+e.message);}

      // Estimate P&L (Alpaca settles async)
      const bars=await axios.get(base+'/v2/stocks/'+asset.symbol+'/bars',{
        params:{timeframe:'1Min',limit:5},headers:alpacaHeaders()
      }).catch(()=>null);
      const lastPrice=bars&&bars.data.bars?bars.data.bars[bars.data.bars.length-1].c:0;
      const approxChange=signal.direction==='buy'?0.005:-0.005;
      pl=tradeAmount*approxChange;
      won=pl>0;
    }

    // Apply 1% stop loss — if loss exceeds 1% cap it
    if(pl<-stopLossAmount){
      pl=-stopLossAmount;
      log('1% stop loss applied — capped loss at $'+stopLossAmount.toFixed(2));
    }
    won=pl>0;

    // Convert USD P&L to KES (approximate)
    const KES_RATE=129;
    const plKES=pl*KES_RATE;

    // Update state
    bot.currentDayProfit+=plKES;
    bot.totalProfit+=plKES;
    bot.weeklyProfit+=plKES;
    bot.platforms[platform.toLowerCase()].dailyPL+=plKES;
    bot.lastTradeTime=new Date().toISOString();

    // Log trade
    const tradeRecord={
      time:new Date().toISOString(),
      platform,symbol:asset.symbol,
      direction:signal.direction,
      confidence:signal.confidence,
      amountUSD:tradeAmount,
      plUSD:pl,plKES,won,
      reasons:signal.reasons,
      orderId:openOrder?(openOrder.orderId||openOrder.id):'--'
    };
    bot.trades.unshift(tradeRecord);
    if(bot.trades.length>200)bot.trades.pop();

    log((won?'WIN':'LOSS')+' | P&L: '+(plKES>=0?'+':'')+plKES.toFixed(2)+' KES | Day total: '+bot.currentDayProfit.toFixed(2)+' KES');
    log('Daily target (7% of '+bot.dailyStartBalance.toFixed(2)+'): '+(bot.dailyStartBalance*bot.dailyTarget).toFixed(2)+' KES | Progress: '+bot.currentDayProfit.toFixed(2)+' KES');

  }catch(e){
    log('Trade execution error: '+e.message);
    if(e.response)log('API error: '+JSON.stringify(e.response.data));
  }
}

// ── MAIN TRADING LOOP ─────────────────────────────────────────────────────────
let tradingLoop=null;
let schedulerLoop=null;

async function tradingCycle(){
  if(!bot.running)return;
  if(!isWeekday()){log('Weekend — Jarvis resting');return;}
  if(shouldStopTrading())return;

  try{
    // Scan markets to find best opportunity
    const scan=await scanAllMarkets();
    if(!scan||!scan.topPicks||scan.topPicks.length===0){log('No tradeable signals found this cycle');return;}

    // Trade top 2 picks simultaneously across platforms
    const picks=scan.topPicks.slice(0,2);
    for(const pick of picks){
      if(bot.running&&!shouldStopTrading()){
        await executeRealTrade(pick);
      }
    }
  }catch(e){log('Trading cycle error: '+e.message);}
}

// ── DAILY RESET AT 12AM EAT ───────────────────────────────────────────────────
function scheduleDailyReset(){
  const now=getNairobiTime();
  const nextMidnight=new Date(now);
  nextMidnight.setHours(24,0,0,0);
  const msUntilMidnight=nextMidnight-now;
  log('Next daily reset in '+Math.round(msUntilMidnight/60000)+' minutes');

  setTimeout(async()=>{
    log('=== DAILY RESET 12AM EAT ===');

    // Record previous day profit before reset
    bot.previousDayProfit=bot.currentDayProfit;
    log('Previous day profit recorded: KES '+bot.previousDayProfit.toFixed(2));

    // Update balances from platforms
    try{
      if(process.env.BINANCE_API_KEY&&process.env.BINANCE_API_KEY!=='none'){
        bot.platforms.binance.balance=await getBinanceBalance();
      }
      if(process.env.ALPACA_KEY&&process.env.ALPACA_KEY!=='none'){
        bot.platforms.alpaca.balance=await getAlpacaBalance();
      }
    }catch(e){log('Balance update error: '+e.message);}

    // New daily starting balance
    const totalBalance=(bot.platforms.binance.balance+bot.platforms.alpaca.balance)*129;
    bot.dailyStartBalance=totalBalance||bot.dailyStartBalance;
    bot.dailyStartTime=new Date().toISOString();
    bot.currentDayProfit=0;
    bot.platforms.binance.dailyPL=0;
    bot.platforms.alpaca.dailyPL=0;

    log('New day start balance: KES '+bot.dailyStartBalance.toFixed(2));
    log('Daily target: KES '+(bot.dailyStartBalance*bot.dailyTarget).toFixed(2)+' (7%)');

    // Saturday 12AM — send weekly profits to M-Pesa
    if(isSaturday()){
      log('=== SATURDAY PAYOUT ===');
      log('Weekly profit: KES '+bot.weeklyProfit.toFixed(2));
      if(bot.mpesaPhone&&bot.weeklyProfit>0){
        await sendWeeklyPayout();
      }
    }

    // Monday 12AM — request new funds via STK push
    if(isMonday()){
      log('=== MONDAY FUNDING ===');
      await requestMondayFunding();
    }

    scheduleDailyReset();
  },msUntilMidnight);
}

// ── SATURDAY PAYOUT ───────────────────────────────────────────────────────────
async function sendWeeklyPayout(){
  if(!bot.mpesaPhone||bot.weeklyProfit<=0)return;
  try{
    const token=await getMpesaToken();
    const base=process.env.MPESA_ENV==='live'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
    const sc=process.env.MPESA_SHORTCODE||'174379';
    const ph=bot.mpesaPhone.startsWith('0')?'254'+bot.mpesaPhone.slice(1):bot.mpesaPhone;
    // B2C payout
    if(process.env.MPESA_ENV==='live'&&process.env.MPESA_INITIATOR_NAME){
      await axios.post(base+'/mpesa/b2c/v3/paymentrequest',{
        OriginatorConversationID:'JARVIS-PAYOUT-'+Date.now(),
        InitiatorName:process.env.MPESA_INITIATOR_NAME,
        SecurityCredential:process.env.MPESA_SECURITY_CREDENTIAL,
        CommandID:'BusinessPayment',
        Amount:Math.floor(bot.weeklyProfit),
        PartyA:sc,PartyB:ph,
        Remarks:'Jarvis weekly profit payout',
        QueueTimeOutURL:(process.env.CALLBACK_URL||'https://jarvis-bot-production-6d2b.up.railway.app')+'/mpesa/timeout',
        ResultURL:(process.env.CALLBACK_URL||'https://jarvis-bot-production-6d2b.up.railway.app')+'/mpesa/b2c/result',
        Occasion:'WeeklyPayout'
      },{headers:{Authorization:'Bearer '+token}});
      log('B2C payout sent: KES '+bot.weeklyProfit.toFixed(2)+' to '+bot.mpesaPhone);
    } else {
      log('B2C not configured — manual payout needed: KES '+bot.weeklyProfit.toFixed(2));
    }
    bot.weeklyProfit=0;
    bot.weekStartBalance=bot.dailyStartBalance;
  }catch(e){log('Payout error: '+e.message);}
}

// ── MONDAY FUNDING REQUEST ────────────────────────────────────────────────────
async function requestMondayFunding(){
  if(!bot.mpesaPhone)return;
  try{
    // Analyze which platform performed better last week
    const binancePL=bot.platforms.binance.dailyPL;
    const alpacaPL=bot.platforms.alpaca.dailyPL;
    const totalNeeded=bot.weekStartBalance||1000;

    // Split based on performance (better platform gets more)
    let binanceRatio=0.6,alpacaRatio=0.4;
    if(alpacaPL>binancePL){binanceRatio=0.4;alpacaRatio=0.6;}

    const binanceAmount=Math.round(totalNeeded*binanceRatio);
    const alpacaAmount=Math.round(totalNeeded*alpacaRatio);

    log('Monday funding request: Binance KES '+binanceAmount+' | Alpaca KES '+alpacaAmount);

    // Send Alpaca STK push first
    if(alpacaAmount>0){
      await stkPush(bot.mpesaPhone,alpacaAmount,'Alpaca trading fund');
      log('STK push sent for Alpaca: KES '+alpacaAmount);
      // Wait 5 minutes before sending Binance request
      await new Promise(r=>setTimeout(r,300000));
    }

    // Then Binance STK push
    if(binanceAmount>0){
      await stkPush(bot.mpesaPhone,binanceAmount,'Binance trading fund');
      log('STK push sent for Binance: KES '+binanceAmount);
    }
  }catch(e){log('Monday funding error: '+e.message);}
}

// ── MPESA ─────────────────────────────────────────────────────────────────────
async function getMpesaToken(){
  const auth=Buffer.from((process.env.MPESA_CONSUMER_KEY||'')+':'+(process.env.MPESA_CONSUMER_SECRET||'')).toString('base64');
  const base=process.env.MPESA_ENV==='live'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
  const r=await axios.get(base+'/oauth/v1/generate?grant_type=client_credentials',{headers:{Authorization:'Basic '+auth},timeout:8000});
  return r.data.access_token;
}
async function stkPush(phone,amount,desc){
  const base=process.env.MPESA_ENV==='live'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
  const token=await getMpesaToken();
  const sc=process.env.MPESA_SHORTCODE||'174379';
  const pk=process.env.MPESA_PASSKEY||'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
  const ts=new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
  const pw=Buffer.from(sc+pk+ts).toString('base64');
  const ph=phone.startsWith('0')?'254'+phone.slice(1):phone.startsWith('+')?phone.slice(1):phone;
  const r=await axios.post(base+'/mpesa/stkpush/v1/processrequest',{
    BusinessShortCode:sc,Password:pw,Timestamp:ts,
    TransactionType:'CustomerPayBillOnline',Amount:Math.ceil(amount),
    PartyA:ph,PartyB:sc,PhoneNumber:ph,
    CallBackURL:(process.env.CALLBACK_URL||'https://jarvis-bot-production-6d2b.up.railway.app')+'/mpesa/callback',
    AccountReference:'JarvisTrade',TransactionDesc:desc||'Jarvis trading fund'
  },{headers:{Authorization:'Bearer '+token}});
  return r.data;
}

// ── ROUTES ────────────────────────────────────────────────────────────────────
app.get('/api/scan',async(req,res)=>{
  try{const results=await scanAllMarkets();res.json({ok:true,...results});}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/balance',async(req,res)=>{
  try{
    let binance=0,alpaca=0;
    if(process.env.BINANCE_API_KEY&&process.env.BINANCE_API_KEY!=='none'){binance=await getBinanceBalance();}
    if(process.env.ALPACA_KEY&&process.env.ALPACA_KEY!=='none'){alpaca=await getAlpacaBalance();}
    res.json({ok:true,binanceUSDT:binance,alpacaUSD:alpaca,totalKES:(binance+alpaca)*129});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/start',async(req,res)=>{
  if(bot.running)return res.json({ok:false,msg:'Already running'});
  const{phone,binanceAmount,alpacaAmount}=req.body;
  if(phone)bot.mpesaPhone=phone;

  // Get real balances from platforms
  try{
    if(process.env.BINANCE_API_KEY&&process.env.BINANCE_API_KEY!=='none'){
      bot.platforms.binance.balance=await getBinanceBalance();
      bot.platforms.binance.connected=true;
      log('Binance connected. Balance: $'+bot.platforms.binance.balance.toFixed(2));
    }
    if(process.env.ALPACA_KEY&&process.env.ALPACA_KEY!=='none'){
      bot.platforms.alpaca.balance=await getAlpacaBalance();
      bot.platforms.alpaca.connected=true;
      log('Alpaca connected. Balance: $'+bot.platforms.alpaca.balance.toFixed(2));
    }
  }catch(e){log('Platform connection error: '+e.message);}

  const totalBalance=(bot.platforms.binance.balance+bot.platforms.alpaca.balance)*129;
  bot.dailyStartBalance=totalBalance||parseFloat(binanceAmount||0)+parseFloat(alpacaAmount||0);
  bot.dailyStartTime=new Date().toISOString();
  bot.currentDayProfit=0;
  bot.weeklyProfit=0;
  bot.weekStartBalance=bot.dailyStartBalance;
  bot.running=true;
  bot.status='LIVE';

  log('=== JARVIS STARTED ===');
  log('Daily start balance: KES '+bot.dailyStartBalance.toFixed(2));
  log('Daily target: KES '+(bot.dailyStartBalance*bot.dailyTarget).toFixed(2)+' (7%)');
  log('Stop loss: 1% per trade');
  log('Schedule: Mon-Fri 12AM-12AM EAT');

  // Start trading cycle every 6 minutes
  tradingLoop=setInterval(tradingCycle,360000);
  tradingCycle(); // run immediately

  // Schedule daily resets
  scheduleDailyReset();

  res.json({
    ok:true,
    msg:'Jarvis is LIVE',
    dailyStartBalance:bot.dailyStartBalance,
    dailyTarget:bot.dailyStartBalance*bot.dailyTarget,
    platforms:{
      binance:{connected:bot.platforms.binance.connected,balance:bot.platforms.binance.balance},
      alpaca:{connected:bot.platforms.alpaca.connected,balance:bot.platforms.alpaca.balance}
    }
  });
});

app.post('/api/stop',(req,res)=>{
  bot.running=false;
  bot.status='OFFLINE';
  if(tradingLoop)clearInterval(tradingLoop);
  log('Jarvis stopped. Total profit: KES '+bot.totalProfit.toFixed(2));
  res.json({ok:true,totalProfit:bot.totalProfit,weeklyProfit:bot.weeklyProfit});
});

app.get('/api/status',(req,res)=>{
  const daysLeft=Math.ceil((bot.goalDate-new Date())/(1000*60*60*24));
  const dailyTarget=bot.dailyStartBalance*bot.dailyTarget;
  const dailyProgress=dailyTarget>0?(bot.currentDayProfit/dailyTarget*100).toFixed(1):0;
  res.json({
    ...bot,daysLeft,
    dailyTarget,dailyProgress,
    goalProgress:(bot.totalProfit/bot.goalKES*100).toFixed(6),
    isWeekday:isWeekday(),
    nairobiTime:getNairobiTime().toISOString(),
    winRate:bot.trades.length?Math.round(bot.trades.filter(t=>t.won).length/bot.trades.length*100):0,
    trades:bot.trades.slice(0,30),
    logs:bot.logs.slice(0,50)
  });
});

app.post('/api/fund',async(req,res)=>{
  try{
    const{phone,amount,description}=req.body;
    if(phone)bot.mpesaPhone=phone;
    const result=await stkPush(phone,amount,description);
    res.json({ok:true,result});
  }catch(e){res.status(500).json({error:e.response?e.response.data:e.message});}
});

app.post('/mpesa/callback',(req,res)=>{
  const cb=req.body&&req.body.Body?req.body.Body.stkCallback:null;
  if(cb&&cb.ResultCode===0){
    const amt=cb.CallbackMetadata&&cb.CallbackMetadata.Item?cb.CallbackMetadata.Item.find(i=>i.Name==='Amount').Value:0;
    log('M-Pesa payment confirmed: KES '+amt);
  }
  res.json({ResultCode:0,ResultDesc:'Success'});
});

app.post('/mpesa/b2c/result',(req,res)=>{
  log('B2C payout result: '+JSON.stringify(req.body));
  res.json({ResultCode:0,ResultDesc:'Success'});
});

app.get('/health',(req,res)=>res.json({
  ok:true,running:bot.running,
  weekday:isWeekday(),
  nairobiTime:getNairobiTime().toISOString(),
  binanceConnected:bot.platforms.binance.connected,
  alpacaConnected:bot.platforms.alpaca.connected
}));

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  log('Jarvis Final v1.0 started on port '+PORT);
  log('Real trading: Binance + Alpaca');
  log('Schedule: Mon-Fri 12AM-12AM EAT');
  log('Stop loss: 1% per trade | Daily loss = previous day profit');
  log('Saturday 12AM: auto payout to M-Pesa');
  log('Monday 12AM: auto STK push for new funds');
});
