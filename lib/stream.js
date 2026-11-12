'use strict';
// DeepSeek SSE -> text/reasoning deltas.
//
// The stream mixes three shapes:
//   {"v":{"response":{...,"fragments":[{type,content}]}}}      full snapshot
//   {"v":"..."}                                                append to last fragment
//   {"p":"response/fragments/<idx| -1>/content","o":"APPEND","v":"..."}  targeted append
// Everything else (status/batch patches, title, close) is ignored.

const FRAGMENT_CONTENT = /^response\/fragments\/(-?\d+)\/content$/;

function makeExtractor() {
  let fragments = [];
  let emittedText = '';
  let emittedThink = '';
  let buffer = '';
  let finished = false;
  let usage = 0;

  const value = () => {
    let text = '';
    let think = '';
    for (const f of fragments) {
      if (f.type === 'THINK') think += f.content;
      else text += f.content;
    }
    return { text, think };
  };

  function apply(j) {
    if (!j || typeof j !== 'object') return;

    // Snapshot
    if (j.v && typeof j.v === 'object' && j.v.response) {
      const r = j.v.response;
      if (Array.isArray(r.fragments)) {
        fragments = r.fragments.map((f) => ({
          type: f && f.type ? f.type : 'RESPONSE',
          content: f && typeof f.content === 'string' ? f.content : '',
        }));
      }
      if (typeof r.accumulated_token_usage === 'number') usage = r.accumulated_token_usage;
      if (r.status === 'FINISHED') finished = true;
      return;
    }

    // Batch patch: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":86}]}
    if (Array.isArray(j.v)) {
      if (typeof j.p === 'string' && j.p.startsWith('response/fragments')) {
        fragments = j.v.map((f) => ({
          type: f && f.type ? f.type : 'RESPONSE',
          content: f && typeof f.content === 'string' ? f.content : '',
        }));
        return;
      }
      for (const patch of j.v) {
        if (patch && patch.p === 'accumulated_token_usage' && typeof patch.v === 'number') usage = patch.v;
      }
      return;
    }

    // Standalone usage patch
    if (j.p === 'accumulated_token_usage' && typeof j.v === 'number') {
      usage = j.v;
      return;
    }

    if (typeof j.v !== 'string') return;

    // Targeted append
    if (typeof j.p === 'string') {
      const m = FRAGMENT_CONTENT.exec(j.p);
      if (!m) return; // status / quasi_status / token patches
      let idx = Number(m[1]);
      if (idx < 0) idx = fragments.length - 1;
      if (idx < 0) return;
      if (!fragments[idx]) fragments[idx] = { type: 'RESPONSE', content: '' };
      fragments[idx].content += j.v;
      return;
    }

    // Shorthand append to the last fragment
    if (fragments.length === 0) fragments.push({ type: 'RESPONSE', content: '' });
    fragments[fragments.length - 1].content += j.v;
  }

  function drain() {
    const events = [];
    const { text, think } = value();
    if (think.length > emittedThink.length && think.startsWith(emittedThink)) {
      events.push({ kind: 'reasoning', delta: think.slice(emittedThink.length) });
      emittedThink = think;
    }
    if (text.length > emittedText.length && text.startsWith(emittedText)) {
      events.push({ kind: 'content', delta: text.slice(emittedText.length) });
      emittedText = text;
    }
    return events;
  }

  function parseLine(line) {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const raw = t.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      return;
    }
    apply(j);
  }

  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) parseLine(line);
      return drain();
    },
    flush() {
      if (buffer) parseLine(buffer);
      buffer = '';
      return drain();
    },
    get text() {
      return value().text;
    },
    get reasoning() {
      return value().think;
    },
    get usage() {
      return usage;
    },
    get finished() {
      return finished;
    },
  };
}

module.exports = { makeExtractor };
