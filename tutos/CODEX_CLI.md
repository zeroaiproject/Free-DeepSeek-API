# Codex CLI & OpenAI-compatible CLIs + Free DeepSeek API

This guide covers command-line clients that speak the **OpenAI-compatible** protocol (e.g. Codex/OpenAI-style CLIs, custom scripts, wrappers).

## Principle

Configure the client with:

- **Base URL**: `http://127.0.0.1:8787/v1`
- **API Key**: `public` (or your `API_KEY`)
- **Model**: `deepseek-chat` or `deepseek-reasoner`

## Environment variables (common convention)

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="public"
export OPENAI_MODEL="deepseek-chat"
```

Some CLIs use `OPENAI_API_BASE` instead of `OPENAI_BASE_URL` — set both if needed.

## Examples

### curl (sanity check)

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role":"user","content":"Write a JS function that adds two numbers."}]
  }'
```

### OpenAI CLI / wrappers (if installed)

```bash
# generic example — adapt to your installed tool
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 OPENAI_API_KEY=public \
  <your-openai-compatible-cli> --model deepseek-chat "Refactor this function"
```

### Tool calling

The proxy emulates and supports `tools`, `tool_choice`, `parallel_tool_calls`. Clients should send/consume standard OpenAI `tool_calls`; JSON/DSML conversion is handled internally.

## Best practices

- Advertised context: **1M tokens** — keep prompts relevant for latency.
- Under upstream throttling, wait/reduce rate (the proxy already applies jitter/gap/cooldown).
- For local multi-tool usage, set `API_KEY` on the proxy and reuse the same key in clients.
