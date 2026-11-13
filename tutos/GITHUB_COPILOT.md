# GitHub Copilot + Free DeepSeek API

Integration of **GitHub Copilot** with a custom OpenAI-compatible endpoint depends on your product/plan (Copilot Individual/Business/Enterprise), organization policies, and available **BYOK / custom model** features.

## Compatibility status

- **Copilot Chat / Extensions (BYOK or OpenAI-compatible)**: if your environment allows configuring `baseURL` + key + OpenAI-compatible model, point it to this proxy.
- **Classic inline Copilot completions**: typically backed by GitHub-managed models — not replaceable by this proxy without explicit BYOK support.

> Check the Copilot documentation for your offering for current custom-endpoint support.

## Settings (if BYOK/OpenAI-compatible is available)

| Field | Value |
|---|---|
| Provider | OpenAI / OpenAI-compatible |
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | `public` (or proxy `API_KEY`) |
| Model | `deepseek-chat` or `deepseek-reasoner` |
| Context | up to 1,000,000 (if configurable) |

## Practical alternative

If Copilot cannot target this proxy directly, use it through a compatible tool in your editor:

- **Continue** (VS Code / JetBrains): [CONTINUE.md](CONTINUE.md)
- **Cline** (VS Code): [CLINE.md](CLINE.md)
- **OpenCode** (CLI): [OPENCODE.md](OPENCODE.md)

These provide an agentic experience with an explicit OpenAI-compatible backend.

## Proxy test

```bash
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer public" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello"}]}'
```
