# Cline (VS Code) + Free DeepSeek API

[Cline](https://github.com/cline/cline) est un agent de codage autonome pour VS Code. Il supporte les fournisseurs **OpenAI-compatible**.

## Configuration

1. Installez l’extension **Cline** dans VS Code.
2. Ouvrez les paramètres Cline → **API Provider** : `OpenAI Compatible`.
3. Renseignez :
   - **Base URL** : `http://127.0.0.1:8787/v1`
   - **API Key** : `public` (ou votre `API_KEY`)
   - **Model ID** : `deepseek-chat` (ou `deepseek-reasoner`)
4. (Optionnel) Ajustez :
   - **Context window** : `1000000`
   - **Max tokens** : `8192` (chat) / `32768` (reasoner)

## Utilisation

- Ouvrez un workspace, lancez Cline, et donnez une tâche (édition, refactor, commandes). Cline utilisera le proxy pour les complétions et les appels d’outils.
- Pour les tâches nécessitant plus de réflexion, basculez sur `deepseek-reasoner`.

## Bonnes pratiques

- Le **tool-calling est émulé** : gardez des instructions claires et des outils bien décrits ; si une tâche boucle, simplifiez la demande.
- Respectez le pacing : le proxy peut attendre (rate limit/jitter) pour rester sous les seuils amont.
- Ne mettez pas de secrets dans les prompts ; protégez `/health` si le proxy est exposé.

## Dépannage

- **Connexion refusée** : vérifiez que le proxy écoute (`PORT` par défaut 8787).
- **401 invalid api key** : mettez la même clé dans Cline que dans `API_KEY` (ou videz `API_KEY` côté proxy).
- **Réponses vides/lentes** : throttling amont → le proxy réessaie avec cooldown ; consultez `/health` (rate/metrics/auth/suspension).
- **Pas de token disponible** : ajoutez un `userToken` valide dans `tokens.txt`.
