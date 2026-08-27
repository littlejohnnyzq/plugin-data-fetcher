const path = require('path');

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
const DEFAULT_SETTLE_DELAY_MS = 1500;
const DEFAULT_CHALLENGE_TIMEOUT_MS = 20000;
const DEFAULT_PROFILE_PATH = path.join(__dirname, 'state', 'figma-browser-profile');
const COMMUNITY_WARMUP_URL = 'https://www.figma.com/community';

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createBrowserSaveCollector(options = {}) {
    const puppeteer = options.puppeteer ?? require('puppeteer');
    const extractSaveCount = options.extractSaveCount;
    if (typeof extractSaveCount !== 'function') {
        throw new TypeError('extractSaveCount is required');
    }

    const navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    const settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
    const challengeTimeoutMs = options.challengeTimeoutMs ?? DEFAULT_CHALLENGE_TIMEOUT_MS;
    const sleep = options.delay ?? delay;
    const userDataDir = options.userDataDir ?? process.env.SAVE_BROWSER_PROFILE_PATH ?? DEFAULT_PROFILE_PATH;
    let browser = null;
    let page = null;
    let queue = Promise.resolve();

    async function resetBrowser() {
        const currentBrowser = browser;
        browser = null;
        page = null;
        if (currentBrowser) {
            try {
                await currentBrowser.close();
            } catch (error) {
                console.warn('Failed to close Save browser cleanly:', error.message);
            }
        }
    }

    async function ensurePage() {
        if (browser?.connected && page && !page.isClosed()) {
            return page;
        }

        await resetBrowser();
        const launchOptions = {
            headless: process.env.SAVE_BROWSER_HEADLESS !== 'false',
            userDataDir,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        };
        if (process.env.SAVE_BROWSER_EXECUTABLE_PATH) {
            launchOptions.executablePath = process.env.SAVE_BROWSER_EXECUTABLE_PATH;
        }

        try {
            browser = await puppeteer.launch(launchOptions);
        } catch (error) {
            error.browserCode = error.code;
            error.code = 'SAVE_BROWSER_UNAVAILABLE';
            throw error;
        }
        const pages = await browser.pages();
        page = pages[0] ?? await browser.newPage();
        page.setDefaultNavigationTimeout(navigationTimeoutMs);
        await page.setViewport({ width: 1280, height: 800 });
        const browserUserAgent = await browser.userAgent();
        await page.setUserAgent(browserUserAgent.replace('HeadlessChrome/', 'Chrome/'));
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        return page;
    }

    function createWafError(message = 'Figma WAF challenge') {
        const error = new Error(message);
        error.code = 'FIGMA_WAF_CHALLENGE';
        return error;
    }

    function isChallengeResponse(response) {
        const status = response?.status();
        const headers = response?.headers() ?? {};
        return status === 202 || headers['x-amzn-waf-action'] === 'challenge';
    }

    async function performHumanInteraction(activePage) {
        const firstX = 180 + Math.floor(Math.random() * 500);
        const firstY = 120 + Math.floor(Math.random() * 350);
        await activePage.mouse.move(firstX, firstY, { steps: 8 });
        await sleep(300 + Math.floor(Math.random() * 500));
        await activePage.evaluate(distance => window.scrollBy({ top: distance, behavior: 'smooth' }), 250 + Math.floor(Math.random() * 450));
        await sleep(700 + Math.floor(Math.random() * 800));
        await activePage.mouse.move(firstX + 80, firstY + 60, { steps: 6 });
    }

    async function waitForChallenge(activePage, url, contentExtractor) {
        const deadline = Date.now() + challengeTimeoutMs;
        let tokenSeen = false;
        let tokenSeenAt = null;

        while (Date.now() < deadline) {
            await sleep(1000);
            const html = await activePage.content();
            const extracted = contentExtractor?.(html);
            if (extracted !== null && extracted !== undefined) {
                return extracted;
            }
            if (/captcha-container|x-amzn-waf-action["']?\s*[:=]\s*["']captcha/i.test(html)) {
                const error = new Error('Figma WAF CAPTCHA requires manual completion');
                error.code = 'FIGMA_WAF_CAPTCHA';
                throw error;
            }
            const cookies = await activePage.cookies();
            tokenSeen = cookies.some(cookie => cookie.name === 'aws-waf-token');
            if (tokenSeen && tokenSeenAt === null) tokenSeenAt = Date.now();
            if (!contentExtractor && tokenSeenAt !== null && Date.now() - tokenSeenAt >= 2000) {
                return null;
            }
        }

        if (!tokenSeen) {
            throw createWafError('Figma WAF challenge did not complete');
        }

        let retryResponse;
        try {
            retryResponse = await activePage.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: Math.min(navigationTimeoutMs, 15000)
            });
        } catch (error) {
            if (!/net::ERR_ABORTED/i.test(error.message)) throw error;
        }
        if (isChallengeResponse(retryResponse)) throw createWafError('Figma WAF challenge persisted after token acquisition');
        if (contentExtractor) {
            const retryDeadline = Date.now() + 10000;
            while (Date.now() < retryDeadline) {
                const extracted = contentExtractor(await activePage.content());
                if (extracted !== null && extracted !== undefined) return extracted;
                await sleep(1000);
            }
        }
        return null;
    }

    async function navigate(activePage, url, contentExtractor) {
        let response;
        try {
            response = await activePage.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: navigationTimeoutMs
            });
        } catch (error) {
            if (!/net::ERR_ABORTED/i.test(error.message) || !contentExtractor) throw error;
            const abortedDeadline = Date.now() + 10000;
            while (Date.now() < abortedDeadline) {
                const extracted = contentExtractor(await activePage.content());
                if (extracted !== null && extracted !== undefined) return extracted;
                await sleep(1000);
            }
            throw error;
        }
        if (response?.status() === 403) throw createWafError('Figma WAF blocked the browser request');
        if (isChallengeResponse(response)) {
            return waitForChallenge(activePage, url, contentExtractor);
        }
        return null;
    }

    async function warmUpBrowser() {
        const activePage = await ensurePage();
        await navigate(activePage, COMMUNITY_WARMUP_URL);
        await performHumanInteraction(activePage);
        if (settleDelayMs > 0) await sleep(settleDelayMs);
    }

    async function fetchFromBrowser(contentId) {
        const activePage = await ensurePage();
        const url = `https://www.figma.com/community/plugin/${encodeURIComponent(contentId)}`;

        try {
            const challengeResult = await navigate(activePage, url, extractSaveCount);
            if (challengeResult !== null) {
                await performHumanInteraction(activePage);
                return challengeResult;
            }
            await performHumanInteraction(activePage);
            if (settleDelayMs > 0) {
                await sleep(settleDelayMs);
            }
            const html = await activePage.content();
            const saveCount = extractSaveCount(html);
            if (saveCount === null) {
                if (/awswaf|challenge-container|captcha/i.test(html)) {
                    throw createWafError();
                }
                throw new Error('UseAction count not found in browser page');
            }
            return saveCount;
        } catch (error) {
            if (/Target closed|Session closed|Connection closed|Navigating frame was detached/i.test(error.message)) {
                await resetBrowser();
            }
            throw error;
        }
    }

    function fetchSaveCount(contentId) {
        const result = queue.then(() => fetchFromBrowser(contentId));
        queue = result.catch(() => {});
        return result;
    }

    function warmUp() {
        const result = queue.then(warmUpBrowser);
        queue = result.catch(() => {});
        return result;
    }

    return {
        fetchSaveCount,
        warmUp,
        close: resetBrowser
    };
}

module.exports = {
    DEFAULT_PROFILE_PATH,
    createBrowserSaveCollector
};
