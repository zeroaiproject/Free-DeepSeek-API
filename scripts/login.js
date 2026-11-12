'use strict';
// Exchange DeepSeek email + password for a web userToken.
// usage: node scripts/login.js <email> <password>
const crypto = require('crypto');
const { request } = require('../lib/deepseek');

async function login(email, password) {
  const deviceId = crypto.randomUUID();
  const res = await request('/api/v0/users/login', {
    method: 'POST',
    body: { email, password, os: 'android', device_id: deviceId },
    // The web `os` value is silently answered with HTTP 202 (anti-bot gate);
    // the app client shape is accepted and returns a real biz_code.
    headers: {
      'x-device-id': deviceId,
      'x-client-platform': 'android',
      'x-client-version': '2.7.5',
      'x-app-version': '2.7.5',
      'User-Agent': 'DeepSeek/2.7.5 (Android 14; Pixel 7)',
    },
  });

  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error('unparseable response: ' + res.body.slice(0, 200));
  }
  if (json.code !== 0) throw new Error(`login failed (${json.code}): ${json.msg}`);

  const envelope = json.data || {};
  if (envelope.biz_code !== 0) {
    throw new Error(`login failed (${envelope.biz_code}): ${envelope.biz_msg || 'unknown'}`);
  }

  const biz = envelope.biz_data;
  const token = biz?.user?.token || biz?.token;
  if (!token) throw new Error('no token in response: ' + JSON.stringify(biz).slice(0, 300));
  return { token, email: biz.user?.email || email, deviceId };
}

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
