# Setup — Free DeepSeek API

Ce guide couvre l’installation du proxy, la configuration des tokens et les vérifications de base.

## 1) Prérequis

- **Node.js ≥ 18** (recommandé 20/22) ou **Docker**
- Un compte DeepSeek (`chat.deepseek.com`)
- Aucun package npm requis (zéro dépendance runtime)

## 2) Installation locale

```bash
git clone https://github.com/zeroaiproject/Free-DeepSeek-API.git
cd free-deepseek-api
cp .env.example .env          # optionnel (auto-chargé au démarrage)
```

### Obtenir un token (`userToken`)

**Option A — Navigateur (recommandé, Google/Apple/mobile inclus)**

1. Connectez-vous sur https://chat.deepseek.com
2. Ouvrez les DevTools → Console et exécutez :
   ```js
   localStorage.getItem('userToken')
   ```
3. Copiez la valeur **telle quelle** (blob base64, peut contenir `+`, `/`, `=` — ne pas URL-encoder) dans `tokens.txt` (une ligne par token).

**Option B — Email + mot de passe**

```bash
node scripts/login.js vous@example.com 'votre-mot-de-passe'
# ajoutez le token affiché à tokens.txt
```

> Comptes créés via Google sans mot de passe : définissez-en un via « mot de passe oublié » sur le site (étape manuelle unique) pour permettre la re-connexion automatique plus tard.

**Option C — Inscription automatisée (expérimental)**

```bash
node scripts/signup.js --email vous@gmail.com --mailbox imap --captcha capsolver --persist
```

Nécessite un solveur captcha valide (hCaptcha vérifié côté serveur) et une boîte mail accessible (IMAP/HTTP) pour lire le code. `node scripts/test-signup.js` valide les portes PoW/payload sans captcha.

### Lancer le proxy

```bash
./run.sh
# ou
npm start
# ou
node server.js
```

Par défaut : `http://127.0.0.1:8787`

## 3) Docker

```bash
docker build -t free-deepseek-api .
docker run -d --name freedeepseek \
  -p 8787:8787 \
  -e API_KEY=sk-local \
  -v "$PWD/tokens.txt:/app/tokens.txt:ro" \
  free-deepseek-api
```

Ou via Compose :

```bash
docker compose up -d --build
```

## 4) Vérifications

```bash
# santé / état (tokens masqués, rate, watchdog, métriques)
curl http://127.0.0.1:8787/health

# modèles
curl http://127.0.0.1:8787/v1/models

# complétion (non-stream)
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Ping"}]}'

# streaming
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"Compte jusqu\u0027à 5"}]}'
```

Tests hors-ligne (sans token) :

```bash
npm run test:offline   # parsers + streamgate + PoW
node --check server.js lib/*.js scripts/*.js
```

## 5) Configuration utile

Éditez `.env` (auto-chargé, sans écraser l’environnement existant) :

| Variable | Rôle |
|---|---|
| `PORT` / `HOST` | Écoute (`8787`, `0.0.0.0`) |
| `API_KEY` | Protège le proxy (`Authorization: Bearer <key>`) |
| `DEFAULT_MODEL` | `deepseek-chat` (défaut) ou `deepseek-reasoner` |
| `DEEPSEEK_TOKENS` / `DEEPSEEK_TOKENS_FILE` | Pool de tokens (hot-reload de `tokens.txt`) |
| `DEEPSEEK_EMAIL` / `DEEPSEEK_PASSWORD` / `DEEPSEEK_TOKEN_PERSIST` | Re-login automatique si token révoqué |
| `DEEPSEEK_PROXY` | Sortie via proxy HTTP (`CONNECT`) |
| `RATE_*` / `WARM_*` / `WATCHDOG_*` | Pacing, pré-chauffage, sondes (valeurs prudentes par défaut) |
| `LOG_REQUESTS=1` | Logs légers méthode/chemin/statut/latence |

## 6) Modèles & capacités

| Modèle | Mode | Raisonnement | Outils (émulés) | Contexte annoncé |
|---|---|---:|---:|---:|
| `deepseek-chat` | default | non | oui | 1M tokens |
| `deepseek-reasoner` | thinking | `reasoning_content` | oui | 1M tokens |

> La limite effective dépend de l’endpoint web amont et du compte. Le proxy relaie et annonce 1M ; adaptez si besoin côté client.

## 7) Dépannage rapide

- **Aucun token disponible** : ajoutez un token dans `tokens.txt` (rechargé à chaud) ou `DEEPSEEK_TOKENS`.
- **`40003` / token mort** : remplacez le token ou configurez `DEEPSEEK_EMAIL/PASSWORD` (compte avec mot de passe).
- **Compte suspendu** : `/health` l’indique (`auth.suspendedUntil`) — re-login impossible jusqu’à expiration.
- **Réponses vides / lenteur** : throttling amont silencieux ; le proxy applique cooldown/jitter/gap — réduisez le débit.
- **Client exige une clé** : mettez `apiKey: "public"` (ou la valeur de `API_KEY` si activée).

Passez ensuite au tutoriel de votre outil : [OpenCode](OPENCODE.md), [Claude Code](CLAUDECODE.md), [Cursor](CURSOR.md), etc.
