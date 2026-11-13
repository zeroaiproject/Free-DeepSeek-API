# Continue + Free DeepSeek API

[Continue](https://continue.dev) is a coding assistant for VS Code and JetBrains, compatible with **OpenAI** backends.

## Configuration (`config.json` / `config.yaml`)

Depending on your Continue version, add a model pointing to the proxy.

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

### Example (recent YAML format)

In `~/.continue/config.yaml`:

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

> Adapt keys (`apiBase`/`apiKey`, `contextLength`, `roles`) to your Continue version's exact schema.

## Usage

- Select the "DeepSeek … (Free Proxy)" model in Continue.
- Chat, inline edits, and autocomplete (if enabled for the model) use `POST /v1/chat/completions`.
- Tool calls (when used by your flow) are emulated by the proxy.

## Troubleshooting

- Verify `curl http://127.0.0.1:8787/v1/models`.
- If the proxy has `API_KEY` enabled, use the same value in `apiKey`.
- Variable latency = normal pacing/anti-throttle behavior; check `/health` and `/metrics`.
