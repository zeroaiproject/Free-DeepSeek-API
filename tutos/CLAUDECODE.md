# Claude Code + Free DeepSeek API

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) is Anthropic's coding CLI. This guide covers usage **via OpenAI-compatible endpoints** (clients/runners that allow an OpenAI-compatible backend). If your setup only supports the native Anthropic API (`/v1/messages`), an additional protocol adapter/proxy is required.

## Prerequisites

- Proxy running: `http://127.0.0.1:8787/v1`
- Valid DeepSeek token in the proxy (`/health` OK)

## Configuration (OpenAI-compatible endpoint)

Claude Code and its ecosystem evolve; depending on your version, point the OpenAI-compatible backend to the proxy:

```bash
export OPENAI_API_KEY="public"                 # or your API_KEY value if enabled
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
```

Then select a model exposed by the proxy (if supported by your tool):

- `deepseek-chat`
- `deepseek-reasoner`

Generic example (OpenAI-compatible client/runner):

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 \
OPENAI_API_KEY=public \
claude --model deepseek-chat
```

> Adapt the flag/model selection to your version (`--model`, config file, or profile). Exact model IDs are returned by `GET /v1/models`.

## Capabilities

- **Streaming**: supported.
- **Tool use / actions**: supported via the proxy's tool emulation (injected schemas, JSON/DSML parsing). Behavior may differ from native Anthropic tool use.
- **Reasoning**: `deepseek-reasoner` returns `reasoning_content`.
- **Context**: advertised window up to **1M tokens** (effective upstream limit applies).

## Limitations

- No native Anthropic protocol (`/v1/messages`) in this proxy — OpenAI-compatible only (`/v1/chat/completions`).
- Aggregated usage (no prompt/completion split from upstream).
- Upstream pacing/rate limits and DeepSeek account policies apply.

## Quick verification

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer public" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```
