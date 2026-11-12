'use strict';
// Can a challenge be fetched ahead of time and solved later?
// Can a chat_session_id be reused for a fresh completion?
const fs = require('fs');
const path = require('path');
const { request, createSession, fetchChallenge } = require('../lib/deepseek');
const { buildPowResponse } = require('../lib/pow');

const token = fs
  .readFileSync(path.join(__dirname, '..', 'tokens.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))[0];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function summary(body) {
  const head = body.trimStart();
  if (head.startsWith('{')) {
    try {
      const j = JSON.parse(body);
      return `JSON code=${j.code} msg=${j.msg}`;
    } catch {
      return 'JSON (unparseable)';
    }
  }
  let chars = 0;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const j = JSON.parse(line.slice(6));
      const frags = j?.v?.response?.fragments;
      if (Array.isArray(frags)) for (const f of frags) chars += (f.content || '').length;
      else if (typeof j.v === 'string') chars += j.v.length;
    } catch {}
  }
  return `SSE chars=${chars}`;
}

async function send(sessionId, powResponse) {
  return request('/api/v0/chat/completion', {
    method: 'POST',
    token,
    body: {
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt: 'Dis bonjour.',
      ref_file_ids: [],
      model_type: 'default',
      search_enabled: false,
      thinking_enabled: false,
      preempt: false,
    },
    headers: { Accept: 'text/event-stream', 'X-Ds-Pow-Response': powResponse },
  });
}

async function timed(label, sessionId, challenge) {
  const tSolve = Date.now();
  const pow = await buildPowResponse(challenge);
  const solveMs = Date.now() - tSolve;

  const tSend = Date.now();
  const res = await send(sessionId, pow);
  const sendMs = Date.now() - tSend;

  console.log(`${label}: solve=${solveMs}ms send=${sendMs}ms -> ${summary(res.body)}`);
}

(async () => {
  console.log('--- 1. challenge prefetched 20s in advance, session reused ---');
  const sessionId = await createSession(token);
  const c1 = await fetchChallenge(token, '/api/v0/chat/completion');
  console.log(`prefetched challenge, age will be 20s (expire_at in ${((c1.expire_at - Date.now()) / 1000).toFixed(0)}s)`);
  await sleep(20000);
  await timed('req 1', sessionId, c1);

  await sleep(5000);
  console.log('\n--- 2. fresh challenge, same session again ---');
  const c2 = await fetchChallenge(token, '/api/v0/chat/completion');
  await timed('req 2', sessionId, c2);

  await sleep(5000);
  console.log('\n--- 3. fresh challenge, brand new session ---');
  const c3 = await fetchChallenge(token, '/api/v0/chat/completion');
  const s2 = await createSession(token);
  await timed('req 3', s2, c3);
})();
