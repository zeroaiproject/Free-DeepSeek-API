'use strict';
// Checks whether tokens are still accepted by DeepSeek.
//   node scripts/token-check.js            # all tokens in tokens.txt
//   node scripts/token-check.js <token>    # a single token
//   node scripts/token-check.js --json
const fs = require('fs');
const path = require('path');
const { request } = require('../lib/deepseek');

function fileTokens() {
  const file = process.env.DEEPSEEK_TOKENS_FILE || path.join(__dirname, '..', 'tokens.txt');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function mask(token) {
  if (!token || token.length < 14) return token || '(empty)';
  return token.slice(0, 8) + '…' + token.slice(-4);
}

(async () => {
  const argv = process.argv.slice(2);
  const jsonOut = argv.includes('--json');
  const arg = argv.find((a) => a !== '--json' && a !== '--help' && a !== '-h');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/token-check.js [token] [--json]');
    process.exit(0);
  }

  const tokens = arg ? [arg] : fileTokens();
  if (!tokens.length) {
    console.error('no token given and tokens.txt is empty/missing');
    process.exit(2);
  }

  const results = [];
  let bad = 0;

  for (const token of tokens) {
    const label = mask(token);
    try {
      const res = await request('/api/v0/users/current', { token, timeout: 15000 });
      let j = null;
      try { j = JSON.parse(res.body); } catch {}

      if (j && j.code === 0 && (j.data?.biz_code ?? 0) === 0) {
        const email = j.data?.biz_data?.email || '?';
        results.push({ token: label, status: 'ok', email });
        if (!jsonOut) console.log(`OK    ${label}  ${email}`);
      } else {
        bad += 1;
        const code = j ? (j.data?.biz_code ?? j.code) : `HTTP_${res.status}`;
        const msg = j ? (j.data?.biz_msg || j.msg || 'unknown') : String(res.body || '').slice(0, 120);
        results.push({ token: label, status: 'dead', code, msg });
        if (!jsonOut) console.log(`DEAD  ${label}  code=${code} ${msg}`);
      }
    } catch (e) {
      bad += 1;
      results.push({ token: label, status: 'error', msg: e.message });
      if (!jsonOut) console.log(`ERR   ${label}  ${e.message}`);
    }
  }

  if (jsonOut) console.log(JSON.stringify({ ok: bad === 0, results }, null, 2));
  process.exit(bad ? 1 : 0);
})();
