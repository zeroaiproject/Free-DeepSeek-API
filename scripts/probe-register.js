'use strict';
// Probe: can we register a DeepSeek account from a disposable mailbox?
// Creates a mail.tm inbox, asks DeepSeek for a verification code, waits for it,
// registers, and prints the resulting userToken.

const crypto = require('crypto');

const VERSION = process.env.DS_APP_VERSION || '2.7.6';
const UA = `DeepSeek/${VERSION} (Android 14; Pixel 7)`;
const DS = 'https://chat.deepseek.com';
const MAIL = 'https://api.mail.tm';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function makeInbox() {
  const domains = await json(`${MAIL}/domains?page=1`);
  const domain = domains.body[0].domain;
  const local = 'ds' + crypto.randomBytes(6).toString('hex');
  const address = `${local}@${domain}`;
  const password = crypto.randomBytes(12).toString('hex');

  const created = await json(`${MAIL}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`mail.tm account failed: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  }

  const auth = await json(`${MAIL}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  if (!auth.body.token) throw new Error('mail.tm token failed');

  return { address, password, jwt: auth.body.token };
}

async function dsPost(path, body, headers = {}) {
  const deviceId = crypto.randomUUID();
  return json(`${DS}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-device-id': deviceId,
      'x-client-platform': 'android',
      'x-client-version': VERSION,
      'x-app-version': VERSION,
      'User-Agent': UA,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function main() {
  const inbox = await makeInbox();
  console.log('inbox:', inbox.address);

  const code = await dsPost('/api/v0/users/create_email_verification_code', {
    email: inbox.address,
    locale: 'en_US',
    device_id: crypto.randomUUID(),
    scenario: 'register',
    os: 'android',
  });
  console.log('send code:', JSON.stringify(code.body).slice(0, 300));

  if (code.body.code !== 0 || code.body.data?.biz_code !== 0) {
    console.log('cannot request code, stopping');
    return;
  }

  // Poll the inbox for the DeepSeek mail.
  let found = null;
  for (let i = 0; i < 30 && !found; i++) {
    await sleep(3000);
    const list = await json(`${MAIL}/messages?page=1`, {
      headers: { Authorization: `Bearer ${inbox.jwt}`, Accept: 'application/json' },
    });
    const msgs = Array.isArray(list.body) ? list.body : list.body['hydra:member'] || [];
    if (msgs.length) {
      const msg = await json(`${MAIL}/messages/${msgs[0].id}`, {
        headers: { Authorization: `Bearer ${inbox.jwt}`, Accept: 'application/json' },
      });
      found = msg.body;
      break;
    }
  }

  if (!found) {
    console.log('no mail arrived');
    return;
  }

  const text = (found.text || '') + '\n' + (found.html ? found.html.join(' ') : '');
  console.log('mail subject:', found.subject);
  const m = text.match(/\b(\d{6})\b/);
  console.log('extracted code:', m ? m[1] : '(none)');
  console.log('mail excerpt:', text.replace(/\s+/g, ' ').slice(0, 300));
  if (!m) return;

  const password = crypto.randomBytes(16).toString('base64url');
  const reg = await dsPost('/api/v0/users/register', {
    email: inbox.address,
    code: m[1],
    password,
    device_id: crypto.randomUUID(),
    os: 'android',
  });
  console.log('register:', JSON.stringify(reg.body).slice(0, 500));

  const biz = reg.body.data?.biz_data;
  const token = biz?.user?.token || biz?.token;
  if (token) {
    console.log('\nTOKEN:', token);
    console.log('EMAIL:', inbox.address);
    console.log('PASSWORD:', password);
  }
}

main().catch((e) => {
  console.error('fatal:', e.message);
  process.exit(1);
});
