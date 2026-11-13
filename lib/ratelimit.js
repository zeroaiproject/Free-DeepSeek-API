'use strict';
// Per-token outbound rate limiter.
//
// DeepSeek silently answers the 9th back-to-back completion with an empty
// stream, and hammering past that point is what gets a session revoked.
// A token bucket keeps the proxy under the tolerance; jitter and pacing avoid
// perfectly periodic traffic that looks automated.

function randInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

class RateLimiter {
  constructor({
    burst = 6,
    refillMs = 5000,
    cooldownMs = 30_000,
    cooldownMaxMs = 5 * 60_000,
    jitterMs = 400,
    minGapMs = 1200,
  } = {}) {
    this.burst = Math.max(1, burst);
    this.refillMs = Math.max(0, refillMs);
    this.cooldownMs = Math.max(0, cooldownMs);
    this.cooldownMaxMs = Math.max(this.cooldownMs, cooldownMaxMs);
    this.jitterMs = Math.max(0, jitterMs);
    this.minGapMs = Math.max(0, minGapMs);
    this.state = new Map(); // token -> { tokens, last, blockedUntil, lastTakeAt, cooldownStreak }
    this.locks = new Map(); // token -> { busy, waiters }
  }

  #st(token) {
    let s = this.state.get(token);
    if (!s) {
      s = { tokens: this.burst, last: Date.now(), blockedUntil: 0, lastTakeAt: 0, cooldownStreak: 0 };
      this.state.set(token, s);
    }
    return s;
  }

  #jitter(base = 0) {
    if (this.jitterMs <= 0) return Math.max(0, Math.ceil(base));
    // +/- jitter around base, never below 0
    const delta = randInt(-Math.floor(this.jitterMs / 2), this.jitterMs);
    return Math.max(0, Math.ceil(base + delta));
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

    // Enforce a minimum gap between completions to avoid machine-gun cadence.
    const gapWait = s.lastTakeAt ? this.minGapMs - (now - s.lastTakeAt) : 0;

    if (s.tokens >= 1) {
      if (gapWait > 0) return this.#jitter(gapWait);
      return 0;
    }

    const refillWait = (1 - s.tokens) * this.refillMs;
    return this.#jitter(Math.max(refillWait, gapWait));
  }

  // Reserves one slot. Call after waitMs() has returned 0.
  take(token) {
    const s = this.#st(token);
    s.tokens = Math.max(0, s.tokens - 1);
    s.last = Date.now();
    s.lastTakeAt = Date.now();
  }

  // Called when upstream reports its own limit: stop sending for a while.
  // Escalates on consecutive throttles and adds jitter.
  cooldown(token) {
    const s = this.#st(token);
    s.cooldownStreak = Math.min((s.cooldownStreak || 0) + 1, 6);
    const factor = Math.pow(1.6, s.cooldownStreak - 1);
    const base = Math.min(this.cooldownMaxMs, Math.round(this.cooldownMs * factor));
    const wait = this.#jitter(base);
    s.blockedUntil = Math.max(s.blockedUntil, Date.now() + wait);
    s.tokens = 0;
    s.last = Date.now();
  }

  // A successful completion resets escalation (traffic is accepted again).
  reward(token) {
    const s = this.#st(token);
    s.cooldownStreak = 0;
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
      cooldownStreak: s.cooldownStreak || 0,
    }));
  }
}

module.exports = { RateLimiter };
