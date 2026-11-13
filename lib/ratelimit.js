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
    adaptive = true,
  } = {}) {
    this.burst = Math.max(1, burst);
    this.refillMs = Math.max(0, refillMs);
    this.cooldownMs = Math.max(0, cooldownMs);
    this.cooldownMaxMs = Math.max(this.cooldownMs, cooldownMaxMs);
    this.jitterMs = Math.max(0, jitterMs);
    this.minGapMs = Math.max(0, minGapMs);
    this.adaptive = adaptive !== false;
    this.state = new Map(); // token -> state
    this.locks = new Map(); // token -> { busy, waiters }
  }

  #st(token) {
    let s = this.state.get(token);
    if (!s) {
      s = {
        tokens: this.burst,
        last: Date.now(),
        blockedUntil: 0,
        lastTakeAt: 0,
        cooldownStreak: 0,
        // adaptive signals
        ewmaLatencyMs: 0,
        successStreak: 0,
        errorStreak: 0,
        dynamicGapMs: this.minGapMs,
      };
      this.state.set(token, s);
    }
    return s;
  }

  #jitter(base = 0) {
    if (this.jitterMs <= 0) return Math.max(0, Math.ceil(base));
    const delta = randInt(-Math.floor(this.jitterMs / 2), this.jitterMs);
    return Math.max(0, Math.ceil(base + delta));
  }

  #effectiveGap(s) {
    if (!this.adaptive) return this.minGapMs;
    const base = this.minGapMs;
    const latencyPressure = s.ewmaLatencyMs > 12000 ? Math.min(1200, (s.ewmaLatencyMs - 12000) * 0.05) : 0;
    const errorPressure = Math.min(1500, (s.errorStreak || 0) * 250);
    const successRelief = Math.min(400, (s.successStreak || 0) * 40);
    const gap = Math.max(base * 0.75, Math.min(base * 3, base + latencyPressure + errorPressure - successRelief));
    s.dynamicGapMs = Math.round(gap);
    return s.dynamicGapMs;
  }

  // Milliseconds to wait before the next upstream call is allowed.
  waitMs(token) {
    const s = this.#st(token);
    const now = Date.now();

    if (s.blockedUntil > now) return s.blockedUntil - now;

    const elapsed = now - s.last;
    if (elapsed > 0 && this.refillMs > 0) {
      const gained = elapsed / this.refillMs;
      if (gained > 0) {
        s.tokens = Math.min(this.burst, s.tokens + gained);
        s.last = now;
      }
    }

    const gap = this.#effectiveGap(s);
    const gapWait = s.lastTakeAt ? gap - (now - s.lastTakeAt) : 0;

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

  // Record observed request outcome for adaptive pacing.
  record(token, { latencyMs = 0, ok = false, throttled = false } = {}) {
    if (!this.adaptive) return;
    const s = this.#st(token);
    const ms = Math.max(0, Number(latencyMs) || 0);
    s.ewmaLatencyMs = s.ewmaLatencyMs ? s.ewmaLatencyMs * 0.7 + ms * 0.3 : ms;
    if (throttled) {
      s.errorStreak = (s.errorStreak || 0) + 1;
      s.successStreak = 0;
    } else if (ok) {
      s.successStreak = Math.min((s.successStreak || 0) + 1, 50);
      s.errorStreak = Math.max(0, (s.errorStreak || 0) - 1);
    } else {
      s.errorStreak = (s.errorStreak || 0) + 1;
      s.successStreak = 0;
    }
  }

  // Called when upstream reports its own limit: stop sending for a while.
  cooldown(token) {
    const s = this.#st(token);
    s.cooldownStreak = Math.min((s.cooldownStreak || 0) + 1, 6);
    const factor = Math.pow(1.6, s.cooldownStreak - 1);
    const adaptiveFactor = this.adaptive ? 1 + Math.min(0.8, (s.errorStreak || 0) * 0.08) : 1;
    const base = Math.min(this.cooldownMaxMs, Math.round(this.cooldownMs * factor * adaptiveFactor));
    const wait = this.#jitter(base);
    s.blockedUntil = Math.max(s.blockedUntil, Date.now() + wait);
    s.tokens = 0;
    s.last = Date.now();
  }

  // A successful completion resets escalation (traffic is accepted again).
  reward(token) {
    const s = this.#st(token);
    s.cooldownStreak = 0;
    this.record(token, { ok: true });
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
    return {
      config: {
        burst: this.burst,
        refillMs: this.refillMs,
        cooldownMs: this.cooldownMs,
        cooldownMaxMs: this.cooldownMaxMs,
        jitterMs: this.jitterMs,
        minGapMs: this.minGapMs,
        adaptive: this.adaptive,
      },
      tokens: [...this.state.entries()].map(([token, s]) => {
        const blockedMs = Math.max(0, s.blockedUntil - now);
        const sinceTakeMs = s.lastTakeAt ? now - s.lastTakeAt : null;
        const gap = this.#effectiveGap ? this.#effectiveGap(s) : (s.dynamicGapMs || this.minGapMs);
        return {
          token: token.slice(0, 8) + '…' + token.slice(-4),
          tokens: Number(s.tokens.toFixed(2)),
          blockedMs,
          cooldownStreak: s.cooldownStreak || 0,
          sinceLastTakeMs: sinceTakeMs,
          nextInMs: this.waitMs(token),
          dynamicGapMs: Math.round(gap),
          ewmaLatencyMs: Math.round(s.ewmaLatencyMs || 0),
          successStreak: s.successStreak || 0,
          errorStreak: s.errorStreak || 0,
        };
      }),
    };
  }
}

module.exports = { RateLimiter };
