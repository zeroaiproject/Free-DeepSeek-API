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
//     Sessions are rotated every N uses to keep the account tidy.
//
// A solved PoW response is single-use (replay -> INVALID_POW_RESPONSE), so only
// the solve step (~30-60 ms) remains on the critical path.

const { fetchChallenge, createSession } = require('./deepseek');

const TARGET_PATH = '/api/v0/chat/completion';
const POOL_SIZE = Number(process.env.WARM_POOL || 3);
const SESSION_MAX_USES = Number(process.env.WARM_SESSION_USES || 100);
const EXPIRY_MARGIN_MS = 60_000;

class Warmer {
  constructor() {
    this.state = new Map();
  }

  #st(token) {
    let s = this.state.get(token);
    if (!s) {
      s = { challenges: [], sessions: [], inflightChallenge: 0, inflightSession: 0, session: null };
      this.state.set(token, s);
    }
    return s;
  }

  // Non-blocking refill so the next request is already covered.
  #refill(token) {
    const s = this.#st(token);

    while (s.challenges.length + s.inflightChallenge < POOL_SIZE) {
      s.inflightChallenge += 1;
      fetchChallenge(token, TARGET_PATH)
        .then((c) => s.challenges.push(c))
        .catch(() => {})
        .finally(() => {
          s.inflightChallenge -= 1;
        });
    }

    if (!s.session && s.inflightSession === 0) {
      s.inflightSession += 1;
      createSession(token)
        .then((id) => {
          if (!s.session) s.session = { id, uses: 0 };
        })
        .catch(() => {})
        .finally(() => {
          s.inflightSession -= 1;
        });
    }
  }

  async challenge(token) {
    const s = this.#st(token);
    const now = Date.now();

    // Drop anything about to expire, then take the freshest usable one.
    s.challenges = s.challenges.filter((c) => c.expire_at - now > EXPIRY_MARGIN_MS);
    const challenge = s.challenges.shift() || null;

    this.#refill(token);
    if (challenge) return challenge;

    // Cold path: pool empty (first request, or refill raced us).
    return fetchChallenge(token, TARGET_PATH);
  }

  async session(token) {
    const s = this.#st(token);
    if (s.session && s.session.uses < SESSION_MAX_USES) {
      s.session.uses += 1;
      return s.session.id;
    }
    // Rotate: mark the old one spent, take a pre-created replacement if ready.
    s.session = null;
    this.#refill(token);
    return createSession(token);
  }

  // Called when the upstream rejects a cached challenge.
  dropChallenges(token) {
    const s = this.#st(token);
    if (s) s.challenges = [];
  }

  stats() {
    return [...this.state.entries()].map(([token, s]) => ({
      token: token.slice(0, 8) + '…' + token.slice(-4),
      challenges: s.challenges.length,
      hasSession: !!s.session,
      sessionUses: s.session ? s.session.uses : 0,
    }));
  }
}

module.exports = { Warmer, TARGET_PATH };
