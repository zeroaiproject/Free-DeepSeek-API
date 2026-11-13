# Claude Code + Free DeepSeek API

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) is Anthropic's coding CLI. This guide covers usage **via OpenAI-compatible endpoints** (clients/runners that allow an OpenAI-compatible backend). If your setup only supports the native Anthropic API (`/v1/messages`), an additional protocol adapter/proxy is required.

## Prerequisites

- Proxy running: `http://127.0.0.1:8787/v1`
- Valid DeepSeek token in the proxy (`/health` OK)

## Configuration (OpenAI-compatible endpoint)

Claude Code and third-party integrations evolve. Use this proxy where your setup supports an **OpenAI-compatible** backend.

```bash
export OPENAI_API_KEY="public"                 # or your API_KEY value if enabled
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
```

Then select a model exposed by the proxy (if supported): `deepseek-chat` or `deepseek-reasoner`.

Generic example (OpenAI-compatible client/runner):

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 \
OPENAI_API_KEY=public \
claude --model deepseek-chat
```

> Adapt flags, env vars, and model selection to your installed version. Exact IDs are listed by `GET /v1/models`.

## Capabilities

- **Streaming**: supported.
- **Tool use / actions**: supported via the proxy's tool emulation (injected schemas, JSON/DSML parsing). Behavior may differ from native tool use.
- **Reasoning**: `deepseek-reasoner` returns `reasoning_content` (OpenAI mode) and mapped thinking content on compatible formats.
- **Context**: advertised window up to **1M tokens** (effective upstream limit applies).
- **Anthropic-compatible endpoint**: this proxy also serves `POST /v1/messages`, which may work with tools/adapters targeting Anthropic's Messages API format.

## Limitations

- Backend is DeepSeek web via proxy (not official Claude/Anthropic models).
- Aggregated usage (no prompt/completion split from upstream).
- Upstream pacing/rate limits and DeepSeek account policies apply.

## Quick verification

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer public" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```
