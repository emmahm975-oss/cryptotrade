const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    email: { type: String, required: true },
    asset: { type: String, required: true },
    network: { type: String, required: true },
    amount: { type: Number, required: true },
    address: { type: String, required: true },

    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending'
    },

    createdAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null }
});

module.exports = mongoose.model('Withdrawal', withdrawalSchema);