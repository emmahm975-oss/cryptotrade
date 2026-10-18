const mongoose = require('mongoose');

const signalSchema = new mongoose.Schema({
    pair: { type: String, required: true },       // e.g. 'BTCUSDT', 'EURUSD'
    side: { type: String, enum: ['buy', 'sell'], required: true },
    entry: { type: Number, required: true },
    tp: { type: Number, required: true },          // take profit
    sl: { type: Number, required: true },          // stop loss
    tier: { type: String, enum: ['free', 'paid'], default: 'free' },
    source: { type: String, enum: ['manual', 'ai'], default: 'manual' },
    status: { type: String, enum: ['active', 'hit_tp', 'hit_sl', 'cancelled'], default: 'active' },
    reason: { type: String, default: '' },          // short rationale shown to users
    createdBy: { type: String, default: 'admin' }
}, { timestamps: true });

module.exports = mongoose.model('Signal', signalSchema);