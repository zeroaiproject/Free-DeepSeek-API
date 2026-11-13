<div align="center">

# Free DeepSeek API

**Proxy OpenAI-compatible pour `chat.deepseek.com`**  
*Zéro dépendance npm · Node.js 18+ · PoW natif (WASM) · Streaming · Tool-calling émulé · Pool de tokens*

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![API](https://img.shields.io/badge/OpenAI-compatible-412991?logo=openai&logoColor=white)](#-api)
[![Context](https://img.shields.io/badge/context-1M%20tokens-0ea5e9)](#-mod%C3%A8les)
[![License](https://img.shields.io/badge/license-GLWTS-blueviolet)](LICENSE)

<br/>

```text
┌──────────────┐      OpenAI /v1/chat/completions      ┌──────────────────────┐      PoW + Bearer       ┌───────────────────┐
│  App / Agent │  ───────────────────────────────────▶  │  Free DeepSeek API  │  ────────────────────▶  │ chat.deepseek.com │
│  (SDK, IDE)  │  ◀────────── SSE / JSON ─────────────  │  (ce proxy)         │  ◀───── SSE/JSON ─────  │   (web endpoint)  │
└──────────────┘                                        └──────────────────────┘                         └───────────────────┘
```

<p>
  <a href="#-d%C3%A9marrage-rapide"><b>Démarrage rapide</b></a> ·
  <a href="#-comment-%C3%A7a-marche"><b>Comment ça marche</b></a> ·
  <a href="#-api"><b>API</b></a> ·
  <a href="#-tool-calling"><b>Tool calling</b></a> ·
  <a href="tutos/README.md"><b>Tutoriels agents</b></a> ·
  <a href="#%EF%B8%8F-configuration"><b>Configuration</b></a>
</p>

</div>

---

## ✨ Points forts

| | Fonctionnalité | Détail |
|:--:|---|---|
| ⚡ | **Streaming réel** | Relais SSE DeepSeek → `chat.completion.chunk` OpenAI (débits progressifs, pas de buffer global). |
| 🧠 | **Raisonnement** | `deepseek-reasoner` (thinking) → `reasoning_content` en stream et non-stream. |
| 🛠️ | **Tool calling émulé** | `tools`, `tool_choice`, `parallel_tool_calls`, aller-retour résultats — parsing **JSON + DSML**, hold-back anti-fuite en streaming. |
| 🧱 | **Contexte étendu** | Fenêtre annoncée jusqu’à **1M tokens** (limite effective selon l’endpoint/compte amont). |
| 🔐 | **PoW natif** | Résolution `DeepSeekHashV1` via le WASM original (`wasm_solve`), ~30–110 ms. |
| 🔁 | **Résilience** | Pool round-robin, hot-reload tokens, rate-limit + jitter/gap/cooldown, mutex par token, pré-chauffage, watchdog, re-login auto (optionnel). |
| 📈 | **Observabilité** | `/health` (état masqué + métriques), `/metrics` Prometheus/JSON, `X-Request-Id`, headers de timing `X-Ds-*`. |
| 🧩 | **Drop-in** | SDK OpenAI, curl, et intégrations agents (OpenCode, Cursor, Continue, Cline, Aider, Zed, etc.). |

> [!NOTE]
> Le proxy utilise l’endpoint **web** `chat.deepseek.com` avec des `userToken`. Gardez un débit modéré et conforme aux politiques DeepSeek : le trafic automatisé peut entraîner des limitations ou suspensions de compte.

---

## 🚀 Démarrage rapide

```bash
git clone https://github.com/zeroaiproject/Free-DeepSeek-API.git
cd free-deepseek-api
cp .env.example .env                  # optionnel (auto-chargé)
echo "$DEEPSEEK_USER_TOKEN" > tokens.txt
./run.sh                              # ou: npm start | docker compose up -d
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Dis bonjour en une phrase."}]
  }'
```

<details>
<summary><b>Streaming, santé, modèles</b></summary>

```bash
# streaming SSE
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"Compte de 1 à 5."}]}'

# santé + métriques (tokens masqués)
curl http://127.0.0.1:8787/health

# modèles & capacités
curl http://127.0.0.1:8787/v1/models
```
</details>

---

## 🔑 Obtenir un token

Le proxy requiert un **`userToken`** (stocké par la webapp DeepSeek après connexion).

| Méthode | Commande / action | Notes |
|---|---|---|
| **Navigateur** | `localStorage.getItem('userToken')` sur https://chat.deepseek.com | Coller tel quel (base64, ne pas URL-encoder) dans `tokens.txt` (1 par ligne). |
| **Email + mot de passe** | `node scripts/login.js email motdepasse` | Fonctionne si le compte a un mot de passe. |
| **Signup (expérimental)** | `node scripts/signup.js --email ... --mailbox imap --captcha ...` | PoW invité automatisé ; **captcha hCaptcha vérifié serveur** + boîte mail requises. |

> Comptes Google sans mot de passe : définissez-en un via « mot de passe oublié » (étape manuelle) pour activer la re-connexion auto (`DEEPSEEK_EMAIL/PASSWORD`). Détails et dépannage : [tutos/SETUP.md](tutos/SETUP.md).

---

## 🔬 Comment ça marche

Le proxy reproduit le flux du client web `chat.deepseek.com` et l’expose comme une API OpenAI-compatible. À haut niveau : **auth bearer (`userToken`) → PoW par requête → session de chat → complétion SSE → traduction OpenAI**.

```text
Client (SDK/agent)                     Proxy local                         DeepSeek web
      │                                     │                                   │
      │  POST /v1/chat/completions          │                                   │
      ├────────────────────────────────────▶│  create_pow_challenge             │
      │                                     ├──────────────────────────────────▶│
      │                                     │◀───────── challenge ──────────────┤
      │                                     │  solve PoW (WASM, ~30–110ms)      │
      │                                     │  create/reuse chat_session        │
      │                                     ├──────────────────────────────────▶│
      │                                     │  POST /chat/completion (SSE)      │
      │                                     ├──────────────────────────────────▶│
      │  SSE chunks / JSON OpenAI           │◀──── fragments / patches ─────────┤
      │◀────────────────────────────────────│  assemble + map (THINK/tools)     │
```

### 1) Preuve de travail (PoW)
Chaque complétion nécessite un header `X-Ds-Pow-Response` :
1. **Challenge** — `POST /api/v0/chat/create_pow_challenge` avec `target_path` → `algorithm, challenge, salt, signature, difficulty, expire_at, target_path`.
2. **Résolution** — trouver `answer ∈ [0, difficulty]` tel que `DeepSeekHash(salt_expireAt_answer) == challenge`.
   - Algorithme Keccak custom embarqué dans `lib/sha3_wasm_bg.7b9ca65ddd.wasm` (exécuté tel quel, **pas** SHA-256/SHA3 standard).
3. **Preuve** — envoi en Base64 JSON : `{"algorithm","challenge","salt","answer","signature","target_path"}`.

> Les challenges non résolus peuvent être pré-chauffés (TTL ~300 s) ; une preuve résolue est **à usage unique**.

### 2) Sessions, contexte & prompt
4. **Session** — `POST /api/v0/chat_session/create` renvoie un `chat_session.id` réutilisé quelques requêtes puis tourné (meilleur équilibre latence/bruit).
5. **Transcript aplati** — le proxy convertit les messages OpenAI (system/user/assistant/tool) en prompt texte attendu par le web. Il annonce une fenêtre jusqu’à **1M tokens** (`/v1/models`), mais la limite réellement acceptée dépend de l’endpoint/compte amont.
6. **Complétion** — `POST /api/v0/chat/completion` avec `model: default|thinking`, prompt et paramètres ; réponse en **SSE**.

### 3) Traduction SSE → OpenAI
Le flux DeepSeek (snapshots `response.fragments`, appends `{"v":"..."}`, remplacements/patchs ciblés, événements de statut) est réassemblé puis mappé :
- fragments `THINK` → `reasoning_content` (modèle `deepseek-reasoner`)
- fragments texte → `delta.content` / `message.content`
- fin de flux → `finish_reason` (`stop` / `tool_calls`), `usage` agrégé relayé

### 4) Tool calling (émulation)
L’endpoint web n’expose pas de function-calling natif ; le proxy l’émule :
- **Injection** des schémas `tools` dans un bloc d’instructions système (noms, JSON Schema, règles, `tool_choice`/`parallel_tool_calls`).
- **Parsing** des réponses en `tool_calls` OpenAI depuis JSON (`{"tool_calls":[...]}`) **ou** balisage natif **DSML** (`<｜DSML｜ invoke/parameter>`), avec normalisation/coercition des arguments.
- **Streaming sûr** : `streamgate` retient une courte traîne (`STREAM_HOLD_BACK`) et coupe l’émission texte dès détection d’un marqueur d’appel pour éviter toute fuite de markup.
- **Aller-retour** : les messages `role:"tool"` sont réinjectés dans le transcript pour les tours suivants.

### 5) Résilience, pacing & observabilité
- **Pool de tokens** : round-robin, hot-reload de `tokens.txt`, masquage en `/health`, pénalités/cooldowns.
- **Rate limiting** : bucket + écart mini + jitter + cooldown progressif, **1 complétion en vol par token**, pré-chauffage de challenges/sessions échelonné (absorbe le throttling silencieux et réduit les rafales).
- **Watchdog** : sondes de vivacité jitterées, distinction révocation (`40003` récupérable) vs **suspension** (non récupérable), re-login auto si identifiants configurés.
- **Observabilité** : `/health`, `/metrics` (Prometheus/JSON), `X-Request-Id`, timings `X-Ds-*`, logs optionnels sans corps/secrets.

---

## 🔌 API

| Méthode | Chemin | Description |
|---|---|---|
| `GET` | `/`, `/v1` | Info service (HTML navigateur, JSON API) |
| `GET` | `/health` | Santé, uptime, tokens (masqués), warm/rate/watchdog/auth, métriques |
| `GET` | `/metrics` | Prometheus (`text/plain`) ou JSON (`Accept: application/json`) |
| `GET` | `/v1/models` | Modèles et capacités |
| `POST` | `/v1/chat/completions` | Chat completions (stream/non-stream), `tools` |

### 🧱 Modèles

| Modèle | Mode | Raisonnement | Outils | Contexte annoncé | Sortie max (hint) |
|---|---|---:|---:|---:|---:|
| `deepseek-chat` | `default` | — | ✅ (émulés) | **1M** | 8192 |
| `deepseek-reasoner` | `thinking` | `reasoning_content` | ✅ (émulés) | **1M** | 32768 |

> La fenêtre effective dépend de l’acceptation amont. `usage` reflète l’agrégat amont (pas de split prompt/completion).

---

## 🛠️ Tool calling

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role":"user","content":"Quel temps fait-il à Paris ?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Météo actuelle pour une ville",
        "parameters": {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}
      }
    }]
  }'
```

<details>
<summary><b>Détails (formats, choix d’outil, streaming)</b></summary>

| Champ | Comportement |
|---|---|
| `tool_choice: "auto"` / omis | le modèle décide |
| `tool_choice: "none"` | outils désactivés, réponse texte |
| `tool_choice: "required"` | au moins un appel imposé |
| `tool_choice: {"type":"function","function":{"name":"X"}}` | outil `X` imposé |
| `parallel_tool_calls: false` | réduit au premier appel |

- Sorties parsées : JSON et DSML (barres pleines `｜DSML｜`). Les arguments sont normalisés (objets, chaînes JSON/double-encodées récupérées quand possible).
- En streaming, les marqueurs d’appel ne sont jamais émis dans `content` (hold-back). Le proxy renvoie des `tool_calls` OpenAI valides et applique `finish_reason: "tool_calls"`.
- Tests : `node scripts/test-parsers.js`, `node scripts/test-streamgate.js`, `node scripts/test-tools.js` (proxy actif).
</details>

---

## 🤖 Intégrations (agents de codage)

> **Tous les tutoriels : [tutos/](tutos/README.md)** — base `http://127.0.0.1:8787/v1`, modèles `deepseek-chat` / `deepseek-reasoner`, clé factice `public` si requise.

| Agent / outil | Guide |
|---|---|
| OpenCode | [tutos/OPENCODE.md](tutos/OPENCODE.md) |
| Claude Code (via compat OpenAI) | [tutos/CLAUDECODE.md](tutos/CLAUDECODE.md) |
| Cursor | [tutos/CURSOR.md](tutos/CURSOR.md) |
| Windsurf | [tutos/WINDSURF.md](tutos/WINDSURF.md) |
| Cline (VS Code) | [tutos/CLINE.md](tutos/CLINE.md) |
| Continue (VS Code / JetBrains) | [tutos/CONTINUE.md](tutos/CONTINUE.md) |
| Aider | [tutos/AIDER.md](tutos/AIDER.md) |
| GitHub Copilot (BYOK/compat) | [tutos/GITHUB_COPILOT.md](tutos/GITHUB_COPILOT.md) |
| Codex CLI & CLIs OpenAI | [tutos/CODEX_CLI.md](tutos/CODEX_CLI.md) |
| Zed | [tutos/ZED.md](tutos/ZED.md) |
| JetBrains IDEs | [tutos/JETBRAINS.md](tutos/JETBRAINS.md) |
| SDK OpenAI (Python/Node/curl) | [tutos/OPENAI_SDK.md](tutos/OPENAI_SDK.md) |

---

## ⚙️ Configuration

Toutes les variables sont optionnelles. `.env` est **auto-chargé** (sans écraser l’existant). Secrets (`.env`, `tokens.txt`) ignorés par git, tokens persistés en `0600`.

| Variable | Défaut | Rôle |
|---|---:|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Écoute |
| `API_KEY` | — | Protège le proxy (`Authorization: Bearer`) |
| `DEFAULT_MODEL` | `deepseek-chat` | Modèle par défaut |
| `DEEPSEEK_TOKENS` / `DEEPSEEK_TOKENS_FILE` | — / `./tokens.txt` | Pool de tokens (hot-reload) |
| `DEEPSEEK_EMAIL` / `DEEPSEEK_PASSWORD` / `DEEPSEEK_TOKEN_PERSIST` | — | Re-login auto + persistance |
| `DEEPSEEK_PROXY` | — | Proxy sortant HTTP `CONNECT` |
| `WARM_POOL` / `WARM_SESSION_USES` / `WARM_REFILL_*` | `3` / `4` / … | Pré-chauffage & échelonnement |
| `RATE_BURST` / `RATE_REFILL_MS` / `RATE_MIN_GAP_MS` / `RATE_JITTER_MS` | `4` / `6000` / `1500` / `500` | Pacing & bucket |
| `RATE_COOLDOWN_MS` / `RATE_COOLDOWN_MAX_MS` / `RATE_MAX_WAIT_MS` | `45000` / `300000` / `35000` | Recul sur throttling |
| `WATCHDOG_MS` / `WATCHDOG_JITTER_MS` | `120000` / `20000` | Sondes de vivacité |
| `STREAM_HOLD_BACK` | `32` | Garde-fou streaming outils |
| `LOG_REQUESTS` | — | `1` = logs légers (sans corps/secrets) |

> Liste complète et variables signup/captcha/mailbox : [`.env.example`](.env.example) et [tutos/SETUP.md](tutos/SETUP.md).

---

## 🧬 Cycle de vie des tokens & limites

- **Pas de refresh token** : seuls login/register/oauth émettent un `userToken` — un token se remplace, il ne se « rafraîchit » pas.
- **`40003` ≠ toujours pareil** : révocation (re-login possible) vs **suspension** (tous endpoints en échec, attendre) — le proxy distingue, recule et l’expose dans `/health`.
- **Throttling silencieux** : réponses vides après rafales ; le proxy cadence, attend et réessaie (backoff progressif).
- **Anti-suspension ≠ garantie** : pacing/jitter/gaps, sessions réutilisées, pré-warm échelonné et watchdog réduisent les signaux, mais ne suppriment pas le risque.

> [!WARNING]
> Gardez un volume faible et « humain », préférez une sortie réseau propre/résidentielle si nécessaire, et évitez les boucles automatisées soutenues.

---

## 🗂️ Structure du dépôt

```text
server.js                 Serveur HTTP, couche OpenAI, routage, métriques
lib/
  deepseek.js             Client amont (challenge/session/completion, tunnel proxy)
  pow.js                  Solveur PoW WASM
  stream.js               Assemblage SSE → fragments
  streamgate.js           Hold-back / détection d’appels d’outils en stream
  tools.js                Émulation tools (prompt, parsing JSON/DSML, transcript)
  pool.js                 Pool de tokens, hot-reload, swap/re-login
  ratelimit.js            Bucket + mutex + pacing/jitter/cooldown
  warm.js                 Pré-chauffage challenges/sessions
  watchdog.js             Sonde de vivacité, déclenche re-login
  auth.js / signup.js     Login et inscription (expérimental)
  captcha.js / mailbox.js Solveurs captcha & lecture de codes
  metrics.js / env.js     Métriques et chargement .env
scripts/                  login, signup, tests, bench, probes
tutos/                    Guides d’intégration (OpenCode, Cursor, Cline, Aider, etc.)
run.sh                    démarrage/redémarrage (pidfile)
```

---

## 🐳 Docker

```bash
docker build -t free-deepseek-api .
docker run -p 8787:8787 -e API_KEY=sk-local -v "$PWD/tokens.txt:/app/tokens.txt:ro" free-deepseek-api
# ou
docker compose up -d --build
```

## ✅ Tests

```bash
npm run test:offline   # parsers + streamgate + PoW (sans réseau)
npm run test:all       # offline + smoke portes signup (réseau)
node --check server.js lib/*.js scripts/*.js
```

---

<div align="center">

**[GLWTS](LICENSE)** · *Good luck with that shit. Use responsibly.*

</div>
