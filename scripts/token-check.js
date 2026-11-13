'use strict';
// Checks whether the tokens in tokens.txt are still accepted by DeepSeek.
//   node scripts/token-check.js            # all tokens in tokens.txt
//   node scripts/token-check.js <token>    # a single token
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

(async () => {
  const tokens = process.argv[2] ? [process.argv[2]] : fileTokens();
  if (!tokens.length) {
    console.error('no token given and tokens.txt is empty');
    process.exit(2);
  }

  let bad = 0;
  for (const token of tokens) {
    const label = token.slice(0, 8) + '…' + token.slice(-4);
    try {
      const res = await request('/api/v0/users/current', { token, timeout: 15000 });
      const j = JSON.parse(res.body);
      if (j.code === 0) {
        const email = j.data?.biz_data?.email || '?';
        console.log(`OK    ${label}  ${email}`);
      } else {
        bad += 1;
        console.log(`DEAD  ${label}  code=${j.code} ${j.msg}`);
      }
    } catch (e) {
      bad += 1;
      console.log(`ERR   ${label}  ${e.message}`);
    }
  }
  process.exit(bad ? 1 : 0);
})();
