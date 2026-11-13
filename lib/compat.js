'use strict';

const crypto = require('crypto');

function rid(prefix = 'msg') {
  return prefix + '_' + crypto.randomBytes(12).toString('hex');
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function textFromAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (p.type === 'tool_result') {
        const c = p.content;
        if (typeof c === 'string') return `Tool result (${p.tool_use_id || p.name || 'tool'}): ${c}`;
        if (Array.isArray(c)) return `Tool result (${p.tool_use_id || p.name || 'tool'}): ${textFromAnthropicContent(c)}`;
        return `Tool result (${p.tool_use_id || p.name || 'tool'}): ${JSON.stringify(c ?? '')}`;
      }
      if (p.type === 'tool_use') return '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function anthropicToOpenAI(body) {
  const messages = [];
  const systemParts = [];
  if (typeof body.system === 'string') systemParts.push(body.system);
  else if (Array.isArray(body.system)) systemParts.push(textFromAnthropicContent(body.system));
  if (systemParts.filter(Boolean).length) {
    messages.push({ role: 'system', content: systemParts.filter(Boolean).join('\n\n') });
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (typeof m.content === 'string') {
      messages.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) {
      messages.push({ role, content: textFromAnthropicContent(m.content) });
      continue;
    }

    if (role === 'assistant') {
      const text = m.content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
      const toolUses = m.content.filter((p) => p && p.type === 'tool_use');
      const msg = { role: 'assistant', content: text || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id || rid('toolu'),
          type: 'function',
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input && typeof tu.input === 'object' ? tu.input : {}),
          },
        }));
      }
      messages.push(msg);
      continue;
    }

    // user: may contain tool_result blocks; split into text user msg + tool msgs
    const userText = m.content.filter((p) => p && p.type === 'text').map((p) => p.text || '').join('\n');
    const toolResults = m.content.filter((p) => p && p.type === 'tool_result');
    if (userText) messages.push({ role: 'user', content: userText });
    for (const tr of toolResults) {
      let content = tr.content;
      if (typeof content !== 'string') content = textFromAnthropicContent([{ type: 'text', text: Array.isArray(content) ? textFromAnthropicContent(content) : JSON.stringify(content ?? '') }]) || JSON.stringify(content ?? '');
      if (Array.isArray(tr.content)) content = textFromAnthropicContent(tr.content) || JSON.stringify(tr.content);
      messages.push({ role: 'tool', tool_call_id: tr.tool_use_id || '', name: tr.name || '', content: typeof content === 'string' ? content : JSON.stringify(content ?? '') });
    }
    if (!userText && !toolResults.length) {
      messages.push({ role: 'user', content: textFromAnthropicContent(m.content) });
    }
  }

  const tools = Array.isArray(body.tools)
    ? body.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.input_schema || { type: 'object', properties: {} },
        },
      }))
    : undefined;

  let tool_choice;
  const tc = body.tool_choice;
  if (tc) {
    if (tc.type === 'auto') tool_choice = 'auto';
    else if (tc.type === 'any') tool_choice = 'required';
    else if (tc.type === 'none') tool_choice = 'none';
    else if (tc.type === 'tool' && tc.name) tool_choice = { type: 'function', function: { name: tc.name } };
  }

  let model = body.model || 'deepseek-chat';
  // pass through known models; map common anthropic aliases to chat/reasoner heuristically
  if (/reason|think/i.test(model)) model = 'deepseek-reasoner';
  else if (!/^deepseek-/.test(model)) model = 'deepseek-chat';

  return {
    model,
    messages,
    stream: !!body.stream,
    ...(tools && tools.length ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
  };
}

function openAIToAnthropicResponse(openai, reqModel) {
  const choice = (openai.choices && openai.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.reasoning_content) content.push({ type: 'thinking', thinking: String(msg.reasoning_content) });
  if (msg.content) content.push({ type: 'text', text: String(msg.content) });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const input = safeJsonParse(tc.function && tc.function.arguments) || {};
      content.push({ type: 'tool_use', id: tc.id || rid('toolu'), name: tc.function && tc.function.name, input });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  const stop = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
  return {
    id: openai.id || rid('msg'),
    type: 'message',
    role: 'assistant',
    model: reqModel || openai.model || 'deepseek-chat',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: (openai.usage && openai.usage.prompt_tokens) || 0,
      output_tokens: (openai.usage && openai.usage.completion_tokens) || 0,
    },
  };
}

function anthropicError(message, type = 'invalid_request_error') {
  return { type: 'error', error: { type, message } };
}

// Vertex/Gemini helpers
function vertexToOpenAI(body, modelFromPath) {
  const messages = [];
  if (body.systemInstruction && Array.isArray(body.systemInstruction.parts)) {
    const text = body.systemInstruction.parts.map((p) => p.text || '').filter(Boolean).join('\n');
    if (text) messages.push({ role: 'system', content: text });
  }
  for (const c of Array.isArray(body.contents) ? body.contents : []) {
    if (!c || typeof c !== 'object') continue;
    const role = c.role === 'model' ? 'assistant' : 'user';
    const parts = Array.isArray(c.parts) ? c.parts : [];
    const texts = [];
    const toolCalls = [];
    const toolMsgs = [];
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.text === 'string') texts.push(p.text);
      else if (p.functionCall) {
        toolCalls.push({
          id: rid('call'),
          type: 'function',
          function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
        });
      } else if (p.functionResponse) {
        toolMsgs.push({
          role: 'tool',
          name: p.functionResponse.name || '',
          content: JSON.stringify(p.functionResponse.response ?? p.functionResponse),
        });
      }
    }
    if (toolMsgs.length) {
      for (const tm of toolMsgs) messages.push(tm);
      if (texts.length) messages.push({ role: 'user', content: texts.join('\n') });
      continue;
    }
    const msg = { role, content: texts.join('\n') || '' };
    if (toolCalls.length) { msg.tool_calls = toolCalls; if (!msg.content) msg.content = null; }
    messages.push(msg);
  }

  let tools;
  const decls = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (t && Array.isArray(t.functionDeclarations)) decls.push(...t.functionDeclarations);
  }
  if (decls.length) {
    tools = decls.map((fd) => ({
      type: 'function',
      function: { name: fd.name, description: fd.description || '', parameters: fd.parameters || { type: 'object', properties: {} } },
    }));
  }

  let model = modelFromPath || body.model || 'deepseek-chat';
  if (/reason|think/i.test(model)) model = 'deepseek-reasoner';
  else model = 'deepseek-chat';

  return { model, messages, stream: false, ...(tools ? { tools } : {}) };
}

function openAIToVertexResponse(openai, modelName) {
  const choice = (openai.choices && openai.choices[0]) || {};
  const msg = choice.message || {};
  const parts = [];
  if (msg.reasoning_content) parts.push({ text: String(msg.reasoning_content) });
  if (msg.content) parts.push({ text: String(msg.content) });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      parts.push({ functionCall: { name: tc.function && tc.function.name, args: safeJsonParse(tc.function && tc.function.arguments) || {} } });
    }
  }
  if (!parts.length) parts.push({ text: '' });
  const finish = choice.finish_reason === 'tool_calls' ? 'STOP' : 'STOP';
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: finish, index: 0 }],
    usageMetadata: {
      promptTokenCount: (openai.usage && openai.usage.prompt_tokens) || 0,
      candidatesTokenCount: (openai.usage && openai.usage.completion_tokens) || 0,
      totalTokenCount: (openai.usage && openai.usage.total_tokens) || 0,
    },
    modelVersion: modelName || openai.model || 'deepseek-chat',
  };
}

module.exports = {
  anthropicToOpenAI,
  openAIToAnthropicResponse,
  anthropicError,
  vertexToOpenAI,
  openAIToVertexResponse,
  safeJsonParse,
};
