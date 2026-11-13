'use strict';
// Per-token outbound rate limiter.
//
// DeepSeek silently answers the 9th back-to-back completion with an empty
// stream, and hammering past that point is what gets a session revoked.
// A token bucket keeps the proxy just under the tolerance: a small burst for
// agent loops, then a steady drip.

class RateLimiter {
  constructor({ burst = 6, refillMs = 1500, cooldownMs = 25_000 } = {}) {
    this.burst = Math.max(1, burst);
    this.refillMs = Math.max(0, refillMs);
    this.cooldownMs = Math.max(0, cooldownMs);
    this.state = new Map(); // token -> { tokens, last, blockedUntil }
    this.locks = new Map(); // token -> { busy, waiters }
  }

  #st(token) {
    let s = this.state.get(token);
    if (!s) {
      s = { tokens: this.burst, last: Date.now(), blockedUntil: 0 };
      this.state.set(token, s);
    }
    return s;
  }

  // Milliseconds to wait before the next upstream call is allowed.
  waitMs(token) {
    const s = this.#st(token);
    const now = Date.now();

    if (s.blockedUntil > now) return s.blockedUntil - now;

    // Refill proportionally to elapsed time.
    const elapsed = now - s.last;
    if (elapsed > 0 && this.refillMs > 0) {
      const gained = elapsed / this.refillMs;
      if (gained > 0) {
        s.tokens = Math.min(this.burst, s.tokens + gained);
        s.last = now;
      }
    }

    if (s.tokens >= 1) return 0;
    return Math.ceil((1 - s.tokens) * this.refillMs);
  }

  // Reserves one slot. Call after waitMs() has returned 0.
  take(token) {
    const s = this.#st(token);
    s.tokens = Math.max(0, s.tokens - 1);
    s.last = Date.now();
  }

  // Called when upstream reports its own limit: stop sending for a while.
  cooldown(token) {
    const s = this.#st(token);
    s.blockedUntil = Math.max(s.blockedUntil, Date.now() + this.cooldownMs);
    s.tokens = 0;
    s.last = Date.now();
  }

  blockedFor(token) {
    const s = this.#st(token);
    return Math.max(0, s.blockedUntil - Date.now());
  }

  // One upstream completion at a time per token. Agent tool loops are already
  // sequential, so this costs nothing, and it removes the overlap that made a
  // burst look like automation to DeepSeek.
  lock(token) {
    let m = this.locks.get(token);
    if (!m) {
      m = { busy: false, waiters: [] };
      this.locks.set(token, m);
    }
    const release = () => {
      const next = m.waiters.shift();
      if (next) next(release);
      else m.busy = false;
    };
    if (!m.busy) {
      m.busy = true;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => m.waiters.push(resolve));
  }

  stats() {
    const now = Date.now();
    return [...this.state.entries()].map(([token, s]) => ({
      token: token.slice(0, 8) + '…' + token.slice(-4),
      tokens: Number(s.tokens.toFixed(2)),
      blockedMs: Math.max(0, s.blockedUntil - now),
    }));
  }
}

module.exports = { RateLimiter };
