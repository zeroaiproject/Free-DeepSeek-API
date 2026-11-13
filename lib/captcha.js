'use strict';
// Captcha solving for the DeepSeek signup flow.
//
// chat.deepseek.com uses an invisible hCaptcha widget (sitekey below) on
// /users/create_email_verification_code. The token is verified server-side, so
// it cannot be faked — it has to come from hCaptcha. Three ways to get one:
//
//   none      no token (the request will be rejected; useful for testing)
//   capsolver CapSolver API (paid, ~$0.001 per solve)
//   2captcha  2Captcha API (paid)
//   browser   drives a real Chromium at the signup page; the widget may solve
//             itself when the IP is clean, otherwise it needs a human
//
// The sitekey and page URL are fixed, so a solver only needs a key.

const HCAPTCHA_SITEKEY = process.env.HCAPTCHA_SITEKEY || '352e5376-f2cc-43fe-a744-e51640449610';
const PAGE_URL = process.env.SIGNUP_PAGE_URL || 'https://chat.deepseek.com/sign_up';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url}: unparseable response ${text.slice(0, 200)}`);
  }
}

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url}: unparseable response ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------- CapSolver

async function solveCapSolver({ key, timeoutMs = 120_000 }) {
  const created = await postJson('https://api.capsolver.com/createTask', {
    clientKey: key,
    task: {
      type: 'HCaptchaTaskProxyless',
      websiteURL: PAGE_URL,
      websiteKey: HCAPTCHA_SITEKEY,
      isInvisible: true,
    },
  });
  if (created.errorId) throw new Error(`capsolver createTask: ${created.errorCode} ${created.errorDescription}`);
  const taskId = created.taskId;
  if (!taskId) throw new Error('capsolver: no taskId');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const r = await postJson('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
    if (r.errorId) throw new Error(`capsolver getTaskResult: ${r.errorCode} ${r.errorDescription}`);
    if (r.status === 'ready') {
      const token = r.solution?.gRecaptchaResponse || r.solution?.token;
      if (!token) throw new Error('capsolver: ready without a token');
      return token;
    }
  }
  throw new Error('capsolver: timed out');
}

// ----------------------------------------------------------------- 2Captcha

async function solve2Captcha({ key, timeoutMs = 120_000 }) {
  const created = await getJson(
    'https://2captcha.com/in.php?' +
      new URLSearchParams({
        key,
        method: 'hcaptcha',
        sitekey: HCAPTCHA_SITEKEY,
        pageurl: PAGE_URL,
        invisible: '1',
        json: '1',
      })
  );
  if (created.status !== 1) throw new Error(`2captcha in.php: ${created.request}`);
  const id = created.request;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(5000);
    const r = await getJson(
      'https://2captcha.com/res.php?' + new URLSearchParams({ key, action: 'get', id, json: '1' })
    );
    if (r.status === 1) return r.request;
    if (r.request !== 'CAPCHA_NOT_READY') throw new Error(`2captcha res.php: ${r.request}`);
  }
  throw new Error('2captcha: timed out');
}

// -------------------------------------------------------------- real browser
//
// Loads the signup page, which also clears the AWS WAF challenge on the HTML
// path, then lets the widget run. If hCaptcha is in a good mood the token
// appears on its own; otherwise the caller is told a challenge needs a human
// (set CAPTCHA_HEADFUL=1 to watch it and click).

async function solveBrowser({ timeoutMs = 90_000, email } = {}) {
  let playwright;
  try {
    playwright = require('playwright-core');
  } catch {
    throw new Error('browser captcha provider needs playwright-core (npm i playwright-core)');
  }

  const executablePath = process.env.CHROME_PATH || undefined;
  const headless = process.env.CAPTCHA_HEADFUL !== '1';
  const browser = await playwright.chromium.launch({
    executablePath,
    headless,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    });
    const page = await ctx.newPage();
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(6000);

    for (const name of ['Accept all cookies', 'Necessary cookies only']) {
      const b = page.getByRole('button', { name });
      if (await b.count().catch(() => 0)) {
        await b.first().click().catch(() => {});
        break;
      }
    }

    const address = email || 'probe' + Math.random().toString(36).slice(2, 10) + '@gmail.com';
    await page.locator('input[placeholder*="Email" i]').first().fill(address);
    await page.waitForTimeout(400);

    // The token arrives either in the request body or through the widget
    // callback; watch both.
    const tokenPromise = page
      .waitForRequest(
        (r) => r.url().includes('/api/v0/users/create_email_verification_code'),
        { timeout: timeoutMs }
      )
      .then((r) => {
        const body = r.postData() || '';
        const m = body.match(/"hcaptcha_token":"([^"]+)"/);
        return m ? m[1] : null;
      })
      .catch(() => null);

    await page.getByRole('button', { name: 'Send code' }).first().click().catch(() => {});

    const token = await tokenPromise;
    if (token) return token;

    const challenged = page.frames().some((f) => f.url().includes('hcaptcha') && f.url().includes('frame=challenge'));
    if (challenged) {
      throw new Error(
        'hCaptcha served an image challenge: a human or a paid solver is required (CAPTCHA_HEADFUL=1 to solve it by hand)'
      );
    }
    throw new Error('hCaptcha produced no token within the timeout');
  } finally {
    await browser.close().catch(() => {});
  }
}

// ------------------------------------------------------------------- facade

async function solveCaptcha(opts = {}) {
  const provider = opts.provider || process.env.CAPTCHA_PROVIDER || 'none';

  switch (provider) {
    case 'none':
      return null;
    case 'capsolver': {
      const key = opts.key || process.env.CAPSOLVER_KEY;
      if (!key) throw new Error('CAPTCHA_PROVIDER=capsolver needs CAPSOLVER_KEY');
      return solveCapSolver({ key });
    }
    case '2captcha': {
      const key = opts.key || process.env.TWOCAPTCHA_KEY;
      if (!key) throw new Error('CAPTCHA_PROVIDER=2captcha needs TWOCAPTCHA_KEY');
      return solve2Captcha({ key });
    }
    case 'browser':
      return solveBrowser({ email: opts.email });
    default:
      throw new Error(`unknown captcha provider: ${provider}`);
  }
}

module.exports = {
  solveCaptcha,
  solveCapSolver,
  solve2Captcha,
  solveBrowser,
  HCAPTCHA_SITEKEY,
  PAGE_URL,
};
