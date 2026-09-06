const assert = require('node:assert/strict');
const test = require('node:test');
const {
    createBrowserSaveCollector,
    withBrowserSaveSession
} = require('../browser-save-collector');

test('browser Save session always closes the browser', async () => {
    let closeCount = 0;
    const collector = { close: async () => closeCount++ };

    await assert.rejects(
        withBrowserSaveSession(collector, async () => {
            throw new Error('collection failed');
        }),
        /collection failed/
    );
    assert.equal(closeCount, 1);
});

test('browser Save collector reuses one persistent browser and page', async () => {
    const visitedUrls = [];
    let launchCount = 0;
    const page = {
        isClosed: () => false,
        setDefaultNavigationTimeout: () => {},
        setViewport: async () => {},
        setUserAgent: async () => {},
        setExtraHTTPHeaders: async () => {},
        waitForNetworkIdle: async () => {},
        evaluate: async () => {},
        mouse: { move: async () => {} },
        goto: async url => {
            visitedUrls.push(url);
            return { status: () => 200, headers: () => ({}) };
        },
        content: async () => '<script type="application/ld+json">{"saves":12}</script>'
    };
    const browser = {
        connected: true,
        userAgent: async () => 'Mozilla/5.0 HeadlessChrome/142.0.0.0 Safari/537.36',
        pages: async () => [page],
        close: async () => {}
    };
    const puppeteer = {
        launch: async options => {
            launchCount++;
            assert.match(options.userDataDir, /figma-browser-profile$/);
            return browser;
        }
    };
    const collector = createBrowserSaveCollector({
        puppeteer,
        settleDelayMs: 0,
        delay: async () => {},
        extractSaveCount: html => html.includes('"saves":12') ? 12 : null
    });

    await collector.warmUp();
    assert.equal(await collector.fetchSaveCount('101'), 12);
    assert.equal(await collector.fetchSaveCount('102'), 12);
    assert.equal(launchCount, 1);
    assert.deepEqual(visitedUrls, [
        'https://www.figma.com/community',
        'https://www.figma.com/community/plugin/101',
        'https://www.figma.com/community/plugin/102'
    ]);

    await collector.close();
});

test('browser Save collector lets a JavaScript WAF challenge finish', async () => {
    let contentReads = 0;
    const page = {
        isClosed: () => false,
        setDefaultNavigationTimeout: () => {},
        setViewport: async () => {},
        setUserAgent: async () => {},
        setExtraHTTPHeaders: async () => {},
        evaluate: async () => {},
        mouse: { move: async () => {} },
        goto: async () => ({
            status: () => 202,
            headers: () => ({ 'x-amzn-waf-action': 'challenge' })
        }),
        content: async () => {
            contentReads++;
            return contentReads === 1 ? '<div>challenge</div>' : '<div>save=34</div>';
        },
        cookies: async () => [{ name: 'aws-waf-token', value: 'token' }]
    };
    const browser = {
        connected: true,
        userAgent: async () => 'Mozilla/5.0 HeadlessChrome/142.0.0.0 Safari/537.36',
        pages: async () => [page],
        close: async () => {}
    };
    const collector = createBrowserSaveCollector({
        puppeteer: { launch: async () => browser },
        settleDelayMs: 0,
        delay: async () => {},
        extractSaveCount: html => html.includes('save=34') ? 34 : null
    });

    assert.equal(await collector.fetchSaveCount('101'), 34);
    assert.equal(contentReads, 2);
    await collector.close();
});
