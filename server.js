'use strict';
// OpenAI-compatible HTTP server backed by chat.deepseek.com.
// Zero npm dependencies.

const http = require('http');
const crypto = require('crypto');

const { TokenPool } = require('./lib/pool');
const { complete, ApiError } = require('./lib/deepseek');
const { Warmer } = require('./lib/warm');
const { makeExtractor } = require('./lib/stream');
const { init: initPow } = require('./lib/pow');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.API_KEY || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-chat';

const pool = TokenPool.load();
const warmer = new Warmer();

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

function messagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages is required');
  if (messages.length === 1 && messages[0].role === 'user') return contentToText(messages[0].content);

  const lines = messages.map((m) => {
    const text = contentToText(m.content);
    if (m.role === 'system') return `System: ${text}`;
    if (m.role === 'assistant') return `Assistant: ${text}`;
    return `User: ${text}`;
  });
  return lines.join('\n\n');
}

function isAuthError(e) {
  if (!(e instanceof ApiError)) return false;
  return (
    e.code === 40003 ||
    e.code === 40002 ||
    /INVALID_TOKEN|Missing Token|TOKEN/i.test(String(e.msg))
  );
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

// Buffers the first line of the upstream body to distinguish an SSE stream
// (starts with "event:"/"data:") from a plain JSON error document.
function createStreamGate(onStream, onJson) {
  let pending = '';
  let decided = false;
  return (chunk) => {
    if (decided) return onStream(chunk);
    pending += chunk;
    const nl = pending.indexOf('\n');
    if (nl === -1 && pending.length < 4096) return; // need one line to decide

    const firstLine = (nl === -1 ? pending : pending.slice(0, nl)).trim();
    decided = true;
    if (firstLine.startsWith('event:') || firstLine.startsWith('data:')) {
      onStream(pending);
      pending = '';
    } else {
      onJson(pending);
      pending = '';
    }
  };
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const model = body.model || DEFAULT_MODEL;
  const stream = !!body.stream;
  const thinking = /reason/i.test(model) || body.reasoning === true;

  let prompt;
  try {
    prompt = messagesToPrompt(body.messages);
  } catch (e) {
    return err(res, 400, e.message);
  }

  const attempts = Math.max(1, Math.min(pool.size || 1, 3));
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const token = pool.pick();
    if (!token) return err(res, 503, 'no DeepSeek token available', 'service_unavailable');

    const id = 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '');
    const created = Math.floor(Date.now() / 1000);
    const tAttempt = Date.now();

    try {
      // Both usually resolve instantly from the pre-warm cache.
      const tSession = Date.now();
      const [sessionId, challenge] = await Promise.all([warmer.session(token), warmer.challenge(token)]);
      const sessionMs = Date.now() - tSession;

      // ---- streaming path: relay deltas as they arrive -------------------
      if (stream && !res.headersSent) {
        const extractor = makeExtractor();
        const timing = {};
        const includeUsage = !!(body.stream_options && body.stream_options.include_usage);
        let started = false;
        let jsonBody = '';

        const write = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
        const open = () => {
          if (started) return;
          started = true;
          const challengeMs = timing.challengeMs || 0;
          const solveMs = timing.powMs || 0;
          // session and challenge run concurrently; only the slower one counts.
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

        const onStream = (chunkText) => {
          open();
          for (const ev of extractor.push(chunkText)) {
            write(chunk(id, model, ev.kind === 'reasoning' ? { reasoning_content: ev.delta } : { content: ev.delta }));
          }
        };
        const onJson = (chunkText) => {
          jsonBody += chunkText;
        };

        const gate = createStreamGate(onStream, onJson);
        const upstream = await complete(token, { sessionId, challenge, prompt, thinking, onData: gate, timing });

        if (started) {
          pool.reward(token);
          for (const ev of extractor.flush()) {
            write(chunk(id, model, ev.kind === 'reasoning' ? { reasoning_content: ev.delta } : { content: ev.delta }));
          }
          write(chunk(id, model, {}, 'stop'));
          if (includeUsage) {
            write({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [],
              usage: {
                prompt_tokens: 0,
                completion_tokens: extractor.usage || 0,
                total_tokens: extractor.usage || 0,
              },
            });
          }
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        // upstream answered with a JSON document instead of SSE
        let j = null;
        try {
          j = JSON.parse(jsonBody);
        } catch {}
        lastError = j
          ? new ApiError(j.code, j.msg, upstream.status)
          : new ApiError('HTTP_' + upstream.status, (jsonBody || 'empty upstream').slice(0, 300), upstream.status);
        if (isAuthError(lastError)) pool.penalize(token, 300_000);
        continue;
      }

      // ---- non-streaming path -------------------------------------------
      const upstream = await complete(token, { sessionId, challenge, prompt, thinking });

      if (upstream.status !== 200) {
        lastError = new ApiError('HTTP_' + upstream.status, upstream.body.slice(0, 300), upstream.status);
        continue;
      }

      // A non-SSE error document can come back with HTTP 200 and code != 0.
      const head = upstream.body.trimStart();
      if (head.startsWith('{')) {
        let j;
        try {
          j = JSON.parse(upstream.body);
        } catch {}
        if (j && j.code !== 0) {
          lastError = new ApiError(j.code, j.msg, 200);
          if (isAuthError(lastError)) pool.penalize(token, 300_000);
          continue;
        }
      }

      const extractor = makeExtractor();
      extractor.push(upstream.body);
      extractor.flush();
      pool.reward(token);

      return send(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: extractor.text,
              ...(extractor.reasoning ? { reasoning_content: extractor.reasoning } : {}),
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: extractor.usage || 0,
          completion_tokens: extractor.usage || 0,
          total_tokens: extractor.usage || 0,
        },
      });
    } catch (e) {
      lastError = e;
      if (isAuthError(e)) pool.penalize(token, 300_000);
      else if (e instanceof ApiError && (e.code === 40301 || /INVALID_POW/.test(String(e.msg)))) {
        warmer.dropChallenges(token);
      } else pool.penalize(token, 5_000);
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
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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
      return send(res, 200, {
        status: 'ok',
        tokens: pool.status(),
        warm: warmer.stats(),
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

(async () => {
  await initPow();
  if (!pool.size) {
    console.warn('[warn] no DeepSeek token configured — set DEEPSEEK_TOKENS or tokens.txt');
  }
  server.listen(PORT, HOST, () => {
    console.log(`Free DeepSeek API listening on http://${HOST}:${PORT}`);
    console.log(`  tokens loaded : ${pool.size}`);
    console.log(`  default model : ${DEFAULT_MODEL}`);
  });
})();
