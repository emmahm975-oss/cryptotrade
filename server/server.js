require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');

const User = require('./models/User');
const Deposit = require('./models/Deposit');
const Trade = require('./models/Trade');
const Withdrawal = require('./models/Withdrawal');
const Notification = require('./models/Notification');
const { signToken, authMiddleware } = require('./auth');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const TG_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const TG_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const round8 = (n) => Math.round(Number(n) * 1e8) / 1e8;

// ─── Telegram helpers ───
async function sendTelegram(text, keyboard) {
    if (!TG_TOKEN || !TG_CHAT) return;
    const body = { chat_id: TG_CHAT, text, parse_mode: 'HTML' };
    if (keyboard) body.reply_markup = keyboard;
    try {
        const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!r.ok) console.error('Telegram send non-OK:', r.status);
    } catch (err) {
        console.error('Telegram send failed:', err.message);
    }
}

async function tgSendTo(chatId, text) {
    if (!TG_TOKEN || !chatId) return;
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
        });
    } catch (err) {
        console.error('TG user send failed:', err.message);
    }
}

async function notifyUser(user, text) {
    if (!user || !user.telegramId) return;
    await tgSendTo(user.telegramId, text);
}

async function pushNotification(userId, type, message) {
    try {
        await Notification.create({ userId, type, message });
    } catch (err) {
        console.error('Notification error:', err.message);
    }
}

// ─── In-memory rate limiter ───
const rateBuckets = new Map();
function rateLimit({ windowMs = 60000, max = 10 } = {}) {
    return (req, res, next) => {
        const key = `${req.ip}:${req.path}`;
        const now = Date.now();
        const bucket = rateBuckets.get(key) || { count: 0, reset: now + windowMs };
        if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + windowMs; }
        bucket.count++;
        rateBuckets.set(key, bucket);
        if (bucket.count > max) return res.status(429).json({ ok: false, error: 'Too many requests' });
        next();
    };
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateBuckets) if (now > v.reset) rateBuckets.delete(k);
}, 5 * 60 * 1000).unref();

// ═══════════════════════════════════════════
// PRICES
// ═══════════════════════════════════════════
const COINS = { BTC: 'BINANCE:BTCUSDT', ETH: 'BINANCE:ETHUSDT' };

app.get('/api/prices', async (req, res) => {
    try {
        const [r1, r2] = await Promise.all([
            fetch(`https://finnhub.io/api/v1/quote?symbol=${COINS.BTC}&token=${FINNHUB_KEY}`),
            fetch(`https://finnhub.io/api/v1/quote?symbol=${COINS.ETH}&token=${FINNHUB_KEY}`)
        ]);
        const [btc, eth] = await Promise.all([r1.json(), r2.json()]);
        res.json({ BTC: btc.c || 0, ETH: eth.c || 0, USDT: 1 });
    } catch (err) {
        console.error('Price fetch error:', err.message);
        res.status(500).json({ ok: false });
    }
});

// ═══════════════════════════════════════════
// FOREX
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
        for (const pair of FOREX_PAIRS) prices[pair] = ticks[pair] ? ticks[pair].mid : 0;
        res.json({ ok: true, prices });
    } catch (err) {
        console.error('Forex prices error:', err.message);
        res.status(500).json({ ok: false, error: 'Price fetch failed' });
    }
});

app.get('/api/forex/candles/:pair', async (req, res) => {
    try {
        const pair = String(req.params.pair || '').toUpperCase();
        if (!FOREX_PAIRS.includes(pair)) return res.status(400).json({ ok: false, error: 'Invalid pair' });

        const allowedIntervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
        const interval = allowedIntervals.includes(req.query.interval) ? req.query.interval : '1h';
        const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);

        const client = await getBiquote();
        const bars = await client.ohlc(pair, { interval, limit });
        const candles = bars.map((b) => ({
            time: Math.floor(new Date(b.openTime || b.time).getTime() / 1000),
            open: b.open, high: b.high, low: b.low, close: b.close
        }));
        res.json({ ok: true, candles });
    } catch (err) {
        console.error('Forex candles error:', err.message);
        res.status(500).json({ ok: false, error: 'Candle fetch failed' });
    }
});

app.post('/api/forex/trade', authMiddleware, async (req, res) => {
    try {
        const { pair, side, amount } = req.body;
        if (!pair || !side || amount == null) return res.status(400).json({ ok: false, error: 'Missing fields' });
        if (!FOREX_PAIRS.includes(pair)) return res.status(400).json({ ok: false, error: 'Invalid pair' });
        if (!['buy', 'sell'].includes(side)) return res.status(400).json({ ok: false, error: 'Invalid side' });

        const usdtAmount = round8(amount);
        if (!(usdtAmount > 0)) return res.status(400).json({ ok: false, error: 'Invalid amount' });

        const client = await getBiquote();
        const tick = await client.tick(pair);
        const price = Number(tick.mid);
        if (!(price > 0)) return res.status(500).json({ ok: false, error: 'Price unavailable' });

        const updated = await User.findOneAndUpdate(
            { _id: req.user.id, 'balances.USDT': { $gte: usdtAmount } },
            { $inc: { 'balances.USDT': -usdtAmount } },
            { new: true }
        );
        if (!updated) return res.status(400).json({ ok: false, error: 'Insufficient USDT balance' });

        const quantity = round8(usdtAmount / price);
        const trade = await Trade.create({
            userId: updated._id, email: updated.email,
            asset: pair, side, quantity, price, total: usdtAmount
        });
        res.json({ ok: true, trade, balances: updated.balances, price });
    } catch (err) {
        console.error('Forex trade error:', err.message);
        res.status(500).json({ ok: false, error: 'Trade failed' });
    }
});

// ═══════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════
app.post('/api/signup', rateLimit({ max: 5 }), async (req, res) => {
    try {
        const { email, password, fullName, phone, country } = req.body;
        if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });
        if (typeof password !== 'string' || password.length < 8) {
            return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ ok: false, error: 'Invalid email' });
        }

        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(400).json({ ok: false, error: 'Email already registered' });

        const hashed = await bcrypt.hash(password, 10);
        const user = await User.create({
            email: email.toLowerCase(),
            password: hashed,
            fullName: (fullName || '').slice(0, 100),
            phone: (phone || '').slice(0, 40),
            country: (country || '').slice(0, 60),
            status: 'pending'
        });

        await sendTelegram(
            '🆕 <b>NEW SIGNUP</b>\n' +
            '━━━━━━━━━━━━━━━━━━━━━━\n' +
            `\n📧 <b>Email:</b> ${email}\n` +
            `👤 <b>Name:</b> ${fullName || '-'}\n` +
            `📱 <b>Phone:</b> ${phone || '-'}\n` +
            `🌍 <b>Country:</b> ${country || '-'}\n` +
            `\n🕐 ${new Date().toLocaleString()}\n\n<b>Admin approval required</b>`,
            {
                inline_keyboard: [[
                    { text: '✅ APPROVE', callback_data: `approve_user:${user._id}` },
                    { text: '❌ REJECT',  callback_data: `reject_user:${user._id}` }
                ]]
            }
        );

        res.json({
            ok: true,
            message: 'Signup submitted. Waiting for admin approval.',
            telegramConnectUrl: TG_BOT_USERNAME
                ? `https://t.me/${TG_BOT_USERNAME}?start=${user._id}`
                : null
        });
    } catch (err) {
        console.error('Signup error:', err.message);
        res.status(500).json({ ok: false, error: 'Signup failed' });
    }
});

app.post('/api/login', rateLimit({ max: 10 }), async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ ok: false, error: 'Missing credentials' });

        const user = await User.findOne({ email: String(email).toLowerCase() });
        if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
        if (user.status === 'banned') return res.status(403).json({ ok: false, error: 'Account banned' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

        res.json({
            ok: true,
            token: signToken(user),
            user: {
                email: user.email,
                fullName: user.fullName,
                balances: user.balances,
                status: user.status,
                telegramId: user.telegramId || null
            }
        });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ ok: false });
    }
});

app.get('/api/me', authMiddleware, async (req, res) => {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ ok: false });
    res.json({ ok: true, user });
});

// ═══════════════════════════════════════════
// DEPOSITS
// ═══════════════════════════════════════════
app.post('/api/deposit', authMiddleware, async (req, res) => {
    try {
        const { asset, network, amount, txid } = req.body;
        if (!asset || !network || amount == null || !txid) return res.status(400).json({ ok: false, error: 'All fields required' });
        const amt = round8(amount);
        if (!(amt > 0)) return res.status(400).json({ ok: false, error: 'Invalid amount' });

        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ ok: false });

        const deposit = await Deposit.create({
            userId: user._id,
            email: user.email,
            asset: String(asset).slice(0, 20),
            network: String(network).slice(0, 40),
            amount: amt,
            txid: String(txid).slice(0, 200)
        });

        await sendTelegram(
            '💰 <b>NEW DEPOSIT REQUEST</b>\n' +
            '━━━━━━━━━━━━━━━━━━━━━━\n' +
            `\n👤 <b>User:</b> ${user.email}\n` +
            `🪙 <b>Asset:</b> ${asset}\n` +
            `🌐 <b>Network:</b> ${network}\n` +
            `💵 <b>Amount:</b> ${amt}\n` +
            `\n🆔 <b>TXID:</b>\n<pre><code>${txid}</code></pre>\n` +
            `\n🕐 ${new Date().toLocaleString()}\n\n<b>Verify on Binance, then approve:</b>`,
            {
                inline_keyboard: [[
                    { text: '✅ APPROVE', callback_data: `approve_deposit:${deposit._id}` },
                    { text: '❌ REJECT',  callback_data: `reject_deposit:${deposit._id}` }
                ]]
            }
        );

        res.json({ ok: true, depositId: deposit._id });
    } catch (err) {
        console.error('Deposit error:', err.message);
        res.status(500).json({ ok: false });
    }
});

app.get('/api/deposits', authMiddleware, async (req, res) => {
    const list = await Deposit.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json({ ok: true, deposits: list });
});

// ═══════════════════════════════════════════
// CRYPTO TRADES
// ═══════════════════════════════════════════
app.post('/api/trade', authMiddleware, async (req, res) => {
    try {
        const { asset, side, quantity, price } = req.body;
        if (!asset || !side || quantity == null || price == null) return res.status(400).json({ ok: false, error: 'Missing fields' });
        if (!['BTC', 'ETH'].includes(asset)) return res.status(400).json({ ok: false, error: 'Invalid asset' });
        if (!['buy', 'sell'].includes(side)) return res.status(400).json({ ok: false, error: 'Invalid side' });

        const qty = round8(quantity);
        const prc = Number(price);
        if (!(qty > 0) || !(prc > 0)) return res.status(400).json({ ok: false, error: 'Invalid quantity or price' });

        const total = round8(qty * prc);
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ ok: false });

        if (side === 'buy') {
            if (user.balances.USDT < total) return res.status(400).json({ ok: false, error: 'Insufficient USDT' });
            user.balances.USDT = round8(user.balances.USDT - total);
            user.balances[asset] = round8((user.balances[asset] || 0) + qty);
        } else {
            if ((user.balances[asset] || 0) < qty) return res.status(400).json({ ok: false, error: `Insufficient ${asset}` });
            user.balances[asset] = round8(user.balances[asset] - qty);
            user.balances.USDT = round8(user.balances.USDT + total);
        }
        await user.save();

        const trade = await Trade.create({
            userId: user._id, email: user.email,
            asset, side, quantity: qty, price: prc, total
        });
        res.json({ ok: true, trade, balances: user.balances });
    } catch (err) {
        console.error('Trade error:', err.message);
        res.status(500).json({ ok: false });
    }
});

app.get('/api/trades', authMiddleware, async (req, res) => {
    const list = await Trade.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
    res.json({ ok: true, trades: list });
});

// ═══════════════════════════════════════════
// WITHDRAWALS
// ═══════════════════════════════════════════
app.post('/api/withdraw', authMiddleware, async (req, res) => {
    try {
        const { asset, network, amount, address } = req.body;
        if (!asset || !network || amount == null || !address) return res.status(400).json({ ok: false, error: 'All fields required' });
        const amt = round8(amount);
        if (!(amt > 0)) return res.status(400).json({ ok: false, error: 'Invalid amount' });

        const updated = await User.findOneAndUpdate(
            { _id: req.user.id, [`balances.${asset}`]: { $gte: amt } },
            { $inc: { [`balances.${asset}`]: -amt } },
            { new: true }
        );
        if (!updated) return res.status(400).json({ ok: false, error: `Insufficient ${asset}` });

        const withdrawal = await Withdrawal.create({
            userId: updated._id,
            email: updated.email,
            asset: String(asset).slice(0, 20),
            network: String(network).slice(0, 40),
            amount: amt,
            address: String(address).slice(0, 200)
        });

        await sendTelegram(
            '💸 <b>NEW WITHDRAWAL REQUEST</b>\n' +
            '━━━━━━━━━━━━━━━━━━━━━━\n' +
            `\n👤 <b>User:</b> ${updated.email}\n` +
            `🪙 <b>Asset:</b> ${asset}\n` +
            `🌐 <b>Network:</b> ${network}\n` +
            `💵 <b>Amount:</b> ${amt}\n` +
            `\n📍 <b>Address:</b>\n<pre><code>${address}</code></pre>\n` +
            `\n🕐 ${new Date().toLocaleString()}\n\n<b>Send from Binance, then approve:</b>`,
            {
                inline_keyboard: [[
                    { text: '✅ APPROVE', callback_data: `approve_withdrawal:${withdrawal._id}` },
                    { text: '❌ REJECT',  callback_data: `reject_withdrawal:${withdrawal._id}` }
                ]]
            }
        );

        res.json({ ok: true, withdrawalId: withdrawal._id });
    } catch (err) {
        console.error('Withdraw error:', err.message);
        res.status(500).json({ ok: false });
    }
});

app.get('/api/withdrawals', authMiddleware, async (req, res) => {
    const list = await Withdrawal.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json({ ok: true, withdrawals: list });
});

// ═══════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════
app.get('/api/notifications', authMiddleware, async (req, res) => {
    const list = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 }).limit(50);
    res.json({ ok: true, notifications: list });
});

app.post('/api/notifications/read', authMiddleware, async (req, res) => {
    await Notification.updateMany(
        { userId: req.user.id, _id: { $in: req.body.ids || [] } },
        { read: true }
    );
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════
app.post('/api/admin/login', rateLimit({ max: 5 }), (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false });
    if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ ok: false, error: 'Invalid admin credentials' });
    }
    const adminToken = jwt.sign({ isAdmin: true, email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ ok: true, adminToken });
});

function adminAuth(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) return res.status(401).json({ ok: false });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded.isAdmin) return res.status(401).json({ ok: false });
        req.admin = decoded;
        next();
    } catch {
        res.status(401).json({ ok: false });
    }
}

app.get('/api/admin/users', adminAuth, async (req, res) => {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json({ ok: true, users });
});

app.post('/api/admin/approve-user', adminAuth, async (req, res) => {
    const u = await User.findByIdAndUpdate(req.body.userId, { status: 'active', approvedAt: new Date() }, { new: true });
    if (u) {
        await notifyUser(u, '🎉 <b>Account approved!</b>\nYou can now deposit and trade.');
        await pushNotification(u._id, 'account_approved', 'Your account has been approved.');
    }
    res.json({ ok: true });
});

app.post('/api/admin/ban-user', adminAuth, async (req, res) => {
    await User.findByIdAndUpdate(req.body.userId, { status: 'banned' });
    res.json({ ok: true });
});

app.delete('/api/admin/delete-user/:userId', adminAuth, async (req, res) => {
    try {
        const userId = req.params.userId;
        await User.findByIdAndDelete(userId);
        await Deposit.deleteMany({ userId });
        await Trade.deleteMany({ userId });
        await Withdrawal.deleteMany({ userId });
        await Notification.deleteMany({ userId });
        res.json({ ok: true });
    } catch (err) {
        console.error('Delete user error:', err.message);
        res.status(500).json({ ok: false });
    }
});

app.get('/api/admin/deposits', adminAuth, async (req, res) => {
    const list = await Deposit.find().sort({ createdAt: -1 });
    res.json({ ok: true, deposits: list });
});

app.post('/api/admin/approve-deposit', adminAuth, async (req, res) => {
    const d = await Deposit.findOneAndUpdate(
        { _id: req.body.depositId, status: 'pending' },
        { status: 'approved', processedAt: new Date() },
        { new: true }
    );
    if (!d) return res.status(400).json({ ok: false, error: 'Not pending' });

    await User.updateOne({ _id: d.userId }, { $inc: { [`balances.${d.asset}`]: d.amount } });
    const u = await User.findById(d.userId);
    if (u) {
        await notifyUser(u, `💰 <b>Deposit approved</b>\n+${d.amount} ${d.asset} credited to your balance.`);
        await pushNotification(u._id, 'deposit_approved', `Deposit approved: +${d.amount} ${d.asset}`);
    }
    res.json({ ok: true });
});

app.post('/api/admin/reject-deposit', adminAuth, async (req, res) => {
    const d = await Deposit.findOneAndUpdate(
        { _id: req.body.depositId, status: 'pending' },
        { status: 'rejected', processedAt: new Date() },
        { new: true }
    );
    if (d) {
        const u = await User.findById(d.userId);
        if (u) {
            await notifyUser(u, `❌ <b>Deposit rejected</b>\n${d.amount} ${d.asset} was rejected.`);
            await pushNotification(u._id, 'deposit_rejected', `Deposit rejected: ${d.amount} ${d.asset}`);
        }
    }
    res.json({ ok: true });
});

app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
    const list = await Withdrawal.find().sort({ createdAt: -1 });
    res.json({ ok: true, withdrawals: list });
});

app.post('/api/admin/approve-withdrawal', adminAuth, async (req, res) => {
    const w = await Withdrawal.findOneAndUpdate(
        { _id: req.body.withdrawalId, status: 'pending' },
        { status: 'approved', processedAt: new Date() },
        { new: true }
    );
    if (!w) return res.status(400).json({ ok: false, error: 'Not pending' });
    const u = await User.findById(w.userId);
    if (u) {
        await notifyUser(u, `✅ <b>Withdrawal approved</b>\n${w.amount} ${w.asset} sent.`);
        await pushNotification(u._id, 'withdrawal_approved', `Withdrawal approved: ${w.amount} ${w.asset}`);
    }
    res.json({ ok: true });
});

app.post('/api/admin/reject-withdrawal', adminAuth, async (req, res) => {
    const w = await Withdrawal.findOneAndUpdate(
        { _id: req.body.withdrawalId, status: 'pending' },
        { status: 'rejected', processedAt: new Date() },
        { new: true }
    );
    if (!w) return res.status(400).json({ ok: false, error: 'Not pending' });

    await User.updateOne({ _id: w.userId }, { $inc: { [`balances.${w.asset}`]: w.amount } });
    const u = await User.findById(w.userId);
    if (u) {
        await notifyUser(u, `❌ <b>Withdrawal rejected</b>\n${w.amount} ${w.asset} refunded to your balance.`);
        await pushNotification(u._id, 'withdrawal_rejected', `Withdrawal rejected & refunded: ${w.amount} ${w.asset}`);
    }
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
// TELEGRAM WEBHOOK
// ═══════════════════════════════════════════
app.post('/api/telegram-webhook', async (req, res) => {
    if (TG_WEBHOOK_SECRET) {
        const incoming = req.headers['x-telegram-bot-api-secret-token'];
        if (incoming !== TG_WEBHOOK_SECRET) return res.sendStatus(403);
    }

    // /start <userId> — link Telegram account
    const msg = req.body.message;
    if (msg && msg.text && msg.text.startsWith('/start')) {
        const userId = (msg.text.split(' ')[1] || '').trim();
        if (userId && mongoose.Types.ObjectId.isValid(userId)) {
            await User.findByIdAndUpdate(userId, { telegramId: String(msg.chat.id) });
            await tgSendTo(msg.chat.id, '✅ Account linked. You will receive notifications here.');
        }
        return res.sendStatus(200);
    }

    const cb = req.body.callback_query;
    if (!cb) return res.sendStatus(200);

    const [action, id] = String(cb.data || '').split(':');
    let replyText = '';

    try {
        if (action === 'approve_user') {
            const u = await User.findByIdAndUpdate(id, { status: 'active', approvedAt: new Date() }, { new: true });
            if (u) {
                await notifyUser(u, '🎉 <b>Account approved!</b>\nYou can now deposit and trade.');
                await pushNotification(u._id, 'account_approved', 'Your account has been approved.');
            }
            replyText = '✅ USER APPROVED';
        } else if (action === 'reject_user') {
            await User.findByIdAndUpdate(id, { status: 'banned' });
            replyText = '❌ USER REJECTED';
        } else if (action === 'approve_deposit') {
            const d = await Deposit.findOneAndUpdate(
                { _id: id, status: 'pending' },
                { status: 'approved', processedAt: new Date() },
                { new: true }
            );
            if (d) {
                await User.updateOne({ _id: d.userId }, { $inc: { [`balances.${d.asset}`]: d.amount } });
                const u = await User.findById(d.userId);
                if (u) {
                    await notifyUser(u, `💰 <b>Deposit approved</b>\n+${d.amount} ${d.asset} credited.`);
                    await pushNotification(u._id, 'deposit_approved', `Deposit approved: +${d.amount} ${d.asset}`);
                }
                replyText = `✅ DEPOSIT APPROVED — ${d.amount} ${d.asset}`;
            } else {
                replyText = '⚠️ Deposit already processed';
            }
        } else if (action === 'reject_deposit') {
            const d = await Deposit.findOneAndUpdate(
                { _id: id, status: 'pending' },
                { status: 'rejected', processedAt: new Date() },
                { new: true }
            );
            if (d) {
                const u = await User.findById(d.userId);
                if (u) {
                    await notifyUser(u, `❌ <b>Deposit rejected</b>\n${d.amount} ${d.asset}.`);
                    await pushNotification(u._id, 'deposit_rejected', `Deposit rejected: ${d.amount} ${d.asset}`);
                }
            }
            replyText = '❌ DEPOSIT REJECTED';
        } else if (action === 'approve_withdrawal') {
            const w = await Withdrawal.findOneAndUpdate(
                { _id: id, status: 'pending' },
                { status: 'approved', processedAt: new Date() },
                { new: true }
            );
            if (w) {
                const u = await User.findById(w.userId);
                if (u) {
                    await notifyUser(u, `✅ <b>Withdrawal approved</b>\n${w.amount} ${w.asset} sent.`);
                    await pushNotification(u._id, 'withdrawal_approved', `Withdrawal approved: ${w.amount} ${w.asset}`);
                }
            }
            replyText = w ? '✅ WITHDRAWAL APPROVED' : '⚠️ Already processed';
        } else if (action === 'reject_withdrawal') {
            const w = await Withdrawal.findOneAndUpdate(
                { _id: id, status: 'pending' },
                { status: 'rejected', processedAt: new Date() },
                { new: true }
            );
            if (w) {
                await User.updateOne({ _id: w.userId }, { $inc: { [`balances.${w.asset}`]: w.amount } });
                const u = await User.findById(w.userId);
                if (u) {
                    await notifyUser(u, `❌ <b>Withdrawal rejected</b>\n${w.amount} ${w.asset} refunded.`);
                    await pushNotification(u._id, 'withdrawal_rejected', `Withdrawal rejected & refunded: ${w.amount} ${w.asset}`);
                }
                replyText = '❌ WITHDRAWAL REJECTED — Refunded';
            } else {
                replyText = '⚠️ Already processed';
            }
        }

        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id, text: replyText })
        });

        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: cb.message.chat.id,
                message_id: cb.message.message_id,
                text: `${cb.message.text}\n\n— — —\n${replyText}`,
                parse_mode: 'HTML'
            })
        });
    } catch (err) {
        console.error('Webhook error:', err.message);
    }

    res.sendStatus(200);
});

// ─── 404 + error handler ───
app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ ok: false, error: 'Server error' });
});

// ─── START ───
const PORT = process.env.PORT || 3000;
let server;

mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 20,
}).then(() => {
    console.log('✅ MongoDB connected');
    server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 CryptoTrade running on port ${PORT}`);
    });
}).catch((err) => {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
function shutdown() {
    console.log('Shutting down...');
    if (server) server.close(() => mongoose.connection.close().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
}

module.exports = app;