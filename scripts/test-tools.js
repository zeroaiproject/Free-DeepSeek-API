'use strict';
// Tool-calling regression tests against a running proxy.
//   node scripts/test-tools.js
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const assert = require('assert');

const WEATHER = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
};

const TIME = {
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Get the current time in a timezone',
    parameters: { type: 'object', properties: { tz: { type: 'string' } } },
  },
};

async function post(payload) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function toolNames(msg) {
  return (msg.tool_calls || []).map((c) => c.function.name);
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

test('single tool call (non-stream)', async () => {
  const r = await post({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Quel temps fait-il à Paris ?' }],
    tools: [WEATHER],
  });
  const c = r.choices[0];
  assert.strictEqual(c.finish_reason, 'tool_calls');
  assert.deepStrictEqual(toolNames(c.message), ['get_weather']);
  const args = JSON.parse(c.message.tool_calls[0].function.arguments);
  assert.strictEqual(args.city.toLowerCase(), 'paris');
  assert.strictEqual(c.message.content, null);
});

test('tool result is consumed (non-stream)', async () => {
  const r = await post({
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'Quel temps fait-il à Paris ?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '{"temp_c":11,"sky":"nuageux"}' },
    ],
    tools: [WEATHER],
  });
  const c = r.choices[0];
  assert.strictEqual(c.finish_reason, 'stop');
  assert.ok(!c.message.tool_calls, 'expected a final answer, got another tool call');
  assert.match(c.message.content, /11/);
});

test('parallel tool calls', async () => {
  const r = await post({
    model: 'deepseek-chat',
    tool_choice: 'required',
    messages: [{ role: 'user', content: 'Compare la météo à Paris et à Tokyo.' }],
    tools: [WEATHER, TIME],
  });
  const c = r.choices[0];
  assert.strictEqual(c.finish_reason, 'tool_calls');
  assert.ok(c.message.tool_calls.length >= 2, `expected >=2 calls, got ${c.message.tool_calls.length}`);
});

test('parallel_tool_calls=false collapses to one', async () => {
  const r = await post({
    model: 'deepseek-chat',
    tool_choice: 'required',
    parallel_tool_calls: false,
    messages: [{ role: 'user', content: 'Compare la météo à Paris et à Tokyo.' }],
    tools: [WEATHER],
  });
  assert.strictEqual(r.choices[0].message.tool_calls.length, 1);
});

test('tool_choice=none never calls a tool', async () => {
  const r = await post({
    model: 'deepseek-chat',
    tool_choice: 'none',
    messages: [{ role: 'user', content: 'Quel temps fait-il à Paris ?' }],
    tools: [WEATHER],
  });
  assert.strictEqual(r.choices[0].finish_reason, 'stop');
  assert.ok(!r.choices[0].message.tool_calls);
});

test('plain answer with tools attached', async () => {
  const r = await post({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Combien font 2+2 ? Réponds en un mot.' }],
    tools: [WEATHER],
  });
  const c = r.choices[0];
  assert.strictEqual(c.finish_reason, 'stop');
  assert.match(c.message.content, /4|quatre/i);
});

test('streamed tool call', async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      stream: true,
      messages: [{ role: 'user', content: 'Météo à Tokyo ?' }],
      tools: [WEATHER],
    }),
  });
  assert.strictEqual(res.status, 200);
  const text = await res.text();

  let calls = [];
  let finish = null;
  let sawContent = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (raw === '[DONE]') continue;
    const j = JSON.parse(raw);
    const c = j.choices?.[0];
    if (!c) continue;
    if (c.finish_reason) finish = c.finish_reason;
    if (c.delta?.content) sawContent = true;
    for (const tc of c.delta?.tool_calls || []) calls.push(tc);
  }
  assert.strictEqual(finish, 'tool_calls');
  assert.ok(!sawContent, 'tool-call JSON must not leak as content');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].function.name, 'get_weather');
  assert.ok(JSON.parse(calls[0].function.arguments).city);
});

test('streamed plain answer still streams', async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      stream: true,
      messages: [{ role: 'user', content: 'Dis bonjour en trois mots.' }],
      tools: [WEATHER],
    }),
  });
  const text = await res.text();
  const contentChunks = text.split('\n').filter((l) => l.startsWith('data: ') && l.includes('"content":"')).length;
  assert.ok(contentChunks >= 2, `expected incremental content, got ${contentChunks} chunks`);
});

(async () => {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`PASS  ${c.name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL  ${c.name}\n      ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 4000)); // upstream rate limit
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`);
  process.exit(failed ? 1 : 0);
})();
