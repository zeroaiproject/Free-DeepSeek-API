# Contributing

Thanks for your interest in improving **Free DeepSeek API**.

## Principles

- **Zero npm runtime dependencies.** Keep the core server and libraries dependency-free (Node 18+ built-ins only). Optional/dev-only tooling is fine when clearly isolated and lazy-loaded.
- **No secrets in git.** Never commit `.env`, `tokens.txt`, credentials, cookies, or captured request bodies. Use `.env.example` / `tokens.example.txt` for placeholders.
- **Small, reviewable changes.** Prefer focused patches with a clear rationale.

## Development

```bash
git clone https://github.com/zeroaiproject/Free-DeepSeek-API.git
cd free-deepseek-api
cp tokens.example.txt tokens.txt   # add a token for live/manual tests
npm start
```

## Tests

```bash
npm run test:offline   # parsers + streamgate + PoW selftest (no network/token)
npm run test:all       # offline + signup gate smoke test (hits live signup gates)
npm run test:signup    # guest PoW / register payload / captcha gate checks
```

- Please make sure `npm run test:offline` passes before opening a PR.
- End-to-end/tool tests (`npm run test:tools`, order/reuse/bench) require a **valid, non-suspended** account token and are subject to upstream rate limits — don’t run them in tight loops.

## Areas that need care

- **PoW & protocol** (`lib/pow.js`, WASM, `lib/deepseek.js`): behavior must match what `chat.deepseek.com` expects.
- **Tool-call emulation** (`lib/tools.js`, `lib/streamgate.js`): keep JSON and DSML parsing/stream hold-back correct; add/extend parser cases when changing formats.
- **Auth/rate/suspension handling**: distinguish token revocation from account suspension; avoid bursts that look automated.

## Pull requests

- Keep changes focused and explain *why* (protocol behavior, reliability, compatibility, security, docs).
- Update docs/`CHANGELOG.md` when behavior, config, endpoints, or usage changes.
- Run `node --check server.js lib/*.js scripts/*.js` and `npm run test:offline` before submitting.

## Reporting issues

When reporting a bug, include: Node version, OS, how you run the server, relevant `/health` fields (tokens are masked), and sanitized logs/repro steps. Do **not** share real tokens, passwords, or mailbox credentials.

## License

By contributing, you agree that your contributions will be licensed under the project's **GPL-3.0-or-later** license.
