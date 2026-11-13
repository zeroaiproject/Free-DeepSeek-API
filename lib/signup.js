'use strict';
// Automated DeepSeek account creation.
//
// The signup flow has four gates and this module clears three of them:
//
//   1. guest PoW      solved here (DeepSeek's own WASM hasher, ~30-110 ms)
//   2. e-mail domain  must not be on DeepSeek's disposable list
//   3. captcha        hCaptcha invisible widget — needs a real token, see
//                     lib/captcha.js (paid solver, or a clean residential IP)
//   4. mailbox        the 6-digit code, see lib/mailbox.js
//
// The order matters: the challenge is issued per target_path, is valid for
// 300 s unsolved, and the solved answer is single-use. So every call that
// carries `X-DS-Guest-PoW-Response` gets its own fresh challenge.

const crypto = require('crypto');
const { request } = require('./deepseek');
const { init } = require('./pow');

// The Android client shape is used for the API calls: the web `os` value gets
// HTTP 202 with an empty body from the anti-bot gate on some paths. The
// register call itself is the exception and requires os:"web" plus a nested
// payload — that shape is enforced by the 422 validator, not by taste.
const CLIENT_VERSION = process.env.DEEPSEEK_CLIENT_VERSION || '2.7.6';

const USER_AGENT = `DeepSeek/${CLIENT_VERSION} (Android 14; Pixel 7)`;

const CLIENT_HEADERS = {
  'x-client-platform': 'android',
  'x-client-version': CLIENT_VERSION,
  'x-app-version': CLIENT_VERSION,
  'User-Agent': USER_AGENT,
};

// Business codes that come back inside a 200 with code:0.
const BIZ = {
  OK: 0,
  RECAPTCHA_VERIFY_FAILED: 2,
  EMAIL_EXPIRED: 7,
  EMAIL_DOMAIN_NOT_SUPPORTED: 13,
  EMAIL_ALREADY_REGISTERED: 3,
};

class SignupError extends Error {
  constructor(message, { code, bizCode, bizMsg, body } = {}) {
    super(message);
    this.name = 'SignupError';
    this.code = code;
    this.bizCode = bizCode;
    this.bizMsg = bizMsg;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- guest PoW

// One challenge + answer pair, shaped as the header DeepSeek expects for
// unauthenticated calls. Note the payload is only {salt, answer}: the
// authenticated variant is the one that carries the full challenge object.
async function guestPow(targetPath) {
  const res = await request('/api/v0/users/create_guest_challenge', {
    method: 'POST',
    body: { target_path: targetPath },
    headers: CLIENT_HEADERS,
  });

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new SignupError(`guest challenge: unparseable response ${res.body.slice(0, 200)}`);
  }

  if (json.code !== 0) {
    throw new SignupError(`guest challenge rejected (${json.code}): ${json.msg}`, { code: json.code });
  }
  const envelope = json.data || {};
  if (envelope.biz_code !== BIZ.OK) {
    throw new SignupError(`guest challenge refused (${envelope.biz_code}): ${envelope.biz_msg}`, {
      bizCode: envelope.biz_code,
      bizMsg: envelope.biz_msg,
    });
  }

  const challenge = envelope.biz_data?.guest_challenge;
  if (!challenge) throw new SignupError('guest challenge: empty payload');

  const hasher = await init();
  const answer = hasher.solve(challenge);
  if (answer === undefined) throw new SignupError('guest challenge: no answer found');

  return Buffer.from(JSON.stringify({ salt: challenge.salt, answer })).toString('base64');
}

// ------------------------------------------------------------- verification

// Requests the 6-digit code. Requires a captcha token from a real solve; the
// server answers {"biz_code":2,"biz_msg":"RECAPTCHA_VERIFY_FAILED"} otherwise,
// including for syntactically valid but forged tokens.
async function requestCode(email, { captchaToken, turnstileToken, shumei, locale = 'en_US', deviceId, scenario = 'register' } = {}) {
  const did = deviceId || crypto.randomUUID();
  const path = '/api/v0/users/create_email_verification_code';
  const pow = await guestPow(path);

  const body = {
    email,
    locale,
    device_id: did,
    scenario,
    os: 'web',
  };
  if (captchaToken) body.hcaptcha_token = captchaToken;
  if (turnstileToken) body.turnstile_token = turnstileToken;
  if (shumei) body.shumei_verification = shumei;

  const res = await request(path, {
    method: 'POST',
    body,
    headers: {
      ...CLIENT_HEADERS,
      'x-device-id': did,
      'x-ds-guest-pow-response': pow,
    },
  });

  return parseEnvelope(res, 'request code');
}

// ------------------------------------------------------------------ register

// Final step. `region` must be a two-letter code; DeepSeek validates the
// nested payload shape before it even looks at the code.
async function register(email, verificationCode, password, { locale = 'en_US', region = 'US', deviceId } = {}) {
  const did = deviceId || crypto.randomUUID();
  const path = '/api/v0/users/register';
  const pow = await guestPow(path);

  const res = await request(path, {
    method: 'POST',
    body: {
      locale,
      region,
      payload: {
        email,
        email_verification_code: verificationCode,
        password,
      },
      device_id: did,
      os: 'web',
    },
    headers: {
      ...CLIENT_HEADERS,
      'x-device-id': did,
      'x-ds-guest-pow-response': pow,
    },
  });

  const envelope = parseEnvelope(res, 'register');
  const biz = envelope.biz_data || {};
  const token = biz.user?.token || biz.token;
  if (!token) {
    throw new SignupError('register succeeded but returned no token', { body: JSON.stringify(biz).slice(0, 300) });
  }
  return {
    token,
    email: biz.user?.email || email,
    password,
    deviceId: did,
    user: biz.user || null,
  };
}

// ------------------------------------------------------------------- facade

function parseEnvelope(res, what) {
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new SignupError(`${what}: unparseable response (HTTP ${res.status}) ${res.body.slice(0, 200)}`);
  }

  if (json.code !== 0) {
    throw new SignupError(`${what} rejected (${json.code}): ${json.msg}`, { code: json.code, body: res.body });
  }

  const envelope = json.data || {};
  if (envelope.biz_code !== BIZ.OK) {
    const msg = envelope.biz_msg || 'unknown';
    const hint =
      envelope.biz_code === BIZ.RECAPTCHA_VERIFY_FAILED
        ? ' — the captcha token was missing or rejected (see lib/captcha.js)'
        : envelope.biz_code === BIZ.EMAIL_DOMAIN_NOT_SUPPORTED
          ? ' — disposable mailbox domain is blocked'
          : envelope.biz_code === BIZ.EMAIL_EXPIRED
            ? ' — the verification code is wrong or expired'
            : '';
    throw new SignupError(`${what} failed (${envelope.biz_code}): ${msg}${hint}`, {
      bizCode: envelope.biz_code,
      bizMsg: msg,
      body: res.body,
    });
  }

  return envelope;
}

// Full pipeline: solve the captcha, ask for the code, read the mailbox,
// register. `mailbox` is anything with `.address` and `.waitForCode()`.
async function createAccount({ mailbox, password, captcha, locale = 'en_US', region = 'US', deviceId, codeTimeoutMs = 180_000 } = {}) {
  if (!mailbox) throw new SignupError('createAccount needs a mailbox');

  const did = deviceId || crypto.randomUUID();
  const pass = password || crypto.randomBytes(18).toString('base64url');

  const captchaToken = captcha === undefined ? null : captcha;
  await requestCode(mailbox.address, { captchaToken, locale, deviceId: did });

  const code = await mailbox.waitForCode({ timeoutMs: codeTimeoutMs });
  if (!code) throw new SignupError('no verification code arrived in the mailbox');

  return register(mailbox.address, code, pass, { locale, region, deviceId: did });
}

module.exports = {
  guestPow,
  requestCode,
  register,
  createAccount,
  SignupError,
  BIZ,
  CLIENT_VERSION,
  CLIENT_HEADERS,
  sleep,
};
