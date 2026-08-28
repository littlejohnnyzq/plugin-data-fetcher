const assert = require('node:assert/strict');
const test = require('node:test');

const { COOKIE_NAME, createDashboardAuth } = require('../dashboard-auth');

test('accepts the configured password and rejects other values', () => {
    const auth = createDashboardAuth({ password: 'correct horse', secret: 'test-secret' });

    assert.equal(auth.isConfigured(), true);
    assert.equal(auth.authenticate('correct horse'), true);
    assert.equal(auth.authenticate('wrong'), false);
});

test('creates signed sessions that expire and reject tampering', () => {
    let currentTime = 1_700_000_000_000;
    const auth = createDashboardAuth({
        password: 'password',
        secret: 'test-secret',
        sessionTtlMs: 60_000,
        now: () => currentTime
    });
    const token = auth.createToken();

    assert.equal(auth.verifyToken(token), true);
    assert.equal(auth.verifyToken(`${token}x`), false);

    currentTime += 60_001;
    assert.equal(auth.verifyToken(token), false);
});

test('reads the signed session from the dashboard cookie', () => {
    const auth = createDashboardAuth({ password: 'password', secret: 'test-secret' });
    const token = auth.createToken();
    const req = { headers: { cookie: `other=value; ${COOKIE_NAME}=${encodeURIComponent(token)}` } };

    assert.equal(auth.isAuthenticated(req), true);
});

test('rate limits repeated failed password attempts', () => {
    let currentTime = 1_700_000_000_000;
    const auth = createDashboardAuth({
        password: 'password',
        secret: 'test-secret',
        now: () => currentTime
    });

    for (let index = 0; index < 5; index++) auth.recordFailure('127.0.0.1');
    assert.equal(auth.canAttempt('127.0.0.1').allowed, false);

    currentTime += 15 * 60 * 1000;
    assert.equal(auth.canAttempt('127.0.0.1').allowed, true);
});
