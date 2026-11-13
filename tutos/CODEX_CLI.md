# Codex CLI & CLIs OpenAI-compatibles + Free DeepSeek API

Ce guide couvre les clients en ligne de commande qui parlent le protocole **OpenAI-compatible** (ex. CLIs type Codex/OpenAI, scripts maison, wrappers).

## Principe

Configurez le client avec :

- **Base URL** : `http://127.0.0.1:8787/v1`
- **API Key** : `public` (ou la valeur de `API_KEY`)
- **Model** : `deepseek-chat` ou `deepseek-reasoner`

## Variables d’environnement (convention courante)

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
export OPENAI_API_KEY="public"
export OPENAI_MODEL="deepseek-chat"
```

Certaines CLIs utilisent `OPENAI_API_BASE` au lieu de `OPENAI_BASE_URL` — définissez les deux si besoin.

## Exemples

### curl (sanity check)

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role":"user","content":"Écris une fonction JS qui additionne deux nombres."}]
  }'
```

### OpenAI officiel CLI / wrappers (si installés)

```bash
# exemple générique — adaptez à l’outil installé
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 OPENAI_API_KEY=public \
  <votre-cli-openai-compatible> --model deepseek-chat "Refactor this function"
```

### Tool calling

Le proxy émulé supporte `tools`, `tool_choice`, `parallel_tool_calls`. Les clients doivent envoyer/consommer le format OpenAI `tool_calls` standard ; la conversion JSON/DSML est interne au proxy.

## Bonnes pratiques

- Contexte annoncé : **1M tokens** — gardez les prompts pertinents pour la latence.
- En cas de throttling amont, attendez/reduisez la cadence (le proxy applique déjà jitter/gap/cooldown).
- Pour un usage local multi-outils, définissez `API_KEY` côté proxy et réutilisez la même clé dans vos clients.
