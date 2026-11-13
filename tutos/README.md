# Tutorials — Free DeepSeek API

Setup and integration guides for **Free DeepSeek API** with popular coding tools and agentic assistants.

> **Base URL (OpenAI-compatible):** `http://127.0.0.1:8787/v1`  
> **Models:** `deepseek-chat` (general), `deepseek-reasoner` (thinking → `reasoning_content`)  
> **Context:** up to **1M tokens** advertised (subject to what the web endpoint accepts) · tool/function calling emulated  
> **API key:** none required by the proxy (unless you set `API_KEY`) — most clients require a non-empty value: use `public` or `not-needed`.

## Index

| Guide | Tool / agent | Best for |
|---|---|---|
| [SETUP.md](SETUP.md) | Proxy installation | Getting started, tokens, Docker, verification |
| [OPENCODE.md](OPENCODE.md) | [OpenCode](https://opencode.ai) | Open-source CLI agent, tools & reasoning |
| [CLAUDECODE.md](CLAUDECODE.md) | Claude Code | Anthropic CLI via OpenAI-compatible endpoint |
| [CURSOR.md](CURSOR.md) | Cursor | AI IDE (OpenAI-compatible / base URL override) |
| [WINDSURF.md](WINDSURF.md) | Windsurf (Codeium) | Agentic IDE |
| [CLINE.md](CLINE.md) | Cline (VS Code) | Autonomous coding agent in VS Code |
| [CONTINUE.md](CONTINUE.md) | Continue | Assistant for VS Code / JetBrains |
| [AIDER.md](AIDER.md) | Aider | Terminal pair programming |
| [GITHUB_COPILOT.md](GITHUB_COPILOT.md) | GitHub Copilot Chat | When BYOK/OpenAI-compatible is supported |
| [CODEX_CLI.md](CODEX_CLI.md) | Codex CLI / OpenAI-compatible CLIs | OpenAI-style CLI clients |
| [ZED.md](ZED.md) | Zed | Editor with AI assistant |
| [JETBRAINS.md](JETBRAINS.md) | JetBrains AI / plugins | IntelliJ, PyCharm, etc. |
| [OPENAI_SDK.md](OPENAI_SDK.md) | OpenAI SDK & scripts | Python, Node.js, curl |

## Common prerequisites

1. Proxy running: `./run.sh` or `docker compose up -d`
2. At least one valid token in `tokens.txt` (see [SETUP.md](SETUP.md))
3. Health OK: `curl http://127.0.0.1:8787/health`

> Notes: tool calling is **emulated** (JSON/DSML) — highly compatible, but not identical to official native function calling. Respect upstream rate limits and DeepSeek account policies.
