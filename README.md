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
┌──────────────┐      OpenAI /v1/chat/completions      ┌──────────────────────┐      PoW + Bearer       ┌───────────────────┐
│  App / Agent │  ───────────────────────────────────▶  │  Free DeepSeek API  │  ────────────────────▶  │ chat.deepseek.com │
│  (SDK, IDE)  │  ◀────────── SSE / JSON ─────────────  │  (this proxy)       │  ◀───── SSE/JSON ─────  │   (web endpoint)  │
└──────────────┘                                        └──────────────────────┘                         └───────────────────┘
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
| 🧩 | **Drop-in** | OpenAI SDKs, curl, and agent integrations (OpenCode, Cursor, Continue, Cline, Aider, Zed, etc.). |

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

The proxy reproduces the `chat.deepseek.com` web flow and exposes it as an OpenAI-compatible API. At a high level: **bearer auth (`userToken`) → per-request PoW → chat session → SSE completion → OpenAI translation**.

```text
Client (SDK/agent)                     Local proxy                         DeepSeek web
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
      │  SSE chunks / OpenAI JSON           │◀──── fragments / patches ─────────┤
      │◀────────────────────────────────────│  assemble + map (THINK/tools)     │
```

### 1) Proof-of-Work (anti-abuse)
Each completion requires an `X-Ds-Pow-Response` header:
1. **Challenge** — `POST /api/v0/chat/create_pow_challenge` with `target_path` → `algorithm, challenge, salt, signature, difficulty, expire_at, target_path`.
2. **Solve** — find `answer ∈ [0, difficulty]` such that `DeepSeekHash(salt_expireAt_answer) == challenge`.
   - Custom Keccak algorithm embedded in `lib/sha3_wasm_bg.7b9ca65ddd.wasm` (executed as-is, **not** standard SHA-256/SHA3).
3. **Proof** — Base64-encoded JSON: `{"algorithm","challenge","salt","answer","signature","target_path"}`.

> Unsolved challenges can be pre-warmed (TTL ~300 s); a solved proof is **single-use**.

### 2) Sessions, context & prompt
4. **Session** — `POST /api/v0/chat_session/create` returns a `chat_session.id` reused for a few requests then rotated (latency/noise trade-off).
5. **Flattened transcript** — the proxy converts OpenAI messages (system/user/assistant/tool) into the text prompt expected by the web endpoint. It advertises up to a **1M token** window (`/v1/models`), but the effective limit depends on the upstream endpoint/account.
6. **Completion** — `POST /api/v0/chat/completion` with `model: default|thinking`, prompt, and params; response is **SSE**.

### 3) SSE → OpenAI translation
The DeepSeek stream (snapshots `response.fragments`, appends `{"v":"..."}`, targeted replacements/patches, status events) is reassembled and mapped:
- `THINK` fragments → `reasoning_content` (`deepseek-reasoner`)
- text fragments → `delta.content` / `message.content`
- end of stream → `finish_reason` (`stop` / `tool_calls`), relayed aggregate `usage`

### 4) Tool calling (emulation)
The web endpoint has no native function calling; the proxy emulates it:
- **Injects** `tools` schemas into a system instruction block (names, JSON Schema, rules, `tool_choice`/`parallel_tool_calls`).
- **Parses** replies into OpenAI `tool_calls` from JSON (`{"tool_calls":[...]}`) **or** native **DSML** markup (`<｜DSML｜ invoke/parameter>`), with argument normalization/coercion.
- **Stream-safe**: `streamgate` holds back a short tail (`STREAM_HOLD_BACK`) and stops text emission once a tool-call marker is detected to prevent markup leaks.
- **Round-trip**: `role:"tool"` messages are reinjected into the transcript for subsequent turns.

### 5) Resilience, pacing & observability
- **Token pool**: round-robin, hot-reload of `tokens.txt`, masked in `/health`, penalties/cooldowns.
- **Rate limiting**: bucket + min gap + jitter + escalating cooldown, **1 in-flight completion per token**, staggered pre-warming of challenges/sessions (absorbs silent throttling and reduces bursty patterns).
- **Watchdog**: jittered liveness probes, distinguishes revocation (recoverable `40003`) from **suspension** (not recoverable), optional auto re-login when credentials are configured.
- **Observability**: `/health`, `/metrics` (Prometheus/JSON), `X-Request-Id`, `X-Ds-*` timings, optional lightweight logs without bodies/secrets.

---

## 🔌 API

| Method | Path | Description |
|---|---|---|
| `GET` | `/`, `/v1` | Service info (HTML for browsers, JSON for clients) |
| `GET` | `/health` | Health, uptime, tokens (masked), warm/rate/watchdog/auth, metrics |
| `GET` | `/metrics` | Prometheus (`text/plain`) or JSON (`Accept: application/json`) |
| `GET` | `/v1/models` | Models and capabilities |
| `POST` | `/v1/chat/completions` | Chat completions (stream/non-stream), `tools` |

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

> **All tutorials: [tutos/](tutos/README.md)** — base `http://127.0.0.1:8787/v1`, models `deepseek-chat` / `deepseek-reasoner`, dummy key `public` if required.

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

All variables are optional. `.env` is **auto-loaded** (without overriding existing vars). Secrets (`.env`, `tokens.txt`) are gitignored; tokens are persisted with mode `0600`.

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address |
| `API_KEY` | — | Protect the proxy (`Authorization: Bearer`) |
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
server.js                 HTTP server, OpenAI layer, routing, metrics
lib/
  deepseek.js             Upstream client (challenge/session/completion, proxy tunnel)
  pow.js                  WASM PoW solver
  stream.js               SSE assembly → fragments
  streamgate.js           Stream hold-back / tool-call marker detection
  tools.js                Tool emulation (prompt, JSON/DSML parsing, transcript)
  pool.js                 Token pool, hot-reload, swap/re-login
  ratelimit.js            Bucket + mutex + pacing/jitter/cooldown
  warm.js                 Pre-warm challenges/sessions
  watchdog.js             Liveness probe, triggers re-login
  auth.js / signup.js     Login and signup (experimental)
  captcha.js / mailbox.js Captcha solvers & verification-code readers
  metrics.js / env.js     Metrics and .env loading
scripts/                  login, signup, tests, bench, probes
tutos/                    Integration guides (OpenCode, Cursor, Cline, Aider, etc.)
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
