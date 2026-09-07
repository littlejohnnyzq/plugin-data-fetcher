const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

function parseList(value, fallback) {
    return new Set(String(value || fallback)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean));
}

function parsePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createClientId(nowMs = Date.now()) {
    return `${crypto.randomInt(1, 2147483647)}.${Math.floor(nowMs / 1000)}`;
}

function hashUserId(userId, secret) {
    return crypto.createHmac('sha256', secret).update(userId, 'utf8').digest('hex');
}

function createFixedWindowLimiter(limitPerMinute) {
    const windows = new Map();
    return key => {
        const windowId = Math.floor(Date.now() / 60000);
        const current = windows.get(key);
        if (!current || current.windowId !== windowId) {
            windows.set(key, { windowId, count: 1 });
            if (windows.size > 10000) {
                for (const [storedKey, value] of windows) {
                    if (value.windowId < windowId - 1) windows.delete(storedKey);
                }
            }
            return true;
        }
        current.count += 1;
        return current.count <= limitPerMinute;
    };
}

function validateEvent(input, allowedPluginIds, allowedEventNames) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'Request body must be a JSON object' };
    }
    if (input.schema_version !== 1) return { error: 'Unsupported schema_version' };

    const pluginId = typeof input.plugin_id === 'string' ? input.plugin_id : '';
    if (!allowedPluginIds.has(pluginId)) return { error: 'Unknown plugin_id', status: 403 };

    const eventName = typeof input.event_name === 'string' ? input.event_name : '';
    if (!EVENT_NAME_PATTERN.test(eventName) || !allowedEventNames.has(eventName)) {
        return { error: 'Unknown event_name' };
    }

    const eventId = typeof input.event_id === 'string' ? input.event_id.slice(0, 128) : '';
    const userId = typeof input.user_id === 'string' ? input.user_id : '';
    const sessionId = Number(input.session_id);
    if (!eventId) return { error: 'Invalid event_id' };
    if (!userId || userId.length > 256) return { error: 'Invalid user_id' };
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        return { error: 'Invalid session_id' };
    }

    const properties = {};
    if (input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties)) {
        for (const [key, value] of Object.entries(input.properties)) {
            if (!PROPERTY_NAME_PATTERN.test(key)) continue;
            if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
                properties[key] = typeof value === 'string' ? value.slice(0, 100) : value;
            }
        }
    }

    return {
        event: {
            eventId,
            eventName,
            sessionId,
            pluginId,
            pluginName: typeof input.plugin_name === 'string' ? input.plugin_name.slice(0, 40) : '',
            pluginVersion: typeof input.plugin_version === 'string' ? input.plugin_version.slice(0, 40) : '',
            userId,
            userName: typeof input.user_name === 'string' ? input.user_name.trim().slice(0, 100) : '',
            properties
        }
    };
}

function createUserStore(databasePath, hmacSecret) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');
    database.exec(`
        CREATE TABLE IF NOT EXISTS analytics_users (
            user_id_hash TEXT PRIMARY KEY,
            client_id TEXT NOT NULL UNIQUE,
            user_name TEXT NOT NULL DEFAULT '',
            launch_count INTEGER NOT NULL DEFAULT 0 CHECK (launch_count >= 0),
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS analytics_plugins (
            plugin_id TEXT PRIMARY KEY,
            plugin_name TEXT NOT NULL DEFAULT '',
            latest_version TEXT NOT NULL DEFAULT '',
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE IF NOT EXISTS analytics_user_plugins (
            user_id_hash TEXT NOT NULL,
            plugin_id TEXT NOT NULL,
            launch_count INTEGER NOT NULL DEFAULT 0 CHECK (launch_count >= 0),
            latest_version TEXT NOT NULL DEFAULT '',
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            PRIMARY KEY (user_id_hash, plugin_id),
            FOREIGN KEY (user_id_hash) REFERENCES analytics_users(user_id_hash),
            FOREIGN KEY (plugin_id) REFERENCES analytics_plugins(plugin_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS analytics_user_plugins_plugin_index
            ON analytics_user_plugins(plugin_id, last_seen_at)
    `);

    const findUser = database.prepare(`
        SELECT user_id_hash, client_id, user_name, launch_count, created_at, last_seen_at
        FROM analytics_users WHERE user_id_hash = ?
    `);
    const insertUser = database.prepare(`
        INSERT OR IGNORE INTO analytics_users
            (user_id_hash, client_id, user_name, launch_count, created_at, last_seen_at)
        VALUES (?, ?, ?, 0, ?, ?)
    `);
    const recordLaunch = database.prepare(`
        UPDATE analytics_users
        SET user_name = ?, launch_count = launch_count + 1, last_seen_at = ?
        WHERE user_id_hash = ?
    `);
    const updateName = database.prepare(`
        UPDATE analytics_users SET user_name = ? WHERE user_id_hash = ?
    `);
    const upsertPlugin = database.prepare(`
        INSERT INTO analytics_plugins
            (plugin_id, plugin_name, latest_version, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET
            plugin_name = CASE
                WHEN excluded.plugin_name <> '' THEN excluded.plugin_name
                ELSE analytics_plugins.plugin_name
            END,
            latest_version = CASE
                WHEN excluded.latest_version <> '' THEN excluded.latest_version
                ELSE analytics_plugins.latest_version
            END,
            last_seen_at = excluded.last_seen_at
    `);
    const upsertUserPlugin = database.prepare(`
        INSERT INTO analytics_user_plugins
            (user_id_hash, plugin_id, launch_count, latest_version, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id_hash, plugin_id) DO UPDATE SET
            launch_count = analytics_user_plugins.launch_count + excluded.launch_count,
            latest_version = CASE
                WHEN excluded.latest_version <> '' THEN excluded.latest_version
                ELSE analytics_user_plugins.latest_version
            END,
            last_seen_at = excluded.last_seen_at
    `);
    const findPlugin = database.prepare(`
        SELECT plugin_id, plugin_name, latest_version, first_seen_at, last_seen_at
        FROM analytics_plugins WHERE plugin_id = ?
    `);
    const findUserPlugin = database.prepare(`
        SELECT user_id_hash, plugin_id, launch_count, latest_version, first_seen_at, last_seen_at
        FROM analytics_user_plugins WHERE user_id_hash = ? AND plugin_id = ?
    `);
    const countUsers = database.prepare(`
        SELECT COUNT(*) AS total
        FROM analytics_users
        WHERE ? = '' OR user_name LIKE ? COLLATE NOCASE OR user_id_hash LIKE ?
    `);
    const listUserRowsByRecentUse = database.prepare(`
        SELECT user_id_hash, user_name, launch_count, created_at, last_seen_at
        FROM analytics_users
        WHERE ? = '' OR user_name LIKE ? COLLATE NOCASE OR user_id_hash LIKE ?
        ORDER BY last_seen_at DESC, user_id_hash ASC
        LIMIT ? OFFSET ?
    `);
    const listUserRowsByLaunchCount = database.prepare(`
        SELECT user_id_hash, user_name, launch_count, created_at, last_seen_at
        FROM analytics_users
        WHERE ? = '' OR user_name LIKE ? COLLATE NOCASE OR user_id_hash LIKE ?
        ORDER BY launch_count DESC, last_seen_at DESC, user_id_hash ASC
        LIMIT ? OFFSET ?
    `);

    const resolveTransaction = database.transaction((event, nowMs) => {
        const userIdHash = hashUserId(event.userId, hmacSecret);
        let user = findUser.get(userIdHash);
        for (let attempt = 0; !user && attempt < 4; attempt += 1) {
            insertUser.run(userIdHash, createClientId(nowMs), event.userName, nowMs, nowMs);
            user = findUser.get(userIdHash);
        }
        if (!user) throw new Error('Unable to create analytics user mapping');

        if (event.eventName === 'plugin_launch') {
            recordLaunch.run(event.userName, nowMs, userIdHash);
        } else if (event.userName !== user.user_name) {
            updateName.run(event.userName, userIdHash);
        }

        upsertPlugin.run(
            event.pluginId,
            event.pluginName || '',
            event.pluginVersion || '',
            nowMs,
            nowMs
        );
        upsertUserPlugin.run(
            userIdHash,
            event.pluginId,
            event.eventName === 'plugin_launch' ? 1 : 0,
            event.pluginVersion || '',
            nowMs,
            nowMs
        );
        return findUser.get(userIdHash);
    });

    function resolve(event, nowMs = Date.now()) {
        if (!event.pluginId) throw new Error('pluginId is required to resolve analytics identity');
        return resolveTransaction(event, nowMs);
    }

    function listUsers(options = {}) {
        const limit = Math.min(parsePositiveInteger(options.limit, 50), 200);
        const offset = Math.max(Number.isSafeInteger(options.offset) ? options.offset : 0, 0);
        const query = String(options.query || '').trim().slice(0, 100);
        const sort = options.sort === 'launches' ? 'launches' : 'recent';
        const pattern = `%${query}%`;
        const total = countUsers.get(query, pattern, pattern).total;
        const listStatement = sort === 'launches'
            ? listUserRowsByLaunchCount
            : listUserRowsByRecentUse;
        const userRows = listStatement.all(query, pattern, pattern, limit, offset);
        const pluginsByUser = new Map(userRows.map(user => [user.user_id_hash, []]));

        if (userRows.length > 0) {
            const placeholders = userRows.map(() => '?').join(',');
            const relationshipRows = database.prepare(`
                SELECT
                    up.user_id_hash,
                    up.plugin_id,
                    p.plugin_name,
                    up.launch_count,
                    up.latest_version,
                    up.first_seen_at,
                    up.last_seen_at
                FROM analytics_user_plugins AS up
                LEFT JOIN analytics_plugins AS p ON p.plugin_id = up.plugin_id
                WHERE up.user_id_hash IN (${placeholders})
                ORDER BY up.last_seen_at DESC, up.plugin_id ASC
            `).all(...userRows.map(user => user.user_id_hash));

            relationshipRows.forEach(row => {
                pluginsByUser.get(row.user_id_hash)?.push({
                    id: row.plugin_id,
                    name: row.plugin_name || '',
                    launchCount: row.launch_count,
                    latestVersion: row.latest_version || '',
                    firstSeenAt: row.first_seen_at,
                    lastSeenAt: row.last_seen_at
                });
            });
        }

        return {
            total,
            limit,
            offset,
            sort,
            users: userRows.map(user => ({
                id: user.user_id_hash,
                name: user.user_name || '',
                launchCount: user.launch_count,
                createdAt: user.created_at,
                lastSeenAt: user.last_seen_at,
                plugins: pluginsByUser.get(user.user_id_hash) || []
            }))
        };
    }

    return {
        resolve,
        listUsers,
        getPlugin: pluginId => findPlugin.get(pluginId),
        getUserPlugin: (userId, pluginId) => findUserPlugin.get(
            hashUserId(userId, hmacSecret),
            pluginId
        ),
        healthCheck: () => database.prepare('SELECT 1 AS ok').get().ok === 1,
        close: () => database.close()
    };
}

function createAnalyticsRelay(options = {}) {
    const logger = options.logger || console;
    const axiosClient = options.axiosClient || require('axios');
    const measurementId = options.measurementId ?? process.env.MEASUREMENT_ID ?? '';
    const apiSecret = options.apiSecret ?? process.env.API_SECRET ?? '';
    const hmacSecret = options.hmacSecret ?? process.env.ANALYTICS_HMAC_SECRET ?? '';
    const databasePath = options.databasePath || process.env.ANALYTICS_DB_PATH
        || path.join(__dirname, 'state', 'analytics-users.sqlite');
    const allowedPluginIds = options.allowedPluginIds
        || parseList(process.env.ALLOWED_PLUGIN_IDS, '1370606842652257742');
    const allowedEventNames = options.allowedEventNames
        || parseList(process.env.ALLOWED_EVENT_NAMES, 'plugin_launch');
    const excludedUserIdHashes = options.excludedUserIdHashes
        || parseList(process.env.ANALYTICS_EXCLUDED_USER_ID_HASHES, '');
    const debug = options.debug ?? process.env.GA4_DEBUG === 'true';
    const dryRun = options.dryRun ?? process.env.GA4_DRY_RUN === 'true';
    const timeoutMs = parsePositiveInteger(options.timeoutMs || process.env.GA4_TIMEOUT_MS, 4000);
    const consumeIp = createFixedWindowLimiter(parsePositiveInteger(
        options.ipRateLimit || process.env.IP_RATE_LIMIT_PER_MINUTE,
        6000
    ));
    const consumeUser = createFixedWindowLimiter(parsePositiveInteger(
        options.userRateLimit || process.env.USER_RATE_LIMIT_PER_MINUTE,
        300
    ));

    const configured = hmacSecret.length >= 32 && (dryRun || (measurementId && apiSecret));
    const userStore = configured ? createUserStore(databasePath, hmacSecret) : null;
    if (!configured) {
        logger.warn('Analytics relay disabled: configure ANALYTICS_HMAC_SECRET, MEASUREMENT_ID and API_SECRET');
    }

    async function forward(event, user) {
        const payload = {
            client_id: user.client_id,
            user_id: user.user_id_hash,
            timestamp_micros: String(Date.now() * 1000),
            events: [{
                name: event.eventName,
                params: {
                    session_id: event.sessionId,
                    engagement_time_msec: 1,
                    event_id: event.eventId,
                    plugin_id: event.pluginId,
                    plugin_name: event.pluginName,
                    plugin_version: event.pluginVersion,
                    ...event.properties
                }
            }]
        };
        if (dryRun) return payload;

        const endpoint = debug
            ? 'https://www.google-analytics.com/debug/mp/collect'
            : 'https://www.google-analytics.com/mp/collect';
        const response = await axiosClient.post(endpoint, payload, {
            params: { measurement_id: measurementId, api_secret: apiSecret },
            headers: { 'Content-Type': 'application/json' },
            timeout: timeoutMs,
            validateStatus: status => status >= 200 && status < 300
        });
        if (debug && response.data?.validationMessages?.length) {
            throw new Error(`GA4 validation failed: ${JSON.stringify(response.data.validationMessages)}`);
        }
        return payload;
    }

    async function handle(req, res) {
        if (!configured) return res.status(503).json({ ok: false, error: 'Analytics relay is not configured' });
        const remoteAddress = String(req.headers['x-forwarded-for'] || req.ip || '')
            .split(',')[0]
            .trim();
        if (!consumeIp(remoteAddress)) return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });

        const validation = validateEvent(req.body, allowedPluginIds, allowedEventNames);
        if (validation.error) {
            return res.status(validation.status || 400).json({ ok: false, error: validation.error });
        }
        const { event } = validation;
        const userIdHash = hashUserId(event.userId, hmacSecret);
        if (excludedUserIdHashes.has(userIdHash)) {
            return res.status(204).end();
        }
        if (!consumeUser(`${event.pluginId}:${event.userId}`)) {
            return res.status(429).json({ ok: false, error: 'User rate limit exceeded' });
        }

        try {
            const user = userStore.resolve(event);
            await forward(event, user);
            return res.status(204).end();
        } catch (error) {
            logger.error('Analytics relay failed:', error.message);
            return res.status(502).json({ ok: false, error: 'Analytics relay failed' });
        }
    }

    return {
        configured,
        handle,
        listUsers: options => {
            if (!configured) throw new Error('Analytics relay is not configured');
            return userStore.listUsers(options);
        },
        health: () => ({
            ok: configured && userStore.healthCheck(),
            ga4_mode: dryRun ? 'dry-run' : debug ? 'debug' : 'collect'
        }),
        close: () => userStore?.close()
    };
}

function mountAnalyticsRelay(app, options = {}) {
    const relay = createAnalyticsRelay(options);
    app.post('/api/plugin-events', relay.handle);
    app.get('/analytics-healthz', (req, res) => {
        const health = relay.health();
        res.status(health.ok ? 200 : 503).json(health);
    });
    return relay;
}

module.exports = {
    createAnalyticsRelay,
    createClientId,
    createUserStore,
    hashUserId,
    mountAnalyticsRelay,
    validateEvent
};
