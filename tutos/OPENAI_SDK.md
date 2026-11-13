# OpenAI SDK & scripts + Free DeepSeek API

The proxy is **OpenAI-compatible**: use any OpenAI SDK/client by changing `base_url` and `model`.

- **Base URL**: `http://127.0.0.1:8787/v1`
- **API key**: `public` (or your `API_KEY`)
- **Models**: `deepseek-chat`, `deepseek-reasoner`
- **Advertised context**: 1M tokens

## Python (`openai` SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="public",
)

# non-stream
resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Explain the proxy pattern in 2 sentences."}],
)
print(resp.choices[0].message.content)

# stream
with client.chat.completions.stream(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Count from 1 to 5."}],
) as stream:
    for event in stream:
        if event.type == "content.delta":
            print(event.delta, end="", flush=True)
```

### With tools (emulated function calling)

```python
tools = [{
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

r = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "What's the weather in Paris?"}],
    tools=tools,
)
msg = r.choices[0].message
print(msg.tool_calls)
```

## Node.js (`openai` SDK)

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "public",
});

const r = await client.chat.completions.create({
  model: "deepseek-chat",
  messages: [{ role: "user", content: "Hi!" }],
});
console.log(r.choices[0].message.content);

// streaming
const stream = await client.chat.completions.create({
  model: "deepseek-chat",
  stream: true,
  messages: [{ role: "user", content: "Give 3 ideas." }],
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

## curl

```bash
# chat
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer public" \
  -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"Solve: 23*19"}]}'

# stream (SSE)
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Hello"}]}'
```

## Notes

- `stream_options.include_usage` is supported (upstream-aggregated usage).
- `tool_choice`: `auto` (default), `none`, `required`, or force a specific function.
- Reasoning from `deepseek-reasoner` appears in `reasoning_content` (delta/message depending on stream mode).
- Handle errors/retries client-side: the proxy may return `429/503` or wait under upstream load.
