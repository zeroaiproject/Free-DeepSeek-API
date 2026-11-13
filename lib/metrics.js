'use strict';
// Lightweight in-memory metrics for observability.
// Intentionally simple (no external deps, fixed memory).

class RingWindow {
  constructor(size = 300) {
    this.size = size;
    this.buf = new Array(size);
    this.i = 0;
    this.count = 0;
  }
  push(v) {
    this.buf[this.i] = v;
    this.i = (this.i + 1) % this.size;
    if (this.count < this.size) this.count++;
  }
  values() {
    if (this.count === 0) return [];
    const out = new Array(this.count);
    const start = (this.i - this.count + this.size) % this.size;
    for (let k = 0; k < this.count; k++) out[k] = this.buf[(start + k) % this.size];
    return out;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.requestsTotal = 0;
    this.requestsInFlight = 0;
    this.completionsTotal = 0;
    this.completionsStream = 0;
    this.completionsNonStream = 0;
    this.errorsTotal = 0;
    this.upstreamErrors = 0;
    this.authErrors = 0;
    this.rateLimited = 0;
    this.emptyAnswers = 0;
    this.toolCallResponses = 0;
    this.tokensOut = 0;
    this.totalDurationMs = 0;
    this.maxDurationMs = 0;
    this.statusCounts = Object.create(null);

    // Rolling windows for rate/latency measurements (fixed memory).
    this.recent = new RingWindow(512); // {t, ok, err, tokens, ms}
    this.latencies = new RingWindow(512); // ms, completed requests
  }

  onRequestStart() {
    this.requestsTotal += 1;
    this.requestsInFlight += 1;
  }

  onRequestEnd({ status = 0, durationMs = 0, stream = false, toolCalls = false, tokens = 0, upstreamError = false, authError = false, rateLimited = false, empty = false } = {}) {
    this.requestsInFlight = Math.max(0, this.requestsInFlight - 1);
    const key = String(status || 0);
    this.statusCounts[key] = (this.statusCounts[key] || 0) + 1;
    const ms = Math.max(0, Number(durationMs) || 0);
    this.totalDurationMs += ms;
    if (ms > this.maxDurationMs) this.maxDurationMs = ms;

    let ok = false;
    let err = false;
    let tok = 0;

    if (status >= 200 && status < 300) {
      ok = true;
      this.completionsTotal += 1;
      if (stream) this.completionsStream += 1; else this.completionsNonStream += 1;
      if (toolCalls) this.toolCallResponses += 1;
      if (Number.isFinite(tokens) && tokens > 0) {
        tok = tokens;
        this.tokensOut += tokens;
      }
    } else if (status >= 400) {
      err = true;
      this.errorsTotal += 1;
    }
    if (upstreamError) this.upstreamErrors += 1;
    if (authError) this.authErrors += 1;
    if (rateLimited) this.rateLimited += 1;
    if (empty) this.emptyAnswers += 1;

    const t = Date.now();
    this.recent.push({ t, ok: ok ? 1 : 0, err: err ? 1 : 0, tokens: tok, ms });
    this.latencies.push(ms);
  }

  #windowStats(windowMs) {
    const now = Date.now();
    const cutoff = now - windowMs;
    let req = 0, ok = 0, err = 0, tokens = 0, dur = 0;
    for (const e of this.recent.values()) {
      if (!e || e.t < cutoff) continue;
      req++; ok += e.ok; err += e.err; tokens += e.tokens; dur += e.ms;
    }
    const sec = windowMs / 1000;
    const min = windowMs / 60000;
    return {
      window_s: Math.round(sec),
      requests: req,
      completions: ok,
      errors: err,
      tokens_out: tokens,
      requests_per_min: min > 0 ? Number((req / min).toFixed(2)) : 0,
      completions_per_min: min > 0 ? Number((ok / min).toFixed(2)) : 0,
      tokens_per_min: min > 0 ? Number((tokens / min).toFixed(2)) : 0,
      error_rate: req ? Number((err / req).toFixed(4)) : 0,
      avg_duration_ms: req ? Math.round(dur / req) : 0,
    };
  }

  #latencyStats() {
    const vals = this.latencies.values().filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!vals.length) return { samples: 0, min_ms: 0, p50_ms: 0, p90_ms: 0, p95_ms: 0, p99_ms: 0, max_ms: 0, avg_ms: 0 };
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      samples: vals.length,
      min_ms: Math.round(vals[0]),
      p50_ms: Math.round(percentile(vals, 0.50)),
      p90_ms: Math.round(percentile(vals, 0.90)),
      p95_ms: Math.round(percentile(vals, 0.95)),
      p99_ms: Math.round(percentile(vals, 0.99)),
      max_ms: Math.round(vals[vals.length - 1]),
      avg_ms: Math.round(sum / vals.length),
    };
  }

  snapshot() {
    const uptimeMs = Date.now() - this.startedAt;
    const completed = this.completionsTotal + this.errorsTotal;
    const avgDurationMs = completed ? Math.round(this.totalDurationMs / completed) : 0;
    const uptimeMin = uptimeMs / 60000;
    return {
      uptime_ms: uptimeMs,
      uptime_s: Math.floor(uptimeMs / 1000),
      requests_total: this.requestsTotal,
      requests_in_flight: this.requestsInFlight,
      completions_total: this.completionsTotal,
      completions_stream: this.completionsStream,
      completions_non_stream: this.completionsNonStream,
      tool_call_responses: this.toolCallResponses,
      tokens_out: this.tokensOut,
      errors_total: this.errorsTotal,
      upstream_errors: this.upstreamErrors,
      auth_errors: this.authErrors,
      rate_limited: this.rateLimited,
      empty_answers: this.emptyAnswers,
      avg_duration_ms: avgDurationMs,
      max_duration_ms: this.maxDurationMs,
      status_counts: { ...this.statusCounts },
      latency: this.#latencyStats(),
      rates: {
        overall: {
          requests_per_min: uptimeMin > 0 ? Number((this.requestsTotal / uptimeMin).toFixed(2)) : 0,
          completions_per_min: uptimeMin > 0 ? Number((this.completionsTotal / uptimeMin).toFixed(2)) : 0,
          tokens_per_min: uptimeMin > 0 ? Number((this.tokensOut / uptimeMin).toFixed(2)) : 0,
          error_rate: this.requestsTotal ? Number((this.errorsTotal / this.requestsTotal).toFixed(4)) : 0,
        },
        last_1m: this.#windowStats(60_000),
        last_5m: this.#windowStats(5 * 60_000),
      },
    };
  }

  prometheus() {
    const s = this.snapshot();
    const lines = [];
    const g = (name, val, help, type = 'gauge') => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
      lines.push(`${name} ${val}`);
    };
    const c = (name, val, help) => g(name, val, help, 'counter');
    g('freedeepseek_uptime_seconds', s.uptime_s, 'Server uptime in seconds');
    c('freedeepseek_requests_total', s.requests_total, 'Total HTTP requests received');
    g('freedeepseek_requests_in_flight', s.requests_in_flight, 'Requests currently being processed');
    c('freedeepseek_completions_total', s.completions_total, 'Successful chat completions');
    c('freedeepseek_tool_call_responses_total', s.tool_call_responses, 'Responses that returned tool calls');
    c('freedeepseek_tokens_out_total', s.tokens_out, 'Output tokens reported upstream');
    c('freedeepseek_errors_total', s.errors_total, 'Requests ending in error status');
    c('freedeepseek_upstream_errors_total', s.upstream_errors, 'Upstream transport/API errors');
    c('freedeepseek_auth_errors_total', s.auth_errors, 'Upstream auth/token errors');
    c('freedeepseek_rate_limited_total', s.rate_limited, 'Rate-limit / cooldown events');
    c('freedeepseek_empty_answers_total', s.empty_answers, 'Empty upstream answers (silent throttle)');
    g('freedeepseek_avg_duration_ms', s.avg_duration_ms, 'Average request duration in ms');
    g('freedeepseek_max_duration_ms', s.max_duration_ms, 'Max observed request duration in ms');
    g('freedeepseek_latency_p50_ms', s.latency.p50_ms, 'p50 request latency (recent window)');
    g('freedeepseek_latency_p90_ms', s.latency.p90_ms, 'p90 request latency (recent window)');
    g('freedeepseek_latency_p95_ms', s.latency.p95_ms, 'p95 request latency (recent window)');
    g('freedeepseek_latency_p99_ms', s.latency.p99_ms, 'p99 request latency (recent window)');
    g('freedeepseek_requests_per_min_1m', s.rates.last_1m.requests_per_min, 'Requests per minute over last 1m');
    g('freedeepseek_completions_per_min_1m', s.rates.last_1m.completions_per_min, 'Completions per minute over last 1m');
    g('freedeepseek_tokens_per_min_1m', s.rates.last_1m.tokens_per_min, 'Output tokens per minute over last 1m');
    g('freedeepseek_error_rate_1m', s.rates.last_1m.error_rate, 'Error rate over last 1m');
    lines.push('# HELP freedeepseek_responses_by_status HTTP responses by status code');
    lines.push('# TYPE freedeepseek_responses_by_status counter');
    for (const [code, n] of Object.entries(s.status_counts)) {
      lines.push(`freedeepseek_responses_by_status{code="${code}"} ${n}`);
    }
    return lines.join('\n') + '\n';
  }
}

module.exports = { Metrics };
