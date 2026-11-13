'use strict';
// Decides which part of a streaming answer may be sent to the client while
// tools are attached.
//
// A tool call must never reach the client as text, but the model sometimes
// writes prose first and appends the call afterwards. So content is emitted with
// a short tail held back; the moment a tool-call marker appears anywhere in the
// text, emission stops and the remainder is buffered for parsing.

const TOOL_MARKERS = ['"tool_calls"', '\uFF5CDSML', '```', '<|'];

function hasToolMarker(text) {
  for (const m of TOOL_MARKERS) if (text.includes(m)) return true;
  return false;
}

class StreamGate {
  constructor({ toolsActive, holdBack = 32 } = {}) {
    this.toolsActive = !!toolsActive;
    this.holdBack = holdBack;
    this.emitted = 0;
    this.buffering = false;
  }

  // Returns the piece of `text` that is safe to emit now ('' if none).
  pump(text) {
    if (this.buffering) return '';
    if (this.toolsActive && hasToolMarker(text)) {
      this.buffering = true;
      return '';
    }

    const safe = this.toolsActive ? Math.max(this.emitted, text.length - this.holdBack) : text.length;
    if (safe <= this.emitted) return '';

    const piece = text.slice(this.emitted, safe);
    this.emitted = safe;
    return piece;
  }

  // Everything still unemitted, or '' when a tool call is being buffered.
  finish(text) {
    if (this.buffering || text.length <= this.emitted) return '';
    const piece = text.slice(this.emitted);
    this.emitted = text.length;
    return piece;
  }

  // Remaining text after a buffered tail was rejected as a tool call.
  drain(text) {
    if (text.length <= this.emitted) return '';
    const piece = text.slice(this.emitted);
    this.emitted = text.length;
    return piece;
  }
}

module.exports = { StreamGate, hasToolMarker, TOOL_MARKERS };
