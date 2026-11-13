'use strict';
// Signup pipeline smoke tests.
//
// What this proves without needing a captcha solver or a real mailbox:
//   1. guest PoW is accepted (the challenge endpoint works without auth and
//      our X-DS-Guest-PoW-Response header clears the 40300 gate)
//   2. /users/register with a correct body shape and a bogus code returns
//      EMAIL_EXPIRED (biz_code 7) — not 40300, not 422 — which means the PoW,
//      headers and payload were all accepted and only the code was checked
//   3. /users/create_email_verification_code without a captcha token is rejected
//      with RECAPTCHA_VERIFY_FAILED (biz_code 2) — the expected gate
//
// Run:  node scripts/test-signup.js

const crypto = require('crypto');
const assert = require('assert');
const { guestPow, requestCode, register, SignupError, BIZ } = require('../lib/signup');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(` FAIL ${name}`);
    console.error('      ' + (e && e.stack ? e.stack.split('\n')[0] : e));
    failed++;
  }
}

async function main() {
  console.log('test-signup: guest PoW + signup gates\n');

  await test('guestPow returns a base64 header for /api/v0/users/register', async () => {
    const pow = await guestPow('/api/v0/users/register');
    assert.strictEqual(typeof pow, 'string');
    assert.ok(pow.length > 20, 'pow header too short');
    const decoded = JSON.parse(Buffer.from(pow, 'base64').toString('utf8'));
    assert.ok('salt' in decoded, 'missing salt');
    assert.ok('answer' in decoded, 'missing answer');
  });

  await test('guestPow works for the email verification endpoint too', async () => {
    const pow = await guestPow('/api/v0/users/create_email_verification_code');
    const decoded = JSON.parse(Buffer.from(pow, 'base64').toString('utf8'));
    assert.ok(typeof decoded.answer === 'number');
  });

  await test('register with a bogus code returns EMAIL_EXPIRED, not 40300/422', async () => {
    const email = `probe${crypto.randomBytes(4).toString('hex')}@gmail.com`;
    let err;
    try {
      await register(email, '000000', crypto.randomBytes(12).toString('base64url'));
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof SignupError, 'expected SignupError, got ' + err);
    assert.notStrictEqual(err.code, 40300, 'guest PoW was rejected as Missing Header');
    assert.strictEqual(err.bizCode, BIZ.EMAIL_EXPIRED, `expected EMAIL_EXPIRED(7), got ${err.bizCode} ${err.bizMsg}`);
  });

  await test('requestCode without captcha is rejected with RECAPTCHA_VERIFY_FAILED', async () => {
    const email = `probe${crypto.randomBytes(4).toString('hex')}@gmail.com`;
    let err;
    try {
      await requestCode(email, {});
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof SignupError, 'expected SignupError');
    assert.strictEqual(err.bizCode, BIZ.RECAPTCHA_VERIFY_FAILED, `expected biz 2, got ${err.bizCode} ${err.bizMsg}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error('fatal:', e && e.stack || e);
  process.exit(1);
});
