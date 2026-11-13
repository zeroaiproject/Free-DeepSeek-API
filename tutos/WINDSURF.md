# Windsurf + Free DeepSeek API

[Windsurf](https://codeium.com/windsurf) (Codeium) est un IDE agentique. Il peut, selon les versions/offres, accepter des fournisseurs **OpenAI-compatible**.

## Configuration

1. Proxy actif : `http://127.0.0.1:8787/v1` (token valide).
2. Ouvrez les paramètres de modèles/fournisseurs dans Windsurf :
   - **Provider type** : OpenAI / OpenAI-compatible (ou « Bring your own key » si disponible)
   - **Base URL** : `http://127.0.0.1:8787/v1`
   - **API Key** : `public` (ou votre `API_KEY`)
   - **Model** : `deepseek-chat` ou `deepseek-reasoner`
3. (Si demandé) renseignez la fenêtre de contexte : **1 000 000**.

## Recommandations

- Préférez `deepseek-chat` pour l’édition/itérations rapides ; `deepseek-reasoner` pour les tâches de raisonnement.
- Activez le streaming et les outils si les options existent (tool-calling émulé côté proxy).
- Évitez d’envoyer un contexte inutilement maximal en continu : la latence et le pacing amont augmentent.

## Vérification

- `curl http://127.0.0.1:8787/health` doit être `ok` avec au moins un token disponible.
- Test direct :

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer public" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Réponds: OK"}]}'
```

## Remarques

- Les fonctionnalités propriétaires Windsurf (cascade interne, certains modes) peuvent ne pas utiliser ce backend. Consultez la doc de votre version pour le chemin exact des réglages BYOK/OpenAI-compatible.
- En cas d’erreur d’auth côté proxy, alignez la clé client avec `API_KEY` (ou laissez `API_KEY` vide côté proxy).
