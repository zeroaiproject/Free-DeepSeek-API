# Tutoriels — Free DeepSeek API

Guides d’installation et d’intégration de **Free DeepSeek API** avec les principaux outils et agents de codage.

> **Base URL (OpenAI-compatible)** : `http://127.0.0.1:8787/v1`  
> **Modèles** : `deepseek-chat` (général), `deepseek-reasoner` (raisonnement → `reasoning_content`)  
> **Contexte** : fenêtre jusqu’à **1M tokens** (selon ce que l’endpoint web accepte) · outils/fonctions émulés  
> **API key** : aucune côté proxy (sauf si vous définissez `API_KEY`) — la plupart des clients exigent une valeur non vide : utilisez `not-needed` ou `public`.

## Sommaire

| Guide | Outil / agent | Idéal pour |
|---|---|---|
| [SETUP.md](SETUP.md) | Installation du proxy | Démarrage, token, Docker, vérifications |
| [OPENCODE.md](OPENCODE.md) | [OpenCode](https://opencode.ai) | Agent CLI open-source, outils & reasoning |
| [CLAUDECODE.md](CLAUDECODE.md) | Claude Code | CLI Anthropic via endpoint compatible |
| [CURSOR.md](CURSOR.md) | Cursor | IDE IA (OpenAI-compatible / override) |
| [WINDSURF.md](WINDSURF.md) | Windsurf (Codeium) | IDE agentique |
| [CLINE.md](CLINE.md) | Cline (VS Code) | Agent autonome dans VS Code |
| [CONTINUE.md](CONTINUE.md) | Continue | Assistant VS Code / JetBrains |
| [AIDER.md](AIDER.md) | Aider | Pair-programming en terminal |
| [GITHUB_COPILOT.md](GITHUB_COPILOT.md) | GitHub Copilot Chat | Selon support BYOK/OpenAI-compatible |
| [CODEX_CLI.md](CODEX_CLI.md) | Codex CLI / OpenAI-compatible CLIs | Clients CLI type OpenAI |
| [ZED.md](ZED.md) | Zed | Éditeur avec assistant IA |
| [JETBRAINS.md](JETBRAINS.md) | JetBrains AI / proxies | IDE IntelliJ, PyCharm, etc. |
| [OPENAI_SDK.md](OPENAI_SDK.md) | SDK OpenAI & scripts | Python, Node.js, curl |

## Prérequis communs

1. Proxy lancé : `./run.sh` ou `docker compose up -d`
2. Au moins un token valide dans `tokens.txt` (voir [SETUP.md](SETUP.md))
3. Santé OK : `curl http://127.0.0.1:8787/health`

> Remarques : le tool-calling est **émulé** (JSON/DSML) — très compatible, mais pas identique au function-calling natif des API officielles. Respectez les limites de débit amont et les politiques de compte DeepSeek.
