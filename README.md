<div align="center">

# Free DeepSeek API

**OpenAI-compatible proxy for `chat.deepseek.com`**  
*Zero npm dependencies · Node 18+ · Native PoW (WASM) · Streaming · Tools · Token pool*

[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![API](https://img.shields.io/badge/API-OpenAI%20compatible-412991?logo=openai&logoColor=white)](#endpoints)
[![License](https://img.shields.io/badge/license-GLWTS-blueviolet)](LICENSE)

<br/>

```text
your app  ── OpenAI format ──▶  this proxy  ── PoW + bearer token ──▶  chat.deepseek.com
```

[Quick start](#-quick-start) · [Get a token](#-getting-a-token) · [Configuration](#%EF%B8%8F-configuration) · [Tool calling](#-tool-calling) · [OpenCode](#-using-it-from-opencode) · [How it works](#-how-it-works)

</div>

---

## ✨ Highlights

| | Feature | Details |
|:--:|---|---|
| ⚡ | **True streaming** | Relays DeepSeek SSE as OpenAI `chat.completion.chunk` deltas (no buffering). |
| 🧠 | **Reasoning model** | `deepseek-reasoner` / thinking mode → `reasoning_content`. |
| 🛠️ | **Tool calling (emulated)** | `tools`, `tool_choice`, `parallel_tool_calls`, tool-result round trip (JSON + DSML parsing, stream-safe hold-back). |
| 🔐 | **Native PoW** | Solves `DeepSeekHashV1` with the original `sha3_wasm_bg` WASM (~30–110 ms). |
| 🔁 | **Resilient by design** | Round-robin token pool, per-token rate limiter + mutex, warm cache, liveness watchdog, hot token reload, optional auto re-login. |
| 🧩 | **Drop-in** | Works with OpenAI SDKs and OpenCode; exposes `/v1/chat/completions`, `/v1/models`, `/health`. |
| 🧪 | **Experimental signup** | Guest-PoW + code-request + register pipeline (captcha & mailbox gates documented). |

> [!NOTE]
> This project talks to the **web** endpoint (`chat.deepseek.com`) with user tokens. Keep usage moderate and respect DeepSeek’s policies — automated traffic can lead to account suspension.

---

## 🚀 Quick start

```bash
git clone https://github.com/zeroaiproject/free-deepseek-api.git
cd free-deepseek-api
cp .env.example .env                 # optional (auto-loaded at startup)
echo "$YOUR_DEEPSEEK_TOKEN" > tokens.txt
./run.sh                             # or: npm start
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Salut, qui es-tu ?"}]
  }'
```

<details>
<summary><b>Example response</b></summary>

```json
{
  "id": "chatcmpl-377eec9833d6424096b38aaf349a1d05",
  "object": "chat.completion",
  "model": "deepseek-chat",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "Je suis DeepSeek, un assistant IA créé par DeepSeek." },
    "finish_reason": "stop"
  }]
}
```
</details>

**Streaming**

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"Compte de 1 à 5."}]}'
```

---

## 🔑 Getting a token

The proxy needs a **`userToken`** — the value DeepSeek’s web app stores in `localStorage` after login.

### Option A — Browser (Google / Apple / mobile accounts)

1. Log in at <https://chat.deepseek.com>
2. DevTools → Console:
   ```js
   localStorage.getItem('userToken')
   ```
3. Paste the value (raw base64 blob, e.g. ends with `==` / contains `+` `/` — **do not URL-encode**), one per line, into `tokens.txt`.

### Option B — Email + password (no browser)

```bash
node scripts/login.js you@example.com 'your-password'
# append the printed token to tokens.txt
```

> The web login path (`os: "web"`) can hit an HTTP `202` anti-bot gate. The CLI uses the app client shape (`os: "android"` + app UA) to obtain a real `biz_code`.

### Option C — Automated signup *(experimental)*

```bash
CAPTCHA_PROVIDER=capsolver CAPSOLVER_KEY=... \
node scripts/signup.js --email you@gmail.com --mailbox imap --persist
```

Drives the real web registration flow: **guest PoW** → request 6‑digit code → read mailbox → register. Prints (and optionally persists) the new `userToken`.

| Gate | Status |
|---|---|
| Guest PoW (`X-DS-Guest-PoW-Response`) | ✅ solved locally (shipped WASM, no token) |
| Email domain | ⚠️ must not be disposable (`gmail/outlook/yahoo/qq/163/proton` OK; throwaway → `EMAIL_DOMAIN_NOT_SUPPORTED`) |
| Captcha (`hcaptcha_token`, invisible) | 🚧 **server-verified** — needs a real solve |
| Mailbox code | ✅ IMAP / HTTP poll / mail.tm reader |

<details>
<summary><b>Captcha & mailbox providers</b></summary>

**Captcha** (`CAPTCHA_PROVIDER` / `--captcha`): `none` (default, tests → `RECAPTCHA_VERIFY_FAILED`), `capsolver` (`CAPSOLVER_KEY`), `2captcha` (`TWOCAPTCHA_KEY`), `browser` (`playwright-core` + `CHROME_PATH`, `CAPTCHA_HEADFUL=1`; may self-solve on a clean residential IP, else needs a human/puzzle).

**Mailbox** (`MAILBOX` / `--mailbox`): `imap` (`IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_PORT`, `IMAP_TLS`, `IMAP_MAILBOX`), `http` (`MAILBOX_URL`), `mailtm` (disposable — domain-blocked, useful to observe rejection).

```bash
node scripts/test-signup.js   # smoke: guest PoW + register/code gates (no captcha/mailbox)
```

> Cannot mint accounts for free from a typical datacenter IP: the invisible hCaptcha escalates to image challenges and forged tokens are rejected. Unattended signup needs a paid solver key or a residential/browser session the widget accepts.
</details>

---

## ⚙️ Configuration

All variables are optional and read from the environment. A local **`.env` is auto-loaded** at startup (existing env vars are not overridden).

> **Security & credentials:** keep secrets in `.env` / `tokens.txt` (gitignored). Persisted tokens are written **atomically with `0600`** permissions. Set `API_KEY` to require `Authorization: Bearer <key>` (constant-time compare). Protect `/health` if exposed beyond localhost (it shows masked token status). `LOG_REQUESTS=1` enables lightweight request logs (method/path/status/latency — no bodies/secrets). Hardening headers: `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, `no-store`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `API_KEY` | *(empty)* | Require clients to send `Authorization: Bearer <key>` |
| `DEFAULT_MODEL` | `deepseek-chat` | Model when the request omits `model` |
| `DEEPSEEK_TOKENS` | — | Comma/space separated tokens (merged with `tokens.txt`) |
| `DEEPSEEK_TOKENS_FILE` | `./tokens.txt` | Token file (hot-reloaded) |
| `WARM_POOL` | `3` | Pre-fetched PoW challenges per token (`0` disables) |
| `WARM_SESSION_USES` | `4` | Reuse a chat session N times before rotating |
| `WARM_SESSION_POOL` | `1` | Pre-created sessions kept per token |
| `WARM_REFILL_DELAY_MS` | `750` | Base delay between background warm refills (anti-burst) |
| `WARM_REFILL_JITTER_MS` | `600` | Jitter added to warm refills |
| `RATE_BURST` | `4` | Short burst allowance per token (lower = steadier/human-like) |
| `RATE_REFILL_MS` | `6000` | One new slot per token every N ms |
| `RATE_COOLDOWN_MS` | `45000` | Base pause after an empty answer (silent throttle) |
| `RATE_COOLDOWN_MAX_MS` | `300000` | Cap for escalated cooldown on repeated throttles |
| `RATE_JITTER_MS` | `500` | Random jitter added to waits/cooldowns (breaks fixed cadence) |
| `RATE_MIN_GAP_MS` | `1500` | Minimum gap between completions per token |
| `RATE_MAX_WAIT_MS` | `35000` | Max wait for a slot before erroring |
| `WATCHDOG_MS` | `120000` | Liveness probe interval (`0` disables) |
| `WATCHDOG_JITTER_MS` | `20000` | Jitter on probe schedule (avoids periodic pings) |
| `STREAM_HOLD_BACK` | `32` | Chars held back while scanning for a tool call |
| `DEEPSEEK_PROXY` | — | Upstream via `http://[user:pass@]host:port` (CONNECT tunnel) |
| `DEEPSEEK_EMAIL` / `DEEPSEEK_PASSWORD` | — | Enable automatic re-login on `40003` |
| `DEEPSEEK_TOKEN_PERSIST` | — | `1` writes a re-minted token back to `tokens.txt` |
| `RELOGIN_BACKOFF_MS` | `600000` | Backoff between re-login attempts after failure |
| `CAPTCHA_PROVIDER` | `none` | `capsolver` · `2captcha` · `browser` (signup) |
| `CAPSOLVER_KEY` / `TWOCAPTCHA_KEY` | — | Paid captcha solver key |
| `HCAPTCHA_SITEKEY` / `CHROME_PATH` | — | Signup captcha overrides / browser binary |
| `MAILBOX` | `mailtm` | `imap` · `http` · `mailtm` (signup) |
| `MAILBOX_URL` | — | JSON endpoint polled by `http` mailbox |
| `IMAP_HOST/PORT/USER/PASSWORD` | — | IMAP inbox for verification code |
| `LOG_REQUESTS` | — | `1` = lightweight request logging |
| `DEBUG_BODY_DIR` | — | Dump incoming request bodies (debugging) |

Tokens are load-balanced round-robin. A revoked token is benched and (if credentials are set) re-minted; the request waits briefly for a slot instead of failing immediately. `tokens.txt` is watched — paste a token, no restart needed.

---

## 🔌 Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` · `/v1` | Service info (HTML for browsers, JSON for API clients) |
| `GET` | `/health` | Liveness, version/uptime, masked token/warm/rate/watchdog/auth **+ metrics** |
| `GET` | `/metrics` | Prometheus text metrics (or JSON with `Accept: application/json`) |
| `GET` | `/v1/models` | `deepseek-chat`, `deepseek-reasoner` (with capability hints) |
| `POST` | `/v1/chat/completions` | OpenAI chat completions (stream & non-stream), `tools` supported |

| `model` | DeepSeek mode | Reasoning |
| --- | --- | --- |
| `deepseek-chat` | `default` | — |
| `deepseek-reasoner` | `thinking` | Returned as `reasoning_content` |

---

## 🛠️ Tool calling

The web endpoint has **no native function calling**, so the proxy emulates it: tool JSON Schemas are injected into the prompt, the reply is parsed back into OpenAI `tool_calls`. Supports `tools`, `tool_choice`, `parallel_tool_calls`, and the tool-result round trip.

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
        "description": "Current weather for a city",
        "parameters": { "type": "object", "properties": {"city": {"type":"string"}}, "required": ["city"] }
      }
    }]
  }'
```

<details>
<summary><b>Behavior & format details</b></summary>

| Field | Behaviour |
| --- | --- |
| `tool_choice: "auto"` / omitted | model decides |
| `tool_choice: "none"` | tools dropped, plain answer |
| `tool_choice: "required"` | at least one call forced |
| `tool_choice: {"type":"function","function":{"name":"X"}}` | that tool forced |
| `parallel_tool_calls: false` | collapsed to the first call |

**Two output formats parsed:** requested JSON and DeepSeek’s native **DSML** markup (`<｜DSML｜ invoke ...>` with fullwidth bars, not ASCII). Both are accepted so tool calls never leak into `content`.

**Streaming with tools:** `lib/streamgate.js` emits content with a short tail held back (`STREAM_HOLD_BACK`) and stops on markers (`"tool_calls"`, `｜DSML｜`, fences, `<|`), so a marker split across SSE chunks is never leaked.

```bash
node scripts/test-parsers.js     # 11 parser cases (offline)
node scripts/test-streamgate.js  # 23 streaming hold-back cases (offline)
node scripts/test-tools.js       # 8 end-to-end cases (running proxy)
```
</details>

---

## 🧩 Using it from OpenCode

Add the proxy as a provider in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "providers": {
    "freedeepseek": {
      "name": "Free DeepSeek API",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:8787/v1", "apiKey": "public" },
      "compatibility": { "reasoningField": "reasoning_content" },
      "models": {
        "deepseek-chat": {
          "name": "DeepSeek Chat (Free)",
          "limit": { "context": 128000, "output": 8192 },
          "cost": { "input": 0, "output": 0 },
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"], "reasoning": { "supported": false } }
        },
        "deepseek-reasoner": {
          "name": "DeepSeek Reasoner (Free)",
          "limit": { "context": 128000, "output": 32768 },
          "cost": { "input": 0, "output": 0 },
          "capabilities": { "tools": true, "input": ["text"], "output": ["text"], "reasoning": { "supported": true, "toggle": false } }
        }
      }
    }
  }
}
```

```bash
opencode models | grep freedeepseek
opencode run --model freedeepseek/deepseek-chat --auto "Read sample.txt and count its lines."
```

> The proxy needs no API key, but the OpenAI-compatible client requires a non-empty one — hence `"apiKey": "public"`.

---

## 📦 Drop-in OpenAI SDK

<details open>
<summary><b>Python</b></summary>

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")

r = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Explique le PoW en deux phrases."}],
)
print(r.choices[0].message.content)
```
</details>

<details>
<summary><b>Node.js</b></summary>

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'not-needed' });
const r = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Explique le PoW en deux phrases.' }],
});
console.log(r.choices[0].message.content);
```
</details>

---

## 🔬 How it works

DeepSeek requires an `X-Ds-Pow-Response` proof-of-work for `/api/v0/chat/completion`:

1. `POST /api/v0/chat/create_pow_challenge` `{ target_path }` → challenge (`algorithm, challenge, salt, signature, difficulty, expire_at, target_path`)
2. Solve: find `answer` in `[0, difficulty]` such that the DeepSeek hash of `"<salt>_<expire_at>_<answer>"` equals `challenge`
3. Base64 of `{ algorithm, challenge, salt, answer, signature, target_path }` → `X-Ds-Pow-Response`
4. `POST /api/v0/chat_session/create` → `chat_session.id`
5. `POST /api/v0/chat/completion` → SSE stream

Step 2 is **not** SHA-256 / NIST SHA3 — it’s a custom Keccak variant compiled to WASM (`wasm_solve`). `lib/sha3_wasm_bg.7b9ca65ddd.wasm` is shipped and executed as-is.

```bash
npm run test:pow       # offline PoW selftest
npm run test:offline   # parsers + streamgate + PoW (no network)
npm run test:all       # offline + signup gate smoke test
```

<details>
<summary><b>SSE shapes handled</b> · <b>Pre-warm & timing</b> · <b>Performance</b></summary>

**SSE shapes**

```text
{"v":{"response":{...,"fragments":[{type,content}]}}}            snapshot
{"v":"..."}                                                      append to last fragment
{"p":"response/fragments","v":[{...}]}                           fragment list replace
{"p":"response/fragments/-1/content","o":"APPEND","v":"..."}     targeted append
{"p":"response","o":"BATCH","v":[...]}                           ignored
{"p":"response/status","o":"SET","v":"FINISHED"}                 ignored
```
`THINK` fragments → `reasoning_content`; others → `content`.

**Pre-warm & instrumentation**

`lib/warm.js` keeps per token a queue of unsolved challenges (300 s, one-time use) and reusable sessions (`parent_message_id: null`, rotated every `WARM_SESSION_USES`). Solved PoW is single-use (replay → `40301 INVALID_POW_RESPONSE`).

Streaming responses carry: `X-Ds-Session-Ms`, `X-Ds-Challenge-Ms`, `X-Ds-Solve-Ms`, `X-Ds-Prep-Ms`, `X-Ds-Upstream-Ttfb-Ms`.

**Measured (reference, 1 token, `WARM_POOL=3`, wired)**

| Metric | Cold | Warm |
| --- | ---: | ---: |
| **TTFT** (client → first token) | 963 ms | **764 ms** |
| Proxy prep before upstream | 363 ms | **43 ms** |
| Decode throughput (sustained) | — | **166 tok/s** |
| Wall throughput (incl. TTFT) | — | **144 tok/s** |
| End-to-end, ~1.15k-token answer | — | **8.0 s** |

```bash
node scripts/bench.js 5 short
node scripts/bench.js 3 long
```
</details>

---

## 🧬 Token lifetime & limits

<details>
<summary><b>There is no refresh token · Two kinds of <code>40003</code> · Rate limit vs suspension</b></summary>

**No refresh token.** Only `POST /api/v0/users/login`, `/users/register`, and `/users/oauth/google/login` mint a `userToken`. `auth_token/list` is GET-only; `auth_token/create|refresh|renew` don’t exist. A token can’t be refreshed — only re-minted by logging in again (or kept alive).

**Two different `40003 Authorization Failed`:**
- *Token revoked* → re-login works and returns a new token.
- *Account suspended* (policy violation) → every endpoint returns `40003` (incl. `auth_token/list`), re-login won’t help until the suspension ends. The proxy backs off (`RELOGIN_BACKOFF_MS`), records `auth.suspendedUntil` in `/health`, and returns `503 account_suspended`.

**Rate limit (real, separate):** ~8 back-to-back completions OK, 9th → empty `200` stream (silent throttle, recovers ~30 s, not `40003`). The proxy enforces a token bucket (`RATE_BURST`/`RATE_REFILL_MS`), 30 s cooldown on empty answers, **one upstream completion in flight per token**, and session reuse — requests wait/retry instead of failing.

**Repairing a dead token:** set `DEEPSEEK_EMAIL` + `DEEPSEEK_PASSWORD` (+ `DEEPSEEK_TOKEN_PERSIST=1`) for automatic re-mint (watchdog every `WATCHDOG_MS` and inline on `40003`). Google-only accounts have no password — set one once via web “forgot password” (one-time manual step). Without a password, keep a pool of tokens from different accounts. Use `DEEPSEEK_PROXY` for a clean/residential egress if needed.
</details>

> [!WARNING]
> **No anti-suspension is foolproof.** Account suspension is a server-side policy decision. The proxy reduces obvious automation signals (conservative pacing, jittered waits/cooldowns, minimum gaps, escalating backoff on throttles, staggered warm refills/watchdog probes, one in-flight completion per token, session reuse) and recovers from plain token revocation — but it cannot guarantee an account won’t be suspended. Keep volume low and human-like, prefer residential egress, and avoid sustained automated loops.

---

## 🗂️ Layout

```text
server.js                     HTTP server, OpenAI compatibility layer
lib/deepseek.js               chat.deepseek.com client (challenge, session, completion)
lib/pow.js                    DeepSeekHash WASM wrapper
lib/stream.js                 SSE fragment assembler
lib/streamgate.js             content hold-back / tool-call detection while streaming
lib/tools.js                  tool-call emulation, JSON + DSML parsers
lib/pool.js                   round-robin token pool, hot reload, re-login swap
lib/ratelimit.js              token bucket + per-token upstream mutex
lib/watchdog.js               liveness probe, triggers re-login on 40003
lib/warm.js                   pre-warm cache (challenges + reusable session)
lib/env.js                    minimal .env loader (zero-dep)
lib/auth.js                   email+password login (and auto re-login)
lib/signup.js                 automated signup (guest PoW + code request + register)
lib/captcha.js                hCaptcha solver facade (capsolver / 2captcha / browser)
lib/mailbox.js                verification-code readers (IMAP / HTTP poll / mail.tm)
lib/sha3_wasm_bg.*.wasm       original PoW module
scripts/                      login, signup, tests, bench, probes, debug helpers
run.sh                        start/restart with pidfile
```

---

## 🐳 Docker

```bash
docker build -t free-deepseek-api .
docker run -p 8787:8787 -e API_KEY=sk-local -v "$PWD/tokens.txt:/app/tokens.txt:ro" free-deepseek-api
```

Or with Compose (uses `./tokens.txt` and `./.env`):

```bash
docker compose up -d --build
```

---

## 📝 Notes

- `usage` mirrors DeepSeek’s `accumulated_token_usage` (no prompt/completion split reported).
- Sessions are reused (then rotated); conversation state comes from the `messages` you send (flattened transcript) — no cross-request history leaks.
- Token is a raw base64 blob (~≤72 chars); do not URL-encode it.
- `lib/sha3_wasm_bg.7b9ca65ddd.wasm` is DeepSeek’s artifact, redistributed for interoperability.

---

<div align="center">

**[GLWTS](LICENSE)** · *Good luck with that shit. Use responsibly.*

</div>
