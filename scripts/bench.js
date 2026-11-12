'use strict';
// Latency + throughput benchmark for the Free DeepSeek API proxy.
//
//   node scripts/bench.js [runs] [short|long] [model]
//
// Reports per-run TTFT, decode throughput (tokens/s after the first token) and
// wall throughput, plus the proxy's internal breakdown from the X-Ds-* headers.

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const RUNS = Number(process.argv[2] || 5);
const PROFILE = process.argv[3] || 'short';
const MODEL = process.argv[4] || 'deepseek-chat';
// DeepSeek silently returns an empty answer when requests are fired too fast.
const DELAY_MS = Number(process.env.BENCH_DELAY_MS || 3000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROMPTS = {
  short: 'Réponds en une seule phrase courte : qu\'est-ce qu\'un proxy ?',
  long:
    'Écris exactement 12 paragraphes numérotés sur l\'histoire de l\'informatique, ' +
    'environ 60 mots par paragraphe. Pas de conclusion, pas de titre.',
};

const now = () => Number(process.hrtime.bigint()) / 1e6;

function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  const sum = v.reduce((a, b) => a + b, 0);
  const q = (p) => v[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  return {
    min: v[0],
    median: q(0.5),
    mean: sum / n,
    p95: q(0.95),
    max: v[n - 1],
  };
}

async function runOnce(prompt) {
  const t0 = now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const tHeaders = now();

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const h = res.headers;
  const internal = {
    sessionMs: Number(h.get('x-ds-session-ms') || 0),
    challengeMs: Number(h.get('x-ds-challenge-ms') || 0),
    solveMs: Number(h.get('x-ds-solve-ms') || 0),
    prepMs: Number(h.get('x-ds-prep-ms') || 0),
    upstreamTtfbMs: Number(h.get('x-ds-upstream-ttfb-ms') || 0),
  };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ttft = null;
  let tLast = null;
  let tokens = 0;
  let chars = 0;
  let deltas = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const tNow = now();
    buf += dec.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;

      let j;
      try {
        j = JSON.parse(payload);
      } catch {
        continue;
      }
      if (j.usage && typeof j.usage.completion_tokens === 'number') {
        tokens = j.usage.completion_tokens;
        continue;
      }
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      const piece = (d.content || '') + (d.reasoning_content || '');
      if (!piece) continue;
      if (ttft === null) ttft = tNow - t0;
      chars += piece.length;
      deltas += 1;
      tLast = tNow;
    }
  }

  const tEnd = now();
  const decodeMs = ttft === null ? 0 : tLast - (t0 + ttft);

  return {
    ttft: ttft ?? 0,
    total: tEnd - t0,
    headersMs: tHeaders - t0,
    tokens,
    chars,
    deltas,
    decodeMs,
    decodeTps: decodeMs > 0 && tokens > 0 ? (tokens / decodeMs) * 1000 : 0,
    wallTps: tokens > 0 ? (tokens / (tEnd - t0)) * 1000 : 0,
    internal,
  };
}

function fmt(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(0) + ' ms';
}

(async () => {
  const prompt = PROMPTS[PROFILE];
  if (!prompt) {
    console.error('profile must be "short" or "long"');
    process.exit(2);
  }

  console.log(`\nFree DeepSeek API — benchmark`);
  console.log(`  endpoint : ${BASE}/v1/chat/completions`);
  console.log(`  model    : ${MODEL}`);
  console.log(`  profile  : ${PROFILE} (${RUNS} runs)\n`);

  // warm-up: first call pays for WASM instantiation + TLS, report it separately
  const warm = await runOnce(prompt);
  console.log(
    `warm-up  ttft ${fmt(warm.ttft)}  total ${fmt(warm.total)}  tokens ${warm.tokens}  ` +
      `pool ${warm.decodeTps.toFixed(1)} tok/s\n`
  );
  await sleep(DELAY_MS);

  const runs = [];
  for (let i = 1; i <= RUNS; i++) {
    let r = await runOnce(prompt);

    // Rate-limited answers come back empty with no error. Retry once, slower.
    for (let retry = 0; r.tokens === 0 && retry < 2; retry++) {
      console.log(`#${i}  empty answer (upstream rate limit) — backing off 20s`);
      await sleep(20000);
      r = await runOnce(prompt);
    }
    if (r.tokens === 0) {
      console.log(`#${i}  still empty, skipping`);
      continue;
    }

    runs.push(r);
    console.log(
      `#${i}  ttft ${fmt(r.ttft).padStart(8)}  total ${fmt(r.total).padStart(8)}  ` +
        `tok ${String(r.tokens).padStart(4)}  decode ${r.decodeTps.toFixed(1).padStart(6)} tok/s  ` +
        `wall ${r.wallTps.toFixed(1).padStart(6)} tok/s  ` +
        `[prep ${r.internal.prepMs}ms = max(sess ${r.internal.sessionMs}, chal ${r.internal.challengeMs}) + solve ${r.internal.solveMs} | upstream-ttfb ${r.internal.upstreamTtfbMs}ms]`
    );
    if (i < RUNS) await sleep(DELAY_MS);
  }

  if (!runs.length) {
    console.error('\nno measurable runs — upstream is rate limiting');
    process.exit(1);
  }

  const pick = (f) => runs.map(f);
  const ttft = stats(pick((r) => r.ttft));
  const total = stats(pick((r) => r.total));
  const dec = stats(pick((r) => r.decodeTps));
  const wall = stats(pick((r) => r.wallTps));
  const tok = stats(pick((r) => r.tokens));

  const row = (label, s, unit = 'ms', p = fmt) =>
    `${label.padEnd(12)} min ${p(s.min)}  med ${p(s.median)}  mean ${p(s.mean)}  p95 ${p(s.p95)}  max ${p(s.max)}`;

  console.log('\n— TTFT (client → first content token) —');
  console.log('  ' + row('ttft', ttft));
  console.log('\n— Tokens per second —');
  console.log('  ' + row('decode', dec, 'tok/s', (v) => v.toFixed(1)));
  console.log('  ' + row('wall', wall, 'tok/s', (v) => v.toFixed(1)));
  console.log('\n— End to end —');
  console.log('  ' + row('total', total));
  console.log('  ' + row('tokens', tok, 'tok', (v) => v.toFixed(0)));

  const overhead = stats(pick((r) => r.internal.prepMs));
  console.log('\n— Proxy overhead before upstream request —');
  console.log('  ' + row('prep', overhead));
  console.log(
    `\nmedian decode throughput: ${dec.median.toFixed(1)} tok/s   median TTFT: ${fmt(ttft.median)}`
  );
})().catch((e) => {
  console.error('\nbenchmark failed:', e.message);
  process.exit(1);
});
