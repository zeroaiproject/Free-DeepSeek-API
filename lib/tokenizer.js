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
    (code >= 0x3400 && code <= 0x4dbf) ||   // Extension A
    (code >= 0x20000 && code <= 0x2a6df) || // Extension B
    (code >= 0x2a700 && code <= 0x2b73f) || // Extension C
    (code >= 0x2b740 && code <= 0x2b81f) || // Extension D
    (code >= 0x2b820 && code <= 0x2ceaf) || // Extension E/F ranges (approx coverage)
    (code >= 0x3040 && code <= 0x30ff) ||   // Hiragana + Katakana
    (code >= 0x31f0 && code <= 0x31ff) ||   // Katakana Phonetic Extensions
    (code >= 0xac00 && code <= 0xd7af) ||   // Hangul Syllables
    (code >= 0x1100 && code <= 0x11ff) ||   // Hangul Jamo
    (code >= 0x3130 && code <= 0x318f) ||   // Hangul Compatibility Jamo
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK Compatibility Ideographs
    (code >= 0x2f800 && code <= 0x2fa1f) || // CJK Compatibility Ideographs Supplement
    (code >= 0x3000 && code <= 0x303f) ||   // CJK Symbols and Punctuation
    (code >= 0xff01 && code <= 0xff60) ||   // Fullwidth forms
    (code >= 0xffe0 && code <= 0xffee)
  );
}

function isEmoji(code) {
  return (
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1f1e6 && code <= 0x1f1ff)
  );
}

function wordTokenEstimate(word) {
  if (!word) return 0;
  // Count common subword boundaries (camelCase, snake, digit/letter transitions)
  const transitions =
    (word.match(/[a-z][A-Z]/g) || []).length +
    (word.match(/[A-Z]{2,}[a-z]/g) || []).length +
    (word.match(/[A-Za-z]\d|\d[A-Za-z]/g) || []).length +
    (word.match(/_+/g) || []).length;
  const len = word.length;
  let est;
  if (len <= 2) est = 0.7;
  else if (len <= 4) est = 1;
  else if (len <= 7) est = 1.35;
  else if (len <= 11) est = 1.9;
  else est = 1.9 + (len - 11) / 4.5;
  est += transitions * 0.35;
  // URLs/paths/hashes-like long tokens tend to split more
  if (/^(0x)?[0-9a-fA-F]{8,}$/.test(word)) est = Math.max(est, Math.ceil(len / 4));
  return est;
}

function estimateTextTokens(text) {
  if (text == null) return 0;
  const s = String(text);
  if (!s) return 0;

  let tokens = 0;
  let i = 0;

  while (i < s.length) {
    const code = s.codePointAt(i);
    const ch = String.fromCodePoint(code);
    const step = ch.length;

    // Newlines: usually 1 token-ish boundary in chat/code, cheaper in bulk
    if (ch === '\n' || ch === '\r') {
      let j = i + step;
      while (j < s.length && (s[j] === '\n' || s[j] === '\r')) j++;
      const n = j - i;
      tokens += n === 1 ? 0.6 : 0.6 + (n - 1) * 0.25;
      i = j;
      continue;
    }

    // Other whitespace: spaces/tabs often merge with following tokens in BPE,
    // but indentation matters in code; approximate lightly.
    if (/\s/.test(ch)) {
      let j = i + step;
      while (j < s.length) {
        const cj = s[j];
        if (cj === '\n' || cj === '\r' || !/\s/.test(cj)) break;
        j++;
      }
      const run = j - i;
      tokens += run <= 2 ? 0.15 : 0.15 + Math.ceil((run - 2) / 4) * 0.2;
      i = j;
      continue;
    }

    // CJK / fullwidth: usually ~1 token per char (sometimes punctuation merges)
    if (isCJK(code)) {
      // common paired punctuation can be slightly cheaper, but keep simple
      tokens += 1;
      i += step;
      continue;
    }

    // Emoji / pictographs: often 1-2 tokens depending on tokenizer/ZWJ; estimate ~1.5
    if (isEmoji(code)) {
      tokens += 1.2;
      i += step;
      // consume variation selectors / joiners crudely
      while (i < s.length) {
        const nc = s.codePointAt(i);
        if (nc === 0xfe0f || nc === 0x200d || (nc >= 0x1f3fb && nc <= 0x1f3ff)) {
          i += (nc > 0xffff ? 2 : 1);
          continue;
        }
        break;
      }
      continue;
    }

    // Words / identifiers / numbers / hex-like runs
    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i + step;
      let hasDot = false;
      while (j < s.length) {
        const c = s[j];
        if (/[A-Za-z0-9_]/.test(c)) { j++; continue; }
        // keep decimals/versions together: 3.14, 1.2.3
        if (c === '.' && /[0-9]/.test(s[j - 1] || '') && /[0-9]/.test(s[j + 1] || '') && !hasDot) {
          hasDot = true; j++; continue;
        }
        break;
      }
      const word = s.slice(i, j);
      // Apostrophe/contraction suffix: don't -> do n't / don ' t style split approximation
      if ((s[j] === "'" || s[j] === '’') && /^[A-Za-z]{1,3}$/.test(s.slice(j + 1, j + 4)) && /[A-Za-z]/.test(word[word.length - 1] || '')) {
        tokens += wordTokenEstimate(word) + 0.6;
        j += 1 + (s.slice(j + 1).match(/^[A-Za-z]{1,3}/) || [''])[0].length;
        i = j;
        continue;
      }
      tokens += wordTokenEstimate(word);
      i = j;
      continue;
    }

    // Punctuation/symbols/operators: cluster common multi-char operators
    if (/[^\sA-Za-z0-9_]/.test(ch)) {
      // multi-char operator tokens common in code
      const two = s.slice(i, i + 2);
      const three = s.slice(i, i + 3);
      if (['===', '!==', '==>', '->', '=>', '::', '??', '?.', '||', '&&', '>=', '<=', '!=', '==', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '++', '--', '|>', '...'].includes(three) || ['===', '!==', '>>>', '...', '**=', '<<=', '>>=', '||=', '&&=', '??='].includes(three)) {
        tokens += 1; i += 3; continue;
      }
      if (['===', '!==', '==', '!=', '<=', '>=', '=>', '->', '::', '&&', '||', '??', '?.', '+=', '-=', '*=', '/=', '%=', '**', '<<', '>>', '++', '--', '|>', '/*', '*/', '//'].includes(two)) {
        tokens += 1; i += 2; continue;
      }
      // repeated same punctuation sometimes merges (----, ====, ....) but better to approximate
      let j = i + step;
      while (j < s.length) {
        const nc = s[j];
        if (nc !== ch) break;
        if ('()[]{}<>,;:'.includes(ch)) break; // brackets usually separate
        if (j - i >= 4) break;
        j++;
      }
      if (j > i + step && !'()[]{}<>,;:\'"`'.includes(ch)) {
        tokens += 1 + (j - (i + step)) * 0.35;
      } else {
        tokens += 1;
      }
      i = j;
      continue;
    }

    // Fallback: count unknown codepoint as one token
    tokens += 1;
    i += step;
  }

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

function estimateMessagesTokens(messages, { overheadPerMessage = 3.5 } = {}) {
  if (!Array.isArray(messages)) return estimateTokens(messages);
  let total = 0;
  for (const m of messages) {
    if (!m || typeof m !== 'object') { total += overheadPerMessage; continue; }
    total += overheadPerMessage;
    if (m.role) total += Math.max(0.2, estimateTextTokens(String(m.role)) * 0.25);
    if (m.name) total += estimateTokens(String(m.name)) + 0.5;
    total += estimateTokens(flattenContent(m.content));
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc.function || tc || {};
        if (fn.name) total += estimateTokens(String(fn.name)) + 0.5;
        if (fn.arguments != null) {
          total += estimateTokens(typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments));
        } else if (tc.input != null) {
          total += estimateTokens(typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input));
        }
        if (tc.id) total += estimateTokens(String(tc.id)) * 0.3;
      }
      total += m.tool_calls.length * 1.5;
    }
    if (m.tool_call_id) total += estimateTokens(String(m.tool_call_id)) * 0.4;
  }
  return Math.ceil(total + 3); // conversation priming overhead
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
