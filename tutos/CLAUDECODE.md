# Claude Code + Free DeepSeek API

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) est la CLI de codage d’Anthropic. Ce guide décrit l’usage **via compatibilité OpenAI** (tiers/clients qui permettent un endpoint OpenAI-compatible). Si votre installation ne supporte que l’API Anthropic native, un adaptateur/proxy de protocole supplémentaire est requis.

## Prérequis

- Proxy lancé : `http://127.0.0.1:8787/v1`
- Token DeepSeek valide dans le proxy (`/health` OK)

## Configuration (endpoint OpenAI-compatible)

Claude Code/écosystème évolue ; selon votre version, pointez le backend OpenAI-compatible vers le proxy :

```bash
export OPENAI_API_KEY="public"                 # ou la valeur de API_KEY si activée
export OPENAI_BASE_URL="http://127.0.0.1:8787/v1"
```

Puis sélectionnez le modèle exposé par le proxy (si l’outil le permet) :

- `deepseek-chat`
- `deepseek-reasoner`

Exemple générique (client/runner compatible OpenAI) :

```bash
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 \
OPENAI_API_KEY=public \
claude --model deepseek-chat
```

> Adaptez le nom du flag/modèle à votre version (`--model`, config file, ou profil). Les identifiants exacts sont ceux retournés par `GET /v1/models`.

## Fonctionnalités

- **Streaming** : supporté.
- **Tool use / actions** : pris en charge via l’émulation d’outils du proxy (schémas injectés, réponses JSON/DSML parsées). Les comportements peuvent différer du tool-use natif Anthropic.
- **Raisonnement** : `deepseek-reasoner` renvoie `reasoning_content`.
- **Contexte** : fenêtre annoncée jusqu’à **1M tokens** (limite effective amont).

## Limites à connaître

- Pas de protocole Anthropic natif (`/v1/messages`) dans ce proxy — uniquement OpenAI-compatible (`/v1/chat/completions`).
- Comptage d’usage agrégé (pas de split prompt/completion côté amont).
- Débit/pacing et politiques de compte DeepSeek s’appliquent.

## Vérification rapide

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer public" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Dis bonjour en une phrase."}]}'
```
