const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const {
    createAnalyticsRelay,
    createUserStore,
    hashUserId,
    mountAnalyticsRelay
} = require('../analytics-relay');

const HMAC_SECRET = 'test-only-secret-with-more-than-32-characters';
const PLUGIN_ID = '1370606842652257742';

function createTempDatabase(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-analytics-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, 'users.sqlite');
}

function createEvent(overrides = {}) {
    return {
        schema_version: 1,
        event_id: '1700000000-1-test',
        event_name: 'plugin_launch',
        session_id: 1700000000,
        plugin_id: PLUGIN_ID,
        plugin_name: 'iCharts',
        plugin_version: '1.0.0',
        user_id: 'figma-user-1',
        user_name: 'Test User',
        properties: { editor_type: 'figma', nested: { ignored: true } },
        ...overrides
    };
}

function createTestRelay(t, forwarded) {
    const relay = createAnalyticsRelay({
        databasePath: createTempDatabase(t),
        hmacSecret: HMAC_SECRET,
        measurementId: 'G-TEST',
        apiSecret: 'test-secret',
        allowedPluginIds: new Set([PLUGIN_ID]),
        allowedEventNames: new Set(['plugin_launch', 'generate_chart']),
        axiosClient: {
            async post(url, payload) {
                forwarded.push({ url, payload });
                return { status: 204, data: null };
            }
        },
        logger: { warn() {}, error() {} }
    });
    t.after(() => relay.close());
    return relay;
}

async function startTestServer(t, relayOptions) {
    const app = express();
    app.use(express.json());
    const relay = mountAnalyticsRelay(app, relayOptions);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    t.after(() => relay.close());
    return `http://127.0.0.1:${server.address().port}`;
}

test('same Figma user reuses one GA4 client_id', async t => {
    const forwarded = [];
    const relay = createTestRelay(t, forwarded);
    const responses = [];
    const createResponse = () => ({
        status(code) { this.statusCode = code; return this; },
        json(value) { responses.push({ status: this.statusCode, value }); return this; },
        end() { responses.push({ status: this.statusCode }); return this; }
    });

    await relay.handle({ body: createEvent(), headers: {}, ip: '127.0.0.1' }, createResponse());
    await relay.handle({
        body: createEvent({ event_id: '1700000000-2-test' }),
        headers: {},
        ip: '127.0.0.1'
    }, createResponse());

    assert.equal(responses[0].status, 204);
    assert.equal(responses[1].status, 204);
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[0].payload.client_id, forwarded[1].payload.client_id);
    assert.equal(forwarded[0].payload.user_id, hashUserId('figma-user-1', HMAC_SECRET));
    assert.notEqual(forwarded[0].payload.user_id, 'figma-user-1');
});

test('only launch events increment the stored launch counter', t => {
    const databasePath = createTempDatabase(t);
    const store = createUserStore(databasePath, HMAC_SECRET);
    t.after(() => store.close());
    const launchEvent = {
        eventName: 'plugin_launch',
        userId: 'figma-user-counter',
        userName: 'Counter User'
    };

    const first = store.resolve(launchEvent, 1700000000000);
    store.resolve({ ...launchEvent, eventName: 'generate_chart' }, 1700000010000);
    const second = store.resolve(launchEvent, 1700000020000);

    assert.equal(first.launch_count, 1);
    assert.equal(second.launch_count, 2);
    assert.equal(second.client_id, first.client_id);
});

test('feature event reuses mapping and is forwarded without user name', async t => {
    const forwarded = [];
    const relay = createTestRelay(t, forwarded);
    const response = () => ({
        status(code) { this.statusCode = code; return this; },
        json() { return this; },
        end() { return this; }
    });

    await relay.handle({ body: createEvent(), headers: {}, ip: 'one' }, response());
    await relay.handle({
        body: createEvent({ event_name: 'generate_chart', event_id: 'feature-1' }),
        headers: {},
        ip: 'one'
    }, response());

    assert.equal(forwarded[0].payload.client_id, forwarded[1].payload.client_id);
    assert.equal(forwarded[1].payload.events[0].name, 'generate_chart');
    assert.equal(JSON.stringify(forwarded[1].payload).includes('Test User'), false);
    assert.deepEqual(forwarded[1].payload.events[0].params.editor_type, 'figma');
});

test('Express endpoint validates plugin identity and reports health', async t => {
    const forwarded = [];
    const baseUrl = await startTestServer(t, {
        databasePath: createTempDatabase(t),
        hmacSecret: HMAC_SECRET,
        measurementId: 'G-TEST',
        apiSecret: 'test-secret',
        allowedPluginIds: new Set([PLUGIN_ID]),
        allowedEventNames: new Set(['plugin_launch']),
        axiosClient: { async post(url, payload) { forwarded.push(payload); return { status: 204 }; } },
        logger: { warn() {}, error() {} }
    });

    const health = await fetch(`${baseUrl}/analytics-healthz`);
    const valid = await fetch(`${baseUrl}/api/plugin-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createEvent())
    });
    const invalid = await fetch(`${baseUrl}/api/plugin-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createEvent({ plugin_id: 'unknown' }))
    });

    assert.equal(health.status, 200);
    assert.equal(valid.status, 204);
    assert.equal(invalid.status, 403);
    assert.equal(forwarded.length, 1);
});
