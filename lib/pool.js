'use strict';
// Round-robin token pool with cooldown on auth failures.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'tokens.json');

class TokenPool {
  constructor(tokens) {
    this.tokens = tokens.map((t) => ({ token: t, cooldownUntil: 0, failures: 0 }));
    this.cursor = 0;
  }

  static load() {
    const fromEnv = (process.env.DEEPSEEK_TOKENS || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    let fromFile = [];
    const file = process.env.DEEPSEEK_TOKENS_FILE || path.join(__dirname, '..', 'tokens.txt');
    if (fs.existsSync(file)) {
      fromFile = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    }

    return new TokenPool([...new Set([...fromEnv, ...fromFile])]);
  }

  get size() {
    return this.tokens.length;
  }

  pick() {
    const now = Date.now();
    for (let i = 0; i < this.tokens.length; i++) {
      const idx = (this.cursor + i) % this.tokens.length;
      const entry = this.tokens[idx];
      if (entry.cooldownUntil <= now) {
        this.cursor = (idx + 1) % this.tokens.length;
        return entry.token;
      }
    }
    return null;
  }

  // Milliseconds until the soonest cooled-down token becomes usable again.
  // Returns 0 when a token is already available, Infinity when the pool is empty.
  nextAvailableMs() {
    if (!this.tokens.length) return Infinity;
    const now = Date.now();
    let best = Infinity;
    for (const t of this.tokens) {
      const wait = t.cooldownUntil - now;
      if (wait <= 0) return 0;
      if (wait < best) best = wait;
    }
    return best;
  }

  penalize(token, retryAfterMs = 60_000) {
    const entry = this.tokens.find((t) => t.token === token);
    if (!entry) return;
    entry.failures += 1;
    entry.cooldownUntil = Date.now() + retryAfterMs * Math.min(entry.failures, 10);
  }

  reward(token) {
    const entry = this.tokens.find((t) => t.token === token);
    if (entry) entry.failures = 0;
  }

  status() {
    const now = Date.now();
    return this.tokens.map((t, i) => ({
      index: i,
      token: t.token.slice(0, 8) + '…' + t.token.slice(-4),
      available: t.cooldownUntil <= now,
      failures: t.failures,
    }));
  }
}

module.exports = { TokenPool };
