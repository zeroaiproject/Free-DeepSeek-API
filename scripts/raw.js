'use strict';
// Debug helper: prints the raw DeepSeek SSE stream for a prompt.
// usage: node scripts/raw.js "prompt" [thinking]
const { createSession, complete } = require('../lib/deepseek');
const fs = require('fs');
const path = require('path');

const token = (process.env.DS_TOKEN || fs.readFileSync(path.join(__dirname, '..', 'tokens.txt'), 'utf8'))
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))[0];

const prompt = process.argv[2] || 'Combien font 17*23 ?';
const thinking = process.argv[3] === 'thinking';

(async () => {
  const sessionId = await createSession(token);
  const res = await complete(token, { sessionId, prompt, thinking });
  console.log(res.body);
})();
