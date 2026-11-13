'use strict';
// Background token health watchdog.
//
// DeepSeek has no refresh endpoint: a web token is minted only by /users/login
// (or register / oauth). So the only way to keep a proxy alive without human
// input is to notice death early and re-mint from stored credentials before a
// client ever sees a 401. This polls the cheap /users/current endpoint and
// triggers the caller's re-login hook when a token is revoked.

const { request } = require('./deepseek');

const AUTH_CODES = new Set([40002, 40003]);

// Cheap liveness probe. Never sends a completion, so it does not consume the
// request budget that the rate limiter protects.
async function probe(token, timeout = 15_000) {
  let res;
  try {
    res = await request('/api/v0/users/current', { token, timeout });
  } catch (e) {
    return { alive: false, transient: true, reason: e.message };
  }

  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    // The anti-bot gate answers HTTP 202 with an empty body; that is not a
    // statement about the token, so treat it as transient.
    return { alive: false, transient: true, reason: `unparseable body (HTTP ${res.status})` };
  }

  if (json.code === 0 && (json.data?.biz_code ?? 0) === 0) {
    return { alive: true, email: json.data?.biz_data?.email || null };
  }

  const code = json.data?.biz_code ?? json.code;
  return {
    alive: false,
    transient: !AUTH_CODES.has(code),
    code,
    reason: json.data?.biz_msg || json.msg || 'unknown',
  };
}

class Watchdog {
  constructor({ pool, relogin, intervalMs = 90_000, log = console.log } = {}) {
    this.pool = pool;
    this.relogin = relogin;
    this.intervalMs = intervalMs;
    this.log = log;
    this.timer = null;
    this.last = null;
    this.running = false;
  }

  start() {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const seen = new Set();
      for (const entry of this.pool.tokens) {
        const token = entry.token;
        if (seen.has(token)) continue;
        seen.add(token);

        const r = await probe(token);
        this.last = { at: new Date().toISOString(), token: token.slice(0, 8) + '…', ...r };

        if (r.alive) {
          this.pool.reward(token);
          continue;
        }
        if (r.transient) continue;

        this.log(`[watchdog] token ${token.slice(0, 8)}… is revoked (${r.code} ${r.reason})`);
        this.pool.penalize(token, 300_000);
        const fresh = await this.relogin(token);
        if (fresh) this.log('[watchdog] replaced with a fresh token');
      }
    } finally {
      this.running = false;
    }
  }

  stats() {
    return { last: this.last, intervalMs: this.intervalMs };
  }
}

module.exports = { Watchdog, probe, AUTH_CODES };
