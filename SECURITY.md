# Security Policy

## Reporting a vulnerability

If you discover a security issue in this project (e.g. credential leakage, auth bypass in the proxy, unsafe token handling, path traversal in debug dumps), please **do not open a public issue** with exploit details.

Instead, report it privately to the maintainers via GitHub’s private vulnerability reporting (Security tab), or by contacting the repository owner directly. Include:

- affected component and version/commit
- reproduction steps or proof of concept (sanitized — no real tokens/passwords)
- potential impact

We’ll review and address valid reports as quickly as possible.

## Scope & notes

- This proxy forwards traffic to a third-party service using user-provided tokens. **Tokens, passwords, and mailbox credentials are sensitive** — protect `.env`, `tokens.txt`, and `/health` (use `API_KEY` and avoid exposing the server publicly).
- Persisted tokens are written atomically with restrictive permissions (`0600`); secrets files are gitignored. Do not disable these protections.
- The automated signup flow interacts with anti-bot/captcha mechanisms and real accounts; use it only with accounts and infrastructure you are authorized to use, in compliance with applicable terms and laws.
- Upstream (`chat.deepseek.com`) behavior, rate limits, and suspension policies are outside this project’s control.
