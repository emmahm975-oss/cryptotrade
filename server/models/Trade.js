const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true },
    asset: { type: String, required: true },   // BTC, ETH
    side: { type: String, enum: ['buy', 'sell'], required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },   // price at time of trade
    total: { type: Number, required: true },   // qty * price in USDT

    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Trade', tradeSchema);