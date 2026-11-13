# Cursor + Free DeepSeek API

[Cursor](https://cursor.com) peut consommer des endpoints **OpenAI-compatible** (selon l’option « OpenAI API Key » / override de base URL disponible dans votre version).

## Configuration

1. Lancez le proxy (`http://127.0.0.1:8787`) avec un token valide.
2. Dans Cursor : **Settings → Models / OpenAI** (libellés variables selon version) :
   - **OpenAI API Key** : `public` (ou la valeur de `API_KEY` si vous en avez défini une)
   - **Override OpenAI Base URL** : `http://127.0.0.1:8787/v1`
3. Ajoutez/choisissez un modèle personnalisé :
   - `deepseek-chat`
   - `deepseek-reasoner`

## Paramètres recommandés

- **Context window** : jusqu’à `1000000` (1M) si le champ est éditable
- **Max output** : `8192` (chat) / `32768` (reasoner) en point de départ
- **Streaming** : activé
- **Tools / function calling** : activé si proposé (émulé côté proxy)

## Vérification

Dans le chat Cursor, demandez une réponse courte puis un appel d’outil simple (ex. lecture de fichier / action supportée) pour confirmer que le modèle répond via le proxy.

Vous pouvez aussi valider côté proxy :

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

## Notes

- Certains flux Cursor (indexation, embeddings, modèles propriétaires) ne passent pas par cet endpoint ; seuls les appels chat OpenAI-compatible sont concernés.
- Si Cursor impose un format spécifique non supporté, comparez avec un appel `curl` équivalent sur `/v1/chat/completions`.
- `deepseek-reasoner` peut produire des blocs de raisonnement (`reasoning_content`) — l’UI peut les afficher ou les ignorer selon version.
