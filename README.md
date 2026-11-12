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

Multiple tokens are load-balanced round-robin. A token that returns
`INVALID_TOKEN` is benched with exponential backoff and the request is retried
on the next token (up to 3 attempts).

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

## Layout

```
server.js                     HTTP server, OpenAI compatibility layer
lib/deepseek.js               chat.deepseek.com client (challenge, session, completion)
lib/pow.js                    DeepSeekHash WASM wrapper
lib/stream.js                 SSE fragment assembler
lib/pool.js                   round-robin token pool with cooldown
lib/sha3_wasm_bg.*.wasm       original PoW module
scripts/login.js              email+password -> userToken
scripts/pow-selftest.js       offline PoW vector test
scripts/raw.js                dump the raw upstream SSE stream
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
