'use strict';
// OpenAI-compatible HTTP server backed by chat.deepseek.com.
// Zero npm dependencies.

const { loadEnv } = require('./lib/env');
loadEnv();

const http = require('http');
const crypto = require('crypto');

const { TokenPool } = require('./lib/pool');
const { complete, ApiError } = require('./lib/deepseek');
const { login } = require('./lib/auth');
const { Warmer } = require('./lib/warm');
const { RateLimiter } = require('./lib/ratelimit');
const { Watchdog } = require('./lib/watchdog');
const { makeExtractor } = require('./lib/stream');
const { StreamGate } = require('./lib/streamgate');
const { buildToolInstructions, extractToolCalls, buildTranscript, toolDefs } = require('./lib/tools');
const { init: initPow } = require('./lib/pow');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-chat';

const pool = TokenPool.load();
const warmer = new Warmer();
const limiter = new RateLimiter({
  burst: Number(process.env.RATE_BURST || 6),
  refillMs: Number(process.env.RATE_REFILL_MS || 5000),
  cooldownMs: Number(process.env.RATE_COOLDOWN_MS || 30_000),
});

// Optional automatic re-login: DeepSeek revokes tokens, and a revoked token
// can be replaced without restarting if the account password is available.
const DS_EMAIL = process.env.DEEPSEEK_EMAIL || '';
const DS_PASSWORD = process.env.DEEPSEEK_PASSWORD || '';
const PERSIST_TOKEN = process.env.DEEPSEEK_TOKEN_PERSIST === '1';

// A revoked token is not the only way an account dies. A policy suspension
// answers every endpoint with 40003 too, and no amount of re-login helps until
// the suspension expires. Retrying the login on every request would just
// hammer an endpoint that is already annoyed, so failures are backed off and a
// suspension is remembered.
const RELOGIN_BACKOFF_MS = Number(process.env.RELOGIN_BACKOFF_MS || 600_000);
let reloginInFlight = null;
let reloginCooldownUntil = 0;
let suspendedUntil = 0;
let lastAuthError = null;

function isSuspension(message) {
  return /suspend|violation|banned|forbidden|封禁|违规|冻结/i.test(String(message || ''));
}

// "…suspended until November 16, 2026 07:40" -> epoch ms, when parseable.
function parseSuspensionUntil(message) {
  const m = String(message || '').match(/until\s+(.+?)(?:[.;]|$)/i);
  if (m) {
    const t = Date.parse(m[1].trim());
    if (Number.isFinite(t) && t > Date.now()) return t;
  }
  return Date.now() + 24 * 3600_000;
}

function relogin(deadToken) {
  if (!DS_EMAIL || !DS_PASSWORD) return Promise.resolve(null);
  if (Date.now() < reloginCooldownUntil) return Promise.resolve(null);
  if (reloginInFlight) return reloginInFlight;

  reloginInFlight = login(DS_EMAIL, DS_PASSWORD)
    .then((r) => {
      pool.swap(deadToken, r.token);
      if (PERSIST_TOKEN) pool.persist();
      suspendedUntil = 0;
      lastAuthError = null;
      console.log('[auth] token revoked, re-login succeeded');
      return r.token;
    })
    .catch((e) => {
      lastAuthError = e.message;
      reloginCooldownUntil = Date.now() + RELOGIN_BACKOFF_MS;
      if (isSuspension(e.message)) {
        suspendedUntil = parseSuspensionUntil(e.message);
        console.log('[auth] ACCOUNT SUSPENDED until', new Date(suspendedUntil).toISOString(), '-', e.message);
      } else {
        console.log('[auth] re-login failed:', e.message);
      }
      return null;
    })
    .finally(() => {
      reloginInFlight = null;
    });

  return reloginInFlight;
}

const watchdog = new Watchdog({
  pool,
  relogin,
  intervalMs: Number(process.env.WATCHDOG_MS || 90_000),
});

const MODELS = [
  { id: 'deepseek-chat', object: 'model', created: 1700000000, owned_by: 'deepseek' },
  { id: 'deepseek-reasoner', object: 'model', created: 1700000000, owned_by: 'deepseek' },
];

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function err(res, status, message, type = 'invalid_request_error', code = null) {
  send(res, status, { error: { message, type, code } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 32 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function isAuthError(e) {
  if (!(e instanceof ApiError)) return false;
  return e.code === 40003 || e.code === 40002 || /INVALID_TOKEN|Missing Token|TOKEN/i.test(String(e.msg));
}

function chunk(id, model, delta, finish = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function usageChunk(id, model, created, tokens) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: { prompt_tokens: 0, completion_tokens: tokens, total_tokens: tokens },
  };
}

function toToolCalls(calls) {
  return calls.map((c) => ({
    id: 'call_' + crypto.randomBytes(12).toString('hex'),
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
  }));
}

// Buffers the first line of the upstream body to distinguish an SSE stream
// (starts with "event:"/"data:") from a plain JSON error document.
function createSseSplitter(onStream, onJson) {
  let pending = '';
  let decided = false;
  return (chunkText) => {
    if (decided) return onStream(chunkText);
    pending += chunkText;
    const nl = pending.indexOf('\n');
    if (nl === -1 && pending.length < 4096) return;

    const firstLine = (nl === -1 ? pending : pending.slice(0, nl)).trim();
    decided = true;
    if (firstLine.startsWith('event:') || firstLine.startsWith('data:')) onStream(pending);
    else onJson(pending);
    pending = '';
  };
}

// Tool-call detection and content hold-back live in lib/streamgate.js so they
// can be unit tested without an HTTP round trip.
const HOLD_BACK = Number(process.env.STREAM_HOLD_BACK || 32);

async function handleChat(req, res) {
  // Pick up a token pasted into tokens.txt without a restart.
  pool.reloadIfChanged();

  // Nothing below can succeed while the account is suspended, and every
  // attempt would be another request on a flagged account.
  if (suspendedUntil > Date.now() && !pool.pick()) {
    return err(
      res,
      503,
      `DeepSeek account suspended until ${new Date(suspendedUntil).toISOString()}`,
      'account_suspended'
    );
  }
  const body = await readBody(req);
  if (process.env.DEBUG_BODY_DIR) {
    try {
      const fs = require('fs');
      const p = require('path');
      fs.writeFileSync(
        p.join(process.env.DEBUG_BODY_DIR, `req-${Date.now()}.json`),
        JSON.stringify(body, null, 2)
      );
    } catch {}
  }
  const model = body.model || DEFAULT_MODEL;
  const stream = !!body.stream;
  const thinking = /reason/i.test(model) || body.reasoning === true;

  const defs = toolDefs(Array.isArray(body.tools) ? body.tools : []);
  const toolChoice = body.tool_choice;
  const toolsActive = defs.length > 0 && toolChoice !== 'none';
  const allowedNames = new Set(defs.map((d) => d.name));
  const parallel = body.parallel_tool_calls !== false;

  let prompt;
  try {
    const transcript = buildTranscript(body.messages, contentToText);
    prompt = toolsActive
      ? `System: ${buildToolInstructions(body.tools, toolChoice)}\n\n${transcript}`
      : transcript;
  } catch (e) {
    return err(res, 400, e.message);
  }

  // A single token is normal, so retries must not be capped by pool size:
  // one upstream failure should not turn into an immediate 503.
  const MAX_ATTEMPTS = 4;
  const MAX_WAIT_MS = 2_000;
  const MAX_RATE_WAIT_MS = Number(process.env.RATE_MAX_WAIT_MS || 35_000);
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let token = pool.pick();

    // Every token is cooling down (e.g. right after penalize() on the previous
    // attempt). Wait briefly for the soonest one instead of failing the request.
    if (!token) {
      if (suspendedUntil > Date.now()) {
        return err(
          res,
          503,
          `DeepSeek account suspended until ${new Date(suspendedUntil).toISOString()}`,
          'account_suspended'
        );
      }
      const wait = pool.nextAvailableMs();
      if (!Number.isFinite(wait) || wait > MAX_WAIT_MS) {
        return err(res, 503, 'no DeepSeek token available', 'service_unavailable');
      }
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      token = pool.pick();
      if (!token) return err(res, 503, 'no DeepSeek token available', 'service_unavailable');
    }

    // Stay under DeepSeek's burst tolerance before spending a request.
    // The check and the reservation must be atomic: requests that wake from the
    // same timer would otherwise all take a slot at once and burst again.
    let rateBlocked = false;
    for (;;) {
      const wait = limiter.waitMs(token);
      if (wait <= 0) {
        limiter.take(token);
        break;
      }
      if (wait > MAX_RATE_WAIT_MS) {
        lastError = new ApiError('RATE_LIMITED', 'DeepSeek rate limit; retry shortly', 429);
        rateBlocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
    if (rateBlocked) break;

    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '');
    const created = Math.floor(Date.now() / 1000);
    const tAttempt = Date.now();

    try {
      // Both usually resolve instantly from the pre-warm cache.
      const tSession = Date.now();
      const [sessionId, challenge] = await Promise.all([warmer.session(token), warmer.challenge(token)]);
      const sessionMs = Date.now() - tSession;

      // ---- streaming path ------------------------------------------------
      if (stream && !res.headersSent) {
        const extractor = makeExtractor();
        const timing = {};
        const includeUsage = !!(body.stream_options && body.stream_options.include_usage);
        let started = false;
        let jsonBody = '';

        // With tools enabled the answer may be a tool call, and the model
        // sometimes writes prose first and then appends the call. The gate
        // emits content with a short tail held back and stops emitting as soon
        // as a tool-call marker appears, so nothing leaks as text.
        const sg = new StreamGate({ toolsActive, holdBack: HOLD_BACK });

        const write = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
        const emit = (ev) =>
          write(
            chunk(id, model, ev.kind === 'reasoning' ? { reasoning_content: ev.delta } : { content: ev.delta })
          );

        const open = () => {
          if (started) return;
          started = true;
          const challengeMs = timing.challengeMs || 0;
          const solveMs = timing.powMs || 0;
          const prepMs = Math.max(sessionMs, challengeMs) + solveMs;
          const upstreamTtfbMs = Math.max(0, Date.now() - tAttempt - prepMs);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no',
            'X-Ds-Session-Ms': String(sessionMs),
            'X-Ds-Challenge-Ms': String(challengeMs),
            'X-Ds-Solve-Ms': String(solveMs),
            'X-Ds-Prep-Ms': String(prepMs),
            'X-Ds-Upstream-Ttfb-Ms': String(upstreamTtfbMs),
          });
          write(chunk(id, model, { role: 'assistant', content: '' }));
        };

        // Streams content up to the safe point.
        const pump = () => {
          const piece = sg.pump(extractor.text);
          if (piece) emit({ kind: 'content', delta: piece });
        };

        const handleEvents = (events) => {
          for (const ev of events) {
            if (ev.kind === 'reasoning') {
              emit(ev);
              continue;
            }
            if (sg.buffering) continue;
            pump();
          }
        };

        const flushHeld = () => {
          const piece = sg.finish(extractor.text);
          if (piece) emit({ kind: 'content', delta: piece });
        };

        const onStream = (chunkText) => {
          handleEvents(extractor.push(chunkText));
        };
        const onJson = (chunkText) => {
          jsonBody += chunkText;
        };

        const splitter = createSseSplitter(onStream, onJson);
        const release = await limiter.lock(token);
        let upstream;
        try {
          upstream = await complete(token, { sessionId, challenge, prompt, thinking, onData: splitter, timing });
        } finally {
          release();
        }

        if (!started && !extractor.text && !extractor.reasoning) {
          // No content at all. Either a JSON error document came back instead of
          // SSE, or DeepSeek silently rate limited us with an empty stream.
          let j = null;
          try {
            j = JSON.parse(jsonBody);
          } catch {}

          if (j) {
            lastError = new ApiError(j.code, j.msg, upstream.status);
            if (isAuthError(lastError)) {
              pool.penalize(token, 300_000);
              await relogin(token);
            }
            continue;
          }

          if (upstream.status !== 200) {
            lastError = new ApiError('HTTP_' + upstream.status, (jsonBody || 'empty upstream').slice(0, 300), upstream.status);
            continue;
          }

          // Empty 200 means DeepSeek rate limited us. Sit out the cooldown and
          // retry rather than surfacing an error to the client.
          limiter.cooldown(token);
          lastError = new ApiError(
            'EMPTY_ANSWER',
            'upstream returned an empty answer (DeepSeek rate limit); retry in ~30s',
            429
          );
          continue;
        }

        pool.reward(token);
        handleEvents(extractor.flush());

        let finish = 'stop';
        let calls = null;

        // A buffered tail is the only place a tool call can hide once prose has
        // already been streamed.
        if (toolsActive && sg.buffering) {
          calls = extractToolCalls(extractor.text, allowedNames);
        }

        if (calls) {
          if (!parallel) calls = calls.slice(0, 1);
          open();
          if (extractor.reasoning) write(chunk(id, model, { reasoning_content: extractor.reasoning }));
          const wire = toToolCalls(calls);
          write(
            chunk(
              id,
              model,
              {
                tool_calls: wire.map((c, i) => ({
                  index: i,
                  id: c.id,
                  type: 'function',
                  function: { name: c.function.name, arguments: c.function.arguments },
                })),
              }
            )
          );
          finish = 'tool_calls';
        } else {
          open();
          if (extractor.reasoning) write(chunk(id, model, { reasoning_content: extractor.reasoning }));
          // Emit whatever the hold-back kept, or the whole buffer when a
          // suspected tool call turned out to be ordinary prose.
          if (sg.buffering) {
            const rest = sg.drain(extractor.text);
            if (rest) write(chunk(id, model, { content: rest }));
          } else {
            flushHeld();
          }
        }

        write(chunk(id, model, {}, finish));
        if (includeUsage) write(usageChunk(id, model, created, extractor.usage || 0));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // ---- non-streaming path --------------------------------------------
      const release = await limiter.lock(token);
      let upstream;
      try {
        upstream = await complete(token, { sessionId, challenge, prompt, thinking });
      } finally {
        release();
      }

      if (upstream.status !== 200) {
        lastError = new ApiError('HTTP_' + upstream.status, upstream.body.slice(0, 300), upstream.status);
        continue;
      }

      // A non-SSE error document can come back with HTTP 200 and code != 0.
      if (upstream.body.trimStart().startsWith('{')) {
        let j;
        try {
          j = JSON.parse(upstream.body);
        } catch {}
        if (j && j.code !== 0) {
          lastError = new ApiError(j.code, j.msg, 200);
          if (isAuthError(lastError)) {
            pool.penalize(token, 300_000);
            await relogin(token);
          }
          continue;
        }
      }

      const extractor = makeExtractor();
      extractor.push(upstream.body);
      extractor.flush();

      if (!extractor.text && !extractor.reasoning) {
        limiter.cooldown(token);
        lastError = new ApiError(
          'EMPTY_ANSWER',
          'upstream returned an empty answer (DeepSeek rate limit); retry in ~30s',
          429
        );
        continue;
      }

      pool.reward(token);

      let calls = toolsActive ? extractToolCalls(extractor.text, allowedNames) : null;
      if (calls && !parallel) calls = calls.slice(0, 1);

      const message = calls
        ? { role: 'assistant', content: null, tool_calls: toToolCalls(calls) }
        : {
            role: 'assistant',
            content: extractor.text,
            ...(extractor.reasoning ? { reasoning_content: extractor.reasoning } : {}),
          };

      return send(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: calls ? 'tool_calls' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: extractor.usage || 0,
          total_tokens: extractor.usage || 0,
        },
      });
    } catch (e) {
      lastError = e;
      // Headers already went out on the streaming path: the client has a partial
      // stream, so retrying would corrupt it. Close it and stop.
      if (res.headersSent) {
        try {
          res.write('data: ' + JSON.stringify(chunk(id, model, {}, 'stop')) + '\n\n');
          res.write('data: [DONE]\n\n');
        } catch {}
        return res.end();
      }
      if (isAuthError(e)) {
        pool.penalize(token, 300_000);
        await relogin(token);
      } else if (e instanceof ApiError && (e.code === 40301 || /INVALID_POW/.test(String(e.msg)))) {
        warmer.dropChallenges(token);
      } else pool.penalize(token, 1_200);
    }
  }

  const status = lastError && lastError.httpStatus ? lastError.httpStatus : 502;
  return err(res, status, lastError ? lastError.message : 'upstream failure', 'upstream_error');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (API_KEY) {
    const auth = req.headers.authorization || '';
    const key = auth.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
    if (key !== API_KEY) return err(res, 401, 'invalid api key', 'authentication_error');
  }

  try {
    if (url.pathname === '/' || url.pathname === '/health') {
      pool.reloadIfChanged();
      return send(res, 200, {
        status: 'ok',
        tokens: pool.status(),
        warm: warmer.stats(),
        rate: limiter.stats(),
        watchdog: watchdog.stats(),
        auth: {
          configured: !!(DS_EMAIL && DS_PASSWORD),
          suspendedUntil: suspendedUntil ? new Date(suspendedUntil).toISOString() : null,
          reloginCooldownMs: Math.max(0, reloginCooldownUntil - Date.now()),
          lastError: lastAuthError,
        },
        models: MODELS.map((m) => m.id),
      });
    }
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return send(res, 200, { object: 'list', data: MODELS });
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return await handleChat(req, res);
    }
    return err(res, 404, 'not found');
  } catch (e) {
    if (!res.headersSent) return err(res, 500, e.message, 'internal_error');
    res.end();
  }
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal || 'shutdown'} received, stopping…`);
  try { watchdog.stop && watchdog.stop(); } catch {}
  server.close(() => {
    console.log('[server] stopped');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e && e.stack || e);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e && e.stack || e);
});

(async () => {
  try {
    await initPow();
  } catch (e) {
    console.error('[fatal] failed to initialize PoW module:', e && e.message || e);
    process.exit(1);
  }

  if (!pool.size) {
    console.warn('[warn] no DeepSeek token configured — set DEEPSEEK_TOKENS or tokens.txt');
  }

  server.listen(PORT, HOST, () => {
    console.log(`\n  Free DeepSeek API  (OpenAI-compatible)`);
    console.log(`  ───────────────────────────────────────`);
    console.log(`  listening     : http://${HOST}:${PORT}`);
    console.log(`  health        : http://${HOST}:${PORT}/health`);
    console.log(`  tokens        : ${pool.size}`);
    console.log(`  default model : ${DEFAULT_MODEL}`);
    console.log(`  watchdog      : ${watchdog.intervalMs ? watchdog.intervalMs + 'ms' : 'off'}`);
    console.log(`  auto re-login : ${DS_EMAIL && DS_PASSWORD ? 'on' : 'off (set DEEPSEEK_EMAIL + DEEPSEEK_PASSWORD)'}`);
    console.log('');
    watchdog.start();
  });
})();
