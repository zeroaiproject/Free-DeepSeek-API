# SDK OpenAI & scripts + Free DeepSeek API

Le proxy est **OpenAI-compatible** : utilisez n’importe quel SDK/client OpenAI en changeant `base_url` et `model`.

- **Base URL** : `http://127.0.0.1:8787/v1`
- **API key** : `public` (ou votre `API_KEY`)
- **Modèles** : `deepseek-chat`, `deepseek-reasoner`
- **Contexte annoncé** : 1M tokens

## Python (SDK `openai`)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="public",
)

# non-stream
resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Explique le pattern proxy en 2 phrases."}],
)
print(resp.choices[0].message.content)

# stream
with client.chat.completions.stream(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Compte de 1 à 5."}],
) as stream:
    for event in stream:
        if event.type == "content.delta":
            print(event.delta, end="", flush=True)
```

### Avec outils (function calling émulé)

```python
tools = [{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Météo actuelle pour une ville",
    "parameters": {
      "type": "object",
      "properties": {"city": {"type": "string"}},
      "required": ["city"]
    }
  }
}]

r = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Quel temps fait-il à Paris ?"}],
    tools=tools,
)
msg = r.choices[0].message
print(msg.tool_calls)
```

## Node.js (SDK `openai`)

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "public",
});

const r = await client.chat.completions.create({
  model: "deepseek-chat",
  messages: [{ role: "user", content: "Salut !" }],
});
console.log(r.choices[0].message.content);

// streaming
const stream = await client.chat.completions.create({
  model: "deepseek-chat",
  stream: true,
  messages: [{ role: "user", content: "Donne 3 idées." }],
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
  -d '{"model":"deepseek-reasoner","messages":[{"role":"user","content":"Résous: 23*19"}]}'

# stream (SSE)
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","stream":true,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"Hello"}]}'
```

## Remarques

- `stream_options.include_usage` est supporté (usage agrégé côté amont).
- `tool_choice`: `auto` (défaut), `none`, `required`, ou forcer une fonction spécifique.
- Le raisonnement de `deepseek-reasoner` apparaît dans `reasoning_content` (delta/message selon mode stream/non-stream).
- Gérer les erreurs/retries côté client : le proxy peut renvoyer `429/503` ou attendre selon la charge amont.
