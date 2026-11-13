'use strict';
// Email + password login for a DeepSeek account, used both by scripts/login.js
// and by the server's automatic re-login when a token is revoked.

const crypto = require('crypto');
const { request } = require('./deepseek');

const CLIENT_VERSION = process.env.DEEPSEEK_CLIENT_VERSION || '2.7.5';

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
      'x-client-version': CLIENT_VERSION,
      'x-app-version': CLIENT_VERSION,
      'User-Agent': `DeepSeek/${CLIENT_VERSION} (Android 14; Pixel 7)`,
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

module.exports = { login };
