'use strict';
// Replays a captured OpenAI request body against the upstream and dumps the
// raw model text, to see which tool-call format the model picks.
//   node scripts/replay.js /tmp/dsbody/req-XXXX.json
const fs = require('fs');
const path = require('path');
const { complete } = require('../lib/deepseek');
const { Warmer } = require('../lib/warm');
const { makeExtractor } = require('../lib/stream');
const { buildToolInstructions, buildTranscript, toolDefs } = require('../lib/tools');

const token = fs
  .readFileSync(path.join(__dirname, '..', 'tokens.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))[0];

const toText = (c) => {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n');
  return '';
};

(async () => {
  const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const defs = toolDefs(body.tools || []);
  const transcript = buildTranscript(body.messages, toText);
  const prompt = defs.length
    ? `System: ${buildToolInstructions(body.tools, body.tool_choice)}\n\n${transcript}`
    : transcript;

  console.log(`prompt: ${prompt.length} chars, ${defs.length} tools`);

  const warmer = new Warmer();
  const sessionId = await warmer.session(token);
  const challenge = await warmer.challenge(token);

  const extractor = makeExtractor();
  await complete(token, { sessionId, challenge, prompt, onData: (c) => extractor.push(c) });
  extractor.flush();

  const text = extractor.text;
  console.log('\n--- head (escaped) ---');
  console.log(JSON.stringify(text));
  console.log('\n--- head (visible) ---');
  console.log(text.slice(0, 300));
  console.log('\n--- codepoints ---');
  console.log([...text.slice(0, 24)].map((c) => c.codePointAt(0).toString(16)).join(' '));
})();
