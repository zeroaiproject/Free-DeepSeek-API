# Aider + Free DeepSeek API

[Aider](https://aider.chat) est un outil de pair-programming dans le terminal. Il fonctionne très bien avec des endpoints **OpenAI-compatible**.

## Configuration

```bash
export OPENAI_API_BASE=http://127.0.0.1:8787/v1
export OPENAI_API_KEY=public   # ou la valeur de API_KEY
```

Lancez Aider en ciblant le modèle du proxy :

```bash
# modèle chat
aider --model openai/deepseek-chat

# modèle raisonnement
aider --model openai/deepseek-reasoner
```

> Selon la version d’Aider, le préfixe peut être `openai/` avec `OPENAI_API_BASE`, ou `--openai-api-base` en option. Vérifiez `aider --help`.

## Exemples

```bash
# dans un dépôt git
OPENAI_API_BASE=http://127.0.0.1:8787/v1 OPENAI_API_KEY=public \
  aider --model openai/deepseek-chat README.md server.js

# message one-shot
aider --model openai/deepseek-chat --message "Explique le flux PoW et streaming."
```

## Conseils

- **Contexte** : fenêtre annoncée 1M tokens, mais pour de meilleures perfs/latence n’ajoutez que les fichiers pertinents (`/add`, globs ciblés).
- **Streaming** : activé côté proxy ; Aider en bénéficie selon ses options.
- **Outils/fonctions** : l’émulation du proxy est orientée `tools` OpenAI ; Aider pilote surtout via prompts/édition, ce qui reste compatible.
- **Stabilité** : en cas de throttle amont, les réponses peuvent être plus lentes (pacing/cooldown) — c’est attendu.

## Vérification

```bash
curl -s http://127.0.0.1:8787/health >/dev/null && echo "proxy ok"
aider --model openai/deepseek-chat --message "Réponds OK"
```
