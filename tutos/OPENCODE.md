# OpenCode + Free DeepSeek API

[OpenCode](https://opencode.ai) is an open-source coding agent CLI. This proxy connects as an **OpenAI-compatible** provider.

## Prerequisites

- Proxy running with a valid token (`curl http://127.0.0.1:8787/health`)
- OpenCode installed (`opencode` in PATH)

## Configuration

OpenCode config locations and schema evolve by version (see [OpenCode config docs](https://opencode.ai/docs/config/)). Use `$schema: "https://opencode.ai/config.json"` for editor validation and adapt keys to your installed version.

Add a provider in `~/.config/opencode/opencode.jsonc` (global) or `opencode.jsonc` (project):

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

**Notes**
- `apiKey` must be non-empty for most OpenAI-compatible clients; the proxy ignores it unless `API_KEY` is set server-side (then use the same value).
- If your version expects different provider keys/shape, keep the essentials: **OpenAI-compatible provider**, **`baseURL`** `http://127.0.0.1:8787/v1`, **non-empty API key**, and model IDs `deepseek-chat` / `deepseek-reasoner`.
- You can set a default model with `"model": "freedeepseek/deepseek-chat"` if supported by your config. Check `opencode --help` and the schema for your version.

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
