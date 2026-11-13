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
const { Metrics } = require('./lib/metrics');

const pkg = (() => { try { return require('./package.json'); } catch { return {}; } })();
const VERSION = pkg.version || '0.0.0';
const STARTED_AT = Date.now();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-chat';

const pool = TokenPool.load();
const warmer = new Warmer();
const metrics = new Metrics();
const limiter = new RateLimiter({
  burst: Number(process.env.RATE_BURST || 4),
  refillMs: Number(process.env.RATE_REFILL_MS || 6000),
  cooldownMs: Number(process.env.RATE_COOLDOWN_MS || 45_000),
  cooldownMaxMs: Number(process.env.RATE_COOLDOWN_MAX_MS || 5 * 60_000),
  jitterMs: Number(process.env.RATE_JITTER_MS || 500),
  minGapMs: Number(process.env.RATE_MIN_GAP_MS || 1500),
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
  intervalMs: Number(process.env.WATCHDOG_MS || 120_000),
  jitterMs: Number(process.env.WATCHDOG_JITTER_MS || 20_000),
});

const MODELS = [
  { id: 'deepseek-chat', object: 'model', created: 1700000000, owned_by: 'deepseek' },
  { id: 'deepseek-reasoner', object: 'model', created: 1700000000, owned_by: 'deepseek' },
];

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'interest-cohort=()',
};

function withSecurityHeaders(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers };
}

function send(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, withSecurityHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  }));
  res.end(body);
}

function requestId() {
  try { return crypto.randomUUID(); } catch { return crypto.randomBytes(16).toString('hex'); }
}

function sendHtml(res, status, html) {
  res.writeHead(status, withSecurityHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  }));
  res.end(html);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

function wantsHtml(req) {
  const accept = String(req.headers.accept || '');
  // Browsers ask for text/html; API clients typically send */* or application/json.
  return accept.includes('text/html') && !accept.includes('application/json');
}

function landingPage() {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const base = '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Free DeepSeek API</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1020; --card:#121a33; --muted:#9fb0d0; --text:#eaf0ff; --accent:#6ee7ff; --accent2:#a78bfa; --ok:#34d399; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: radial-gradient(1200px 600px at 10% -10%, #18244a 0%, transparent 60%), radial-gradient(900px 500px at 110% 0%, #1a2f4a 0%, transparent 55%), var(--bg); color:var(--text); }
    .wrap { max-width: 920px; margin: 0 auto; padding: 48px 20px 64px; }
    .badge { display:inline-block; padding:4px 10px; border:1px solid #2a3a66; border-radius:999px; color:var(--muted); font-size:12px; letter-spacing:.02em; }
    h1 { margin:14px 0 8px; font-size: clamp(28px, 4vw, 42px); line-height:1.1; }
    h1 span { background: linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
    p.lead { margin:0 0 22px; color:var(--muted); font-size:16px; max-width: 70ch; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap:14px; margin: 22px 0 26px; }
    .card { background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.01)); border:1px solid #243055; border-radius:14px; padding:16px 16px 14px; }
    .card h3 { margin:0 0 6px; font-size:14px; color:#d9e6ff; }
    .card p, .card li { margin:0; color:var(--muted); font-size:13px; line-height:1.5; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    pre { margin:0; background:#0a1124; border:1px solid #243055; border-radius:14px; padding:14px 16px; overflow:auto; color:#dce7ff; font-size:13px; line-height:1.5; }
    .k { color:#93c5fd; } .s { color:#86efac; } .p { color:#f9a8d4; } .c { color:#6b7c9e; }
    .row { display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; }
    a.pill { text-decoration:none; color:var(--text); border:1px solid #2a3a66; background:#101833; padding:8px 12px; border-radius:10px; font-size:13px; }
    a.pill:hover { border-color:#3a5294; }
    .status { color: var(--ok); font-weight:600; }
    footer { margin-top:28px; color:#6f83a8; font-size:12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="badge">OpenAI-compatible &middot; v${esc(VERSION)} &middot; <span class="status">running</span></div>
    <h1><span>Free DeepSeek API</span></h1>
    <p class="lead">A zero-dependency proxy for <code>chat.deepseek.com</code> exposing <code>/v1/chat/completions</code> with streaming, reasoning, and tool-calling emulation.</p>

    <div class="grid">
      <div class="card"><h3>Health</h3><p><a class="pill" href="/health">GET /health</a></p></div>
      <div class="card"><h3>Metrics</h3><p><a class="pill" href="/metrics">GET /metrics</a></p></div>
      <div class="card"><h3>Models</h3><p><a class="pill" href="/v1/models">GET /v1/models</a></p></div>
      <div class="card"><h3>Chat</h3><p><code>POST /v1/chat/completions</code></p></div>
    </div>

<pre><span class="c"># quick test</span>
curl ${esc(base)}http://localhost:${esc(String(PORT))}/v1/chat/completions \
  -H <span class="s">'Content-Type: application/json'</span> \
  -d <span class="s">'{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello"}]}'</span></pre>

    <div class="row">
      <a class="pill" href="https://github.com/zeroaiproject/Free-DeepSeek-API">GitHub</a>
      <a class="pill" href="/health">Status JSON</a>
    </div>
    <footer>Tokens and credentials stay server-side. If <code>API_KEY</code> is set, send <code>Authorization: Bearer &lt;key&gt;</code>.</footer>
  </div>
</body>
</html>`;
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

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/payload too large/i.test(msg)) return err(res, 413, 'payload too large', 'invalid_request_error');
    return err(res, 400, 'invalid JSON body', 'invalid_request_error');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return err(res, 400, 'request body must be a JSON object', 'invalid_request_error');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return err(res, 400, '`messages` must be a non-empty array', 'invalid_request_error', 'invalid_messages');
  }
  const badMsg = body.messages.find((m) => !m || typeof m !== 'object' || Array.isArray(m) || !m.role);
  if (badMsg !== undefined) {
    return err(res, 400, 'each message must be an object with a `role`', 'invalid_request_error', 'invalid_messages');
  }

  if (process.env.DEBUG_BODY_DIR) {
    try {
      const fs = require('fs');
      const p = require('path');
      fs.mkdirSync(process.env.DEBUG_BODY_DIR, { recursive: true });
      fs.writeFileSync(
        p.join(process.env.DEBUG_BODY_DIR, `req-${Date.now()}.json`),
        JSON.stringify(body, null, 2)
      );
    } catch {}
  }

  const model = typeof body.model === 'string' && body.model ? body.model : DEFAULT_MODEL;
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
        limiter.reward(token);
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
      limiter.reward(token);

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
      'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (API_KEY) {
    const auth = String(req.headers.authorization || '');
    const bearer = auth.replace(/^Bearer\s+/i, '');
    const key = bearer || String(req.headers['x-api-key'] || '');
    if (!safeEqual(key, API_KEY)) return err(res, 401, 'invalid api key', 'authentication_error');
  }

  const method = req.method || 'GET';
  const rid = requestId();
  res.setHeader('X-Request-Id', rid);

  const t0 = Date.now();
  let loggedStatus = 200;
  let metricsEnded = false;
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (status, ...rest) => { loggedStatus = status; return origWriteHead(status, ...rest); };

  metrics.onRequestStart();
  const endMetrics = () => {
    if (metricsEnded) return;
    metricsEnded = true;
    metrics.onRequestEnd({ status: loggedStatus, durationMs: Date.now() - t0 });
  };

  const done = () => {
    endMetrics();
    if (process.env.LOG_REQUESTS === '1') {
      console.log(`[http] ${rid.slice(0, 8)} ${method} ${url.pathname} ${loggedStatus} ${Date.now() - t0}ms`);
    }
  };
  res.on('finish', done);
  res.on('close', () => { if (!res.writableEnded) endMetrics(); });

  try {
    if ((url.pathname === '/' || url.pathname === '/v1') && (method === 'GET' || method === 'HEAD')) {
      if (method === 'HEAD') {
        res.writeHead(200, withSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }));
        return res.end();
      }
      if (wantsHtml(req)) return sendHtml(res, 200, landingPage());
      const info = {
        name: 'Free DeepSeek API',
        version: VERSION,
        status: 'ok',
        openai_compatible: true,
        endpoints: {
          health: '/health',
          metrics: '/metrics',
          models: '/v1/models',
          chat: '/v1/chat/completions',
        },
        docs: 'https://github.com/zeroaiproject/Free-DeepSeek-API',
      };
      return send(res, 200, info);
    }

    if (url.pathname === '/health' && (method === 'GET' || method === 'HEAD')) {
      pool.reloadIfChanged();
      const body = {
        status: 'ok',
        version: VERSION,
        uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
        tokens: pool.status(),
        warm: warmer.stats(),
        rate: limiter.stats(),
        watchdog: watchdog.stats(),
        metrics: metrics.snapshot(),
        auth: {
          configured: !!(DS_EMAIL && DS_PASSWORD),
          suspendedUntil: suspendedUntil ? new Date(suspendedUntil).toISOString() : null,
          reloginCooldownMs: Math.max(0, reloginCooldownUntil - Date.now()),
          lastError: lastAuthError,
        },
        models: MODELS.map((m) => m.id),
      };
      if (method === 'HEAD') {
        res.writeHead(200, withSecurityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }));
        return res.end();
      }
      return send(res, 200, body);
    }

    if (url.pathname === '/metrics' && method === 'GET') {
      const accept = String(req.headers.accept || '');
      if (accept.includes('application/json')) return send(res, 200, metrics.snapshot());
      const body = metrics.prometheus();
      res.writeHead(200, withSecurityHeaders({
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      }));
      return res.end(body);
    }

    if (url.pathname === '/v1/models' && method === 'GET') {
      const data = MODELS.map((m) => ({
        ...m,
        context_window: m.id.includes('reasoner') ? 128000 : 128000,
        max_output_tokens: m.id.includes('reasoner') ? 32768 : 8192,
        capabilities: { tools: true, streaming: true, reasoning: m.id.includes('reasoner') },
      }));
      return send(res, 200, { object: 'list', data });
    }

    if ((url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') && method === 'POST') {
      return await handleChat(req, res);
    }

    if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') {
      return err(res, 405, 'method not allowed', 'invalid_request_error');
    }
    return err(res, 404, 'not found', 'invalid_request_error');
  } catch (e) {
    const msg = e && e.message ? e.message : 'internal error';
    console.error('[http] internal error', msg);
    if (!res.headersSent) return err(res, 500, 'internal server error', 'internal_error');
    try { res.end(); } catch {}
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

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 0; // streaming completions can be long-lived

  server.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
    console.log(`\n  Free DeepSeek API v${VERSION}  (OpenAI-compatible)`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  listening     : http://${HOST}:${PORT}`);
    console.log(`  local health  : http://${shownHost}:${PORT}/health`);
    console.log(`  metrics       : http://${shownHost}:${PORT}/metrics`);
    console.log(`  tokens        : ${pool.size}`);
    console.log(`  default model : ${DEFAULT_MODEL}`);
    console.log(`  watchdog      : ${watchdog.intervalMs ? watchdog.intervalMs + 'ms' : 'off'}`);
    console.log(`  auto re-login : ${DS_EMAIL && DS_PASSWORD ? 'on' : 'off (set DEEPSEEK_EMAIL + DEEPSEEK_PASSWORD)'}`);
    console.log('');
    watchdog.start();
  });
})();
