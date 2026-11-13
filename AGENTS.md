# AGENTS.md

Guidance for coding agents working in this repository.

## Project summary

**Free DeepSeek API** is an OpenAI-compatible HTTP proxy for `chat.deepseek.com` (web endpoint) backed by user tokens.

- **Zero npm runtime dependencies** (Node.js 18+ built-ins only). Optional tooling (e.g. Playwright for browser captcha solving) must be lazy-loaded/isolated.
- Core flow: solve `DeepSeekHashV1` PoW (shipped WASM), create/reuse chat sessions, stream completions, and translate DeepSeek SSE into OpenAI/Anthropic/Vertex-compatible responses.
- Tool calling is **emulated** (no native web function-calling): schemas are injected into the prompt and replies are parsed back into `tool_calls` (JSON and DSML formats), with stream hold-back to avoid leaking tool markup.

## Repo layout

- `server.js` — HTTP server, routing, handlers, request orchestration, metrics/auth/watchdog wiring.
- `lib/deepseek.js` — upstream client (challenge, session, completion, proxy tunnel).
- `lib/pow.js` + `lib/sha3_wasm_bg.*.wasm` — PoW solver (original WASM). **Do not replace semantics.**
- `lib/stream.js`, `lib/streamgate.js` — SSE fragment assembly and stream-safe tool-call hold-back.
- `lib/tools.js` — tool prompt builder, transcript shaping, JSON/DSML tool-call extraction.
- `lib/compat.js`, `lib/protocol.js` — Anthropic/Vertex translation and unified protocol normalization/format helpers.
- `lib/tokenizer.js` — heuristic token estimator for count endpoints.
- `lib/body.js`, `lib/security.js` — request body parsing/limits and redaction/security helpers.
- `lib/pool.js`, `lib/ratelimit.js`, `lib/warm.js`, `lib/watchdog.js` — token pool, adaptive pacing/rate limiting, smart pre-warm/session reuse, liveness + re-login.
- `lib/auth.js`, `lib/signup.js`, `lib/captcha.js`, `lib/mailbox.js` — login and experimental signup pipeline.
- `lib/env.js`, `lib/metrics.js` — `.env` loading, in-memory metrics.
- `scripts/` — CLI tools, tests, probes, benchmark.
- `tutos/` — integration guides for coding agents.

## Models & context

- Exposed models: `deepseek-chat` (default) and `deepseek-reasoner` (thinking, `reasoning_content`).
- Advertised context window: **1M tokens** (effective limit depends on upstream). Keep `server.js` `/v1/models`, README, and tutos consistent when changing this.

## Development rules

- **No secrets in git.** Never commit `.env`, `tokens.txt`, credentials, cookies, or captured bodies. `.env.example` / `tokens.example.txt` are placeholders.
- **Preserve protocol behavior.** Changes to PoW, challenge headers, session/completion payloads, and signup gates must match what `chat.deepseek.com` expects. Validate with existing scripts/tests before/after.
- **Keep it dependency-free.** Do not add npm runtime dependencies. Prefer small, auditable code over abstractions.
- **Be careful with rate/suspension logic.** Distinguish token revocation (`40003` re-login fixable) from account suspension (`40003` on all endpoints, not fixable). Avoid introducing bursty or perfectly periodic upstream traffic.
- **Streaming correctness matters.** Never leak tool-call markers/markup to clients; respect hold-back and chunk boundaries.
- **Backwards compatibility.** `/v1/chat/completions`, `/v1/models`, `/health` behavior and OpenAI response shapes are relied upon by SDKs/agents.

## Tests & verification

```bash
npm run test:offline   # parsers + streamgate + PoW selftest (no network/token)
npm run test:all       # offline + signup gate smoke test (hits live gates)
npm run test:signup    # guest PoW / register payload / captcha gate checks
node --check server.js lib/*.js scripts/*.js
```

- Ensure **`npm run test:offline` passes** for any code change.
- End-to-end/tool/bench tests require a valid, non-suspended token and are sensitive to upstream rate limits — do not run in tight loops.
- If you change tool parsing/streaming, keep `scripts/test-parsers.js` and `scripts/test-streamgate.js` passing and extend them for new cases.

## Key operational notes

- `.env` is auto-loaded at startup; tokens hot-reload from `tokens.txt`.
- Default bind is `127.0.0.1`; non-loopback binds require `API_KEY` unless `ALLOW_INSECURE_EXPOSED=1`.
- `Accept-Encoding: identity` is intentional upstream (no decompression pipeline).
- Solved PoW is single-use; unsolved challenges can be reused within validity.
- There is no refresh token endpoint — only re-mint via login/register/oauth.
- License: **GPL-3.0-or-later**. Keep docs (`README.md`, `tutos/`, `CHANGELOG.md`, `llms.txt`) in sync with behavior/config/endpoints.
