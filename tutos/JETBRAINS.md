# JetBrains IDEs + Free DeepSeek API

Works with IntelliJ IDEA, PyCharm, WebStorm, GoLand, etc., via **AI Assistant** features (if BYOK/OpenAI-compatible is available) or via compatible plugins/clients.

## Option 1 — JetBrains AI Assistant (if custom endpoint is supported)

1. Open **Settings/Preferences → Tools → AI Assistant** (or equivalent for your version/product).
2. Configure a custom OpenAI-compatible provider (if available):
   - **Base URL**: `http://127.0.0.1:8787/v1`
   - **API Key**: `public` (or `API_KEY`)
   - **Model**: `deepseek-chat` / `deepseek-reasoner`
   - **Context length**: `1000000` (if configurable)

> BYOK OpenAI-compatible availability depends on JetBrains version and license.

## Option 2 — Continue plugin for JetBrains

1. Install the **Continue** plugin from the JetBrains Marketplace.
2. Configure `~/.continue/config.json` (or `config.yaml`) as in [CONTINUE.md](CONTINUE.md).
3. Select the DeepSeek model in Continue.

## Option 3 — Local proxy via integrated terminal

Use the IDE integrated terminal with a compatible CLI agent:

- **Aider**: [AIDER.md](AIDER.md)
- **OpenCode**: [OPENCODE.md](OPENCODE.md)

## Verification

```bash
curl http://127.0.0.1:8787/v1/models
```

## Notes

- Completions, chat, and "agent" actions may not all share the same backend in the IDE; only traffic routed to the configured endpoint will use this proxy.
- In corporate environments, ensure `http://127.0.0.1:8787` is reachable from the IDE (system proxy/firewall).
