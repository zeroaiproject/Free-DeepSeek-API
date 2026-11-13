# JetBrains IDEs + Free DeepSeek API

Fonctionne avec IntelliJ IDEA, PyCharm, WebStorm, GoLand, etc., via les fonctionnalités **AI Assistant** (si BYOK/OpenAI-compatible disponible) ou via des plugins/clients compatibles.

## Option 1 — JetBrains AI Assistant (si endpoint personnalisé supporté)

1. Ouvrez **Settings/Preferences → Tools → AI Assistant** (ou équivalent selon version/produit).
2. Configurez un fournisseur personnalisé OpenAI-compatible (si disponible) :
   - **Base URL** : `http://127.0.0.1:8787/v1`
   - **API Key** : `public` (ou `API_KEY`)
   - **Model** : `deepseek-chat` / `deepseek-reasoner`
   - **Context length** : `1000000` (si configurable)

> La disponibilité du BYOK OpenAI-compatible dépend de la version et de la licence JetBrains.

## Option 2 — Plugin Continue pour JetBrains

1. Installez le plugin **Continue** depuis le Marketplace JetBrains.
2. Configurez `~/.continue/config.json` (ou `config.yaml`) comme dans [CONTINUE.md](CONTINUE.md).
3. Sélectionnez le modèle DeepSeek dans Continue.

## Option 3 — Proxy local via CLI intégré

Utilisez le terminal intégré de l’IDE avec un agent CLI compatible :

- **Aider** : [AIDER.md](AIDER.md)
- **OpenCode** : [OPENCODE.md](OPENCODE.md)

## Vérification

```bash
curl http://127.0.0.1:8787/v1/models
```

## Remarques

- Complétions, chat et actions « agent » ne partagent pas toujours le même backend dans l’IDE ; seul le trafic routé vers l’endpoint configuré utilisera ce proxy.
- En environnement d’entreprise, vérifiez que `http://127.0.0.1:8787` est accessible depuis l’IDE (proxy système/firewall).
