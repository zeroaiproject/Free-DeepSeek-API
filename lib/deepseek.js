'use strict';
// Minimal DeepSeek chat.deepseek.com API client.
// No SDK, no dependencies — only node:https.

const https = require('https');
const http = require('http');
const { buildPowResponse } = require('./pow');

const HOST = 'chat.deepseek.com';
const ORIGIN = 'https://chat.deepseek.com';

// Optional outbound proxy for every upstream call (http://user:pass@host:port).
const PROXY_URL = process.env.DEEPSEEK_PROXY || process.env.HTTPS_PROXY || '';

// Establishes a CONNECT tunnel and returns the raw socket, ready for TLS.
function openTunnel(proxyUrl, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(proxyUrl);
    const auth =
      u.username || u.password
        ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
        : null;

    const req = http.request({
      host: u.hostname,
      port: Number(u.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: {
        Host: `${host}:${port}`,
        ...(auth ? { 'Proxy-Authorization': auth } : {}),
      },
      timeout,
    });

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: HTTP ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new Error('proxy CONNECT timeout')));
    req.on('error', reject);
    req.end();
  });
}

const BASE_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  // No decompression pipeline: request plaintext so JSON/SSE parsing is reliable.
  'Accept-Encoding': 'identity',
  Origin: ORIGIN,
  Pragma: 'no-cache',
  Priority: 'u=1, i',
  Referer: ORIGIN + '/',
  'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  'x-app-version': '20241129.1',
  'x-client-platform': 'web',
  'x-client-version': '1.0.0-always',
};

function request(path, { method = 'GET', body, token, headers = {}, onData, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = { ...BASE_HEADERS, ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    if (payload !== null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }

    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    const ok = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const onResponse = (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        if (onData) {
          try {
            onData(chunk);
          } catch (e) {
            try { req && req.destroy(); } catch {}
            fail(e);
          }
        } else {
          buf += chunk;
        }
      });
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: buf, streamed: !!onData }));
      res.on('error', fail);
    };

    let req;

    if (PROXY_URL) {
      // Tunnel through an HTTP proxy so the upstream sees the proxy's IP rather
      // than this machine's. DeepSeek revokes sessions used from datacenter IPs.
      openTunnel(PROXY_URL, HOST, 443, timeout)
        .then((socket) => {
          if (settled) { try { socket.destroy(); } catch {} return; }
          req = https.request(
            {
              hostname: HOST,
              port: 443,
              path,
              method,
              headers: h,
              socket,
              agent: false,
              servername: HOST,
            },
            onResponse
          );
          req.on('error', fail);
          if (timeout) req.setTimeout(timeout, () => { try { req.destroy(); } catch {} fail(new Error('deepseek timeout')); });
          if (payload !== null) req.write(payload);
          req.end();
        })
        .catch(fail);
      return;
    }

    req = https.request({ hostname: HOST, port: 443, path, method, headers: h }, onResponse);
    req.on('error', fail);
    if (timeout) req.setTimeout(timeout, () => { try { req.destroy(); } catch {} fail(new Error('deepseek timeout')); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

class ApiError extends Error {
  constructor(code, msg, httpStatus) {
    super(`DeepSeek ${code}: ${msg}`);
    this.code = code;
    this.msg = msg;
    this.httpStatus = httpStatus;
  }
}

function unwrap(res) {
  let json;
  try {
    json = JSON.parse(res.body || '{}');
  } catch {
    throw new ApiError('BAD_RESPONSE', String(res.body || '').slice(0, 200), res.status);
  }
  if (!json || typeof json !== 'object') {
    throw new ApiError('BAD_RESPONSE', 'unexpected response shape', res.status);
  }
  if (json.code !== 0) throw new ApiError(json.code, json.msg || 'upstream error', res.status);
  return json.data?.biz_data;
}

async function fetchChallenge(token, targetPath) {
  const res = await request('/api/v0/chat/create_pow_challenge', {
    method: 'POST',
    token,
    body: { target_path: targetPath },
  });
  return unwrap(res).challenge;
}

async function createSession(token) {
  const res = await request('/api/v0/chat_session/create', {
    method: 'POST',
    token,
    body: { character_id: null },
  });
  return unwrap(res).chat_session.id;
}

// Streams a completion. `onEvent` receives parsed event objects as they arrive.
async function complete(
  token,
  {
    sessionId,
    sessionIdPromise,
    challenge,
    prompt,
    parentMessageId = null,
    thinking = false,
    search = false,
    onData,
    timing,
  }
) {
  const targetPath = '/api/v0/chat/completion';

  // Cold path: resolve session and challenge concurrently.
  const tChallenge = Date.now();
  const challengePromise =
    challenge !== undefined
      ? Promise.resolve(challenge)
      : fetchChallenge(token, targetPath).then((c) => {
          if (timing) timing.challengeMs = Date.now() - tChallenge;
          return c;
        });

  const [resolvedChallenge, resolvedSessionId] = await Promise.all([
    challengePromise,
    sessionIdPromise || Promise.resolve(sessionId),
  ]);

  const tPow = Date.now();
  const powResponse = await buildPowResponse(resolvedChallenge);
  if (timing) timing.powMs = Date.now() - tPow;
  if (timing && challenge !== undefined) timing.challengeMs = 0;

  const body = {
    chat_session_id: resolvedSessionId,
    parent_message_id: parentMessageId,
    prompt,
    ref_file_ids: [],
    model_type: thinking ? 'thinking' : 'default',
    search_enabled: !!search,
    thinking_enabled: !!thinking,
    preempt: false,
  };

  return request(targetPath, {
    method: 'POST',
    token,
    body,
    headers: { Accept: 'text/event-stream', 'X-Ds-Pow-Response': powResponse },
    onData,
  });
}

module.exports = { request, ApiError, fetchChallenge, createSession, complete, ORIGIN };
