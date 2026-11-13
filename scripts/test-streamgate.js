'use strict';
// Offline unit tests for lib/streamgate.js — the logic that decides which part
// of a streaming answer may reach the client while tools are attached.

const { StreamGate, hasToolMarker } = require('../lib/streamgate');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('PASS ', name);
  } else {
    fail++;
    console.log('FAIL ', name, detail === undefined ? '' : '-> ' + JSON.stringify(detail));
  }
}

// Feeds a growing text through the gate the way the SSE handler does and
// returns everything that was emitted.
function run(chunks, opts = {}) {
  const g = new StreamGate({ toolsActive: true, holdBack: 8, ...opts });
  let text = '';
  let out = '';
  for (const c of chunks) {
    text += c;
    out += g.pump(text);
  }
  return { out, text, gate: g };
}

// 1. Plain prose, tools attached: everything is emitted once the answer ends.
{
  const chunks = ['Bonjour, ', 'voici la ', 'réponse complète.'];
  const { out, text, gate } = run(chunks);
  const final = out + gate.finish(text);
  check('prose streams, hold-back is flushed', final === text, { final, text });
  check('prose did not trip buffering', gate.buffering === false);
}

// 2. Prose first, then a JSON tool call: the call must never leak.
{
  const chunks = ['I will create the file.\n\n', '{"tool_calls":[{"name":"write"', ',"arguments":{"path":"a"}}]}'];
  const { out, gate } = run(chunks);
  check('prose-then-JSON stops at the marker', gate.buffering === true);
  check('prose-then-JSON leaks no tool text', !out.includes('tool_calls') && !out.includes('write'), out);
  check('prose-then-JSON still emitted the prose', out.startsWith('I will create'), out);
}

// 3. DSML open tag.
{
  const { out, gate } = run(['Je regarde.\n', '<\uFF5CDSML\uFF5C calls>']);
  check('DSML open tag stops emission', gate.buffering === true);
  check('DSML open tag not emitted', !out.includes('\uFF5C'), out);
}

// 4. DSML close tag only (model answered with prose then closed markup).
{
  const { out, gate } = run(['done', '\n</\uFF5CDSML\uFF5C invoke>']);
  check('DSML close tag is detected', gate.buffering === true, out);
}

// 5. Fenced JSON.
{
  const { out, gate } = run(['Sure:\n', '```json\n{"tool_calls":[]}\n```']);
  check('fenced block stops emission', gate.buffering === true);
  check('fence itself never emitted', !out.includes('```'), out);
}

// 6. Marker split across chunks must not leak its prefix.
{
  const { out, gate } = run(['ok ', '{"tool_', 'calls":[{"name":"x"}]}']);
  check('split marker detected', gate.buffering === true);
  check('split marker prefix not leaked', !out.includes('{"tool_'), out);
}

// 7. Pure tool call from the very first chunk emits nothing.
{
  const { out, gate } = run(['{"tool_calls":[{"name":"read","arguments":{"path":"a"}}]}']);
  check('pure tool call emits nothing', out === '', out);
  check('pure tool call buffered', gate.buffering === true);
  check('finish() emits nothing while buffering', gate.finish('{"tool_calls":[]}') === '');
}

// 8. Prose that merely looks suspicious but is not a marker.
{
  const { out, text, gate } = run(['Use a tool if you need one. ', 'That is all.']);
  check('ordinary prose mentioning "tool" is not buffered', gate.buffering === false);
  check('ordinary prose fully emitted', out + gate.finish(text) === text);
}

// 9. toolsActive=false: no hold-back, no detection.
{
  const g = new StreamGate({ toolsActive: false, holdBack: 8 });
  let text = '';
  let out = '';
  for (const c of ['{"tool_calls":', '[1,2]}']) {
    text += c;
    out += g.pump(text);
  }
  check('tools off emits everything immediately', out === text, { out, text });
}

// 10. drain() releases a buffered tail when it turns out to be prose.
{
  const g = new StreamGate({ toolsActive: true, holdBack: 8 });
  const text = 'hello <| not a real call';
  g.pump(text);
  check('drain returns the held tail', g.drain(text) === text, g.drain(text));
  check('drain is idempotent', g.drain(text) === '');
}

// 11. hasToolMarker sanity.
{
  check('hasToolMarker finds JSON key', hasToolMarker('{"tool_calls":[]}'));
  check('hasToolMarker finds DSML', hasToolMarker('<\uFF5CDSML\uFF5C invoke>'));
  check('hasToolMarker ignores plain text', !hasToolMarker('nothing here'));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
