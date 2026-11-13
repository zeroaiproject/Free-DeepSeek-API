'use strict';
// Lightweight in-memory metrics for observability.
// Intentionally simple (no external deps, fixed memory).

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
  }

  onRequestStart() {
    this.requestsTotal += 1;
    this.requestsInFlight += 1;
  }

  onRequestEnd({ status = 0, durationMs = 0, stream = false, toolCalls = false, tokens = 0, upstreamError = false, authError = false, rateLimited = false, empty = false } = {}) {
    this.requestsInFlight = Math.max(0, this.requestsInFlight - 1);
    const key = String(status || 0);
    this.statusCounts[key] = (this.statusCounts[key] || 0) + 1;
    this.totalDurationMs += Math.max(0, durationMs);
    if (durationMs > this.maxDurationMs) this.maxDurationMs = durationMs;

    if (status >= 200 && status < 300) {
      this.completionsTotal += 1;
      if (stream) this.completionsStream += 1; else this.completionsNonStream += 1;
      if (toolCalls) this.toolCallResponses += 1;
      if (Number.isFinite(tokens) && tokens > 0) this.tokensOut += tokens;
    } else if (status >= 400) {
      this.errorsTotal += 1;
    }
    if (upstreamError) this.upstreamErrors += 1;
    if (authError) this.authErrors += 1;
    if (rateLimited) this.rateLimited += 1;
    if (empty) this.emptyAnswers += 1;
  }

  snapshot() {
    const uptimeMs = Date.now() - this.startedAt;
    const completed = this.completionsTotal + this.errorsTotal;
    const avgDurationMs = completed ? Math.round(this.totalDurationMs / completed) : 0;
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
    lines.push('# HELP freedeepseek_responses_by_status HTTP responses by status code');
    lines.push('# TYPE freedeepseek_responses_by_status counter');
    for (const [code, n] of Object.entries(s.status_counts)) {
      lines.push(`freedeepseek_responses_by_status{code="${code}"} ${n}`);
    }
    return lines.join('\n') + '\n';
  }
}

module.exports = { Metrics };
