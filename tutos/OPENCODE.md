# OpenCode + Free DeepSeek API

[OpenCode](https://opencode.ai) est un agent de codage CLI open-source. Ce proxy s’y connecte comme fournisseur **OpenAI-compatible**.

## Prérequis

- Proxy lancé et token valide (`curl http://127.0.0.1:8787/health`)
- OpenCode installé (`opencode` dans le PATH)

## Configuration

Ajoutez le provider dans `~/.config/opencode/opencode.jsonc` (créez le fichier si besoin) :

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "freedeepseek": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Free DeepSeek API",
      "options": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "public"
      },
      "models": {
        "deepseek-chat": {
          "name": "DeepSeek Chat (Free, 1M ctx)",
          "limit": { "context": 1000000, "output": 8192 },
          "cost": { "input": 0, "output": 0 },
          "tool_call": true,
          "reasoning": false
        },
        "deepseek-reasoner": {
          "name": "DeepSeek Reasoner (Free, 1M ctx)",
          "limit": { "context": 1000000, "output": 32768 },
          "cost": { "input": 0, "output": 0 },
          "tool_call": true,
          "reasoning": true
        }
      }
    }
  }
}
```

> `apiKey` doit être non vide pour le client OpenAI-compatible ; le proxy l’ignore sauf si `API_KEY` est défini côté serveur (auquel cas mettez la même valeur).
> Si votre version d’OpenCode attend encore la clé `providers` / `settings` / `compatibility`, adaptez la forme au schéma indiqué par `opencode --help` ou la doc de votre version — les champs essentiels restent `baseURL`, `apiKey`, et les IDs de modèles `deepseek-chat` / `deepseek-reasoner`.

## Utilisation

```bash
# vérifier que les modèles sont vus
opencode models | grep freedeepseek

# lancer avec un modèle
opencode --model freedeepseek/deepseek-chat

# exécution non-interactive avec outils
opencode run --model freedeepseek/deepseek-chat "Liste les fichiers du projet et résume l'architecture."
```

## Conseils

- **Outils** : supportés via émulation (JSON/DSML) — laissez `tool_call: true`. Pour des tâches complexes, gardez les prompts/outils concis.
- **Reasoner** : utilisez `deepseek-reasoner` pour les tâches demandant réflexion ; le raisonnement est exposé en `reasoning_content`.
- **Contexte 1M** : la fenêtre annoncée est 1M tokens ; évitez d’envoyer inutilement d’énormes historiques pour réduire latence et pression amont.
- **Débit** : le proxy cadence les requêtes (gap/jitter/cooldown). En cas de réponse lente, c’est souvent volontaire/anti-throttle.

## Dépannage

- Modèle absent : vérifiez la syntaxe JSONC et relancez `opencode`.
- Erreurs 401 du proxy : alignez `apiKey` client avec `API_KEY` serveur (ou désactivez `API_KEY`).
- `503 account_suspended` / token mort : voir `tutos/SETUP.md` (section dépannage) et `/health`.
