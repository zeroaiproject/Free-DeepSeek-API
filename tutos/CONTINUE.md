# Continue + Free DeepSeek API

[Continue](https://continue.dev) est un assistant de code pour VS Code et JetBrains, compatible avec les backends **OpenAI**.

## Configuration (`config.json` / `config.yaml`)

Selon votre version de Continue, ajoutez un modèle pointant vers le proxy.

### Exemple (format JSON courant)

Dans `~/.continue/config.json` :

```json
{
  "models": [
    {
      "title": "DeepSeek Chat (Free Proxy)",
      "provider": "openai",
      "model": "deepseek-chat",
      "apiBase": "http://127.0.0.1:8787/v1",
      "apiKey": "public",
      "contextLength": 1000000
    },
    {
      "title": "DeepSeek Reasoner (Free Proxy)",
      "provider": "openai",
      "model": "deepseek-reasoner",
      "apiBase": "http://127.0.0.1:8787/v1",
      "apiKey": "public",
      "contextLength": 1000000
    }
  ]
}
```

### Exemple (format YAML récent)

Dans `~/.continue/config.yaml` :

```yaml
models:
  - name: DeepSeek Chat (Free Proxy)
    provider: openai
    model: deepseek-chat
    apiBase: http://127.0.0.1:8787/v1
    apiKey: public
    roles: [chat, edit, apply]
  - name: DeepSeek Reasoner (Free Proxy)
    provider: openai
    model: deepseek-reasoner
    apiBase: http://127.0.0.1:8787/v1
    apiKey: public
    roles: [chat]
```

> Adaptez les clés (`apiBase`/`apiKey`, `contextLength`, `roles`) au schéma exact de votre version de Continue.

## Utilisation

- Sélectionnez le modèle « DeepSeek … (Free Proxy) » dans Continue.
- Chat, édition inline et autocomplétion (si activée pour le modèle) passent par `POST /v1/chat/completions`.
- Les appels d’outils (si utilisés par votre flux) sont émulés par le proxy.

## Dépannage

- Vérifiez `curl http://127.0.0.1:8787/v1/models`.
- Si le proxy a `API_KEY` activé, utilisez la même valeur dans `apiKey`.
- Latence variable = pacing/anti-throttle normal ; consultez `/health` et `/metrics`.
