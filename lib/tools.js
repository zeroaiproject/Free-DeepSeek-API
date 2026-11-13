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
  const names = defs.map((d) => d.name);
  const lines = [
    '# Tool use',
    '',
    'You have access to these tools (JSON Schemas):',
    '',
    '```json',
    JSON.stringify(defs, null, 2),
    '```',
    '',
    'When a tool call is needed, respond with ONLY this JSON object and nothing else:',
    '{"tool_calls":[{"name":"<tool name>","arguments":{<arguments object>}}]}',
    '',
    'Rules:',
    '- To call tool(s), output raw valid JSON only: no markdown fences, no prose, no prefix/suffix text.',
    '- "name" must be exactly one of: ' + names.join(', '),
    '- "arguments" must be a JSON object matching the tool schema (use {} if none). Never encode arguments as a JSON string.',
    '- You may include multiple items in "tool_calls" when parallel calls are useful.',
    '- Do not invent tool results. Do not describe a call in plain text instead of emitting the JSON.',
    '- If no tool is needed, answer normally in plain text (do not emit tool_calls JSON).',
  ];
  if (forced) {
    lines.push(`- You MUST call the tool "${forced}" now (and no other tool). Return only the tool_calls JSON.`);
  } else if (toolChoice === 'required') {
    lines.push('- You MUST call at least one tool now. Return only the tool_calls JSON.');
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
  if (typeof args === 'object' && !Array.isArray(args)) return args;
  if (typeof args === 'string') {
    let s = args.trim();
    if (!s) return {};
    // Handle double-encoded JSON strings.
    for (let i = 0; i < 2; i++) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        if (typeof parsed === 'string') { s = parsed.trim(); continue; }
        return {};
      } catch {
        // Try to recover an embedded object from a messy string.
        const obj = findBalancedObject(s);
        if (obj && obj !== s) {
          try {
            const p = JSON.parse(obj);
            if (p && typeof p === 'object' && !Array.isArray(p)) return p;
          } catch {}
        }
        return {};
      }
    }
    return {};
  }
  return {};
}

function normalizeCalls(calls, allowedNames) {
  if (!Array.isArray(calls)) return null;
  const out = [];
  const seen = new Set();
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const fn = call.function && typeof call.function === 'object' ? call.function : null;
    const name = call.name || (fn && fn.name) || call.tool_name || call.tool;
    if (!name || typeof name !== 'string') continue;
    if (allowedNames && allowedNames.size && !allowedNames.has(name)) continue;

    const rawArgs = call.arguments ?? call.parameters ?? call.input ?? (fn && (fn.arguments ?? fn.parameters));
    const args = coerceArguments(rawArgs);

    // Deduplicate exact repeats that sometimes appear in noisy outputs.
    const key = name + '\n' + JSON.stringify(args);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ name, arguments: args });
  }
  return out.length ? out : null;
}

// Returns [{ name, arguments }] or null when the text is a normal answer.
function extractToolCalls(text, allowedNames) {
  if (text == null) return null;
  const raw = String(text);
  if (!raw.trim()) return null;

  const stripped = stripFences(raw).trim();
  const allowed = Array.isArray(allowedNames) ? new Set(allowedNames.filter(Boolean)) : allowedNames;

  // DeepSeek's own markup format wins when present.
  const dsml = parseDsml(stripped, allowed);
  if (dsml) return dsml;

  const candidates = [];
  const pushCandidate = (c) => {
    if (!c || typeof c !== 'string') return;
    const t = c.trim();
    if (!t) return;
    if (!candidates.includes(t)) candidates.push(t);
  };

  pushCandidate(stripped);

  // Find and try all balanced JSON objects/arrays in order (handles prose + multiple blocks)
  const scan = (s) => {
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '{' || ch === '[') {
        let depth = 0, inStr = false, esc = false, start = i, ok = false;
        for (let j = i; j < s.length; j++) {
          const c = s[j];
          if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
          }
          if (c === '"') inStr = true;
          else if (c === '{' || c === '[') depth++;
          else if (c === '}' || c === ']') {
            depth--;
            if (depth === 0) { pushCandidate(s.slice(start, j + 1)); i = j + 1; ok = true; break; }
          }
        }
        if (!ok) i++;
      } else {
        i++;
      }
      if (candidates.length >= 12) break;
    }
  };
  scan(stripped);

  // Also try tail from first brace/bracket (covers some malformed wrappers)
  const firstBrace = stripped.indexOf('{');
  const firstBracket = stripped.indexOf('[');
  let start = -1;
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);
  if (start > 0) pushCandidate(stripped.slice(start));

  const merged = [];
  const seen = new Set();

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    let calls = null;
    if (Array.isArray(parsed)) calls = parsed;
    else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.tool_calls)) calls = parsed.tool_calls;
      else if (Array.isArray(parsed.tool_call)) calls = parsed.tool_call;
      else if (Array.isArray(parsed.function_calls)) calls = parsed.function_calls;
      else if (parsed.function_call && typeof parsed.function_call === 'object') calls = [parsed.function_call];
      else if (parsed.tool_calls && Array.isArray(parsed.tool_calls.calls)) calls = parsed.tool_calls.calls;
      else if (parsed.calls && Array.isArray(parsed.calls)) calls = parsed.calls;
      else if (typeof parsed.name === 'string' && (parsed.arguments != null || parsed.parameters != null || parsed.input != null || parsed.function != null)) calls = [parsed];
      else if (parsed.function && typeof parsed.function === 'object' && typeof parsed.function.name === 'string') calls = [parsed];
      else if (parsed.function && typeof parsed.function === 'string') calls = [{ name: parsed.function, arguments: parsed.arguments ?? parsed.parameters ?? parsed.input }];
      else if (typeof parsed.tool === 'string' || typeof parsed.tool_name === 'string') calls = [parsed];
    }

    const out = normalizeCalls(calls, allowed);
    if (out) {
      for (const c of out) {
        const key = c.name + '\n' + JSON.stringify(c.arguments);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(c);
      }
      // Prefer a complete tool_calls wrapper result when found
      if (parsed && !Array.isArray(parsed) && (parsed.tool_calls || parsed.function_calls || parsed.calls)) return merged;
    }
  }

  return merged.length ? merged : null;
}

// Rewrites an OpenAI transcript into the flattened form DeepSeek expects.
function buildTranscript(messages, contentToText) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages is required');

  const text = (m) => contentToText(m && m.content);
  const single = messages.length === 1 && messages[0] && messages[0].role === 'user';

  return messages
    .map((m, i) => {
      if (!m || typeof m !== 'object') return `User:`;
      const role = m.role || 'user';
      const body = text(m);

      if (role === 'system' || role === 'developer') return `System: ${body}`;

      if (role === 'tool' || role === 'function') {
        const name = m.name || m.tool_call_id || '';
        const label = name ? `Tool result (${name})` : 'Tool result';
        return `${label}: ${body}`;
      }

      if (role === 'assistant') {
        const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        if (calls.length) {
          const compact = calls
            .map((c) => ({
              name: c?.function?.name || c?.name || c?.tool_name,
              arguments: coerceArguments(c?.function?.arguments ?? c?.arguments ?? c?.parameters),
            }))
            .filter((c) => c.name);
          const prefix = body ? `${body}\n` : '';
          const tc = compact.length ? `{"tool_calls":${JSON.stringify(compact)}}` : '';
          return `Assistant: ${[prefix.trimEnd(), tc].filter(Boolean).join('\n')}`.trimEnd();
        }
        return single ? body : `Assistant: ${body}`;
      }

      // user (default)
      if (single && i === 0) return body;
      const name = m.name ? ` (${m.name})` : '';
      return `User${name}: ${body}`;
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
