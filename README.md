# Free DeepSeek API

> OpenAI-compatible proxy for `chat.deepseek.com` — **zero npm dependencies**, Node 18+.

Use DeepSeek's web chat behind a standard `/v1/chat/completions` API: streaming, reasoning model, tool calling emulation, token pool, auto re-login, and an experimental account-signup pipeline.

```
your app  ── OpenAI format ──▶  this proxy  ── PoW + bearer token ──▶  chat.deepseek.com
```

- Solves `DeepSeekHashV1` proof-of-work natively (ships the original `sha3_wasm_bg` WASM).
- Relays SSE as OpenAI `chat.completion` / `chat.completion.chunk` (true streaming).
- Emulates `tools` / `tool_choice` (JSON + DSML parsing, stream-safe hold-back).
- Round-robin token pool, rate limiting, liveness watchdog, hot token reload.

---

## Quick start

```bash
git clone https://github.com/zeroaiproject/free-deepseek-api.git
cd free-deepseek-api
cp .env.example .env          # optional
echo "$YOUR_DEEPSEEK_TOKEN" > tokens.txt
./run.sh
```

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Salut, qui es-tu ?"}]
  }'
```

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

---

## Getting a token

The proxy needs a `userToken` — the value DeepSeek's own web app stores in
`localStorage` after login.

**Option A — browser (works with Google/Apple/mobile accounts)**

1. Log in at <https://chat.deepseek.com>.
2. DevTools → Console:

   ```js
   localStorage.getItem('userToken')
   ```

3. Paste the value (it ends with `==` or has `+` `/`), one per line, into
   `tokens.txt`.

**Option B — email + password (no browser)**

```bash
node scripts/login.js you@example.com 'your-password'
```

On success it prints the token, which you append to `tokens.txt`.
Wrong credentials return `PASSWORD_OR_USER_NAME_IS_WRONG`.

> The web login path (`os: "web"`) answers with an empty `HTTP 202` anti-bot
> gate. The app client shape (`os: "android"` + app user-agent) is accepted and
> returns a real `biz_code`, which is what `scripts/login.js` uses.

**Option C — automated signup (experimental)**

```bash
CAPTCHA_PROVIDER=capsolver CAPSOLVER_KEY=... \
node scripts/signup.js --email you@gmail.com --mailbox imap --persist
```

This drives the real web registration flow: it solves the guest proof-of-work,
asks DeepSeek to send the 6-digit code, reads it from your mailbox, and
registers the account. It prints the new `userToken` (and appends it to
`tokens.txt` with `--persist`).

The flow has four gates, and only three are cleared locally:

| gate | status |
| --- | --- |
| guest PoW (`X-DS-Guest-PoW-Response`) | solved here with the shipped WASM, no token needed |
| email domain | must not be disposable — gmail/outlook/yahoo/qq/163/proton are accepted, throwaway domains return `EMAIL_DOMAIN_NOT_SUPPORTED` |
| captcha (`hcaptcha_token`, invisible widget) | **verified server-side**; needs a real solve (see below) |
| mailbox code | read from IMAP, an HTTP endpoint, or a disposable inbox |

Captcha providers (`CAPTCHA_PROVIDER` / `--captcha`):

| provider | needs | notes |
| --- | --- | --- |
| `none` (default) | — | useful for tests; the code request fails with `RECAPTCHA_VERIFY_FAILED` |
| `capsolver` | `CAPSOLVER_KEY` | paid solver |
| `2captcha` | `TWOCAPTCHA_KEY` | paid solver |
| `browser` | `playwright-core` + Chromium (`CHROME_PATH`) | drives the real signup page; the widget may solve itself on a clean residential IP, but a challenged IP gets an image puzzle and needs a human (`CAPTCHA_HEADFUL=1`) |

Mailbox providers (`MAILBOX` / `--mailbox`): `imap` (`IMAP_HOST`, `IMAP_USER`,
`IMAP_PASSWORD`, `IMAP_PORT`, `IMAP_TLS`, `IMAP_MAILBOX`), `http` (polls
`MAILBOX_URL`), `mailtm` (disposable inbox — blocked by the domain gate, so
only useful to observe the rejection).

Smoke test (offline of captcha/mailbox, hits the live PoW + register gates):

```bash
node scripts/test-signup.js
```

> This cannot mint accounts for free from a datacenter IP: the invisible hCaptcha
> escalates to image challenges there and DeepSeek rejects forged tokens. To run
> it unattended you need a paid solver key or a residential/browser session that
> the widget accepts.

---

## Configuration

All optional, read from the environment. A local `.env` file is auto-loaded at
startup (existing environment variables are not overridden).

**Security & credentials:** keep secrets in `.env` / `tokens.txt` (gitignored);
persisted tokens are written atomically with `0600` permissions. Set `API_KEY` to
require clients to send `Authorization: Bearer <key>` (compared in constant time).
`/health` exposes masked token status for operations — protect it like any
internal endpoint if the proxy is reachable beyond localhost. Set
`LOG_REQUESTS=1` for lightweight request logging (method/path/status/latency, no
bodies or secrets). The server sends basic hardening headers (`nosniff`,
`X-Frame-Options: DENY`, `no-referrer`, `no-store`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `API_KEY` | *(empty)* | If set, clients must send `Authorization: Bearer <key>` |
| `DEFAULT_MODEL` | `deepseek-chat` | Model when the request omits `model` |
| `DEEPSEEK_TOKENS` | — | Comma/space separated tokens (merged with `tokens.txt`) |
| `DEEPSEEK_TOKENS_FILE` | `./tokens.txt` | Extra token file |
| `WARM_POOL` | `3` | Pre-fetched PoW challenges kept per token (`0` disables) |
| `WARM_SESSION_USES` | `4` | Reuse a chat session this many times before rotating |
| `WARM_SESSION_POOL` | `1` | Pre-created sessions kept per token |
| `RATE_BURST` | `6` | Back-to-back upstream completions allowed per token |
| `RATE_REFILL_MS` | `5000` | One new slot per token every N ms |
| `RATE_COOLDOWN_MS` | `30000` | Pause after an empty answer (DeepSeek's silent throttle) |
| `RATE_MAX_WAIT_MS` | `35000` | Longest a request will wait for a slot before erroring |
| `WATCHDOG_MS` | `90000` | Liveness probe interval (`0` disables) |
| `STREAM_HOLD_BACK` | `32` | Characters held back while scanning for a tool call |
| `DEEPSEEK_PROXY` | — | Route upstream calls through `http://[user:pass@]host:port` |
| `DEEPSEEK_EMAIL` | — | Account email, enables automatic re-login |
| `DEEPSEEK_PASSWORD` | — | Account password, enables automatic re-login |
| `DEEPSEEK_TOKEN_PERSIST` | — | `1` writes a re-login token back to `tokens.txt` |
| `RELOGIN_BACKOFF_MS` | `600000` | Pause between re-login attempts after a failure |
| `CAPTCHA_PROVIDER` | `none` | `capsolver`, `2captcha` or `browser` for automated signup |
| `CAPSOLVER_KEY` / `TWOCAPTCHA_KEY` | — | API key for the chosen paid captcha solver |
| `HCAPTCHA_SITEKEY` | *(DeepSeek's)* | Override the signup hCaptcha sitekey if it rotates |
| `CHROME_PATH` | — | Chromium binary for the `browser` captcha provider |
| `MAILBOX` | `mailtm` | Signup mailbox: `imap`, `http` or `mailtm` |
| `MAILBOX_URL` | — | JSON endpoint polled by the `http` mailbox |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_USER` / `IMAP_PASSWORD` | — | IMAP inbox used to read the verification code |
| `DEBUG_BODY_DIR` | — | Dump each incoming request body there (debugging) |

Multiple tokens are load-balanced round-robin. A token that returns
`INVALID_TOKEN` is benched for 5 minutes, the watchdog tries to re-mint it from
`DEEPSEEK_EMAIL`/`DEEPSEEK_PASSWORD`, and the request is retried. When every
token is cooling down the request waits briefly for the soonest one instead of
failing immediately.

`tokens.txt` is watched: paste a new token and the running server picks it up on
the next request, no restart needed.

---

## Token lifetime

### There is no refresh token

This is worth stating plainly because it saves a lot of searching. The full
`/api/v0/...` surface was recovered from the Android client, and **only three
endpoints ever mint a `userToken`**:

| endpoint | mints a token from |
| --- | --- |
| `POST /api/v0/users/login` | email + password |
| `POST /api/v0/users/register` | email verification code |
| `POST /api/v0/users/oauth/google/login` | a Google credential |

Everything else is read-only or destructive. `GET /api/v0/users/auth_token/list`
lists sessions and answers `405 Method Not Allowed` to `POST`, `PUT`, `PATCH`
and `DELETE`. `auth_token/create`, `auth_token/refresh`, `auth_token/renew`,
`refresh_token` and `token/refresh` do not exist — they fall through to the SPA
HTML like any other unknown path. No API response ever carries a `Set-Cookie`,
so there is no cookie jar to keep alive either.

A token therefore cannot be refreshed. It can only be **re-minted by logging in
again**, and it does not need refreshing as long as it stays alive.

### Two very different `40003`s

`40003 Authorization Failed` is the same code for two unrelated failures, and
the fix is opposite in each case:

| what happened | how to tell | fix |
| --- | --- | --- |
| the token was revoked | logging in works and returns a new token | re-login |
| **the account was suspended** | the web UI shows a *violation of user policies* notice; logging in also fails | wait, or use another account |

A suspension is account-level: every endpoint returns `40003`, including
`GET /users/auth_token/list`, which works normally with a revoked token. The
account is unusable until the date in the notice. Re-login does not help, so the
proxy backs off (`RELOGIN_BACKOFF_MS`, 10 min), remembers the suspension date,
reports it in `/health` under `auth.suspendedUntil`, and answers
`503 account_suspended` immediately instead of spending retries.

Nothing in this project can prevent a suspension. It is a policy decision made
by DeepSeek's abuse detection, not a rate limit you can tune under. What the
proxy can do is stay small enough to look uninteresting.

### The rate limit is real and separate

Measured on one account, one token, real completions:

| pattern | result |
| --- | --- |
| 8 completions back-to-back | all succeed |
| 9th back-to-back | empty `200` stream (silent throttle, *not* `40003`) |
| 12 completions, 5 s apart | all succeed |
| 20 sequential through the limiter | 20/20, token alive after |

The throttle recovers in ~30 s and never revokes anything by itself. Hammering
past it is still a bad idea, and two things in the proxy used to generate that
burst:

- `warmer` pre-created a fresh chat session per request. Every session is
  another upstream call, so one client request cost three upstream requests.
- Concurrent requests that woke from the same timer all took a slot at once.

Both are fixed:

- **Token bucket** (`lib/ratelimit.js`, burst 6, refill 5000 ms, cooldown 30 s).
  The proxy sits just under the tolerance instead of discovering it.
- **One upstream completion in flight per token.** Agent tool loops are already
  sequential, so this costs nothing and removes overlap entirely.
- **Sessions are reused up to 4 times** (`WARM_SESSION_USES`) instead of one per
  request, cutting upstream traffic by roughly 2.4x.

Tune with `RATE_BURST`, `RATE_REFILL_MS`, `RATE_COOLDOWN_MS`, `RATE_MAX_WAIT_MS`.
When the bucket is empty the request **waits and retries** rather than returning
an error, so a client sees a slow answer instead of a failure.

### Repairing a token that is already dead

The only zero-input repair is a password. Set it once and the proxy re-mints
tokens forever:

```bash
DEEPSEEK_EMAIL=you@example.com \
DEEPSEEK_PASSWORD=… \
DEEPSEEK_TOKEN_PERSIST=1 \
node server.js
```

`lib/watchdog.js` probes `GET /api/v0/users/current` every 90 s (`WATCHDOG_MS`).
On `40003` it marks the token dead, logs in again, swaps it into the pool and
rewrites `tokens.txt`. The same re-login fires inline on any `40003` a request
hits. One re-login is shared by all concurrent requests.

**If the account was created with Google it has no password**, so auto re-login
cannot work. Set one: on `chat.deepseek.com` use *forgot password* with the
account's email, take the code from the inbox, choose a password. That is a
one-time manual step; after it the proxy is self-healing and you never touch it
again. There is no way to do it programmatically — `email_reset_password` needs
a verification code, and requesting one for a disposable domain returns
`EMAIL_DOMAIN_NOT_SUPPORTED` while real domains return `RECAPTCHA_VERIFY_FAILED`
(the captcha is genuinely verified; adding `captcha_token`, `recaptcha_token`,
`turnstile_token` or `hcaptcha_token` changes nothing).

Without a password, keep several tokens in `tokens.txt` from different accounts
and let the pool rotate. Paste a new one and it is picked up without a restart.

### Keeping an account alive

A suspension is triggered by behaviour, so the only defence is to behave like a
person with a browser tab open:

- Keep sustained volume low. An agent loop that fires a completion every few
  seconds for hours is the pattern that gets flagged.
- One account per machine and per IP, not a pool of tokens on one account.
- A residential IP helps; a datacenter IP is an extra signal (see below).
- Don't run the proxy 24/7 against the free web endpoint for production traffic.

### Datacenter IPs

Still worth checking, but it is not the primary cause. A token issued from a
residential connection and used from a hosting provider can be flagged:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://chat.deepseek.com/
```

`202` with an empty body means the anti-bot gate is up for that IP; a clean IP
gets `200` and the app HTML. Route the upstream through a clean IP if needed:

```bash
DEEPSEEK_PROXY=http://user:pass@residential-proxy:8080 node server.js
```

Every upstream call then goes through a `CONNECT` tunnel, so DeepSeek sees the
proxy's address.

---

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI chat completions, streaming and non-streaming |
| `GET` | `/v1/models` | `deepseek-chat`, `deepseek-reasoner` |
| `GET` | `/health` | Liveness + per-token availability |

### Models

| `model` | DeepSeek mode | Reasoning |
| --- | --- | --- |
| `deepseek-chat` | `default` | — |
| `deepseek-reasoner` | `thinking` | Returned as `reasoning_content` |

### Streaming

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"Compte de 1 à 5."}]}'
```

```
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"1"},"finish_reason":null}]}
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":", "},"finish_reason":null}]}
data: {"id":"chatcmpl-…","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

Deltas are relayed as they arrive from DeepSeek — the proxy does not buffer the
whole answer.

---

## Tool calling

The web endpoint has **no native function calling**, so the proxy emulates it:
the tool JSON Schemas are injected as a leading `System:` block, the model is
asked to answer with a single JSON object, and the reply is parsed back into
OpenAI `tool_calls`. The whole `tools` / `tool_choice` / `parallel_tool_calls`
surface works, including the tool-result round trip.

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
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_…",
        "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" }
      }]
    }
  }]
}
```

Send the result back as a `role: "tool"` message and the model answers in plain
text.

| Field | Behaviour |
| --- | --- |
| `tool_choice: "auto"` / omitted | model decides |
| `tool_choice: "none"` | tools are dropped, plain answer |
| `tool_choice: "required"` | at least one call is forced |
| `tool_choice: {"type":"function","function":{"name":"X"}}` | that tool is forced |
| `parallel_tool_calls: false` | extra calls are collapsed to the first one |

### Two output formats are accepted

With a small tool set the model follows the JSON instruction. With a large one
(OpenCode sends 13 tools and a 37 kB system prompt) it sometimes falls back to
its own markup, **DSML**:

```
<||DSML|| calls>
<||DSML|| invoke name="read">
<||DSML|| parameter name="path" string="true">sample.txt</||DSML|| parameter>
</||DSML|| invoke>
</||DSML|| calls>
```

Both are parsed, so tool calls never leak into `content`. The separator is
U+FF5C U+FF5C (fullwidth bars), not ASCII pipes.

### Streaming with tools

A streamed tool call must not be sent as text, and the model sometimes writes
prose *first* and appends the call afterwards — so deciding from the first
character is not enough. `lib/streamgate.js` streams content with a 32-character
tail held back (`STREAM_HOLD_BACK`) and watches the whole text for a marker:
`"tool_calls"`, `｜DSML｜`, ```` ``` ```` or `<|`. The moment one appears,
emission stops and everything after it is buffered for the parser. A marker
split across two SSE chunks is therefore never emitted, because its prefix is
still inside the held-back tail.

### Tests

```bash
node scripts/test-parsers.js    # 11 parser cases, offline, no token
node scripts/test-streamgate.js # 23 streaming hold-back cases, offline
node scripts/test-tools.js     # 8 end-to-end cases against the running proxy
```

---

## Using it from OpenCode

Add the proxy as a provider in `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "providers": {
    "freedeepseek": {
      "name": "Free DeepSeek API",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "http://127.0.0.1:8787/v1",
        "apiKey": "public"
      },
      "compatibility": { "reasoningField": "reasoning_content" },
      "models": {
        "deepseek-chat": {
          "name": "DeepSeek Chat (Free)",
          "limit": { "context": 128000, "output": 8192 },
          "cost": { "input": 0, "output": 0 },
          "capabilities": {
            "tools": true,
            "input": ["text"],
            "output": ["text"],
            "reasoning": { "supported": false }
          }
        },
        "deepseek-reasoner": {
          "name": "DeepSeek Reasoner (Free)",
          "limit": { "context": 128000, "output": 32768 },
          "cost": { "input": 0, "output": 0 },
          "capabilities": {
            "tools": true,
            "input": ["text"],
            "output": ["text"],
            "reasoning": { "supported": true, "toggle": false }
          }
        }
      }
    }
  }
}
```

Then:

```bash
opencode models | grep freedeepseek
opencode run --model freedeepseek/deepseek-chat --auto "Read sample.txt and count its lines."
```

The proxy needs no API key, but OpenCode's OpenAI-compatible client requires a
non-empty one, hence `"apiKey": "public"`.

---

## Drop-in OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")

r = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Explique le PoW en deux phrases."}],
)
print(r.choices[0].message.content)
```

```js
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'not-needed' });
const r = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: 'Explique le PoW en deux phrases.' }],
});
console.log(r.choices[0].message.content);
```

---

## How it works

DeepSeek refuses `/api/v0/chat/completion` unless the request carries an
`X-Ds-Pow-Response` header proving work was done. The flow is:

1. `POST /api/v0/chat/create_pow_challenge` `{ target_path }`
   → `{ algorithm, challenge, salt, signature, difficulty, expire_at, target_path }`
2. Solve: find `answer` in `[0, difficulty]` such that the DeepSeek hash of
   `"<salt>_<expire_at>_<answer>"` equals `challenge`.
3. Base64 of `{ algorithm, challenge, salt, answer, signature, target_path }`
   becomes `X-Ds-Pow-Response`.
4. `POST /api/v0/chat_session/create` → `chat_session.id`
5. `POST /api/v0/chat/completion` → SSE stream.

Step 2 is **not** SHA-256 and **not** NIST SHA3-256 — it is a custom Keccak
variant compiled to WebAssembly (`wasm_solve`). It cannot be reproduced with
`node:crypto`, so `lib/sha3_wasm_bg.7b9ca65ddd.wasm` is shipped and executed
directly. A 144 000-iteration search takes ~110 ms.

Verify the module end-to-end without touching the network:

```bash
npm run test:pow
# answer=137201 expected=137201 in 107ms
# POW SELFTEST OK
```

### SSE shapes handled

```
{"v":{"response":{...,"fragments":[{type,content}]}}}                    snapshot
{"v":"..."}                                                              append to last fragment
{"p":"response/fragments","v":[{...}]}                                   fragment list replace
{"p":"response/fragments/-1/content","o":"APPEND","v":"..."}             targeted append
{"p":"response","o":"BATCH","v":[...]}                                   ignored
{"p":"response/status","o":"SET","v":"FINISHED"}                         ignored
```

Fragments typed `THINK` are split out into `reasoning_content`; everything else
becomes `content`.

---

## Performance

Measured on the reference machine (single token, `WARM_POOL=3`, wired network),
against `chat.deepseek.com` over TLS:

```bash
node scripts/bench.js 5 short     # short answers
node scripts/bench.js 3 long      # ~1200-token answers
```

| Metric | Cold cache | Warm cache |
| --- | --- | --- |
| **TTFT** (client → first content token) | 963 ms | **764 ms** |
| Proxy prep before upstream request | 363 ms | **43 ms** |
| Decode throughput (sustained) | — | **166 tok/s** |
| Wall throughput (incl. TTFT) | — | **144 tok/s** |
| End-to-end, 1 150-token answer | — | 8.0 s |

Per-run, long profile:

```
#1  ttft 642 ms  total 9.07 s  tok 1293  decode 157.9 tok/s  wall 142.6 tok/s
#2  ttft 859 ms  total 7.52 s  tok 1135  decode 170.9 tok/s  wall 150.9 tok/s
#3  ttft 856 ms  total 8.02 s  tok 1152  decode 166.1 tok/s  wall 143.7 tok/s
```

### Where the TTFT goes (warm)

```
  43 ms  prep    solve the pre-fetched PoW (single-use, ~30-90 ms)
 320 ms  TTFB    upstream TLS + request accept
 400 ms  prefill DeepSeek starts emitting the first fragment
─────
 764 ms
```

### The pre-warm cache

`lib/warm.js` keeps, per token:

- a queue of **unsolved challenges** (valid 300 s, consumed only by the
  completion that uses them) — removes a 290 ms round-trip;
- **one reusable session** — `parent_message_id: null` makes every completion a
  new branch from the root, so no history leaks between requests (verified),
  and the session is rotated every `WARM_SESSION_USES` calls.

A solved `X-Ds-Pow-Response` is **single-use** — replaying it returns
`40301 INVALID_POW_RESPONSE` — so the solve itself cannot be cached.

Set `WARM_POOL=0` to disable and measure the cold path.

### Instrumentation

Streaming responses carry timing headers:

| Header | Meaning |
| --- | --- |
| `X-Ds-Session-Ms` | time spent acquiring a session |
| `X-Ds-Challenge-Ms` | time spent fetching the PoW challenge |
| `X-Ds-Solve-Ms` | time spent solving the PoW |
| `X-Ds-Prep-Ms` | `max(session, challenge) + solve` |
| `X-Ds-Upstream-Ttfb-Ms` | proxy → first byte from DeepSeek |

### Upstream rate limit

DeepSeek silently returns an **empty answer** (no error) after 8 requests fired
back-to-back on one account; it recovers within ~30 s. Hammering past that point
is what gets the token revoked, so the proxy enforces its own budget instead:
`lib/ratelimit.js` (token bucket, burst 6, refill 5 s) plus one upstream
completion in flight per token. An empty answer engages a 30 s cooldown and the
request is retried, so the client sees latency rather than a 429.

The benchmark spaces requests with `BENCH_DELAY_MS` (default 3000) and retries an
empty run once.

---

## Layout

```
server.js                     HTTP server, OpenAI compatibility layer
lib/deepseek.js               chat.deepseek.com client (challenge, session, completion)
lib/pow.js                    DeepSeekHash WASM wrapper
lib/stream.js                 SSE fragment assembler
lib/tools.js                  tool-call emulation, JSON + DSML parsers
lib/pool.js                   round-robin token pool, hot reload, re-login swap
lib/ratelimit.js              token bucket + per-token upstream mutex
lib/watchdog.js               liveness probe, triggers re-login on 40003
lib/streamgate.js             content hold-back / tool-call detection while streaming
lib/auth.js                   email+password login (also used for auto re-login)
lib/signup.js                 automated signup (guest PoW + code request + register)
lib/captcha.js                hCaptcha solver facade (capsolver / 2captcha / browser)
lib/mailbox.js                verification-code readers (IMAP / HTTP poll / mail.tm)
lib/warm.js                   pre-warm cache (challenges + reusable session)
lib/sha3_wasm_bg.*.wasm       original PoW module
scripts/login.js              email+password -> userToken (CLI wrapper)
scripts/signup.js             automated signup -> userToken
scripts/token-check.js        verify the tokens in tokens.txt are still alive
scripts/pow-selftest.js       offline PoW vector test
scripts/test-parsers.js       offline tool-call parser tests
scripts/test-streamgate.js    offline streaming hold-back tests
scripts/test-signup.js        signup gate smoke tests (guest PoW / 40300 / biz codes)
scripts/test-tools.js         end-to-end tool-calling tests
scripts/bench.js              TTFT / tokens-per-second benchmark
scripts/raw.js                dump the raw upstream SSE stream
scripts/replay.js             replay a captured request upstream
scripts/dump-tool-format.js   inspect the tool-call format the model picks
scripts/order-test.js         session vs PoW ordering check
scripts/reuse-test.js         PoW/session reuse semantics
run.sh                        start/restart with a pidfile
```

---

## Docker

```bash
docker build -t free-deepseek-api .
docker run -p 8787:8787 -e API_KEY=sk-local free-deepseek-api
```

---

## Notes and limits

- `usage` counters mirror DeepSeek's `accumulated_token_usage`; DeepSeek does not
  report prompt/completion split, so all three fields carry the same number.
- Chat sessions are reused up to 4 times, then rotated. Conversation state lives
  in the `messages` array you send — the proxy flattens it into a transcript, so
  no history leaks between callers.
- Accounts can be suspended by DeepSeek for automated traffic. Keep a pool.
- Token format is a raw base64 blob, up to ~72 chars; do not URL-encode it.
- `lib/sha3_wasm_bg.7b9ca65ddd.wasm` is DeepSeek's own artifact, redistributed
  for interoperability.

WTFPL.
