'use strict';
// Exchange DeepSeek email + password for a web userToken.
// usage: node scripts/login.js <email> <password>
const { login } = require('../lib/auth');

if (require.main === module) {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('usage: node scripts/login.js <email> <password>');
    process.exit(2);
  }
  login(email, password)
    .then((r) => {
      console.log('token:', r.token);
      console.error('account:', r.email);
    })
    .catch((e) => {
      console.error('error:', e.message);
      process.exit(1);
    });
}

module.exports = { login };
