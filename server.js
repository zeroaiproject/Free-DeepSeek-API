'use strict';
// OpenAI-compatible HTTP server backed by chat.deepseek.com.
// Zero npm dependencies.

const http = require('http');
const crypto = require('crypto');

const { TokenPool } = require('./lib/pool');
const { complete, ApiError } = require('./lib/deepseek');
const { Warmer } = require('./lib/warm');
const { makeExtractor } = require('./lib/stream');
const { buildToolInstructions, extractToolCalls, buildTranscript, toolDefs } = require('./lib/tools');
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
function createStreamGate(onStream, onJson) {
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

// First non-whitespace characters that start a tool call rather than prose.
// DSML (DeepSeek's markup tool format) begins with '<' + U+FF5C.
const TOOL_PREFIXES = ['{', '```', '<\uFF5C', '<|'];

// 'tool' => buffer the whole answer, 'wait' => need more characters,
// 'text' => a normal answer, stream it.
function classifyPrefix(peek) {
  for (const p of TOOL_PREFIXES) {
    if (peek.startsWith(p)) return 'tool';
    if (p.startsWith(peek)) return 'wait';
  }
  return 'text';
}

async function handleChat(req, res) {
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
  const MAX_ATTEMPTS = 3;
  const MAX_WAIT_MS = 2_000;
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let token = pool.pick();

    // Every token is cooling down (e.g. right after penalize() on the previous
    // attempt). Wait briefly for the soonest one instead of failing the request.
    if (!token) {
      const wait = pool.nextAvailableMs();
      if (!Number.isFinite(wait) || wait > MAX_WAIT_MS) {
        return err(res, 503, 'no DeepSeek token available', 'service_unavailable');
      }
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      token = pool.pick();
      if (!token) return err(res, 503, 'no DeepSeek token available', 'service_unavailable');
    }

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

        // With tools enabled the model may answer with a JSON tool call, which
        // must not be streamed as text. Hold output until the first characters
        // reveal which shape it is.
        let mode = toolsActive ? 'peek' : 'stream';
        let pending = [];

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

        const handleEvents = (events) => {
          for (const ev of events) {
            if (mode === 'stream') {
              emit(ev);
              continue;
            }
            if (mode === 'buffer') continue;
            pending.push(ev);
            if (ev.kind !== 'content') continue;
            const peek = extractor.text.trimStart();
            if (!peek) continue;
            const kind = classifyPrefix(peek);
            if (kind === 'wait') continue;
            if (kind === 'tool') {
              mode = 'buffer';
            } else {
              mode = 'stream';
              for (const p of pending) emit(p);
              pending = [];
            }
          }
        };

        const onStream = (chunkText) => {
          handleEvents(extractor.push(chunkText));
        };
        const onJson = (chunkText) => {
          jsonBody += chunkText;
        };

        const gate = createStreamGate(onStream, onJson);
        const upstream = await complete(token, { sessionId, challenge, prompt, thinking, onData: gate, timing });

        if (!started && !extractor.text && !extractor.reasoning) {
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

        pool.reward(token);
        handleEvents(extractor.flush());

        let finish = 'stop';
        let calls = null;

        if (mode !== 'stream' && toolsActive) {
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
        } else if (mode !== 'stream') {
          open();
          if (extractor.reasoning) write(chunk(id, model, { reasoning_content: extractor.reasoning }));
          if (extractor.text) write(chunk(id, model, { content: extractor.text }));
        }

        write(chunk(id, model, {}, finish));
        if (includeUsage) write(usageChunk(id, model, created, extractor.usage || 0));
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // ---- non-streaming path --------------------------------------------
      const upstream = await complete(token, { sessionId, challenge, prompt, thinking });

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
          if (isAuthError(lastError)) pool.penalize(token, 300_000);
          continue;
        }
      }

      const extractor = makeExtractor();
      extractor.push(upstream.body);
      extractor.flush();
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
          res.write('data: [DONE]\n\n');
        } catch {}
        return res.end();
      }
      if (isAuthError(e)) pool.penalize(token, 300_000);
      else if (e instanceof ApiError && (e.code === 40301 || /INVALID_POW/.test(String(e.msg)))) {
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
