const mongoose = require('mongoose');

const depositSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true },
    asset: { type: String, required: true },     // USDT, BTC, ETH
    network: { type: String, required: true },   // TRC20, BEP20, BTC, ERC20
    amount: { type: Number, required: true },
    txid: { type: String, required: true },      // Blockchain transaction ID

    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },

    createdAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null }
});

module.exports = mongoose.model('Deposit', depositSchema);