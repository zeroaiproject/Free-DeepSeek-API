# Zed + Free DeepSeek API

[Zed](https://zed.dev) propose un assistant IA configurable. Selon la version, il supporte des fournisseurs **OpenAI-compatible**.

## Configuration

Éditez vos paramètres Zed (`~/.config/zed/settings.json` ou via l’UI de settings) pour ajouter un provider OpenAI-compatible pointant vers le proxy.

### Exemple (structure indicative)

```json
{
  "language_models": {
    "openai": {
      "api_url": "http://127.0.0.1:8787/v1",
      "available_models": [
        {
          "name": "deepseek-chat",
          "display_name": "DeepSeek Chat (Free, 1M)",
          "max_tokens": 8192
        },
        {
          "name": "deepseek-reasoner",
          "display_name": "DeepSeek Reasoner (Free, 1M)",
          "max_tokens": 32768
        }
      ],
      "version": "1"
    }
  }
}
```

> La structure exacte des clés (`language_models`, `openai`, `api_url`, `available_models`, gestion de la clé API) peut varier selon la version de Zed. Référez-vous aux paramètres de votre version et conservez les valeurs : **base URL** `http://127.0.0.1:8787/v1`, modèles `deepseek-chat` / `deepseek-reasoner`, clé `public` (ou votre `API_KEY`).

## Utilisation

- Sélectionnez le modèle DeepSeek dans le panneau assistant / inline de Zed.
- Activez le streaming si proposé. Les appels d’outils (quand utilisés) sont émulés côté proxy.

## Vérification

```bash
curl http://127.0.0.1:8787/health
curl -H "Authorization: Bearer public" \
     -H "Content-Type: application/json" \
     -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Salut"}]}' \
     http://127.0.0.1:8787/v1/chat/completions
```

## Notes

- Si Zed ne permet pas encore le BYOK OpenAI-compatible dans votre édition, utilisez le proxy via un outil CLI (OpenCode, Aider) en parallèle.
- Contexte annoncé : 1M tokens ; ajustez les limites côté éditeur si nécessaire.
