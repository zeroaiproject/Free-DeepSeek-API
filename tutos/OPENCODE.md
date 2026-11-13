# OpenCode + Free DeepSeek API

[OpenCode](https://opencode.ai) is an open-source coding agent CLI. This proxy connects as an **OpenAI-compatible** provider.

## Prerequisites

- Proxy running with a valid token (`curl http://127.0.0.1:8787/health`)
- OpenCode installed (`opencode` in PATH)

## Configuration

Add the provider in `~/.config/opencode/opencode.jsonc` (create if needed):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "freedeepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Free DeepSeek API",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "public"
      },
      "models": {
        "deepseek-chat": {
          "name": "DeepSeek Chat (Free, 1M ctx)",
          "limit": { "context": 1000000, "output": 8192 },
          "cost": { "input": 0, "output": 0 },
          "tool_call": true,
          "reasoning": false
        },
        "deepseek-reasoner": {
          "name": "DeepSeek Reasoner (Free, 1M ctx)",
          "limit": { "context": 1000000, "output": 32768 },
          "cost": { "input": 0, "output": 0 },
          "tool_call": true,
          "reasoning": true
        }
      }
    }
  }
}
```

> `apiKey` must be non-empty for the OpenAI-compatible client; the proxy ignores it unless `API_KEY` is set server-side (then use the same value).
> If your OpenCode version expects a different schema key (e.g. `providers`/`settings`/`compatibility`), adapt to your version's config format — the essentials are `baseURL`, `apiKey`, and model IDs `deepseek-chat` / `deepseek-reasoner`.

## Usage

```bash
# verify models are visible
opencode models | grep freedeepseek

# run with a model
opencode --model freedeepseek/deepseek-chat

# non-interactive run with tools
opencode run --model freedeepseek/deepseek-chat "List project files and summarize the architecture."
```

## Tips

- **Tools**: supported via emulation (JSON/DSML) — keep `tool_call: true`. For complex tasks, keep prompts/tools concise.
- **Reasoner**: use `deepseek-reasoner` for tasks requiring deeper thinking; reasoning is exposed as `reasoning_content`.
- **1M context**: the advertised window is 1M tokens; avoid sending unnecessarily huge histories to reduce latency and upstream pressure.
- **Throughput**: the proxy paces requests (gap/jitter/cooldown). Slower responses can be intentional/anti-throttle behavior.

## Troubleshooting

- Model not listed: check JSONC syntax and restart `opencode`.
- Proxy 401 errors: align client `apiKey` with server `API_KEY` (or disable `API_KEY`).
- `503 account_suspended` / dead token: see `tutos/SETUP.md` and `/health`.
