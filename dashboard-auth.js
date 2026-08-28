const crypto = require('crypto');

const COOKIE_NAME = 'plugin_data_session';
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function createDashboardAuth(options = {}) {
    const password = String(options.password ?? process.env.DASHBOARD_PASSWORD ?? '');
    const configuredSecret = String(options.secret ?? process.env.DASHBOARD_AUTH_SECRET ?? '');
    const sessionTtlMs = options.sessionTtlMs ?? getSessionTtlMs();
    const now = options.now ?? (() => Date.now());
    const failedAttempts = new Map();
    const secret = configuredSecret || crypto
        .createHash('sha256')
        .update(`plugin-data-dashboard:${password}`)
        .digest();

    function isConfigured() {
        return password.length > 0;
    }

    function authenticate(candidate) {
        if (!isConfigured()) return false;
        return safeEqual(String(candidate ?? ''), password);
    }

    function createToken() {
        const payload = Buffer.from(JSON.stringify({
            version: 1,
            expiresAt: now() + sessionTtlMs
        })).toString('base64url');
        return `${payload}.${sign(payload, secret)}`;
    }

    function verifyToken(token) {
        if (!isConfigured() || typeof token !== 'string') return false;
        const separator = token.lastIndexOf('.');
        if (separator <= 0) return false;

        const payload = token.slice(0, separator);
        const signature = token.slice(separator + 1);
        if (!safeEqual(signature, sign(payload, secret))) return false;

        try {
            const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            return parsed.version === 1
                && Number.isFinite(parsed.expiresAt)
                && parsed.expiresAt > now();
        } catch {
            return false;
        }
    }

    function isAuthenticated(req) {
        return verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
    }

    function issueCookie(req, res) {
        const secure = options.secureCookies ?? isSecureRequest(req);
        res.cookie(COOKIE_NAME, createToken(), {
            httpOnly: true,
            maxAge: sessionTtlMs,
            sameSite: 'lax',
            secure,
            path: '/'
        });
    }

    function clearCookie(req, res) {
        const secure = options.secureCookies ?? isSecureRequest(req);
        res.clearCookie(COOKIE_NAME, {
            httpOnly: true,
            sameSite: 'lax',
            secure,
            path: '/'
        });
    }

    function requireAuth(req, res, next) {
        if (!isConfigured()) {
            return respondUnauthorized(req, res, 503, 'Dashboard password is not configured');
        }
        if (!isAuthenticated(req)) {
            return respondUnauthorized(req, res, 401, 'Authentication required');
        }
        return next();
    }

    function canAttempt(key) {
        const currentTime = now();
        const entry = failedAttempts.get(key);
        if (!entry || currentTime - entry.startedAt >= ATTEMPT_WINDOW_MS) {
            failedAttempts.delete(key);
            return { allowed: true, retryAfterSeconds: 0 };
        }
        if (entry.count < MAX_FAILED_ATTEMPTS) {
            return { allowed: true, retryAfterSeconds: 0 };
        }
        return {
            allowed: false,
            retryAfterSeconds: Math.ceil((ATTEMPT_WINDOW_MS - (currentTime - entry.startedAt)) / 1000)
        };
    }

    function recordFailure(key) {
        const currentTime = now();
        const entry = failedAttempts.get(key);
        if (!entry || currentTime - entry.startedAt >= ATTEMPT_WINDOW_MS) {
            failedAttempts.set(key, { count: 1, startedAt: currentTime });
            return;
        }
        entry.count += 1;
    }

    function clearFailures(key) {
        failedAttempts.delete(key);
    }

    return {
        authenticate,
        canAttempt,
        clearCookie,
        clearFailures,
        createToken,
        isAuthenticated,
        isConfigured,
        issueCookie,
        recordFailure,
        requireAuth,
        verifyToken
    };
}

function getSessionTtlMs() {
    const hours = Number(process.env.DASHBOARD_SESSION_TTL_HOURS || 12);
    if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_SESSION_TTL_MS;
    return Math.min(hours, 24 * 30) * 60 * 60 * 1000;
}

function parseCookies(cookieHeader = '') {
    return String(cookieHeader).split(';').reduce((cookies, part) => {
        const separator = part.indexOf('=');
        if (separator <= 0) return cookies;
        const name = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        try {
            cookies[name] = decodeURIComponent(value);
        } catch {
            cookies[name] = value;
        }
        return cookies;
    }, {});
}

function sign(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(left, right) {
    const leftHash = crypto.createHash('sha256').update(left).digest();
    const rightHash = crypto.createHash('sha256').update(right).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
}

function isSecureRequest(req) {
    return req.secure || String(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https';
}

function respondUnauthorized(req, res, status, message) {
    if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') {
        return res.status(status).json({ error: message });
    }
    return res.redirect(303, `/product/plugin-data/?error=${status === 503 ? 'unconfigured' : 'auth'}`);
}

module.exports = {
    COOKIE_NAME,
    createDashboardAuth
};
