'use strict';
// Unit tests for the tool-call parser. No network, no token required.
//   node scripts/test-parsers.js
const assert = require('assert');
const { extractToolCalls, isDsml, buildTranscript } = require('../lib/tools');

const M = '\uFF5C\uFF5CDSML\uFF5C\uFF5C';
const ALLOWED = new Set(['read', 'get_weather', 'get_time']);

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('canonical JSON tool call', () => {
  const text = '{"tool_calls":[{"name":"read","arguments":{"path":"a.txt"}}]}';
  assert.deepStrictEqual(extractToolCalls(text, ALLOWED), [{ name: 'read', arguments: { path: 'a.txt' } }]);
});

test('fenced JSON tool call', () => {
  const text = '```json\n{"tool_calls":[{"name":"read","arguments":{"path":"b.txt"}}]}\n```';
  assert.deepStrictEqual(extractToolCalls(text, ALLOWED), [{ name: 'read', arguments: { path: 'b.txt' } }]);
});

test('bare object with name/arguments', () => {
  const text = '{"name":"get_weather","arguments":{"city":"Paris"}}';
  assert.deepStrictEqual(extractToolCalls(text, ALLOWED), [
    { name: 'get_weather', arguments: { city: 'Paris' } },
  ]);
});

test('arguments given as a JSON string', () => {
  const text = '{"tool_calls":[{"name":"read","arguments":"{\\"path\\":\\"c.txt\\"}"}]}';
  assert.deepStrictEqual(extractToolCalls(text, ALLOWED), [{ name: 'read', arguments: { path: 'c.txt' } }]);
});

test('parallel JSON tool calls', () => {
  const text =
    '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}},' +
    '{"name":"get_weather","arguments":{"city":"Tokyo"}}]}';
  const calls = extractToolCalls(text, ALLOWED);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(
    calls.map((c) => c.arguments.city),
    ['Paris', 'Tokyo']
  );
});

test('DSML single invoke', () => {
  const text =
    `\n\n<${M} calls>\n<${M} invoke name="read">\n` +
    `<${M} parameter name="path" string="true">sample.txt</${M} parameter>\n` +
    `</${M} invoke>\n</${M} calls>`;
  assert.ok(isDsml(text));
  assert.deepStrictEqual(extractToolCalls(text, ALLOWED), [{ name: 'read', arguments: { path: 'sample.txt' } }]);
});

test('DSML parallel invokes', () => {
  const text =
    `<${M} calls>\n` +
    `<${M} invoke name="get_weather">\n<${M} parameter name="city" string="true">Paris</${M} parameter>\n</${M} invoke>\n` +
    `<${M} invoke name="get_weather">\n<${M} parameter name="city" string="true">Tokyo</${M} parameter>\n</${M} invoke>\n` +
    `</${M} calls>`;
  const calls = extractToolCalls(text, ALLOWED);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(
    calls.map((c) => c.arguments.city),
    ['Paris', 'Tokyo']
  );
});

test('DSML non-string parameter is coerced', () => {
  const text =
    `<${M} calls>\n<${M} invoke name="read">\n` +
    `<${M} parameter name="limit" string="false">42</${M} parameter>\n` +
    `</${M} invoke>\n</${M} calls>`;
  assert.deepStrictEqual(extractToolCalls(text, ALLOWED), [{ name: 'read', arguments: { limit: 42 } }]);
});

test('DSML unknown tool is dropped', () => {
  const text =
    `<${M} calls>\n<${M} invoke name="rm_rf">\n` +
    `<${M} parameter name="path" string="true">/</${M} parameter>\n` +
    `</${M} invoke>\n</${M} calls>`;
  assert.strictEqual(extractToolCalls(text, ALLOWED), null);
});

test('plain prose is not a tool call', () => {
  assert.strictEqual(extractToolCalls('Il fait 11 degres a Paris.', ALLOWED), null);
  assert.strictEqual(extractToolCalls('', ALLOWED), null);
  assert.strictEqual(extractToolCalls('{"answer":42}', ALLOWED), null);
});

test('transcript renders tool results', () => {
  const out = buildTranscript(
    [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'get_weather', content: '{"temp_c":11}' },
    ],
    (c) => (typeof c === 'string' ? c : '')
  );
  assert.match(out, /User: weather\?/);
  assert.match(out, /"tool_calls":\[\{"name":"get_weather","arguments":\{"city":"Paris"\}\}\]/);
  assert.match(out, /Tool result \(get_weather\): \{"temp_c":11\}/);
});

let failed = 0;
for (const c of cases) {
  try {
    c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL  ${c.name}\n      ${e.message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
