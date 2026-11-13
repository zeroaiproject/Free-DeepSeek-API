# GitHub Copilot + Free DeepSeek API

L’intégration de **GitHub Copilot** avec un endpoint OpenAI-compatible personnalisé dépend de l’édition/produit (Copilot Individual/Business/Enterprise), des politiques d’organisation et des fonctionnalités **BYOK / custom model** disponibles au moment de la configuration.

## État de compatibilité

- **Copilot Chat / Extensions (BYOK ou OpenAI-compatible)** : si votre environnement permet de définir `baseURL` + clé + modèle OpenAI-compatible, pointez vers ce proxy.
- **Complétions inline Copilot “classiques”** : généralement adossées aux modèles gérés par GitHub — non remplaçables par ce proxy sans support BYOK explicite.

> Vérifiez la documentation Copilot de votre offre pour la prise en charge actuelle des endpoints personnalisés.

## Paramètres (si BYOK/OpenAI-compatible est disponible)

| Champ | Valeur |
|---|---|
| Provider | OpenAI / OpenAI-compatible |
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | `public` (ou `API_KEY` du proxy) |
| Model | `deepseek-chat` ou `deepseek-reasoner` |
| Context | jusqu’à 1 000 000 (si configurable) |

## Alternative pratique

Si Copilot ne peut pas cibler ce proxy directement, utilisez-le via un agent/outillage compatible dans l’éditeur :

- **Continue** (VS Code / JetBrains) : [CONTINUE.md](CONTINUE.md)
- **Cline** (VS Code) : [CLINE.md](CLINE.md)
- **OpenCode** (CLI) : [OPENCODE.md](OPENCODE.md)

Ces outils offrent une expérience agentique proche avec un backend OpenAI-compatible explicite.

## Test du proxy

```bash
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer public" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Hello"}]}'
```
