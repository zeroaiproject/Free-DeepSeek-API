'use strict';

const crypto = require('crypto');

const SENSITIVE_KEY_RE = /(^|_|-)(authorization|api[_-]?key|token|access[_-]?token|refresh[_-]?token|user[_-]?token|password|passwd|secret|cookie|set-cookie|session|bearer)($|_|-)/i;

function redactSecrets(value, depth = 0) {
  if (depth > 8) return '[REDACTED_DEPTH]';
  if (value == null) return value;
  if (typeof value === 'string') {
    if (value.length > 2000) return `[REDACTED_STRING len=${value.length}]`;
    // Redact obvious bearer/jwt/base64-ish long tokens inline
    if (/^Bearer\s+\S+/i.test(value)) return 'Bearer [REDACTED]';
    if (value.length > 80 && /^[A-Za-z0-9+/_=-]+$/.test(value)) return `[REDACTED_TOKEN len=${value.length}]`;
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      if (typeof v === 'string') out[k] = `[REDACTED len=${v.length}]`;
      else if (v == null) out[k] = v;
      else out[k] = '[REDACTED]';
    } else {
      out[k] = redactSecrets(v, depth + 1);
    }
  }
  return out;
}

function safeDebugDump(dir, prefix, payload) {
  if (!dir) return null;
  try {
    const fs = require('fs');
    const p = require('path');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    const file = p.join(dir, name);
    const redacted = redactSecrets(payload);
    fs.writeFileSync(file, JSON.stringify(redacted, null, 2), { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

module.exports = { redactSecrets, safeDebugDump, isLoopbackHost };
