'use strict';

/**
 * Read and parse a JSON request body with byte limits and timeout.
 * - Accumulates Buffers (not strings) for correct byte accounting.
 * - Enforces maxBytes and timeoutMs.
 * - Returns {} for empty bodies.
 */
function readJsonBody(req, {
  maxBytes = 32 * 1024 * 1024,
  timeoutMs = 60_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };

    const fail = (err) => {
      if (done) return;
      done = true;
      cleanup();
      try { req.destroy(); } catch {}
      reject(err);
    };

    const ok = (val) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(val);
    };

    const onData = (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        const e = new Error('payload too large');
        e.code = 'PAYLOAD_TOO_LARGE';
        fail(e);
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (done) return;
      if (size === 0) return ok({});
      try {
        const text = Buffer.concat(chunks, size).toString('utf8');
        if (!text.trim()) return ok({});
        ok(JSON.parse(text));
      } catch {
        const e = new Error('invalid JSON body');
        e.code = 'INVALID_JSON';
        fail(e);
      }
    };

    const onError = (err) => fail(err || new Error('request error'));
    const onAborted = () => {
      const e = new Error('request aborted');
      e.code = 'ABORTED';
      fail(e);
    };
    const onClose = () => {
      // If closed before end without error/aborted in some runtimes, treat as aborted when incomplete.
      if (!done && !req.complete) onAborted();
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const e = new Error('request body timeout');
        e.code = 'BODY_TIMEOUT';
        fail(e);
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

module.exports = { readJsonBody };
