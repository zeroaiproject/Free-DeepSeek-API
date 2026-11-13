'use strict';
// Tool-calling emulation for the DeepSeek web endpoint.
//
// chat.deepseek.com has no native function-calling protocol, so tools are
// described in a system block and the model is asked to answer with a single
// JSON object. The reply is parsed back into OpenAI `tool_calls`.

const MAX_TOOLS = 128;

function toolDefs(tools) {
  return tools
    .filter((t) => t && t.type === 'function' && t.function && t.function.name)
    .slice(0, MAX_TOOLS)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || '',
      parameters: t.function.parameters || { type: 'object', properties: {} },
    }));
}

function forcedTool(toolChoice) {
  if (toolChoice && typeof toolChoice === 'object') {
    const name = toolChoice.function?.name || toolChoice.name;
    if (typeof name === 'string' && name) return name;
  }
  return null;
}

function buildToolInstructions(tools, toolChoice) {
  const defs = toolDefs(tools);
  if (!defs.length) return '';

  const forced = forcedTool(toolChoice);
  const lines = [
    '# Tool use',
    '',
    'You have access to these tools:',
    '',
    JSON.stringify(defs, null, 2),
    '',
    'To call one or more tools, reply with ONLY a JSON object of this shape:',
    '{"tool_calls":[{"name":"<tool name>","arguments":{<arguments>}}]}',
    '',
    'Rules:',
    '- Emit raw JSON. No markdown fences, no text before or after.',
    '- Never use DSML or XML-like tags (e.g. <||DSML|| ...>) — plain JSON only.',
    '- "arguments" must be an object matching the tool JSON Schema.',
    '- Call a tool when it is required to answer. Never invent tool results.',
    '- If no tool is needed, answer normally in plain text.',
  ];
  if (forced) {
    lines.push(`- You MUST call the tool "${forced}" now. Do not answer in plain text.`);
  } else if (toolChoice === 'required') {
    lines.push('- You MUST call at least one tool now. Do not answer in plain text.');
  }
  return lines.join('\n');
}

// Extract the first balanced {...} block, ignoring braces inside strings.
function findBalancedObject(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return s.slice(i, j + 1);
      }
    }
  }
  return null;
}

function stripFences(s) {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1] : s;
}

// ---------------------------------------------------------------------------
// DSML: DeepSeek's native markup tool-call format.
//
// When a large tool set is attached the model sometimes ignores the requested
// JSON shape and answers with its own markup instead:
//
//   <||DSML|| calls>
//   <||DSML|| invoke name="read">
//   <||DSML|| parameter name="path" string="true">sample.txt</||DSML|| parameter>
//   </||DSML|| invoke>
//   </||DSML|| calls>
//
// The separator is U+FF5C U+FF5C (fullwidth vertical bars), not ASCII pipes.
// ---------------------------------------------------------------------------

const DSML_MARK = '\uFF5C\uFF5CDSML\uFF5C\uFF5C';
const DSML_PREFIX = '<' + DSML_MARK;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const RE_INVOKE = new RegExp(
  `<${escapeRe(DSML_MARK)}\\s*invoke\\b([^>]*)>([\\s\\S]*?)</${escapeRe(DSML_MARK)}\\s*invoke\\s*>`,
  'g'
);
const RE_PARAM = new RegExp(
  `<${escapeRe(DSML_MARK)}\\s*parameter\\b([^>]*)>([\\s\\S]*?)</${escapeRe(DSML_MARK)}\\s*parameter\\s*>`,
  'g'
);

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
}

function dsmlValue(raw, isString) {
  const value = raw.replace(/^\n/, '').replace(/\n$/, '');
  if (isString) return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function parseDsml(text, allowedNames) {
  if (!text || !text.includes(DSML_PREFIX)) return null;

  const calls = [];
  RE_INVOKE.lastIndex = 0;
  let invoke;
  while ((invoke = RE_INVOKE.exec(text)) !== null) {
    const name = attr(invoke[1], 'name');
    if (!name) continue;
    if (allowedNames && allowedNames.size && !allowedNames.has(name)) continue;

    const args = {};
    const body = invoke[2];
    RE_PARAM.lastIndex = 0;
    let param;
    while ((param = RE_PARAM.exec(body)) !== null) {
      const key = attr(param[1], 'name');
      if (!key) continue;
      args[key] = dsmlValue(param[2], attr(param[1], 'string') !== 'false');
    }
    calls.push({ name, arguments: args });
  }

  return calls.length ? calls : null;
}

function isDsml(s) {
  return typeof s === 'string' && s.trimStart().startsWith(DSML_PREFIX);
}

function coerceArguments(args) {
  if (args === undefined || args === null) return {};
  if (typeof args === 'object') return args;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

// Returns [{ name, arguments }] or null when the text is a normal answer.
function extractToolCalls(text, allowedNames) {
  if (!text || !text.trim()) return null;

  const stripped = stripFences(text).trim();

  // DeepSeek's own markup format wins when present.
  const dsml = parseDsml(stripped, allowedNames);
  if (dsml) return dsml;

  const candidates = [];
  const balanced = findBalancedObject(stripped);
  if (balanced) candidates.push(balanced);
  candidates.push(stripped);

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    let calls = null;
    if (Array.isArray(parsed)) calls = parsed;
    else if (Array.isArray(parsed.tool_calls)) calls = parsed.tool_calls;
    else if (parsed.tool_calls && Array.isArray(parsed.tool_calls.calls)) calls = parsed.tool_calls.calls;
    else if (typeof parsed.name === 'string') calls = [parsed];
    else if (parsed.function && typeof parsed.function.name === 'string') calls = [parsed.function];

    if (!calls) continue;

    const out = [];
    for (const call of calls) {
      const name = call?.name || call?.function?.name;
      if (!name) continue;
      if (allowedNames && allowedNames.size && !allowedNames.has(name)) continue;
      out.push({ name, arguments: coerceArguments(call.arguments ?? call.function?.arguments) });
    }
    if (out.length) return out;
  }
  return null;
}

// Rewrites an OpenAI transcript into the flattened form DeepSeek expects.
function buildTranscript(messages, contentToText) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages is required');

  const text = (m) => contentToText(m.content);
  const single = messages.length === 1 && messages[0].role === 'user';

  return messages
    .map((m) => {
      const body = text(m);
      if (m.role === 'system') return `System: ${body}`;
      if (m.role === 'tool') {
        const label = m.name ? `Tool result (${m.name})` : 'Tool result';
        return `${label}: ${body}`;
      }
      if (m.role === 'assistant') {
        const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        if (calls.length) {
          const compact = calls.map((c) => ({
            name: c?.function?.name || c?.name,
            arguments: coerceArguments(c?.function?.arguments ?? c?.arguments),
          }));
          const prefix = body ? `${body}\n` : '';
          return `Assistant: ${prefix}{"tool_calls":${JSON.stringify(compact)}}`;
        }
        return single ? body : `Assistant: ${body}`;
      }
      return single ? body : `User: ${body}`;
    })
    .join('\n\n');
}

module.exports = {
  buildToolInstructions,
  extractToolCalls,
  buildTranscript,
  toolDefs,
  forcedTool,
  isDsml,
  DSML_PREFIX,
};
