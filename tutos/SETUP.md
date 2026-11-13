# Setup — Free DeepSeek API

This guide covers proxy installation, token configuration, and basic verification.

## 1) Prerequisites

- **Node.js ≥ 18** (20/22 recommended) or **Docker**
- A DeepSeek account (`chat.deepseek.com`)
- No npm packages required (zero runtime dependencies)

## 2) Local installation

```bash
git clone https://github.com/zeroaiproject/Free-DeepSeek-API.git
cd free-deepseek-api
cp .env.example .env          # optional (auto-loaded at startup)
```

### Get a token (`userToken`)

**Option A — Browser (recommended, works with Google/Apple/mobile logins)**

1. Sign in at https://chat.deepseek.com
2. Open DevTools → Console and run:
   ```js
   localStorage.getItem('userToken')
   ```
3. Copy the value **as-is** (base64 blob, may contain `+`, `/`, `=` — do not URL-encode) into `tokens.txt` (one per line).

**Option B — Email + password**

```bash
node scripts/login.js you@example.com 'your-password'
# add the printed token to tokens.txt
```

**Option C — Automated signup (experimental)**

```bash
node scripts/signup.js --email you@gmail.com --mailbox imap --captcha capsolver --persist
```

Requires a valid captcha solver (server-verified hCaptcha) and an accessible mailbox (IMAP/HTTP) to read the code. `node scripts/test-signup.js` validates PoW/payload gates without a captcha.

### Start the proxy

```bash
./run.sh
# or
npm start
# or
node server.js
```

Default: `http://127.0.0.1:8787`

## 3) Docker

```bash
docker build -t free-deepseek-api .
docker run -d --name freedeepseek \
  -p 8787:8787 \
  -e API_KEY=sk-local \
  -v "$PWD/tokens.txt:/app/tokens.txt:ro" \
  free-deepseek-api
```

Or with Compose:

```bash
docker compose up -d --build
```

## 4) Verification

```bash
# health / status (masked tokens, rate, watchdog, metrics)
curl http://127.0.0.1:8787/health

# models
curl http://127.0.0.1:8787/v1/models

# completion (non-stream)
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"Ping"}]}'

# streaming
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"Count to 5"}]}'
```

Offline tests (no token required):

```bash
npm run test:offline   # parsers + streamgate + PoW
node --check server.js lib/*.js scripts/*.js
```

## 5) Useful configuration

Edit `.env` (auto-loaded, does not override existing environment variables):

| Variable | Purpose |
|---|---|
| `PORT` / `HOST` | Listen address (`8787`, `0.0.0.0`) |
| `API_KEY` | Protect the proxy (`Authorization: Bearer <key>`) |
| `DEFAULT_MODEL` | `deepseek-chat` (default) or `deepseek-reasoner` |
| `DEEPSEEK_TOKENS` / `DEEPSEEK_TOKENS_FILE` | Token pool (hot-reloads `tokens.txt`) |
| `DEEPSEEK_EMAIL` / `DEEPSEEK_PASSWORD` / `DEEPSEEK_TOKEN_PERSIST` | Automatic re-login if a token is revoked |
| `DEEPSEEK_PROXY` | Outbound HTTP proxy (`CONNECT`) |
| `RATE_*` / `WARM_*` / `WATCHDOG_*` | Pacing, pre-warming, probes (conservative defaults) |
| `LOG_REQUESTS=1` | Lightweight method/path/status/latency logs |

## 6) Models & capabilities

| Model | Mode | Reasoning | Tools (emulated) | Advertised context |
|---|---|---:|---:|---:|
| `deepseek-chat` | default | no | yes | 1M tokens |
| `deepseek-reasoner` | thinking | `reasoning_content` | yes | 1M tokens |

> The effective limit depends on the upstream web endpoint and account. The proxy relays and advertises 1M; adjust client-side limits if needed.

## 7) Quick troubleshooting

- **No token available**: add a token to `tokens.txt` (hot-reloaded) or `DEEPSEEK_TOKENS`.
- **`40003` / dead token**: replace the token or configure `DEEPSEEK_EMAIL/PASSWORD` (password-based account).
- **Account suspended**: `/health` reports it (`auth.suspendedUntil`) — re-login cannot clear a suspension until it expires.
- **Empty/slow responses**: silent upstream throttling; the proxy applies cooldown/jitter/gap — reduce request rate.
- **Client requires a key**: set `apiKey: "public"` (or your `API_KEY` value if enabled).

Next, pick your tool guide: [OpenCode](OPENCODE.md), [Claude Code](CLAUDECODE.md), [Cursor](CURSOR.md), etc.
