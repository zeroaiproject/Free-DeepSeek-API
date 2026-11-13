'use strict';
// Exchange DeepSeek email + password for a web userToken.
// usage: node scripts/login.js <email> <password> [--json]
const { login } = require('../lib/auth');

function parseArgs(argv) {
  const args = { _: [] };
  for (const a of argv) {
    if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const [email, password] = args._;

  if (args.help || !email || !password) {
    console.log('Usage: node scripts/login.js <email> <password> [--json]');
    console.log('  Exchanges DeepSeek credentials for a web userToken.');
    console.log('  Tip: append the token to tokens.txt (one per line).');
    process.exit(args.help ? 0 : 2);
  }

  login(email, password)
    .then((r) => {
      if (args.json) {
        console.log(JSON.stringify({ token: r.token, email: r.email, deviceId: r.deviceId || null }));
      } else {
        console.log('token:   ' + r.token);
        console.log('account: ' + r.email);
        console.log('\nAppend it to tokens.txt (one per line).');
      }
    })
    .catch((e) => {
      console.error('error:', e.message);
      process.exit(1);
    });
}

module.exports = { login };
