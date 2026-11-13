<div align="center">

# Free DeepSeek API

**OpenAI-compatible proxy for `chat.deepseek.com`**  
*Zero npm dependencies · Node.js 18+ · Native PoW (WASM) · Streaming · Emulated tool calling · Token pool*

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![API](https://img.shields.io/badge/OpenAI-compatible-412991?logo=openai&logoColor=white)](#-api)
[![Context](https://img.shields.io/badge/context-1M%20tokens-0ea5e9)](#-models)
[![License](https://img.shields.io/badge/license-GLWTS-blueviolet)](LICENSE)

<br/>

```text
┌──────────────┐   OpenAI / Anthropic / Vertex APIs   ┌──────────────────────┐      PoW + Bearer       ┌───────────────────┐
│  App / Agent │  ──────────────────────────────────▶  │  Free DeepSeek API  │  ────────────────────▶  │ chat.deepseek.com │
│  (SDK, IDE)  │  ◀────────── SSE / JSON ───────────  │  (this proxy)       │  ◀───── SSE/JSON ─────  │   (web endpoint)  │
└──────────────┘                                       └──────────────────────┘                         └───────────────────┘
```

<p>
  <a href="#-quick-start"><b>Quick start</b></a> ·
  <a href="#-how-it-works"><b>How it works</b></a> ·
  <a href="#-api"><b>API</b></a> ·
  <a href="#-tool-calling"><b>Tool calling</b></a> ·
  <a href="tutos/README.md"><b>Agent tutorials</b></a> ·
  <a href="#%EF%B8%8F-configuration"><b>Configuration</b></a>
</p>

</div>

---

## ✨ Highlights

| | Feature | Details |
|:--:|---|---|
| ⚡ | **True streaming** | Relays DeepSeek SSE as OpenAI `chat.completion.chunk` deltas (no global buffering). |
| 🧠 | **Reasoning** | `deepseek-reasoner` (thinking) → `reasoning_content` in stream and non-stream responses. |
| 🛠️ | **Emulated tool calling** | `tools`, `tool_choice`, `parallel_tool_calls`, tool-result round-trips — **JSON + DSML** parsing with stream hold-back to prevent leaks. |
| 🧱 | **Extended context** | Advertised window up to **1M tokens** (effective limit depends on the upstream endpoint/account). |
| 🔐 | **Native PoW** | Solves `DeepSeekHashV1` via the original WASM (`wasm_solve`), ~30–110 ms. |
| 🔁 | **Resilience** | Round-robin token pool, hot-reload, rate limiting + jitter/gap/cooldown, one in-flight completion per token, pre-warming, watchdog, optional auto re-login. |
| 📈 | **Observability** | `/health` (masked status + metrics), `/metrics` (Prometheus/JSON), `X-Request-Id`, `X-Ds-*` timing headers. |
| 🧩 | **Drop-in** | OpenAI, **Anthropic Messages**, and **Vertex/Gemini** compatible APIs for SDKs, curl, and agent integrations (OpenCode, Cursor, Continue, Cline, Aider, Zed, etc.). |

> [!NOTE]
> The proxy uses the **web** endpoint `chat.deepseek.com` with `userToken`s. Keep traffic moderate and compliant with DeepSeek policies: automated usage may lead to rate limits or account suspension.

---

## 🚀 Quick start

```bash
git clone https://github.com/zeroaiproject/Free-DeepSeek-API.git
cd free-deepseek-api
cp .env.example .env                  # optional (auto-loaded)
echo "$DEEPSEEK_USER_TOKEN" > tokens.txt
./run.sh                              # or: npm start | docker compose up -d
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Say hello in one sentence."}]
  }'
```

<details>
<summary><b>Streaming, health, models</b></summary>

```bash
# streaming SSE
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"Count from 1 to 5."}]}'

# health + metrics (masked tokens)
curl http://127.0.0.1:8787/health

# models & capabilities
curl http://127.0.0.1:8787/v1/models
```
</details>

---

## 🔑 Getting a token

The proxy requires a **`userToken`** (stored by the DeepSeek web app after login).

| Method | Command / action | Notes |
|---|---|---|
| **Browser** | `localStorage.getItem('userToken')` at https://chat.deepseek.com | Paste as-is (base64, do not URL-encode) into `tokens.txt` (one per line). |
| **Email + password** | `node scripts/login.js email password` | Works if the account has a password. |
| **Signup (experimental)** | `node scripts/signup.js --email ... --mailbox imap --captcha ...` | Guest PoW automated; **server-verified hCaptcha** + accessible mailbox required. |

> Google accounts without a password: set one via "forgot password" (one-time manual step) to enable automatic re-login (`DEEPSEEK_EMAIL/PASSWORD`). Details and troubleshooting: [tutos/SETUP.md](tutos/SETUP.md).

---

## 🔬 How it works

The proxy reproduces the `chat.deepseek.com` web flow and exposes it through **OpenAI**, **Anthropic Messages**, and **Vertex/Gemini** compatible interfaces.

At a high level: **client request → format normalization → auth/token selection → per-request PoW → chat session → upstream SSE completion → stream assembly → format translation → client response**.

```text
Client / SDK / Agent
   │  OpenAI  (/v1/chat/completions)
   │  Anthropic (/v1/messages)
   │  Vertex/Gemini (:generateContent / :streamGenerateContent)
   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Free DeepSeek API (local)                    │
│  1) Validate + normalize request (messages/tools/stream/model)      │
│  2) Pick token (pool) + rate-limit/lock + prewarm (challenge/sess) │
│  3) Solve DeepSeekHashV1 PoW (WASM) -> X-Ds-Pow-Response           │
│  4) Create/reuse chat session + POST /chat/completion (SSE)        │
│  5) Reassemble fragments/patches + emulate tools (JSON/DSML)       │
│  6) Translate to target API format (stream or non-stream)          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ HTTPS (PoW + Bearer userToken)
                                ▼
                        chat.deepseek.com (web backend)
```

### 1) API compatibility & request normalization
- **OpenAI**: native internal shape (`/v1/chat/completions`, `tools`, `tool_choice`, streaming chunks).
- **Anthropic**: `/v1/messages` requests/responses/events are translated (system/messages/content blocks, `tool_use`/`tool_result`, `thinking`/reasoning mapping, stop reasons).
- **Vertex/Gemini**: `contents`/`parts`, `systemInstruction`, function call/response, and `generateContent`/`streamGenerateContent` responses are translated.
- Incoming messages are normalized into a flattened transcript for the web endpoint while preserving roles, tool calls, and tool results as text/context.

### 2) Authentication, token pool & pacing
- Uses DeepSeek web **`userToken`** bearer credentials from `tokens.txt` / env (hot-reload, masked in `/health`).
- **Pool & resilience**: round-robin selection, cooldown/penalties, optional auto re-login (if credentials configured), watchdog liveness probes.
- **Pacing**: token bucket + minimum gap + jitter + escalating cooldown, with **one in-flight upstream completion per token** to reduce bursty patterns and absorb silent throttling.
- **Failure modes**: distinguishes token revocation (recoverable by re-mint/re-login) from **account suspension** (`40003` across endpoints, not recoverable until expiry) and reports/backoffs accordingly.

### 3) Proof-of-Work (per completion)
Each completion must include a valid `X-Ds-Pow-Response`:
1. **Challenge** — `POST /api/v0/chat/create_pow_challenge` (`target_path`) returns algorithm/challenge/salt/signature/difficulty/expiry metadata.
2. **Solve** — find `answer` in the allowed range such that `DeepSeekHashV1(salt_expireAt_answer) == challenge`.
   - Uses the shipped custom Keccak/WASM implementation (`lib/sha3_wasm_bg.7b9ca65ddd.wasm`) for correctness and speed (~30–110 ms typical).
3. **Proof header** — Base64 JSON payload `{ algorithm, challenge, salt, answer, signature, target_path }`.

Pre-warming may cache unsolved challenges/sessions; **solved PoW proofs are single-use**, while unsolved challenges are reusable within their validity window.

### 4) Session creation & upstream completion
4. **Session** — create or reuse a chat session (`/api/v0/chat_session/create`) for a limited number of turns to balance latency and upstream traffic patterns.
5. **Prompt/model mapping** — internal model IDs map to web modes (e.g. chat/default, reasoner/thinking). The proxy advertises up to **1M tokens** context in `/v1/models`, but the effective accepted context depends on the upstream endpoint/account.
6. **Completion request** — `POST /api/v0/chat/completion` with flattened prompt and parameters; upstream responds as **SSE** (fragments, snapshots, incremental patches, status events).

### 5) Stream assembly & output translation
The DeepSeek SSE stream is incrementally reassembled and converted:
- **Reasoning** fragments (`THINK`) → `reasoning_content` / thinking blocks (format-dependent).
- **Text** fragments → OpenAI deltas/messages, Anthropic text/thinking deltas, or Vertex/Gemini parts.
- **Control/usage** → normalized finish reasons and relayed aggregate usage where available.

This includes handling snapshot/append/replace-style updates from the web protocol and emitting client-visible chunks progressively (true streaming).

### 6) Tool calling emulation (no native web function-calling)
- **Schema injection**: tool definitions, rules, and `tool_choice`/parallel-call constraints are injected into prompt instructions.
- **Response parsing**: model outputs are parsed into structured tool calls from requested **JSON** or native **DSML** markup (`<｜DSML｜ ...>`), with argument normalization/coercion and deduplication.
- **Stream safety**: `StreamGate` holds back a short tail and suppresses text emission once a tool-call marker is detected to avoid leaking tool markup to clients.
- **Multi-turn loop**: tool results (`role:"tool"` / Anthropic `tool_result` / Vertex `functionResponse`) are fed back into subsequent requests.

### 7) Observability & operations
- **Health/metrics**: `/health` (masked status, warm/rate/watchdog/auth/metrics) and `/metrics` (Prometheus or JSON).
- **Tracing/timing**: `X-Request-Id` and `X-Ds-*` timing headers; optional lightweight request logging (`LOG_REQUESTS=1`) without bodies/secrets.
- **Safety defaults**: conservative pacing, hot token reload, atomic token persistence (`0600`), and upstream-decoding-safe request behavior (`Accept-Encoding: identity`).

---

## 🔌 API

| Method | Path | Description |
|---|---|---|
| `GET` | `/`, `/v1`, `/openai/v1` | Service info (HTML for browsers, JSON for clients) |
| `GET` | `/version` | Service name/version |
| `GET` | `/health` | Detailed health/status (tokens masked), warm/rate/watchdog/auth/metrics |
| `GET` | `/livez`, `/healthz` | Liveness probe |
| `GET` | `/readyz` | Readiness probe (tokens/auth availability) |
| `GET` | `/metrics` | Prometheus (`text/plain`) or JSON (`Accept: application/json`) |
| `GET` | `/v1/models` | Models and capabilities |
| `GET` | `/v1/models/{id}` | Single model details |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions (stream/non-stream), `tools` |
| `POST` | `/v1/completions` | Legacy completions shim (mapped to chat) |
| `POST` | `/v1/messages` | Anthropic Messages API compatible (stream/non-stream), tools |
| `POST` | `/v1/messages/count_tokens` | Anthropic token-count (heuristic estimate, no external tokenizer) |
| `POST` | `/v1beta/models/{model}:generateContent` | Vertex/Gemini `generateContent` compatible |
| `POST` | `/v1beta/models/{model}:streamGenerateContent` | Vertex/Gemini `streamGenerateContent` compatible (SSE) |
| `POST` | `/v1beta/models/{model}:countTokens` | Vertex token-count (heuristic estimate, no external tokenizer) |
| `POST` | `/v1/embeddings`, `/v1/images/*`, `/v1/audio/*`, ... | Explicit `501 not supported` responses (graceful fallback) |

### 🧱 Models

| Model | Mode | Reasoning | Tools | Advertised context | Max output (hint) |
|---|---|---:|---:|---:|---:|
| `deepseek-chat` | `default` | — | ✅ (emulated) | **1M** | 8192 |
| `deepseek-reasoner` | `thinking` | `reasoning_content` | ✅ (emulated) | **1M** | 32768 |

> Effective window depends on upstream acceptance. `usage` reflects upstream aggregate (no prompt/completion split).

---

## 🛠️ Tool calling

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role":"user","content":"What is the weather in Paris?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Current weather for a city",
        "parameters": {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}
      }
    }]
  }'
```

<details>
<summary><b>Details (formats, tool choice, streaming)</b></summary>

| Field | Behavior |
|---|---|
| `tool_choice: "auto"` / omitted | model decides |
| `tool_choice: "none"` | tools disabled, text response |
| `tool_choice: "required"` | at least one call required |
| `tool_choice: {"type":"function","function":{"name":"X"}}` | force tool `X` |
| `parallel_tool_calls: false` | keep only the first call |

- Parsed outputs: JSON and DSML (fullwidth `｜DSML｜` separators). Arguments are normalized (objects, JSON/double-encoded strings recovered when possible).
- During streaming, tool-call markers are never emitted in `content` (hold-back). The proxy returns valid OpenAI `tool_calls` and sets `finish_reason: "tool_calls"`.
- Tests: `node scripts/test-parsers.js`, `node scripts/test-streamgate.js`, `node scripts/test-tools.js` (proxy running).
</details>

---

## 🤖 Integrations (coding agents)

> **All tutorials: [tutos/](tutos/README.md)** — OpenAI base `http://127.0.0.1:8787/v1`, Anthropic `http://127.0.0.1:8787` (`/v1/messages`), Vertex/Gemini `http://127.0.0.1:8787/v1beta/...:generateContent`, models `deepseek-chat` / `deepseek-reasoner`, dummy key `public` if required.

<details>
<summary><b>Anthropic & Vertex examples</b></summary>

```bash
# Anthropic Messages API
curl http://127.0.0.1:8787/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: public' \
  -d '{"model":"deepseek-chat","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'

# Vertex/Gemini generateContent
curl http://127.0.0.1:8787/v1beta/models/deepseek-chat:generateContent \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello"}]}]}'
```
</details>

| Agent / tool | Guide |
|---|---|
| OpenCode | [tutos/OPENCODE.md](tutos/OPENCODE.md) |
| Claude Code (via OpenAI compat) | [tutos/CLAUDECODE.md](tutos/CLAUDECODE.md) |
| Cursor | [tutos/CURSOR.md](tutos/CURSOR.md) |
| Windsurf | [tutos/WINDSURF.md](tutos/WINDSURF.md) |
| Cline (VS Code) | [tutos/CLINE.md](tutos/CLINE.md) |
| Continue (VS Code / JetBrains) | [tutos/CONTINUE.md](tutos/CONTINUE.md) |
| Aider | [tutos/AIDER.md](tutos/AIDER.md) |
| GitHub Copilot (BYOK/compat) | [tutos/GITHUB_COPILOT.md](tutos/GITHUB_COPILOT.md) |
| Codex CLI & OpenAI CLIs | [tutos/CODEX_CLI.md](tutos/CODEX_CLI.md) |
| Zed | [tutos/ZED.md](tutos/ZED.md) |
| JetBrains IDEs | [tutos/JETBRAINS.md](tutos/JETBRAINS.md) |
| OpenAI SDK (Python/Node/curl) | [tutos/OPENAI_SDK.md](tutos/OPENAI_SDK.md) |

---

## ⚙️ Configuration

Most variables are optional. `.env` is **auto-loaded** (without overriding existing vars). Secrets (`.env`, `tokens.txt`) are gitignored; tokens are persisted with mode `0600`.

> **Security note:** binding to a non-loopback `HOST` without `API_KEY` is refused at startup unless `ALLOW_INSECURE_EXPOSED=1` is explicitly set. Debug dumps (if enabled) are redacted.

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address (`127.0.0.1` recommended for local-only) |
| `API_KEY` | — | Protect the proxy (`Authorization: Bearer` / `x-api-key`) |
| `ALLOW_INSECURE_EXPOSED` | `0` | Allow non-loopback bind without `API_KEY` (unsafe override) |
| `CORS_ORIGIN` | `*` | CORS allowed origin for browser clients |
| `BODY_LIMIT_BYTES` / `BODY_TIMEOUT_MS` | `33554432` / `60000` | Request body size/read timeout limits |
| `DEFAULT_MODEL` | `deepseek-chat` | Default model |
| `DEEPSEEK_TOKENS` / `DEEPSEEK_TOKENS_FILE` | — / `./tokens.txt` | Token pool (hot-reload) |
| `DEEPSEEK_EMAIL` / `DEEPSEEK_PASSWORD` / `DEEPSEEK_TOKEN_PERSIST` | — | Auto re-login + persistence |
| `DEEPSEEK_PROXY` | — | Outbound HTTP `CONNECT` proxy |
| `WARM_POOL` / `WARM_SESSION_USES` / `WARM_REFILL_*` | `3` / `4` / … | Pre-warming & staggering |
| `RATE_BURST` / `RATE_REFILL_MS` / `RATE_MIN_GAP_MS` / `RATE_JITTER_MS` | `4` / `6000` / `1500` / `500` | Pacing & bucket |
| `RATE_COOLDOWN_MS` / `RATE_COOLDOWN_MAX_MS` / `RATE_MAX_WAIT_MS` | `45000` / `300000` / `35000` | Throttle backoff |
| `WATCHDOG_MS` / `WATCHDOG_JITTER_MS` | `120000` / `20000` | Liveness probes |
| `STREAM_HOLD_BACK` | `32` | Stream tool-call safety buffer |
| `LOG_REQUESTS` | — | `1` = lightweight logs (no bodies/secrets) |

> Full list including signup/captcha/mailbox variables: [`.env.example`](.env.example) and [tutos/SETUP.md](tutos/SETUP.md).

---

## 🧬 Token lifecycle & limits

- **No refresh token**: only login/register/oauth mint a `userToken` — tokens are replaced, not refreshed.
- **`40003` is ambiguous**: revocation (re-login may help) vs **suspension** (all endpoints fail, wait it out) — the proxy distinguishes, backs off, and reports state in `/health`.
- **Silent throttling**: empty responses after bursts; the proxy paces, waits, and retries (progressive backoff).
- **Anti-suspension is not guaranteed**: pacing/jitter/gaps, session reuse, staggered pre-warm and watchdog reduce signals but cannot eliminate policy risk.

> [!WARNING]
> Keep volume low and human-like, prefer clean/residential egress when needed, and avoid sustained automated loops.

---

## 🗂️ Repository layout

```text
server.js                 HTTP server, routing, handlers, orchestration
lib/
  deepseek.js             Upstream client (challenge/session/completion, proxy tunnel)
  pow.js                  WASM PoW solver
  stream.js               SSE assembly → fragments
  streamgate.js           Stream hold-back / tool-call marker detection
  tools.js                Tool emulation (prompt, JSON/DSML parsing, transcript)
  compat.js               Anthropic/Vertex format translation helpers
  tokenizer.js            Heuristic token estimator (count endpoints)
  body.js                 Request body parsing (byte limits/timeouts)
  security.js             Redaction and basic security helpers
  pool.js                 Token pool, hot-reload, swap/re-login
  ratelimit.js            Bucket + mutex + pacing/jitter/cooldown
  warm.js                 Pre-warm challenges/sessions
  watchdog.js             Liveness probe, triggers re-login
  auth.js / signup.js     Login and signup (experimental)
  captcha.js / mailbox.js Captcha solvers & verification-code readers
  metrics.js / env.js     Metrics and .env loading
scripts/                  login, signup, tests, bench, probes
tutos/                    Integration guides (OpenCode, Cursor, Cline, Aider, etc.)
CHANGELOG.md              Project change history
run.sh                    start/restart helper (pidfile)
```

---

## 🐳 Docker

```bash
docker build -t free-deepseek-api .
docker run -p 8787:8787 -e API_KEY=sk-local -v "$PWD/tokens.txt:/app/tokens.txt:ro" free-deepseek-api
# or
docker compose up -d --build
```

## ✅ Tests

```bash
npm run test:offline   # parsers + streamgate + PoW (no network)
npm run test:all       # offline + signup gate smoke (network)
node --check server.js lib/*.js scripts/*.js
```

---

<div align="center">

**[GLWTS](LICENSE)** · *Good luck with that shit. Use responsibly.*

</div>
