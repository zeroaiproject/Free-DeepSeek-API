'use strict';
// Offline PoW self-test using a recorded challenge/answer pair.
// Verifies the WASM module loads and solves exactly as the DeepSeek web client does.

const assert = require('assert');
const { init } = require('../lib/pow');

// Captured from a live /api/v0/chat/create_pow_challenge response.
const VECTOR = {
  algorithm: 'DeepSeekHashV1',
  challenge: '430d78b23eba0333f48884d6fd7ca9cd0c82015998c686d8c6f0b2d5b17e758b',
  salt: 'eb87c08c211ccabf8377',
  difficulty: 144000,
  expire_at: 1794522145200,
  expected: 137201,
};

(async () => {
  const hasher = await init();
  const t0 = Date.now();
  const answer = hasher.solve(VECTOR);
  const ms = Date.now() - t0;

  console.log(`answer=${answer} expected=${VECTOR.expected} in ${ms}ms`);
  assert.strictEqual(answer, VECTOR.expected, 'PoW answer mismatch');
  console.log('POW SELFTEST OK');
})().catch((e) => {
  console.error('POW SELFTEST FAILED:', e.message);
  process.exit(1);
});
