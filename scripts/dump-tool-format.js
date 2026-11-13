'use strict';
// Dumps the raw model text for a tools-enabled prompt, to inspect the exact
// tool-call format the model chooses when many tools are attached.
const fs = require('fs');
const path = require('path');
const { complete, fetchChallenge } = require('../lib/deepseek');
const { Warmer } = require('../lib/warm');
const { makeExtractor } = require('../lib/stream');
const { buildToolInstructions, buildTranscript } = require('../lib/tools');

const token = fs
  .readFileSync(path.join(__dirname, '..', 'tokens.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))[0];

const TOOLS = [
  ['read', 'Read a file from disk', { path: { type: 'string' } }, ['path']],
  ['write', 'Write a file to disk', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']],
  ['edit', 'Replace text in a file', { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, ['path']],
  ['bash', 'Run a shell command', { command: { type: 'string' } }, ['command']],
  ['glob', 'Find files by glob', { pattern: { type: 'string' } }, ['pattern']],
  ['grep', 'Search file contents', { pattern: { type: 'string' } }, ['pattern']],
  ['webfetch', 'Fetch a URL', { url: { type: 'string' } }, ['url']],
  ['task', 'Delegate to a subagent', { prompt: { type: 'string' } }, ['prompt']],
  ['todowrite', 'Update the todo list', { todos: { type: 'array' } }, ['todos']],
].map(([name, description, props, required]) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v])),
      required,
    },
  },
}));

(async () => {
  const warmer = new Warmer();
  const sessionId = await warmer.session(token);
  const challenge = await warmer.challenge(token);

  const transcript = buildTranscript(
    [{ role: 'user', content: 'Read the file sample.txt using the read tool.' }],
    (c) => (typeof c === 'string' ? c : '')
  );
  const prompt = `System: ${buildToolInstructions(TOOLS, undefined)}\n\n${transcript}`;

  const extractor = makeExtractor();
  await complete(token, {
    sessionId,
    challenge,
    prompt,
    onData: (c) => extractor.push(c),
  });
  extractor.flush();

  console.log('--- raw text (JSON-escaped) ---');
  console.log(JSON.stringify(extractor.text));
  console.log('--- raw text (visible) ---');
  console.log(extractor.text);
  console.log('--- codepoints of first 40 chars ---');
  console.log([...extractor.text.slice(0, 40)].map((c) => c.codePointAt(0).toString(16)).join(' '));
})();
