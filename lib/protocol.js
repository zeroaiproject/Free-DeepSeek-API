'use strict';
// Unified protocol helpers: normalize requests and format responses/events across
// OpenAI, Anthropic Messages, and Vertex/Gemini-compatible APIs.

const crypto = require('crypto');
const compat = require('./compat');

function rid(prefix = 'id') {
  return prefix + '_' + crypto.randomBytes(12).toString('hex');
}

// Normalize an inbound request into a common OpenAI-like shape for the core engine.
// format: 'openai' | 'anthropic' | 'vertex'
function normalizeRequest(format, raw, opts = {}) {
  if (format === 'anthropic') {
    const reqModel = typeof raw?.model === 'string' ? raw.model : 'deepseek-chat';
    const oai = compat.anthropicToOpenAI(raw || {});
    return { format, reqModel, ...oai, raw };
  }
  if (format === 'vertex') {
    const reqModel = opts.modelFromPath || raw?.model || 'deepseek-chat';
    const oai = compat.vertexToOpenAI(raw || {}, opts.modelFromPath);
    // Vertex generateContent is non-stream by endpoint; streaming decided by route
    oai.stream = !!opts.stream;
    return { format, reqModel, ...oai, raw };
  }
  // openai (default)
  return { format: 'openai', reqModel: raw?.model, ...(raw || {}), raw };
}

function toOpenAIResponse({ id, created, model, message, finish_reason, usage }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message, finish_reason }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function toAnthropicResponse(openai, reqModel) {
  return compat.openAIToAnthropicResponse(openai, reqModel);
}

function toVertexResponse(openai, modelName) {
  return compat.openAIToVertexResponse(openai, modelName);
}

function formatNonStream(format, openaiResp, reqModel) {
  if (format === 'anthropic') return toAnthropicResponse(openaiResp, reqModel || openaiResp.model);
  if (format === 'vertex') return toVertexResponse(openaiResp, reqModel || openaiResp.model);
  return openaiResp;
}

// --- Streaming adapters ----------------------------------------------------

function sseData(res, payload) {
  res.write('data: ');
  res.write(JSON.stringify(payload));
  res.write('\n\n');
}

function sseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write('data: ');
  res.write(JSON.stringify(payload));
  res.write('\n\n');
}

function openAIChunk(id, model, created, delta, finish = null) {
  return { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
}

class OpenAIStreamWriter {
  constructor(res, { id, model, created, includeUsage = false }) {
    this.res = res; this.id = id; this.model = model; this.created = created; this.includeUsage = includeUsage; this.started = false;
  }
  open(headers, writeHead) {
    if (this.started) return;
    this.started = true;
    writeHead(200, headers);
    sseData(this.res, openAIChunk(this.id, this.model, this.created, { role: 'assistant', content: '' }, null));
  }
  content(text) { if (!text) return; sseData(this.res, openAIChunk(this.id, this.model, this.created, { content: text }, null)); }
  reasoning(text) { if (!text) return; sseData(this.res, openAIChunk(this.id, this.model, this.created, { reasoning_content: text }, null)); }
  toolCalls(wireCalls) {
    if (!wireCalls || !wireCalls.length) return;
    sseData(this.res, openAIChunk(this.id, this.model, this.created, {
      tool_calls: wireCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } })),
    }, null));
  }
  done(finish = 'stop', completionTokens = 0) {
    sseData(this.res, openAIChunk(this.id, this.model, this.created, {}, finish));
    if (this.includeUsage) sseData(this.res, { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: { prompt_tokens: 0, completion_tokens: completionTokens, total_tokens: completionTokens } });
    this.res.write('data: [DONE]\n\n');
  }
}

class AnthropicStreamWriter {
  constructor(res, { id, model }) {
    this.res = res; this.id = id; this.model = model; this.started = false; this.nextIndex = 0;
    this.textIndex = -1; this.thinkIndex = -1; this.textOpen = false; this.thinkOpen = false;
  }
  open(headers, writeHead) {
    if (this.started) return;
    this.started = true;
    writeHead(200, headers);
    sseEvent(this.res, 'message_start', { type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  _openText() {
    if (this.textOpen) return;
    this.textIndex = this.nextIndex++; this.textOpen = true;
    sseEvent(this.res, 'content_block_start', { type: 'content_block_start', index: this.textIndex, content_block: { type: 'text', text: '' } });
  }
  _closeText() { if (!this.textOpen) return; sseEvent(this.res, 'content_block_stop', { type: 'content_block_stop', index: this.textIndex }); this.textOpen = false; }
  _openThink() {
    if (this.thinkOpen) return;
    this.thinkIndex = this.nextIndex++; this.thinkOpen = true;
    sseEvent(this.res, 'content_block_start', { type: 'content_block_start', index: this.thinkIndex, content_block: { type: 'thinking', thinking: '' } });
  }
  _closeThink() { if (!this.thinkOpen) return; sseEvent(this.res, 'content_block_stop', { type: 'content_block_stop', index: this.thinkIndex }); this.thinkOpen = false; }
  content(text) { if (!text) return; this._closeThink(); this._openText(); sseEvent(this.res, 'content_block_delta', { type: 'content_block_delta', index: this.textIndex, delta: { type: 'text_delta', text } }); }
  reasoning(text) { if (!text) return; this._openThink(); sseEvent(this.res, 'content_block_delta', { type: 'content_block_delta', index: this.thinkIndex, delta: { type: 'thinking_delta', thinking: text } }); }
  toolCalls(wireCalls) {
    if (!wireCalls || !wireCalls.length) return;
    this._closeThink(); this._closeText();
    for (const c of wireCalls) {
      const idx = this.nextIndex++;
      const input = compat.safeJsonParse(c.function.arguments) || {};
      sseEvent(this.res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: c.id, name: c.function.name, input: {} } });
      sseEvent(this.res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      sseEvent(this.res, 'content_block_stop', { type: 'content_block_stop', index: idx });
    }
  }
  done(finish = 'end_turn', outputTokens = 0) {
    this._closeText(); this._closeThink();
    sseEvent(this.res, 'message_delta', { type: 'message_delta', delta: { stop_reason: finish, stop_sequence: null }, usage: { output_tokens: outputTokens } });
    sseEvent(this.res, 'message_stop', { type: 'message_stop' });
  }
}

class VertexStreamWriter {
  constructor(res, { model }) { this.res = res; this.model = model; this.started = false; }
  open(headers, writeHead) { if (this.started) return; this.started = true; writeHead(200, headers); }
  content(text) { if (!text) return; sseData(this.res, { candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] }); }
  reasoning(text) { if (!text) return; sseData(this.res, { candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] }); }
  toolCalls(wireCalls) {
    if (!wireCalls || !wireCalls.length) return;
    const parts = wireCalls.map((c) => ({ functionCall: { name: c.function.name, args: compat.safeJsonParse(c.function.arguments) || {} } }));
    sseData(this.res, { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }] });
  }
  done(_finish = 'STOP', outputTokens = 0) {
    sseData(this.res, { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 0, candidatesTokenCount: outputTokens, totalTokenCount: outputTokens } });
  }
}

function createStreamWriter(format, res, opts) {
  if (format === 'anthropic') return new AnthropicStreamWriter(res, opts);
  if (format === 'vertex') return new VertexStreamWriter(res, opts);
  return new OpenAIStreamWriter(res, opts);
}

module.exports = {
  normalizeRequest,
  formatNonStream,
  toOpenAIResponse,
  toAnthropicResponse,
  toVertexResponse,
  createStreamWriter,
  openAIChunk,
  sseData,
  sseEvent,
};
