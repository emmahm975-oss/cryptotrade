const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    phone: { type: String, default: '' },
    fullName: { type: String, default: '' },
    country: { type: String, default: '' },

    status: {
        type: String,
        enum: ['pending', 'active', 'banned'],
        default: 'pending'
    },

    // Balances per asset
    balances: {
        USDT: { type: Number, default: 0 },
        BTC:  { type: Number, default: 0 },
        ETH:  { type: Number, default: 0 }
    },

    createdAt: { type: Date, default: Date.now },
    approvedAt: { type: Date, default: null }
});

module.exports = mongoose.model('User', userSchema);