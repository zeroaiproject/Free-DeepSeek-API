# Free DeepSeek API

An OpenAI-compatible HTTP server that talks to `chat.deepseek.com` with a normal
web account token. No API key from DeepSeek, no credit card, no rate plan.

It solves DeepSeek's `DeepSeekHashV1` proof-of-work natively (the original
`sha3_wasm_bg` module, executed as-is) and relays the SSE stream as
OpenAI `chat.completion` / `chat.completion.chunk` objects.

```
your app  ──OpenAI format──▶  this proxy  ──PoW + bearer token──▶  chat.deepseek.com
```

Zero npm dependencies. Node 18+.

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

---

## Configuration

All optional, read from the environment (`.env` is not auto-loaded; use your
process manager or `export`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `API_KEY` | *(empty)* | If set, clients must send `Authorization: Bearer <key>` |
| `DEFAULT_MODEL` | `deepseek-chat` | Model when the request omits `model` |
| `DEEPSEEK_TOKENS` | — | Comma/space separated tokens (merged with `tokens.txt`) |
| `DEEPSEEK_TOKENS_FILE` | `./tokens.txt` | Extra token file |
| `WARM_POOL` | `3` | Pre-fetched PoW challenges kept per token (`0` disables) |
| `WARM_SESSION_USES` | `100` | Reuse a session this many times before rotating |
| `DEEPSEEK_PROXY` | — | Route upstream calls through `http://[user:pass@]host:port` |
| `DEEPSEEK_EMAIL` | — | Account email, enables automatic re-login |
| `DEEPSEEK_PASSWORD` | — | Account password, enables automatic re-login |
| `DEEPSEEK_TOKEN_PERSIST` | — | `1` writes a re-login token back to `tokens.txt` |
| `DEBUG_BODY_DIR` | — | Dump each incoming request body there (debugging) |

Multiple tokens are load-balanced round-robin. A token that returns
`INVALID_TOKEN` is benched with exponential backoff and the request is retried
on the next token. When every token is cooling down the request waits up to 2 s
for the soonest one instead of failing immediately.

`tokens.txt` is watched: paste a new token and the running server picks it up on
the next request, no restart needed.

---

## Token lifetime

DeepSeek revokes web tokens aggressively. Two causes, in order of importance:

**1. Datacenter IPs.** A token issued from a residential connection and used
from a hosting provider (OVH, Hetzner, AWS…) is killed within minutes — and the
account gets logged out of the browser too. You can check whether an IP is
flagged before blaming the token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://chat.deepseek.com/
```

`202` with an empty body means the anti-bot gate is up for that IP; a normal IP
gets `200` and the app HTML.

Route the upstream through a clean IP:

```bash
DEEPSEEK_PROXY=http://user:pass@residential-proxy:8080 node server.js
```

Every upstream call then goes through a `CONNECT` tunnel, so DeepSeek sees the
proxy's address. Verified working (the TLS handshake and the API response come
back through the tunnel unchanged).

**2. Session rotation.** Logging in again, or refreshing the web app in a way
that mints a new token, invalidates the old one. Keep the tab closed after
copying the token.

If the account has a password, let the proxy repair itself:

```bash
DEEPSEEK_EMAIL=you@example.com \
DEEPSEEK_PASSWORD=… \
DEEPSEEK_TOKEN_PERSIST=1 \
node server.js
```

On a `40003 INVALID_TOKEN` the server logs in again, swaps the token in the
pool, optionally rewrites `tokens.txt`, and retries the request. One re-login is
shared by all concurrent requests.

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

A streamed tool call must not be sent as text. The proxy holds the first
characters until they reveal the shape: `{`, ```` ``` ````, `<｜` or `<|` means a
tool call (the rest is buffered and converted), anything else means prose and is
streamed normally with no added latency. Only the initial bytes are delayed.

### Tests

```bash
node scripts/test-parsers.js   # 11 parser cases, offline, no token
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

DeepSeek silently returns an **empty answer** (no error) after ~5 requests fired
back-to-back on one account; it recovers within ~30 s. The benchmark spaces
requests with `BENCH_DELAY_MS` (default 3000) and retries an empty run once.
Space your own traffic, or run more tokens in the pool.

---

## Layout

```
server.js                     HTTP server, OpenAI compatibility layer
lib/deepseek.js               chat.deepseek.com client (challenge, session, completion)
lib/pow.js                    DeepSeekHash WASM wrapper
lib/stream.js                 SSE fragment assembler
lib/tools.js                  tool-call emulation, JSON + DSML parsers
lib/pool.js                   round-robin token pool, hot reload, re-login swap
lib/auth.js                   email+password login (also used for auto re-login)
lib/sha3_wasm_bg.*.wasm       original PoW module
scripts/login.js              email+password -> userToken (CLI wrapper)
scripts/token-check.js        verify the tokens in tokens.txt are still alive
scripts/pow-selftest.js       offline PoW vector test
scripts/test-parsers.js       offline tool-call parser tests
scripts/test-tools.js         end-to-end tool-calling tests
lib/warm.js                   pre-warm cache (challenges + reusable session)
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
- Each request creates a fresh DeepSeek chat session. Conversation state lives
  in the `messages` array you send — the proxy flattens it into a transcript.
- Accounts can be suspended by DeepSeek for automated traffic. Keep a pool.
- Token format is a raw base64 blob, up to ~72 chars; do not URL-encode it.
- `lib/sha3_wasm_bg.7b9ca65ddd.wasm` is DeepSeek's own artifact, redistributed
  for interoperability.

WTFPL.
