# Aider + Free DeepSeek API

[Aider](https://aider.chat) is a terminal pair-programming tool. It works well with **OpenAI-compatible** endpoints.

> Verified against Aider docs: use `OPENAI_API_BASE` + `OPENAI_API_KEY` and prefix the model with `openai/` (e.g. `--model openai/deepseek-chat`). CLI flags/config names can vary slightly by version.

## Configuration

```bash
# macOS/Linux
export OPENAI_API_BASE=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=public   # or your API_KEY value
```

```powershell
# Windows (PowerShell, new shells after setx)
setx OPENAI_API_BASE http://127.0.0.1:8787/v1
setx OPENAI_API_KEY public
```

Run Aider targeting the proxy model:

```bash
# chat model
aider --model openai/deepseek-chat

# reasoning model
aider --model openai/deepseek-reasoner
```

> If your version prefers flags, try `--openai-api-base http://127.0.0.1:8787/v1 --openai-api-key public`. Check `aider --help` for your installed version.

## Examples

```bash
# inside a git repo
OPENAI_API_BASE=http://127.0.0.1:8787/v1 OPENAI_API_KEY=public \
  aider --model openai/deepseek-chat README.md server.js

# one-shot message
aider --model openai/deepseek-chat --message "Explain the PoW and streaming flow."
```

## Tips

- **Context**: window advertised as 1M tokens, but for better performance/latency add only relevant files (`/add`, targeted globs).
- **Streaming**: supported by the proxy; Aider benefits depending on its options.
- **Tools/functions**: the proxy's emulation targets OpenAI `tools`; Aider mostly drives via prompts/edits, which remains compatible.
- **Stability**: under upstream throttling responses may be slower (pacing/cooldown) — expected.

## Verification

```bash
curl -s http://127.0.0.1:8787/health >/dev/null && echo "proxy ok"
aider --model openai/deepseek-chat --message "Reply OK"
```
