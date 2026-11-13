# Cline (VS Code) + Free DeepSeek API

[Cline](https://github.com/cline/cline) is an autonomous coding agent for VS Code. It supports **OpenAI-compatible** providers.

## Configuration

1. Install the **Cline** extension in VS Code.
2. Open Cline settings → **API Provider**: `OpenAI Compatible`.
3. Set:
   - **Base URL**: `http://127.0.0.1:8787/v1`
   - **API Key**: `public` (or your `API_KEY`)
   - **Model ID**: `deepseek-chat` (or `deepseek-reasoner`)
4. (Optional) Adjust:
   - **Context window**: `1000000`
   - **Max tokens**: `8192` (chat) / `32768` (reasoner)

## Usage

- Open a workspace, start Cline, and give it a task (edits, refactors, commands). Cline will use the proxy for completions and tool calls.
- For reasoning-heavy tasks, switch to `deepseek-reasoner`.

## Best practices

- **Tool calling is emulated**: keep instructions clear and tool descriptions precise; if a task loops, simplify the request.
- Respect pacing: the proxy may wait (rate limit/jitter) to stay under upstream thresholds.
- Do not put secrets in prompts; protect `/health` if the proxy is exposed.

## Troubleshooting

- **Connection refused**: verify the proxy is listening (default port 8787).
- **401 invalid api key**: use the same key in Cline as server `API_KEY` (or unset `API_KEY` on the proxy).
- **Empty/slow responses**: upstream throttling → the proxy retries with cooldown; check `/health` (rate/metrics/auth/suspension).
- **No token available**: add a valid `userToken` to `tokens.txt`.
