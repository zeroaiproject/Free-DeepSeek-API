# Continue + Free DeepSeek API

[Continue](https://continue.dev) is a coding assistant for VS Code and JetBrains, compatible with **OpenAI** backends.

## Configuration (`config.json` / `config.yaml`)

Continue's config schema has evolved (JSON and newer YAML/forms). Add an OpenAI-compatible model pointing to the proxy and adapt field names to your installed version.

### Example (common JSON format)

In `~/.continue/config.json`:

```json
{
  "models": [
    {
      "title": "DeepSeek Chat (Free Proxy)",
      "provider": "openai",
      "model": "deepseek-chat",
      "apiBase": "http://127.0.0.1:8787/v1",
      "apiKey": "public",
      "contextLength": 1000000
    },
    {
      "title": "DeepSeek Reasoner (Free Proxy)",
      "provider": "openai",
      "model": "deepseek-reasoner",
      "apiBase": "http://127.0.0.1:8787/v1",
      "apiKey": "public",
      "contextLength": 1000000
    }
  ]
}
```

### Example (YAML / newer-style fields)

In `~/.continue/config.yaml` (or your version's equivalent):

```yaml
models:
  - name: DeepSeek Chat (Free Proxy)
    provider: openai
    model: deepseek-chat
    apiBase: http://127.0.0.1:8787/v1
    apiKey: public
    roles: [chat, edit, apply]
  - name: DeepSeek Reasoner (Free Proxy)
    provider: openai
    model: deepseek-reasoner
    apiBase: http://127.0.0.1:8787/v1
    apiKey: public
    roles: [chat]
```

> Keep the essentials correct for your schema: **provider `openai` (OpenAI-compatible)**, **`apiBase`/base URL** `http://127.0.0.1:8787/v1`, **`apiKey`** `public` (or your `API_KEY`), and **model** `deepseek-chat`/`deepseek-reasoner`. Refer to Continue's docs for the exact keys supported by your version.

## Usage

- Select the "DeepSeek … (Free Proxy)" model in Continue.
- Chat, inline edits, and autocomplete (if enabled for the model) use `POST /v1/chat/completions`.
- Tool calls (when used by your flow) are emulated by the proxy.

## Troubleshooting

- Verify `curl http://127.0.0.1:8787/v1/models`.
- If the proxy has `API_KEY` enabled, use the same value in `apiKey`.
- Variable latency = normal pacing/anti-throttle behavior; check `/health` and `/metrics`.
