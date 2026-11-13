'use strict';

/**
 * Lightweight token estimator (no external dependencies).
 *
 * This is a heuristic approximation intended for count_tokens endpoints and
 * internal budgeting/fallbacks when an exact upstream tokenizer is unavailable.
 * It is generally closer than a naive chars/4 estimate for mixed natural
 * language, code, punctuation, and CJK text.
 */

function isCJK(code) {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Unified Ideographs Extension A
    (code >= 0x3040 && code <= 0x30ff) ||   // Hiragana + Katakana
    (code >= 0xac00 && code <= 0xd7af) ||   // Hangul Syllables
    (code >= 0x1100 && code <= 0x11ff) ||   // Hangul Jamo
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK Compatibility Ideographs
    (code >= 0x3000 && code <= 0x303f)      // CJK Symbols and Punctuation
  );
}

function estimateTextTokens(text) {
  if (text == null) return 0;
  const s = String(text);
  if (!s) return 0;

  let tokens = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const code = s.codePointAt(i);
    const step = code > 0xffff ? 2 : 1;

    // Whitespace: usually attached/cheap, but count newlines/indentation lightly
    if (/\s/.test(ch)) {
      let j = i + step;
      while (j < s.length && /\s/.test(s[j])) j += (s.codePointAt(j) > 0xffff ? 2 : 1);
      const ws = s.slice(i, j);
      const newlines = (ws.match(/\n/g) || []).length;
      if (newlines) tokens += 0.5 + newlines * 0.25;
      else tokens += 0.25;
      i = j;
      continue;
    }

    // CJK characters: roughly 1 token each (varies by tokenizer, but close)
    if (isCJK(code)) {
      tokens += 1;
      i += step;
      continue;
    }

    // Words / identifiers (latin, digits, underscore): subword-ish heuristic
    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i + step;
      while (j < s.length) {
        const c = s[j];
        if (!/[A-Za-z0-9_]/.test(c)) break;
        j += (s.codePointAt(j) > 0xffff ? 2 : 1);
      }
      const word = s.slice(i, j);
      // Short/common tokens ~1, longer words/snake/camel segments split into subwords
      const len = word.length;
      if (len <= 4) tokens += 1;
      else if (len <= 8) tokens += 1.3;
      else tokens += 1.3 + Math.ceil((len - 8) / 4) * 0.5;
      // camelCase / transitions add splits
      const transitions = (word.match(/[a-z][A-Z]/g) || []).length + (word.match(/[A-Za-z]\d|\d[A-Za-z]/g) || []).length;
      if (transitions) tokens += transitions * 0.3;
      i = j;
      continue;
    }

    // Punctuation/symbols/operators: often separate tokens in code
    tokens += 1;
    i += step;
  }

  // Small base overhead for message formatting/metadata in chat contexts
  return Math.max(0, tokens);
}

function flattenContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(flattenContent).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') {
    // OpenAI/Anthropic/Vertex-like blocks
    if (typeof content.text === 'string') return content.text;
    if (typeof content.thinking === 'string') return content.thinking;
    if (typeof content.input_text === 'string') return content.input_text;
    if (content.type === 'tool_use') return `${content.name || ''}\n${JSON.stringify(content.input || {})}`;
    if (content.type === 'tool_result') return `${content.tool_use_id || ''}\n${flattenContent(content.content)}`;
    if (content.functionCall) return `${content.functionCall.name || ''}\n${JSON.stringify(content.functionCall.args || {})}`;
    if (content.functionResponse) return `${content.functionResponse.name || ''}\n${JSON.stringify(content.functionResponse.response || {})}`;
    if (Array.isArray(content.parts)) return content.parts.map(flattenContent).join('\n');
    try { return JSON.stringify(content); } catch { return ''; }
  }
  return String(content);
}

function estimateMessagesTokens(messages, { overheadPerMessage = 4 } = {}) {
  if (!Array.isArray(messages)) return estimateTokens(messages);
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') { total += overheadPerMessage; continue; }
    total += overheadPerMessage;
    if (m.role) total += estimateTextTokens(m.role) * 0.2;
    if (m.name) total += estimateTextTokens(m.name);
    total += estimateTokens(flattenContent(m.content));
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc.function || tc;
        if (fn && fn.name) total += estimateTokens(fn.name);
        if (fn && fn.arguments != null) {
          total += estimateTokens(typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments));
        }
      }
      total += m.tool_calls.length * 2;
    }
    if (m.tool_call_id) total += estimateTokens(m.tool_call_id) * 0.5;
  }
  return Math.ceil(total + 2); // conversation priming overhead
}

function estimateTokens(input, opts = {}) {
  if (input == null) return 0;
  if (typeof input === 'string') return Math.max(1, Math.ceil(estimateTextTokens(input)));
  if (Array.isArray(input)) {
    // could be messages or content parts
    if (input.length && input[0] && typeof input[0] === 'object' && ('role' in input[0] || 'content' in input[0])) {
      return estimateMessagesTokens(input, opts);
    }
    return Math.max(1, Math.ceil(estimateTextTokens(flattenContent(input))));
  }
  if (typeof input === 'object') {
    if (Array.isArray(input.messages)) return estimateMessagesTokens(input.messages, opts);
    if (Array.isArray(input.contents)) {
      // Vertex-style: count text parts
      let t = 0;
      for (const c of input.contents) t += estimateTokens(flattenContent(c));
      if (input.systemInstruction) t += estimateTokens(flattenContent(input.systemInstruction));
      if (Array.isArray(input.tools)) t += estimateTokens(JSON.stringify(input.tools)) * 0.8;
      return Math.max(1, Math.ceil(t + 2));
    }
    // generic object: prefer text-bearing fields before full stringify fallback
    const parts = [];
    if (input.system) parts.push(flattenContent(input.system));
    if (Array.isArray(input.messages)) parts.push(flattenContent(input.messages));
    if (Array.isArray(input.contents)) parts.push(flattenContent(input.contents));
    if (Array.isArray(input.tools)) parts.push(JSON.stringify(input.tools));
    if (parts.length) return Math.max(1, Math.ceil(estimateTextTokens(parts.join('\n'))));
    try { return Math.max(1, Math.ceil(estimateTextTokens(JSON.stringify(input)))); } catch { return 1; }
  }
  return Math.max(1, Math.ceil(estimateTextTokens(String(input))));
}

module.exports = {
  estimateTokens,
  estimateTextTokens,
  estimateMessagesTokens,
  flattenContent,
};
