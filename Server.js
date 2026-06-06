const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

let bot = {
  running: false, market: null, pair: null,
  startBalance: 0, currentBalance: 0,
  sessionPL: 0, totalProfit: 0,
  trades: [], stopLossHit: false,
  goalKES: 10000000, goalDate: new Date('2026-11-21'),
};

async function analyzeCrypto() {
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      params: { vs_currency:'usd', order:'volume_desc', per_page:10, page:1, price_change_percentage:'1h,24h' }
    });
    let best = r.data.reduce((a,b) => Math.abs(b.price_change_percentage_1h_in_currency||0) > Math.abs(a.price_change_percentage_1h_in_currency||0) ? b : a, r.data[0]);
    const chg = best?.price_change_percentage_1h_in_currency || 0;
    const score = Math.abs(chg) > 3 ? 70 : Math.abs(chg) > 1 ? 55 : 40;
    return { market:'CRYPTO', score, pair:(best?.symbol||'BTC').toUpperCase()+'/USDT',
      reason:[`${best?.name} ${chg>0?'+':''}${chg.toFixed(2)}% in 1h`, `Vol: $${((best?.total_volume||0)/1e6).toFixed(0)}M`],
      estProfit:'5–15%', risk:'High' };
  } catch(e) {
    return { market:'CRYPTO', score:55, pair:'BTC/USDT', reason:['High liquidity'], estProfit:'5–15%', risk:'High' };
  }
}

async function analyzeForex() {
  try {
    const r = await axios.get('https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,KES');
    const kes = r.data.rates?.KES || 129;
    const score = kes > 130 ? 55 : 45;
    return { market:'FOREX', score, pair:'EUR/USD',
      reason:[`USD/KES: ${kes.toFixed(2)}`, 'Stable liquid market'],
      estProfit:'2–6%', risk:'Medium' };
  } catch(e) {
    return { market:'FOREX', score:45, pair:'EUR/USD', reason:['Stable market'], estProfit:'2–5%', risk:'Medium' };
  }
}

async function analyzeAltcoins() {
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      params: { vs_currency:'usd', category:'layer-1', order:'volume_desc', per_page:10, price_change_percentage:'1h' }
    });
    let best = r.data.reduce((a,b) => Math.abs(b.price_change_percentage_1h_in_currency||0) > Math.abs(a.price_change_percentage_1h_in_currency||0) ? b : a, r.data[0]);
    const chg = best?.price_change_percentage_1h_in_currency || 0;
    const score = Math.abs(chg) > 5 ? 72 : Math.abs(chg) > 2 ? 58 : 38;
    return { market:'ALTCOINS', score, pair:(best?.symbol||'SOL').toUpperCase()+'/USDT',
      reason:[`${best?.name} ${chg>0?'+':''}${chg.toFixed(2)}% in 1h`,'Altseason momentum'],
      estProfit:'8–25%', risk:'High' };
  } catch(e) {
    return { market:'ALTCOINS', score:55, pair:'SOL/USDT', reason:['Altcoin momentum'], estProfit:'5–15%', risk:'High' };
  }
}

async function analyzeStocks() {
  return { market:'STOCKS', score:35, pair:'AAPL/USD',
    reason:['US markets 16:30–23:00 EAT','Lower volatility'],
    estProfit:'1–4%', risk:'Low' };
}

async function analyzeBinary() {
  const crypto = await analyzeCrypto();
  const score = crypto.score > 50 ? 68 : 52;
  return { market:'BINARY OPTIONS', score, pair:'BTC/USD (60s)',
    reason:['Pocket Option payout: 92%','Fixed risk per trade', score>60?'Volatility FAVORABLE':'Moderate conditions'],
    estProfit:'80–92% per winning trade', risk:'Very High' };
}

async function analyzeAllMarkets() {
  const results = await Promise.all([analyzeBinary(), analyzeCrypto(), analyzeAltcoins(), analyzeForex(), analyzeStocks()]);
  return results.sort((a,b) => b.score - a.score);
}

async function getMpesaToken() {
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const base = process.env.MPESA_ENV==='live' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const r = await axios.get(`${base}/oauth/v1/generate?grant_type=client_credentials`, { headers:{ Authorization:`Basic ${auth}` } });
  return r.data.access_token;
}

async function stkPush(phone, amount) {
  const base = process.env.MPESA_ENV==='live' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  const token = await getMpesaToken();
  const shortcode = process.env.MPESA_SHORTCODE || '174379';
  const passkey = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
  const timestamp = new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
  const password = Buffer.from(shortcode+passkey+timestamp).toString('base64');
  const normalized = phone.startsWith('0') ? '254'+phone.slice(1) : phone.startsWith('+') ? phone.slice(1) : phone;
  const r = await axios.post(`${base}/mpesa/stkpush/v1/processrequest`, {
    BusinessShortCode:shortcode, Password:password, Timestamp:timestamp,
    TransactionType:'CustomerPayBillOnline', Amount:Math.ceil(amount),
    PartyA:normalized, PartyB:shortcode, PhoneNumber:normalized,
    CallBackURL:process.env.CALLBACK_URL||'https://example.com/mpesa/callback',
    AccountReference:'JarvisTrade', TransactionDesc:`Jarvis KES ${amount}`
  }, { headers:{ Authorization:`Bearer ${token}` } });
  return r.data;
}

async function jarvisChat(message) {
  const daysLeft = Math.ceil((bot.goalDate - new Date())/(1000*60*60*24));
  const r = await axios.post('https://api.anthropic.com/v1/messages', {
    model:'claude-sonnet-4-20250514', max_tokens:600,
    system:`You are Jarvis, an elite AI trading assistant for a trader in Kenya. You are sharp, confident, and direct. Current state: Bot running: ${bot.running}, Market: ${bot.market||'None'}, Session P&L: KES ${bot.sessionPL.toFixed(2)}, Total profit: KES ${bot.totalProfit.toFixed(2)}, Goal: KES 10,000,000 by November 21 2026, Days left: ${daysLeft}. Speak like a trusted expert. Call the user "boss" sometimes. Be honest about risk.`,
    messages:[{ role:'user', content:message }]
  }, { headers:{ 'x-api-key':process.env.ANTHROPIC_KEY||'', 'anthropic-version':'2023-06-01', 'Content-Type':'application/json' } });
  return r.data.content[0].text;
}

app.get('/api/analyze', async (req,res) => {
  try {
    const markets = await analyzeAllMarkets();
    res.json({ ok:true, markets, best:markets[0] });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/chat', async (req,res) => {
  try {
    const reply = await jarvisChat(req.body.message);
    res.json({ ok:true, reply });
  } catch(e) { res.status(500).json({ error:e.message, reply:'AI brain offline — check ANTHROPIC_KEY' }); }
});

app.post('/api/fund', async (req,res) => {
  try {
    const result = await stkPush(req.body.phone, req.body.amount);
    res.json({ ok:true, result });
  } catch(e) { res.status(500).json({ error:e.response?.data||e.message }); }
});

app.post('/mpesa/callback', (req,res) => {
  const cb = req.body?.Body?.stkCallback;
  if(cb?.ResultCode===0) {
    const amt = cb.CallbackMetadata?.Item?.find(i=>i.Name==='Amount')?.Value;
    bot.currentBalance += parseFloat(amt||0);
    console.log(`M-Pesa confirmed: KES ${amt}`);
  }
  res.json({ ResultCode:0, ResultDesc:'Success' });
});

app.post('/api/start', (req,res) => {
  const { market, pair, amount } = req.body;
  bot.running=true; bot.market=market; bot.pair=pair;
  bot.startBalance=amount; bot.currentBalance=amount;
  bot.sessionPL=0; bot.stopLossHit=false;
  res.json({ ok:true, msg:`Jarvis trading ${market}` });
});

app.post('/api/stop', (req,res) => {
  bot.running=false;
  res.json({ ok:true, sessionPL:bot.sessionPL });
});

app.post('/api/trade/result', (req,res) => {
  const { won, amount, payout } = req.body;
  const pl = won ? payout-amount : -amount;
  bot.sessionPL+=pl; bot.totalProfit+=pl; bot.currentBalance+=pl;
  bot.trades.unshift({ time:new Date().toISOString(), pl, won });
  if(bot.trades.length>50) bot.trades.pop();
  const drawdown = (bot.startBalance-bot.currentBalance)/bot.startBalance;
  if(drawdown>=0.20 && !bot.stopLossHit) {
    bot.stopLossHit=true; bot.running=false;
    return res.json({ ok:true, stopLossHit:true });
  }
  res.json({ ok:true, sessionPL:bot.sessionPL });
});

app.get('/api/status', (req,res) => {
  const daysLeft = Math.ceil((bot.goalDate-new Date())/(1000*60*60*24));
  res.json({ ...bot, daysLeft, goalProgress:(bot.totalProfit/bot.goalKES*100).toFixed(4) });
});

app.get('/health', (req,res) => res.json({ ok:true, running:bot.running }));

const PORT = process.env.PORT||3000;
app.listen(PORT, () => console.log(`Jarvis live on port ${PORT}`));
