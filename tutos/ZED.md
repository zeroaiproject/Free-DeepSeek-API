# Zed + Free DeepSeek API

[Zed](https://zed.dev) provides a configurable AI assistant. Depending on version, it supports **OpenAI-compatible** providers.

## Configuration

Zed's AI/provider configuration changes across releases. Configure an **OpenAI-compatible** provider and adapt field names to your installed Zed version (Settings UI or `~/.config/zed/settings.json`).

### Example (indicative structure)

```json
{
  "language_models": {
    "openai": {
      "api_url": "http://127.0.0.1:8787/v1",
      "available_models": [
        {
          "name": "deepseek-chat",
          "display_name": "DeepSeek Chat (Free, 1M)",
          "max_tokens": 8192
        },
        {
          "name": "deepseek-reasoner",
          "display_name": "DeepSeek Reasoner (Free, 1M)",
          "max_tokens": 32768
        }
      ],
      "version": "1"
    }
  }
}
```

> The exact schema (keys for base URL, API key, available models, and provider selection) may differ by version. Keep the essentials: **OpenAI-compatible provider**, **base URL** `http://127.0.0.1:8787/v1`, **models** `deepseek-chat` / `deepseek-reasoner`, and **API key** `public` (or your `API_KEY`). Check Zed's current docs/settings for your version.

## Usage

- Select the DeepSeek model in Zed's assistant/inline panel.
- Enable streaming if available. Tool calls (when used) are emulated by the proxy.

## Verification

```bash
curl http://127.0.0.1:8787/health
curl -H "Authorization: Bearer public" \
     -H "Content-Type: application/json" \
     -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hi"}]}' \
     http://127.0.0.1:8787/v1/chat/completions
```

## Notes

- If Zed does not yet allow BYOK OpenAI-compatible in your edition, use the proxy via a CLI agent (OpenCode, Aider) in parallel.
- Advertised context: 1M tokens; adjust editor-side limits if needed.
