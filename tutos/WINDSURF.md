# Windsurf + Free DeepSeek API

[Windsurf](https://codeium.com/windsurf) (Codeium) is an agentic IDE. Depending on version/plan, it may accept **OpenAI-compatible** providers.

## Configuration

Windsurf's BYOK/provider options vary by version and plan.

1. Proxy running: `http://127.0.0.1:8787/v1` (valid token).
2. Open Windsurf model/provider settings and configure an OpenAI-compatible provider (if available):
   - **Provider type**: OpenAI / OpenAI-compatible (or "Bring your own key")
   - **Base URL**: `http://127.0.0.1:8787/v1`
   - **API Key**: `public` (or your `API_KEY`)
   - **Model**: `deepseek-chat` or `deepseek-reasoner`
3. (If requested) set context window: **1,000,000**.

> Field names and availability differ by release. Keep the essentials the same: OpenAI-compatible endpoint, base URL, non-empty key, and model ID. Check Windsurf's current docs/settings for your version.

## Recommendations

- Prefer `deepseek-chat` for fast edit/iterate loops; `deepseek-reasoner` for reasoning-heavy tasks.
- Enable streaming and tools if options exist (tool calling is emulated by the proxy).
- Avoid sending unnecessarily large context continuously: latency and upstream pacing increase.

## Verification

- `curl http://127.0.0.1:8787/health` should be `ok` with at least one token available.
- Direct test:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer public" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Reply: OK"}]}'
```

## Notes

- Proprietary Windsurf features (internal cascade, some modes) may not use this backend. Check your version's docs for the exact BYOK/OpenAI-compatible settings path.
- If you get proxy auth errors, align the client key with server `API_KEY` (or leave `API_KEY` unset on the proxy).
