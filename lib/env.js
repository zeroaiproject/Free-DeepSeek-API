'use strict';
// Minimal .env loader (KEY=VALUE, supports quotes and `export` prefix).
// Zero dependencies; does not override existing environment variables.

const fs = require('fs');
const path = require('path');

function loadEnv(file) {
  const p = path.resolve(file || path.join(process.cwd(), '.env'));
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return false;
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let val = m[2] || '';
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '');
    }
    val = val.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    process.env[key] = val;
  }
  return true;
}

module.exports = { loadEnv };
