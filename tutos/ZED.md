# Zed + Free DeepSeek API

[Zed](https://zed.dev) provides a configurable AI assistant. Depending on version, it supports **OpenAI-compatible** providers.

## Configuration

Edit Zed settings (`~/.config/zed/settings.json` or via the settings UI) to add an OpenAI-compatible provider pointing to the proxy.

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

> The exact key structure (`language_models`, `openai`, `api_url`, `available_models`, API key handling) may vary by Zed version. Refer to your version's settings and keep these values: **base URL** `http://127.0.0.1:8787/v1`, models `deepseek-chat` / `deepseek-reasoner`, key `public` (or your `API_KEY`).

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
