require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');

const User = require('./models/User');
const Deposit = require('./models/Deposit');
const Trade = require('./models/Trade');
const Withdrawal = require('./models/Withdrawal');
const { signToken, authMiddleware } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

// ─── Telegram helpers ───
async function sendTelegram(text, keyboard) {
    const body = { chat_id: TG_CHAT, text, parse_mode: 'HTML' };
    if (keyboard) body.reply_markup = keyboard;
    try {
        await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    } catch (err) { console.error('Telegram send failed:', err); }
}

// ─── Crypto prices (Finnhub) ───
const COINS = { BTC: 'BINANCE:BTCUSDT', ETH: 'BINANCE:ETHUSDT' };

app.get('/api/prices', async (req, res) => {
    try {
        const r1 = await fetch(`https://finnhub.io/api/v1/quote?symbol=${COINS.BTC}&token=${FINNHUB_KEY}`);
        const r2 = await fetch(`https://finnhub.io/api/v1/quote?symbol=${COINS.ETH}&token=${FINNHUB_KEY}`);
        const btc = await r1.json();
        const eth = await r2.json();
        res.json({ BTC: btc.c || 0, ETH: eth.c || 0, USDT: 1 });
    } catch (err) {
        res.status(500).json({ ok: false });
    }
});

// ═══════════════════════════════════════════
// FOREX (biquote)
// ═══════════════════════════════════════════
let bq = null;

async function getBiquote() {
    if (!bq) {
        const mod = await import('biquote');
        const Biquote = mod.default || mod;
        bq = new Biquote();
    }
    return bq;
}

const FOREX_PAIRS = [
    'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD',
    'USDCAD', 'NZDUSD', 'EURGBP', 'USDZAR', 'XAUUSD'
];

app.get('/api/forex/prices', async (req, res) => {
    try {
        const client = await getBiquote();
        const ticks = await client.latest(FOREX_PAIRS);
        const prices = {};
        for (const pair of FOREX_PAIRS) {
            prices[pair] = ticks[pair] ? ticks[pair].mid : 0;
        }
        res.json({ ok: true, prices });
    } catch (err) {
        console.error('Forex prices error:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.get('/api/forex/candles/:pair', async (req, res) => {
    try {
        const pair = req.params.pair.toUpperCase();
        if (!FOREX_PAIRS.includes(pair)) {
            return res.status(400).json({ ok: false, error: 'Invalid pair' });
        }
        const interval = req.query.interval || '1h';
        const limit = Number(req.query.limit) || 300;

        const client = await getBiquote();
        const bars = await client.ohlc(pair, { interval, limit });

        const candles = bars.map(function (b) {
            const isoTime = b.openTime || b.time;
            const unixSeconds = Math.floor(new Date(isoTime).getTime() / 1000);
            return {
                time: unixSeconds,
                open: b.open,
                high: b.high,
                low: b.low,
                close: b.close
            };
        });

        res.json({ ok: true, candles: candles });
    } catch (err) {
        console.error('Forex candles error:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/forex/trade', authMiddleware, async function (req, res) {
    try {
        const pair = req.body.pair;
        const side = req.body.side;
        const amount = req.body.amount;

        if (!pair || !side || !amount) {
            return res.status(400).json({ ok: false, error: 'Missing fields' });
        }
        if (FOREX_PAIRS.indexOf(pair) === -1) {
            return res.status(400).json({ ok: false, error: 'Invalid pair' });
        }

        const usdtAmount = Number(amount);
        if (usdtAmount <= 0) {
            return res.status(400).json({ ok: false, error: 'Invalid amount' });
        }

        const user = await User.findById(req.user.id);
        if (user.balances.USDT < usdtAmount) {
            return res.status(400).json({ ok: false, error: 'Insufficient USDT balance' });
        }

        const client = await getBiquote();
        const tick = await client.tick(pair);
        const price = tick.mid;

        user.balances.USDT -= usdtAmount;
        await user.save();

        const trade = await Trade.create({
            userId: user._id,
            email: user.email,
            asset: pair,
            side: side,
            quantity: usdtAmount,
            price: price,
            total: usdtAmount
        });

        res.json({ ok: true, trade: trade, balances: user.balances, price: price });
    } catch (err) {
        console.error('Forex trade error:', err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── AUTH: SIGNUP ───
app.post('/api/signup', async (req, res) => {
    try {
        const { email, password, fullName, phone, country } = req.body;
        if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });

        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(400).json({ ok: false, error: 'Email already registered' });

        const hashed = await bcrypt.hash(password, 10);
        const user = await User.create({
            email: email.toLowerCase(),
            password: hashed,
            fullName: fullName || '',
            phone: phone || '',
            country: country || '',
            status: 'pending'
        });

        await sendTelegram(
            '🆕 <b>NEW SIGNUP</b>\n' +
            '━━━━━━━━━━━━━━━━━━━━━━\n' +
            '\n📧 <b>Email:</b> ' + email + '\n' +
            '👤 <b>Name:</b> ' + (fullName || '-') + '\n' +
            '📱 <b>Phone:</b> ' + (phone || '-') + '\n' +
            '🌍 <b>Country:</b> ' + (country || '-') + '\n' +
            '\n🕐 ' + new Date().toLocaleString() +
            '\n\n<b>Admin approval required</b>',
            {
                inline_keyboard: [[
                    { text: '✅ APPROVE', callback_data: 'approve_user:' + user._id },
                    { text: '❌ REJECT', callback_data: 'reject_user:' + user._id }
                ]]
            }
        );

        res.json({ ok: true, message: 'Signup submitted. Waiting for admin approval.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false });
    }
});

// ─── AUTH: LOGIN ───
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: (email || '').toLowerCase() });
        if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

                if (user.status === 'banned') return res.status(403).json({ ok: false, error: 'Account banned' });
        // NOTE: pending users ARE allowed to log in

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

                const token = signToken(user);
        res.json({
            ok: true,
            token,
            user: {
                email: user.email,
                fullName: user.fullName,
                balances: user.balances,
                status: user.status      // ← add this
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false });
    }
});

// ─── ME ───
app.get('/api/me', authMiddleware, async (req, res) => {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ ok: false });
    res.json({ ok: true, user });
});

// ─── DEPOSIT ───
app.post('/api/deposit', authMiddleware, async (req, res) => {
    try {
        const { asset, network, amount, txid } = req.body;
        if (!asset || !network || !amount || !txid) {
            return res.status(400).json({ ok: false, error: 'All fields required' });
        }

        const user = await User.findById(req.user.id);
        const deposit = await Deposit.create({
            userId: user._id,
            email: user.email,
            asset, network,
            amount: Number(amount),
            txid
        });

        await sendTelegram(
            '💰 <b>NEW DEPOSIT REQUEST</b>\n' +
            '━━━━━━━━━━━━━━━━━━━━━━\n' +
            '\n👤 <b>User:</b> ' + user.email + '\n' +
            '🪙 <b>Asset:</b> ' + asset + '\n' +
            '🌐 <b>Network:</b> ' + network + '\n' +
            '💵 <b>Amount:</b> ' + amount + '\n' +
            '\n🆔 <b>TXID:</b>\n' +
            '<pre><code>' + txid + '</code></pre>\n' +
            '\n🕐 ' + new Date().toLocaleString() +
            '\n\n<b>Verify on Binance, then approve:</b>',
            {
                inline_keyboard: [[
                    { text: '✅ APPROVE', callback_data: 'approve_deposit:' + deposit._id },
                    { text: '❌ REJECT', callback_data: 'reject_deposit:' + deposit._id }
                ]]
            }
        );

        res.json({ ok: true, depositId: deposit._id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false });
    }
});

app.get('/api/deposits', authMiddleware, async (req, res) => {
    const list = await Deposit.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json({ ok: true, deposits: list });
});

// ─── CRYPTO TRADE (BTC / ETH) ───
app.post('/api/trade', authMiddleware, async (req, res) => {
    try {
        const { asset, side, quantity, price } = req.body;
        if (!asset || !side || !quantity || !price) {
            return res.status(400).json({ ok: false, error: 'Missing fields' });
        }

        const user = await User.findById(req.user.id);
        const qty = Number(quantity);
        const prc = Number(price);
        const total = qty * prc;

        if (side === 'buy') {
            if (user.balances.USDT < total) {
                return res.status(400).json({ ok: false, error: 'Insufficient USDT' });
            }
            user.balances.USDT -= total;
            user.balances[asset] += qty;
        } else {
            if (user.balances[asset] < qty) {
                return res.status(400).json({ ok: false, error: 'Insufficient ' + asset });
            }
            user.balances[asset] -= qty;
            user.balances.USDT += total;
        }
        await user.save();

        const trade = await Trade.create({
            userId: user._id, email: user.email,
            asset, side, quantity: qty, price: prc, total
        });

        res.json({ ok: true, trade, balances: user.balances });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false });
    }
});

app.get('/api/trades', authMiddleware, async (req, res) => {
    const list = await Trade.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
    res.json({ ok: true, trades: list });
});

// ─── WITHDRAW ───
app.post('/api/withdraw', authMiddleware, async (req, res) => {
    try {
        const { asset, network, amount, address } = req.body;
        if (!asset || !network || !amount || !address) {
            return res.status(400).json({ ok: false, error: 'All fields required' });
        }

        const user = await User.findById(req.user.id);
        const amt = Number(amount);

        if (user.balances[asset] < amt) {
            return res.status(400).json({ ok: false, error: 'Insufficient ' + asset });
        }

        user.balances[asset] -= amt;
        await user.save();

        const withdrawal = await Withdrawal.create({
            userId: user._id,
            email: user.email,
            asset, network,
            amount: amt,
            address
        });

        await sendTelegram(
            '💸 <b>NEW WITHDRAWAL REQUEST</b>\n' +
            '━━━━━━━━━━━━━━━━━━━━━━\n' +
            '\n👤 <b>User:</b> ' + user.email + '\n' +
            '🪙 <b>Asset:</b> ' + asset + '\n' +
            '🌐 <b>Network:</b> ' + network + '\n' +
            '💵 <b>Amount:</b> ' + amount + '\n' +
            '\n📍 <b>Address:</b>\n' +
            '<pre><code>' + address + '</code></pre>\n' +
            '\n🕐 ' + new Date().toLocaleString() +
            '\n\n<b>Send from Binance, then approve:</b>',
            {
                inline_keyboard: [[
                    { text: '✅ APPROVE', callback_data: 'approve_withdrawal:' + withdrawal._id },
                    { text: '❌ REJECT', callback_data: 'reject_withdrawal:' + withdrawal._id }
                ]]
            }
        );

        res.json({ ok: true, withdrawalId: withdrawal._id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false });
    }
});

app.get('/api/withdrawals', authMiddleware, async (req, res) => {
    const list = await Withdrawal.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json({ ok: true, withdrawals: list });
});

// ─── ADMIN ───
app.post('/api/admin/login', (req, res) => {
    const { email, password } = req.body;
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
        return res.json({ ok: true, adminToken: process.env.ADMIN_PASSWORD });
    }
    res.status(401).json({ ok: false });
});

function adminAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (token === process.env.ADMIN_PASSWORD) return next();
    res.status(401).json({ ok: false });
}

app.get('/api/admin/users', adminAuth, async (req, res) => {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ ok: true, users });
});

app.post('/api/admin/approve-user', adminAuth, async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { status: 'active', approvedAt: new Date() });
    res.json({ ok: true });
});

app.post('/api/admin/ban-user', adminAuth, async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { status: 'banned' });
    res.json({ ok: true });
});

app.get('/api/admin/deposits', adminAuth, async (req, res) => {
    const list = await Deposit.find().sort({ createdAt: -1 });
    res.json({ ok: true, deposits: list });
});

app.post('/api/admin/approve-deposit', adminAuth, async (req, res) => {
    const d = await Deposit.findById(req.body.depositId);
    if (!d || d.status !== 'pending') return res.status(400).json({ ok: false });

    const user = await User.findById(d.userId);
    if (!user) return res.status(404).json({ ok: false });

    user.balances[d.asset] = (user.balances[d.asset] || 0) + d.amount;
    await user.save();

    d.status = 'approved';
    d.processedAt = new Date();
    await d.save();

    res.json({ ok: true });
});

app.post('/api/admin/reject-deposit', adminAuth, async (req, res) => {
    await Deposit.findByIdAndUpdate(req.body.depositId, {
        status: 'rejected', processedAt: new Date()
    });
    res.json({ ok: true });
});

// ─── TELEGRAM WEBHOOK (CLEAN) ───
app.post('/api/telegram-webhook', async (req, res) => {
    const cb = req.body.callback_query;
    if (!cb) return res.sendStatus(200);

    const parts = cb.data.split(':');
    const action = parts[0];
    const id = parts[1];
    let replyText = '';

    try {
        // ─ Users ─
        if (action === 'approve_user') {
            await User.findByIdAndUpdate(id, { status: 'active', approvedAt: new Date() });
            replyText = '✅ USER APPROVED';
        } else if (action === 'reject_user') {
            await User.findByIdAndUpdate(id, { status: 'banned' });
            replyText = '❌ USER REJECTED';
        }

        // ─ Deposits ─
        else if (action === 'approve_deposit') {
            const d = await Deposit.findById(id);
            if (d && d.status === 'pending') {
                const user = await User.findById(d.userId);
                if (user) {
                    user.balances[d.asset] = (user.balances[d.asset] || 0) + d.amount;
                    await user.save();
                }
                d.status = 'approved';
                d.processedAt = new Date();
                await d.save();
                replyText = '✅ DEPOSIT APPROVED — ' + d.amount + ' ' + d.asset;
            } else {
                replyText = '⚠️ Deposit already processed';
            }
        } else if (action === 'reject_deposit') {
            await Deposit.findByIdAndUpdate(id, { status: 'rejected', processedAt: new Date() });
            replyText = '❌ DEPOSIT REJECTED';
        }

        // ─ Withdrawals ─
        else if (action === 'approve_withdrawal') {
            await Withdrawal.findByIdAndUpdate(id, { status: 'approved', processedAt: new Date() });
            replyText = '✅ WITHDRAWAL APPROVED — Send from Binance';
        } else if (action === 'reject_withdrawal') {
            const w = await Withdrawal.findById(id);
            if (w && w.status === 'pending') {
                const user = await User.findById(w.userId);
                if (user) {
                    user.balances[w.asset] = (user.balances[w.asset] || 0) + w.amount;
                    await user.save();
                }
                w.status = 'rejected';
                w.processedAt = new Date();
                await w.save();
                replyText = '❌ WITHDRAWAL REJECTED — Funds refunded';
            } else {
                replyText = '⚠️ Already processed';
            }
        }

        // ─ Reply to Telegram ─
        await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/answerCallbackQuery', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id, text: replyText })
        });

        await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/editMessageText', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: cb.message.chat.id,
                message_id: cb.message.message_id,
                text: cb.message.text + '\n\n— — —\n' + replyText,
                parse_mode: 'HTML'
            })
        });
    } catch (err) {
        console.error('Webhook error:', err);
    }

    res.sendStatus(200);
});

// ─── START ───
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('✅ MongoDB connected');
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, '0.0.0.0', () => {
            console.log('🚀 CryptoTrade running on port ' + PORT);
        });
    })
    .catch(err => {
        console.error('❌ MongoDB connection error:', err.message);
        process.exit(1);
    });