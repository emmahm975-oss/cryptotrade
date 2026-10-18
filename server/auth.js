const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'cryptotrade_secret';

function signToken(user) {
    return jwt.sign(
        { id: user._id, email: user.email },
        JWT_SECRET,
        { expiresIn: '30d' }
    );
}

function authMiddleware(req, res, next) {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ ok: false, error: 'No token' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        next();
    } catch (err) {
        return res.status(401).json({ ok: false, error: 'Invalid token' });
    }
}

module.exports = { signToken, authMiddleware };