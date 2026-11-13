'use strict';
// Pre-warm cache that removes almost all per-request prep latency.
//
// Two independent costs sit between the client request and the upstream call:
//   1. POST /chat/create_pow_challenge   (~290 ms)
//   2. POST /chat_session/create         (~290 ms)
//
// Both can be resolved ahead of time:
//   - A challenge stays valid for `expire_after` (300 s) and is only consumed
//     by the completion it is used for, so unsolved challenges can be queued.
//   - A session is reusable: with `parent_message_id: null` each completion
//     starts a new branch from the root, so no history leaks between requests.
//     It is rotated every N uses, because every /chat_session/create is another
//     upstream call and DeepSeek throttles the account on total traffic, not
//     just completions.
//
// A solved PoW response is single-use (replay -> INVALID_POW_RESPONSE), so only
// the solve step (~30-60 ms) remains on the critical path.
//
// Anti-suspension: background refills are staggered (no burst of parallel
// session/challenge creates) and paced with jitter.

const { fetchChallenge, createSession } = require('./deepseek');

const TARGET_PATH = '/api/v0/chat/completion';
const POOL_SIZE = Number(process.env.WARM_POOL || 3);
const SESSION_MAX_USES = Number(process.env.WARM_SESSION_USES || 4);
const SESSION_POOL = Number(process.env.WARM_SESSION_POOL || 1);
const SESSION_TTL_MS = Number(process.env.WARM_SESSION_TTL_MS || 30 * 60_000);
const EXPIRY_MARGIN_MS = 60_000;
const REFILL_DELAY_MS = Number(process.env.WARM_REFILL_DELAY_MS || 750);
const REFILL_JITTER_MS = Number(process.env.WARM_REFILL_JITTER_MS || 600);

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const jitter = (base, spread) => base + Math.floor(Math.random() * Math.max(1, spread));

class Warmer {
  constructor() {
    this.state = new Map();
  }

  #st(token) {
    let s = this.state.get(token);
    if (!s) {
      s = {
        challenges: [],
        sessions: [],
        inflightChallenge: 0,
        inflightSession: 0,
        refillScheduled: false,
      };
      this.state.set(token, s);
    }
    return s;
  }

  // Non-blocking refill so the next request is already covered, but paced to
  // avoid a burst of background upstream calls.
  #refill(token) {
    const s = this.#st(token);
    if (s.refillScheduled) return;
    s.refillScheduled = true;

    (async () => {
      try {
        // Small initial stagger so multiple tokens don't refill in sync.
        await sleep(jitter(0, REFILL_JITTER_MS));

        while (s.challenges.length + s.inflightChallenge < POOL_SIZE) {
          s.inflightChallenge += 1;
          try {
            const c = await fetchChallenge(token, TARGET_PATH);
            s.challenges.push(c);
          } catch {} finally {
            s.inflightChallenge -= 1;
          }
          if (s.challenges.length + s.inflightChallenge < POOL_SIZE) {
            await sleep(jitter(REFILL_DELAY_MS, REFILL_JITTER_MS));
          }
        }

        while (s.sessions.length + s.inflightSession < SESSION_POOL) {
          s.inflightSession += 1;
          try {
            const id = await createSession(token);
            s.sessions.push({ id, createdAt: Date.now(), uses: 0 });
          } catch {} finally {
            s.inflightSession -= 1;
          }
          if (s.sessions.length + s.inflightSession < SESSION_POOL) {
            await sleep(jitter(REFILL_DELAY_MS, REFILL_JITTER_MS));
          }
        }
      } finally {
        s.refillScheduled = false;
        // If demand appeared while we were pacing, schedule another pass later.
        if (
          s.challenges.length + s.inflightChallenge < POOL_SIZE ||
          s.sessions.length + s.inflightSession < SESSION_POOL
        ) {
          setTimeout(() => this.#refill(token), jitter(REFILL_DELAY_MS, REFILL_JITTER_MS)).unref?.();
        }
      }
    })().catch(() => {});
  }

  async challenge(token) {
    const s = this.#st(token);
    const now = Date.now();

    s.challenges = s.challenges.filter((c) => c && c.expire_at - now > EXPIRY_MARGIN_MS);
    const challenge = s.challenges.shift() || null;

    this.#refill(token);
    if (challenge) return challenge;
    return fetchChallenge(token, TARGET_PATH);
  }

  async session(token) {
    const s = this.#st(token);
    const now = Date.now();

    while (s.sessions.length) {
      const cur = s.sessions[0];
      if (cur.uses < SESSION_MAX_USES && now - cur.createdAt < SESSION_TTL_MS) {
        cur.uses += 1;
        return cur.id;
      }
      s.sessions.shift();
    }

    this.#refill(token);
    return createSession(token);
  }

  dropChallenges(token) {
    const s = this.#st(token);
    if (s) s.challenges = [];
  }

  stats() {
    return [...this.state.entries()].map(([token, s]) => ({
      token: token.slice(0, 8) + '…' + token.slice(-4),
      challenges: s.challenges.length,
      sessions: s.sessions.length,
      sessionUses: s.sessions.length ? s.sessions[0].uses : 0,
    }));
  }
}

module.exports = { Warmer, TARGET_PATH };
