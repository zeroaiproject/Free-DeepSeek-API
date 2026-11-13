'use strict';
// Mailbox helpers for receiving the DeepSeek verification code.
//
// Three modes, all dependency-free:
//
//   mail.tm    disposable inbox created on the fly (handy for testing, but
//              DeepSeek blocks disposable domains on the send-code step)
//   http       poll a JSON endpoint you control: GET returns either an array of
//              messages or an object with a `messages`/`data` array; each
//              message is searched for a 6-digit code in text/html/subject
//   imap       minimal IMAP client over TLS (or plain) — enough to log in,
//              SELECT INBOX, SEARCH recent unseen messages and FETCH them
//
// `waitForCode()` returns the 6-digit string or null on timeout.

const crypto = require('crypto');
const net = require('net');
const tls = require('tls');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractCode(text) {
  if (!text) return null;
  const m = String(text).match(/\b(\d{6})\b/);
  return m ? m[1] : null;
}

async function fetchJson(url, opts = {}) {
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

// -------------------------------------------------------------------- mail.tm

async function createMailTmInbox() {
  const base = process.env.MAILTM_API || 'https://api.mail.tm';

  const domains = await fetchJson(`${base}/domains?page=1`);
  const list = Array.isArray(domains.body) ? domains.body : domains.body['hydra:member'] || [];
  if (!list.length) throw new Error('mail.tm: no domains available');
  const domain = list[0].domain;

  const local = 'ds' + crypto.randomBytes(6).toString('hex');
  const address = `${local}@${domain}`;
  const password = crypto.randomBytes(14).toString('hex');

  const created = await fetchJson(`${base}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`mail.tm create account: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  }

  const auth = await fetchJson(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  const jwt = auth.body && auth.body.token;
  if (!jwt) throw new Error('mail.tm: could not obtain a token');

  return {
    kind: 'mailtm',
    address,
    password,
    jwt,
    base,
    async waitForCode({ timeoutMs = 180_000, intervalMs = 3000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(intervalMs);
        const listRes = await fetchJson(`${base}/messages?page=1`, {
          headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
        });
        const msgs = Array.isArray(listRes.body) ? listRes.body : listRes.body['hydra:member'] || [];
        if (!msgs.length) continue;
        const msg = await fetchJson(`${base}/messages/${msgs[0].id}`, {
          headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
        });
        const text = flattenMessage(msg.body);
        const code = extractCode(text);
        if (code) return code;
      }
      return null;
    },
  };
}

function flattenMessage(msg) {
  if (!msg) return '';
  const parts = [];
  if (msg.subject) parts.push(String(msg.subject));
  if (msg.intro) parts.push(String(msg.intro));
  if (msg.text) parts.push(String(msg.text));
  if (msg.html) {
    if (Array.isArray(msg.html)) parts.push(msg.html.join('\n'));
    else parts.push(String(msg.html));
  }
  return parts.join('\n');
}

// ----------------------------------------------------------------- HTTP poll
// Polls a URL that returns JSON. The response is searched for a 6-digit code;
// by default it looks for the newest unread-looking message, but you can pass
// `pick(messages)` to choose.

async function createHttpInbox({ url, headers = {}, pick } = {}) {
  if (!url) throw new Error('http mailbox needs a url');
  const address = process.env.MAILBOX_EMAIL || '(http mailbox)';
  return {
    kind: 'http',
    address,
    async waitForCode({ timeoutMs = 180_000, intervalMs = 4000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(intervalMs);
        const res = await fetchJson(url, { headers });
        const body = res.body;
        const messages = Array.isArray(body)
          ? body
          : body && (body.messages || body.data || body.items || body['hydra:member']) || [];
        const haystack = pick ? pick(messages, body) : JSON.stringify(messages);
        const code = extractCode(typeof haystack === 'string' ? haystack : JSON.stringify(haystack));
        if (code) return code;
        // also try the whole body as a fallback (some endpoints just echo text)
        if (!messages.length) {
          const fallback = extractCode(typeof body === 'string' ? body : JSON.stringify(body));
          if (fallback) return fallback;
        }
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------- IMAP
// Minimal IMAP client: LOGIN, SELECT, SEARCH UNSEEN, FETCH BODY[TEXT]/RFC822.
// Good enough to read a verification code. No IDLE, no complex MIME parsing.

class ImapClient {
  constructor({ host, port = 993, tls: useTls = true, user, password, mailbox = 'INBOX' }) {
    this.host = host;
    this.port = port;
    this.useTls = useTls;
    this.user = user;
    this.password = password;
    this.mailbox = mailbox;
    this.tag = 0;
    this.sock = null;
    this.buf = '';
    this.pending = null;
  }

  nextTag() {
    this.tag += 1;
    return `A${String(this.tag).padStart(4, '0')}`;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onConnect = () => resolve();
      const onError = (e) => reject(e);
      if (this.useTls) {
        this.sock = tls.connect({ host: this.host, port: this.port, servername: this.host }, onConnect);
      } else {
        this.sock = net.connect({ host: this.host, port: this.port }, onConnect);
      }
      this.sock.setEncoding('utf8');
      this.sock.on('error', onError);
      this.sock.on('data', (chunk) => this.onData(chunk));
      this.sock.on('close', () => {
        if (this.pending) this.pending.reject(new Error('imap: connection closed'));
      });
    });
  }

  onData(chunk) {
    this.buf += chunk;
    // tagged response terminates a command: "A0001 OK ..." or "A0001 NO/ BAD ..."
    if (!this.pending) return;
    const { tag, resolve, reject } = this.pending;
    const re = new RegExp(`^${tag} (OK|NO|BAD)`, 'm');
    const m = this.buf.match(re);
    if (!m) return;
    const response = this.buf;
    this.buf = '';
    this.pending = null;
    if (m[1] === 'OK') resolve(response);
    else reject(new Error(`imap ${m[1]}: ${response.slice(0, 400)}`));
  }

  command(line) {
    return new Promise((resolve, reject) => {
      const tag = this.nextTag();
      this.pending = { tag, resolve, reject };
      this.sock.write(`${tag} ${line}\r\n`);
    });
  }

  quote(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  async login() {
    // consume greeting if any is buffered is fine; server greets before first cmd
    await sleep(200);
    this.buf = '';
    await this.command(`LOGIN ${this.quote(this.user)} ${this.quote(this.password)}`);
  }

  async select(mailbox) {
    return this.command(`SELECT ${this.quote(mailbox)}`);
  }

  async searchUnseen() {
    const res = await this.command('SEARCH UNSEEN');
    // * SEARCH 1 2 3
    const ids = [];
    for (const line of res.split(/\r?\n/)) {
      const m = line.match(/^\* SEARCH\s*(.*)$/i);
      if (m) {
        for (const tok of m[1].trim().split(/\s+/)) {
          if (/^\d+$/.test(tok)) ids.push(Number(tok));
        }
      }
    }
    return ids;
  }

  async fetchText(id) {
    const res = await this.command(`FETCH ${id} BODY[TEXT]`);
    return res;
  }

  async fetchRecent(limit = 5) {
    // fall back to fetching the last few messages if nothing is UNSEEN
    const res = await this.command('SEARCH ALL');
    const ids = [];
    for (const line of res.split(/\r?\n/)) {
      const m = line.match(/^\* SEARCH\s*(.*)$/i);
      if (m) {
        for (const tok of m[1].trim().split(/\s+/)) {
          if (/^\d+$/.test(tok)) ids.push(Number(tok));
        }
      }
    }
    return ids.slice(-limit);
  }

  async logout() {
    try {
      await this.command('LOGOUT');
    } catch {}
    try {
      this.sock.end();
    } catch {}
  }
}

async function createImapInbox({ host, port, tls: useTls = true, user, password, mailbox = 'INBOX' } = {}) {
  if (!host || !user || !password) {
    throw new Error('imap mailbox needs host, user and password');
  }
  return {
    kind: 'imap',
    address: user,
    async waitForCode({ timeoutMs = 180_000, intervalMs = 5000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const client = new ImapClient({ host, port, tls: useTls, user, password, mailbox });
        try {
          await client.connect();
          await client.login();
          await client.select(mailbox);
          let ids = await client.searchUnseen();
          if (!ids.length) ids = await client.fetchRecent(3);
          for (const id of ids.slice(-5)) {
            const text = await client.fetchText(id);
            const code = extractCode(text);
            if (code) {
              await client.logout();
              return code;
            }
          }
          await client.logout();
        } catch {
          try { client.sock && client.sock.destroy(); } catch {}
        }
        await sleep(intervalMs);
      }
      return null;
    },
  };
}

// ------------------------------------------------------------------- factory

async function createMailbox(opts = {}) {
  const kind = opts.kind || process.env.MAILBOX || 'mailtm';
  switch (kind) {
    case 'mailtm':
      return createMailTmInbox();
    case 'http':
      return createHttpInbox({ url: opts.url || process.env.MAILBOX_URL, headers: opts.headers });
    case 'imap':
      return createImapInbox({
        host: opts.host || process.env.IMAP_HOST,
        port: Number(opts.port || process.env.IMAP_PORT || 993),
        tls: opts.tls !== undefined ? opts.tls : process.env.IMAP_TLS !== '0',
        user: opts.user || process.env.IMAP_USER,
        password: opts.password || process.env.IMAP_PASSWORD,
        mailbox: opts.mailbox || process.env.IMAP_MAILBOX || 'INBOX',
      });
    default:
      throw new Error(`unknown mailbox kind: ${kind}`);
  }
}

module.exports = {
  createMailbox,
  createMailTmInbox,
  createHttpInbox,
  createImapInbox,
  extractCode,
  ImapClient,
};
