'use strict';
// PoW solver — direct port of DeepSeekHash (wasm_solve inside sha3_wasm_bg).
// The hash is a custom Keccak variant implemented in WASM; it cannot be
// reproduced with node:crypto, so we execute the original module.

const fs = require('fs');
const path = require('path');

const WASM_PATH = path.join(__dirname, 'sha3_wasm_bg.7b9ca65ddd.wasm');

class DeepSeekHash {
  constructor(exports, memory) {
    this.e = exports;
    this.mem = memory;
    this.offset = 0;
    this.enc = new TextEncoder();
    this._u8 = null;
  }

  view() {
    if (!this._u8 || this._u8.byteLength === 0) this._u8 = new Uint8Array(this.mem.buffer);
    return this._u8;
  }

  // Mirrors wasm-bindgen's passStringToWasm0 (ASCII fast path + realloc).
  encodeString(text) {
    const alloc = this.e.__wbindgen_export_0;
    const realloc = this.e.__wbindgen_export_1;
    const strLength = text.length;
    let ptr = alloc(strLength, 1) >>> 0;
    let asciiLength = 0;
    for (; asciiLength < strLength; asciiLength++) {
      const c = text.charCodeAt(asciiLength);
      if (c > 127) break;
      this.view()[ptr + asciiLength] = c;
    }
    if (asciiLength !== strLength) {
      if (asciiLength > 0) text = text.slice(asciiLength);
      ptr = realloc(ptr, strLength, asciiLength + text.length * 3, 1) >>> 0;
      const res = this.enc.encodeInto(
        text,
        this.view().subarray(ptr + asciiLength, ptr + asciiLength + text.length * 3)
      );
      asciiLength += res.written;
      ptr = realloc(ptr, asciiLength + text.length * 3, asciiLength, 1) >>> 0;
    }
    this.offset = asciiLength;
    return ptr;
  }

  solve({ algorithm, challenge, salt, difficulty, expire_at }) {
    if (algorithm !== 'DeepSeekHashV1') throw new Error('unsupported algorithm: ' + algorithm);
    const prefix = `${salt}_${expire_at}_`;
    const retptr = this.e.__wbindgen_add_to_stack_pointer(-16);
    try {
      const ptr0 = this.encodeString(challenge);
      const len0 = this.offset;
      const ptr1 = this.encodeString(prefix);
      const len1 = this.offset;
      this.e.wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty);
      const dv = new DataView(this.mem.buffer);
      const status = dv.getInt32(retptr + 0, true);
      const value = dv.getFloat64(retptr + 8, true);
      return status === 0 ? undefined : value;
    } finally {
      this.e.__wbindgen_add_to_stack_pointer(16);
    }
  }
}

let instance = null;

async function init() {
  if (instance) return instance;
  const buf = fs.readFileSync(WASM_PATH);
  const { instance: wasm } = await WebAssembly.instantiate(buf, { wbg: {} });
  instance = new DeepSeekHash(wasm.exports, wasm.exports.memory);
  return instance;
}

// Returns the base64 `X-Ds-Pow-Response` header value for a raw challenge object.
async function buildPowResponse(challenge) {
  const hasher = await init();
  const answer = hasher.solve(challenge);
  if (answer === undefined) throw new Error('pow unsolved');
  return Buffer.from(
    JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    })
  ).toString('base64');
}

module.exports = { init, buildPowResponse, DeepSeekHash };
