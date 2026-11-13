# Changelog

All notable changes to **Free DeepSeek API** are documented in this file.

The project has no formal release/tag cadence yet; entries are grouped by capability milestones in chronological order based on repository history.

## [Unreleased / current]

### Added
- **Anthropic Messages API compatibility**: `POST /v1/messages` (and `/messages`) with request/response translation (messages, `system`, text/tool_use/tool_result blocks, reasoning/thinking mapping), **streaming SSE** (`message_start`, `content_block_*`, `message_delta`, `message_stop`), non-stream responses, and tool mapping over the existing emulation layer (`e0e5f9d`).
- **Vertex/Gemini compatibility**: `POST /v1beta/models/{model}:generateContent` and `:streamGenerateContent` (SSE, `alt=sse`), including Vertex-style publisher model paths, with `contents`/`parts`/`systemInstruction`/function call/response translation and `candidates`/`usageMetadata` responses (`e0e5f9d`).
- **`lib/compat.js`** format translators for Anthropic and Vertex/Gemini.
- **Additional endpoints/handlers**: `/version`, `/livez`/`/healthz`, `/readyz`, `/openai/v1` aliases, `GET /v1/models/{id}`, legacy `POST /v1/completions` shim (mapped to chat), token-count endpoints (`/v1/messages/count_tokens`, Vertex `:countTokens`), and explicit `501` handlers for unsupported OpenAI endpoints (embeddings/images/audio/responses/etc.) for graceful client fallback.
- **`lib/tokenizer.js`**: dependency-free heuristic token estimator (better than chars/4) for count endpoints and internal estimates.
- Documentation updates for multi-API support (README, `llms.txt`, `AGENTS.md`, tutorials index, landing/health endpoint info).

### Changed
- Repo documentation standardized to **English** (README, tutorials, guides, and project docs) (`2d5af89`).
- **Improved fallbacks and resilience**: transient upstream/network error classification with lighter penalties/retry-friendly handling, dropped stale prewarm challenges on transient failures, increased completion retry attempts, and clearer method/path fallback responses (`405/404/501`) for better client compatibility and maturity.
- **Security hardening**: request body parsing now uses byte-counted buffers with configurable limits/timeouts (`BODY_LIMIT_BYTES`, `BODY_TIMEOUT_MS`), debug request dumps are redacted and opt-in, CORS is configurable (`CORS_ORIGIN`), non-loopback binds without `API_KEY` are refused by default (override: `ALLOW_INSECURE_EXPOSED=1`), and additional client/auth header handling added.
- **Tool calling & tokenizer**: improved JSON/DSML extraction/normalization and instruction clarity, plus a refined dependency-free heuristic tokenizer for token-count endpoints.
- **Performance & architecture**:
  - **Streaming path optimizations** in OpenAI SSE handling (reduced intermediate allocations/object churn, chunked SSE writes).
  - **Adaptive concurrency/pacing** in `lib/ratelimit.js` (EWMA latency/success/error-aware gap and cooldown tuning, richer stats).
  - **Smarter session reuse** in `lib/warm.js` (pruning, selection, and reuse/caching of fresh sessions).
  - **Unified protocol engine** foundation in `lib/protocol.js` (shared normalization/formatting/stream adapter helpers for OpenAI, Anthropic, Vertex).
  - **Benchmark engine** improvements in `scripts/bench.js` (TTFT, decode/wall throughput, sustained rates, memory snapshots, p50/p90/p95/p99, JSON output).
- **Modularization**: extracted `lib/body.js`, `lib/security.js`, `lib/compat.js`, `lib/tokenizer.js`, and `lib/protocol.js`; docs/config/Docker updated for new behavior and layout.

### Changed
- Repo documentation standardized to **English** (README, tutorials, guides, and project docs) (`2d5af89`).

## 2026-11 — Docs, UX, and tool-calling refinements

### Added
- **Integration tutorials (`tutos/`)** for coding agents and SDKs: setup, OpenCode, Claude Code, Cursor, Windsurf, Cline, Continue, Aider, GitHub Copilot, Codex/OpenAI-compatible CLIs, Zed, JetBrains, and OpenAI SDK examples (`12127cb`, `2d5af89`).
- **`AGENTS.md`** and **`llms.txt`** for agent/repo guidance and machine-readable project summary (`4a5d70b`, later updates).

### Changed
- **README overhaul**: clearer architecture/flow diagram, improved *How it works*, aesthetics/structure, API/model/config tables, and integration links (`e0c42f2`, `12127cb`, later updates).
- **Advertised context window set to 1M tokens** in `/v1/models` and documentation (effective limit remains upstream/account dependent) (`12127cb`).
- **Tool-calling emulation improved**: stricter prompting, broader JSON/DSML extraction and normalization/coercion, better transcript/forced-tool handling, deduplication, and stream-safe behavior (`4a5d70b`, later refinements).
- License text polished while retaining **GLWTS**.

## 2026-11 — Reliability, security, and observability

### Added
- **Metrics/observability**: in-memory metrics, latency/rate tracking, `/metrics` (Prometheus and JSON), enriched `/health` (warm/rate/watchdog/auth/metrics), request IDs and timing headers (`c354577`, `276e3b8`).
- **Benchmark improvements** (`scripts/bench.js`) and rate/latency measurement refinements (`276e3b8`).
- **Security/HTTP hardening**: security headers, constant-time `API_KEY` comparison, CORS/method handling, generic internal errors, request validation, safer body/timeout handling, atomic token persistence with restrictive permissions (`e9d0ed5`, `2c0bbea`, `056cccf`).
- **HTML landing page** for browser requests and improved service info endpoints (`2c0bbea`).
- **CI and repo tooling/docs**: GitHub Actions workflow, `CONTRIBUTING.md`, `SECURITY.md`, `docker-compose.yml`, `.editorconfig`, package/script/CLI improvements (`ab4ee5c`, `e0c42f2`).

### Changed
- **Upstream robustness**: `Accept-Encoding: identity` and safer response/unwrapping/timeout behavior to avoid decoding issues and improve reliability (`c354577`, `276e3b8`).
- **Anti-suspension pacing**: jitter/gaps, escalating cooldown on silent throttles/empty 200s, `limiter.reward`, staggered warm refills, watchdog jitter, and safer defaults/env controls (`0a6c8d9`).
- **Environment/config handling**: `.env` auto-loading, improved config/credential handling, and `.gitignore`/`.dockerignore` hygiene (`0d51e51`, related commits).
- **License switched to GLWTS** (`056cccf`).

## 2026-11 — Signup automation and account/token lifecycle handling

### Added
- **Automated signup pipeline (experimental)**: guest PoW flow, captcha integration hooks, mailbox/code retrieval, register flow, and scripts (`lib/signup.js`, `lib/captcha.js`, `lib/mailbox.js`, `scripts/signup.js`, `scripts/test-signup.js`) (`25c4d3e`).
- Gate/smoke validation for signup steps (guest PoW, payload behavior, captcha/code gates) without requiring full unattended completion.

### Changed
- **Account suspension handling distinguished from token revocation**: detect/remember suspension state (where parseable), back off re-login attempts, report in `/health`, and return clear service errors instead of hammering endpoints (`a17a7f0`).
- **Token lifecycle behavior**: automatic re-login (when credentials configured), hot token reload, token swap/persist options, outbound proxy support for upstream calls, and tooling to verify token liveness (`becdd4a`, `f37f500`, `ab310eb`, later commits).
- Correct handling of upstream silent throttling (empty 200 streams) as rate limiting rather than token failure, avoiding exponential lockout (`ab310eb`, later pacing work).

## 2026-10/11 — Core proxy, streaming, performance, and tool calling

### Added
- **OpenAI-compatible proxy** for `chat.deepseek.com` with native **`DeepSeekHashV1` PoW** solving (shipped WASM), zero npm runtime dependencies (Node 18+) (`204129d` and follow-ups).
- **Streaming completions** (`/v1/chat/completions`), model mapping (`deepseek-chat` / `deepseek-reasoner`), and reasoning support (`reasoning_content`).
- **Pre-warm cache, session reuse, timing instrumentation, and benchmark tooling** to reduce TTFT/prep overhead (`96a31e9`).
- **OpenAI tool-calling emulation** (prompt-injected schemas, JSON + DSML parsing, stream hold-back/`StreamGate`, `tool_choice`, `parallel_tool_calls`, tool-result round-trips) and OpenCode provider guidance (`60ce94a`).
- **Rate limiting, per-token mutex, session reuse limits, watchdog, and streamgate tests** to reduce bursty behavior and improve stability (`aa2fd1f`).
- Core scripts/tests for parsers, streamgate, PoW, tools, probes, and operational checks.

## Notes

- This proxy targets the DeepSeek **web** endpoint and relies on observed behavior (PoW, sessions, SSE/fragment formats, auth/signup gates). Upstream changes may require updates.
- There is **no refresh-token endpoint**; tokens must be re-minted via login/register flows. Revocation and account suspension are different failure modes.
- Anti-throttle/anti-suspension measures reduce risk but do not guarantee account safety. Use responsibly and in compliance with applicable policies/terms.
