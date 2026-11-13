# Cursor + Free DeepSeek API

[Cursor](https://cursor.com) can consume **OpenAI-compatible** endpoints (depending on the "OpenAI API Key" / base URL override options available in your version).

## Configuration

1. Start the proxy (`http://127.0.0.1:8787`) with a valid token.
2. In Cursor: **Settings → Models / OpenAI** (labels vary by version):
   - **OpenAI API Key**: `public` (or your `API_KEY` value if set)
   - **Override OpenAI Base URL**: `http://127.0.0.1:8787/v1`
3. Add/select a custom model:
   - `deepseek-chat`
   - `deepseek-reasoner`

## Recommended settings

- **Context window**: up to `1000000` (1M) if editable
- **Max output**: `8192` (chat) / `32768` (reasoner) as a starting point
- **Streaming**: enabled
- **Tools / function calling**: enabled if available (emulated by the proxy)

## Verification

In Cursor chat, ask for a short response, then try a simple tool-assisted action (if supported) to confirm requests go through the proxy.

You can also verify on the proxy side:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

## Notes

- Some Cursor flows (indexing, embeddings, proprietary models) do not use this endpoint; only OpenAI-compatible chat calls are affected.
- If Cursor requires a specific unsupported format, compare with an equivalent `curl` request to `/v1/chat/completions`.
- `deepseek-reasoner` may produce reasoning (`reasoning_content`) — the UI may display or ignore it depending on version.
