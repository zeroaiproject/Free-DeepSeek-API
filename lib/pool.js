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

    const pool = new TokenPool([...new Set([...fromEnv, ...fromFile])]);
    pool.file = file;
    pool.stamp = TokenPool.stamp(file);
    return pool;
  }

  static stamp(file) {
    try {
      const s = fs.statSync(file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return '';
    }
  }

  // Picks up a token pasted into tokens.txt without restarting the server.
  // Keeps cooldown state for tokens that are still present.
  reloadIfChanged() {
    if (!this.file) return false;
    const stamp = TokenPool.stamp(this.file);
    if (stamp === this.stamp) return false;
    this.stamp = stamp;

    let lines = [];
    try {
      lines = fs
        .readFileSync(this.file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    } catch {
      return false;
    }

    const fromEnv = (process.env.DEEPSEEK_TOKENS || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const next = [...new Set([...fromEnv, ...lines])];
    const previous = new Map(this.tokens.map((t) => [t.token, t]));
    this.tokens = next.map((t) => previous.get(t) || { token: t, cooldownUntil: 0, failures: 0 });
    if (this.cursor >= this.tokens.length) this.cursor = 0;
    return true;
  }

  // Replaces a dead token with a freshly obtained one.
  swap(oldToken, newToken) {
    const entry = this.tokens.find((t) => t.token === oldToken);
    if (entry) {
      entry.token = newToken;
      entry.cooldownUntil = 0;
      entry.failures = 0;
    } else {
      this.tokens.push({ token: newToken, cooldownUntil: 0, failures: 0 });
    }
    return newToken;
  }

  persist() {
    if (!this.file) return;
    try {
      const body =
        '# One DeepSeek web userToken per line. Lines starting with # are ignored.\n' +
        this.tokens.map((t) => t.token).join('\n') +
        '\n';
      fs.writeFileSync(this.file, body, { mode: 0o600 });
      try {
        fs.chmodSync(this.file, 0o600);
      } catch {}
      this.stamp = TokenPool.stamp(this.file);
      return true;
    } catch {
      return false;
    }
  }

  add(token) {
    if (!token || this.tokens.some((t) => t.token === token)) return false;
    this.tokens.push({ token, cooldownUntil: 0, failures: 0 });
    this.persist();
    return true;
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
    // Fixed cooldown: callers already choose the duration. Multiplying it by the
    // failure count used to push transient 1.2s penalties past the retry window.
    entry.cooldownUntil = Date.now() + retryAfterMs;
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
