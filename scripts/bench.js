'use strict';
// Latency + throughput benchmark for the Free DeepSeek API proxy.
//
//   node scripts/bench.js [runs] [short|long] [model] [--json]
//   BASE_URL=http://127.0.0.1:8787 BENCH_DELAY_MS=3000 node scripts/bench.js
//
// Reports TTFT, decode/wall throughput, token rates, proxy prep breakdown,
// and latency percentiles. Measures sequential sustained rate (requests/min)
// including pacing — useful to validate safe operating points.

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const pos = args.filter((a) => a !== '--json');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const RUNS = Number(pos[0] || 5);
const PROFILE = pos[1] || 'short';
const MODEL = pos[2] || 'deepseek-chat';
const DELAY_MS = Number(process.env.BENCH_DELAY_MS || 3000);
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS || 180000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;

const PROMPTS = {
  short: 'Réponds en une seule phrase courte : qu\'est-ce qu\'un proxy ?',
  long:
    'Écris exactement 12 paragraphes numérotés sur l\'histoire de l\'informatique, ' +
    'environ 60 mots par paragraphe. Pas de conclusion, pas de titre.',
};

function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return null;
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const q = (p) => v[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  return {
    n,
    min: v[0],
    p50: q(0.5),
    p90: q(0.9),
    p95: q(0.95),
    p99: q(0.99),
    max: v[n - 1],
    mean,
    stdev: Math.sqrt(variance),
  };
}

function fmt(ms) {
  if (!Number.isFinite(ms)) return '-';
  return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms.toFixed(0) + ' ms';
}
function fnum(v, d = 1) {
  return Number.isFinite(v) ? v.toFixed(d) : '-';
}

async function fetchHealth() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function runOnce(prompt) {
  const t0 = now();
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(new Error('bench timeout')), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } finally {
    clearTimeout(to);
  }
  const tHeaders = now();

  if (!res.ok) {
    let msg = '';
    try { msg = await res.text(); } catch {}
    throw new Error(`HTTP ${res.status}: ${msg.slice(0, 200)}`);
  }

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
      try { j = JSON.parse(payload); } catch { continue; }
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
  const decodeMs = ttft === null ? 0 : Math.max(0, tLast - (t0 + ttft));

  return {
    ok: true,
    ttftMs: ttft ?? 0,
    totalMs: tEnd - t0,
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

function printTable(title, s, unit, fmtVal) {
  if (!s) return;
  const p = fmtVal || ((v) => fnum(v, 1));
  console.log(`\n— ${title} —`);
  console.log(
    `  n=${s.n}  min ${p(s.min)}  p50 ${p(s.p50)}  p90 ${p(s.p90)}  p95 ${p(s.p95)}  p99 ${p(s.p99)}  max ${p(s.max)}  mean ${p(s.mean)}  stdev ${p(s.stdev)} ${unit || ''}`.trimEnd()
  );
}

(async () => {
  const prompt = PROMPTS[PROFILE];
  if (!prompt) {
    console.error('profile must be "short" or "long"');
    process.exit(2);
  }

  const startedAt = Date.now();
  const healthBefore = await fetchHealth();

  if (!jsonOut) {
    console.log(`\nFree DeepSeek API — benchmark`);
    console.log(`  endpoint : ${BASE}/v1/chat/completions`);
    console.log(`  model    : ${MODEL}`);
    console.log(`  profile  : ${PROFILE} (${RUNS} runs, delay ${DELAY_MS}ms, timeout ${TIMEOUT_MS}ms)`);
    if (healthBefore && healthBefore.rate) {
      const rc = Array.isArray(healthBefore.rate) ? null : healthBefore.rate.config;
      if (rc) console.log(`  limiter  : burst=${rc.burst} refill=${rc.refillMs}ms gap=${rc.minGapMs}ms jitter=${rc.jitterMs}ms`);
    }
    console.log('');
  }

  // warm-up
  let warm = null;
  try {
    warm = await runOnce(prompt);
    if (!jsonOut) {
      console.log(
        `warm-up  ttft ${fmt(warm.ttftMs)}  total ${fmt(warm.totalMs)}  tokens ${warm.tokens}  decode ${fnum(warm.decodeTps)} tok/s`
      );
    }
  } catch (e) {
    if (!jsonOut) console.log(`warm-up  failed: ${e.message}`);
  }
  await sleep(DELAY_MS);

  const runs = [];
  let emptyCount = 0;
  let errorCount = 0;

  for (let i = 1; i <= RUNS; i++) {
    let r;
    try {
      r = await runOnce(prompt);
    } catch (e) {
      errorCount++;
      if (!jsonOut) console.log(`#${i}  ERROR ${e.message}`);
      if (i < RUNS) await sleep(DELAY_MS);
      continue;
    }

    for (let retry = 0; r.tokens === 0 && retry < 2; retry++) {
      emptyCount++;
      if (!jsonOut) console.log(`#${i}  empty answer (upstream throttle) — backing off 20s`);
      await sleep(20000);
      try { r = await runOnce(prompt); } catch (e) { r = { tokens: 0, error: e.message }; break; }
    }

    if (!r || r.tokens === 0) {
      if (!jsonOut) console.log(`#${i}  still empty, skipping`);
      if (i < RUNS) await sleep(DELAY_MS);
      continue;
    }

    runs.push(r);
    if (!jsonOut) {
      console.log(
        `#${i}  ttft ${fmt(r.ttftMs).padStart(8)}  total ${fmt(r.totalMs).padStart(8)}  ` +
          `tok ${String(r.tokens).padStart(4)}  decode ${fnum(r.decodeTps).padStart(6)} tok/s  ` +
          `wall ${fnum(r.wallTps).padStart(6)} tok/s  ` +
          `[prep ${r.internal.prepMs}ms = max(sess ${r.internal.sessionMs}, chal ${r.internal.challengeMs}) + solve ${r.internal.solveMs} | upstream-ttfb ${r.internal.upstreamTtfbMs}ms]`
      );
    }
    if (i < RUNS) await sleep(DELAY_MS);
  }

  const wallClockMs = Date.now() - startedAt;
  const pick = (f) => runs.map(f).filter(Number.isFinite);
  const ttft = stats(pick((r) => r.ttftMs));
  const total = stats(pick((r) => r.totalMs));
  const dec = stats(pick((r) => r.decodeTps));
  const wall = stats(pick((r) => r.wallTps));
  const tok = stats(pick((r) => r.tokens));
  const prep = stats(pick((r) => r.internal.prepMs));
  const uttfb = stats(pick((r) => r.internal.upstreamTtfbMs));

  const sumTokens = runs.reduce((a, r) => a + (r.tokens || 0), 0);
  const sumTotalMs = runs.reduce((a, r) => a + (r.totalMs || 0), 0);
  const measuredMs = Math.max(1, wallClockMs);
  const sustained = {
    measured_runs: runs.length,
    errors: errorCount,
    empty_retries: emptyCount,
    wall_clock_ms: Math.round(measuredMs),
    requests_per_min: Number((runs.length / (measuredMs / 60000)).toFixed(2)),
    tokens_per_min: Number((sumTokens / (measuredMs / 60000)).toFixed(2)),
    tokens_per_sec_wallclock: Number((sumTokens / (measuredMs / 1000)).toFixed(2)),
    avg_tokens_per_sec_request: sumTotalMs > 0 ? Number((sumTokens / (sumTotalMs / 1000)).toFixed(2)) : 0,
  };

  if (jsonOut) {
    console.log(JSON.stringify({ base: BASE, model: MODEL, profile: PROFILE, runs: RUNS, delayMs: DELAY_MS, warm, results: runs, stats: { ttft, total, decodeTps: dec, wallTps: wall, tokens: tok, prepMs: prep, upstreamTtfbMs: uttfb }, sustained }, null, 2));
    process.exit(runs.length ? 0 : 1);
  }

  if (!runs.length) {
    console.error('\nno measurable runs — upstream is rate limiting or unavailable');
    process.exit(1);
  }

  printTable('TTFT (client → first token)', ttft, 'ms', fmt);
  printTable('End to end', total, 'ms', fmt);
  printTable('Decode throughput', dec, 'tok/s');
  printTable('Wall throughput (per request)', wall, 'tok/s');
  printTable('Tokens per response', tok, 'tok', (v) => fnum(v, 0));
  printTable('Proxy prep before upstream', prep, 'ms', fmt);
  printTable('Upstream TTFB', uttfb, 'ms', fmt);

  console.log('\n— Sustained rate (measured, incl. pacing/delays) —');
  console.log(`  runs ${sustained.measured_runs}/${RUNS}  errors ${sustained.errors}  empty-retries ${sustained.empty_retries}  wall ${fmt(sustained.wall_clock_ms)}`);
  console.log(`  requests/min ${sustained.requests_per_min}  tokens/min ${sustained.tokens_per_min}  tokens/s (wallclock) ${sustained.tokens_per_sec_wallclock}  tokens/s (sum of requests) ${sustained.avg_tokens_per_sec_request}`);
  console.log(`\nmedian decode throughput: ${fnum(dec.p50)} tok/s   median TTFT: ${fmt(ttft.p50)}`);
})().catch((e) => {
  console.error('\nbenchmark failed:', e.message);
  process.exit(1);
});
