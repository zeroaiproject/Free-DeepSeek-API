'use strict';
// Compares sequential vs concurrent session+PoW ordering.
const fs = require('fs');
const path = require('path');
const { createSession, complete, fetchChallenge } = require('../lib/deepseek');
const { buildPowResponse } = require('../lib/pow');

const token = fs
  .readFileSync(path.join(__dirname, '..', 'tokens.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))[0];

function firstContent(body) {
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (!raw) continue;
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    const frags = j?.v?.response?.fragments;
    if (Array.isArray(frags) && frags[0] && frags[0].content) return frags[0].content;
  }
  return '(empty)';
}

(async () => {
  const mode = process.argv[2] || 'seq';

  if (mode === 'seq') {
    const t0 = Date.now();
    const sessionId = await createSession(token);
    const tSession = Date.now() - t0;
    const res = await complete(token, { sessionId, prompt: 'Dis bonjour.' });
    console.log(`seq  session=${tSession}ms total=${Date.now() - t0}ms ->`, firstContent(res.body));
    return;
  }

  // concurrent: fire both, then build the request manually
  const t0 = Date.now();
  const [sessionId, challenge] = await Promise.all([
    createSession(token),
    fetchChallenge(token, '/api/v0/chat/completion'),
  ]);
  const tPre = Date.now() - t0;
  const pow = await buildPowResponse(challenge);
  const res = await complete(token, { sessionId, prompt: 'Dis bonjour.' });
  console.log(`conc prep=${tPre}ms total=${Date.now() - t0}ms ->`, firstContent(res.body));
  void pow;
})();
