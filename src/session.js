// Password-free operation: `asus-ipmi-mcp login <host>` asks for the password once (hidden
// prompt on the terminal), opens a web session and a Redfish session on the card, and stores
// only those session tokens in a file readable by the user alone. The MCP server then runs
// on the tokens; the password is never stored, logged, passed on the command line or put in
// the MCP config. The sessions expire on the card after inactivity; `logout` ends them now.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, fetch } from 'undici';

export function sessionFile(host, file = process.env.ASUS_IPMI_SESSION_FILE) {
  if (file) return file;
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'asus-ipmi-mcp', `${host}.json`);
}

export function loadSession(host, file) {
  const f = sessionFile(host, file);
  if (!fs.existsSync(f)) return null;
  const st = fs.statSync(f);
  if (st.mode & 0o077) throw new Error(`session file ${f} is readable by others; run: chmod 600 ${f}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function saveSession(host, data, file) {
  const f = sessionFile(host, file);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return f;
}

/** Read a line from the terminal without echoing it. */
export function promptHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('login needs an interactive terminal (the password is never read from a pipe or argument)');
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (err) => {
      stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
      process.stderr.write('\n');
      err ? reject(err) : resolve(buf);
    };
    const onData = (s) => {
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function login({ host, user = 'admin', file }) {
  if (!host) throw new Error('usage: asus-ipmi-mcp login <host> [--user <user>]');
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  let password = await promptHidden(`Password for ${user}@${host} (not stored): `);
  try {
    // Web session: used by the KVM, virtual media and firmware tools.
    const r = await fetch(`https://${host}/api/session`, {
      method: 'POST', dispatcher,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: user, password }).toString(),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`login failed: HTTP ${r.status}${t.includes('17000') ? ' (wrong credentials, or the card is in flash mode)' : ''}`);
    const j = JSON.parse(t);
    const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [])
      .map((c) => c.split(';')[0]).filter((c) => c.startsWith('QSESSIONID=')).join('; ');

    // Redfish session: used by system_info, sensors, power.
    let redfish = null;
    const rr = await fetch(`https://${host}/redfish/v1/SessionService/Sessions`, {
      method: 'POST', dispatcher,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ UserName: user, Password: password }),
    });
    if (rr.ok) redfish = { token: rr.headers.get('x-auth-token'), uri: rr.headers.get('location') };
    else process.stderr.write(`warning: Redfish session refused (HTTP ${rr.status}); Redfish tools will fail\n`);

    const f = saveSession(host, { host, user, created: new Date().toISOString(), web: { cookie, csrf: j.CSRFToken }, redfish }, file);
    process.stderr.write(`Sessions stored in ${f} (mode 600, no password). They expire on the card after inactivity; end them with: asus-ipmi-mcp logout ${host}\n`);
  } finally {
    password = null;
  }
}

export async function logout({ host, file }) {
  if (!host) throw new Error('usage: asus-ipmi-mcp logout <host>');
  const f = sessionFile(host, file);
  const s = loadSession(host, file);
  if (!s) { process.stderr.write(`no session file ${f}\n`); return; }
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  await fetch(`https://${host}/api/session`, { method: 'DELETE', dispatcher, headers: { 'X-CSRFTOKEN': s.web?.csrf || '', cookie: s.web?.cookie || '' } }).catch(() => {});
  if (s.redfish?.uri) {
    const u = s.redfish.uri.startsWith('http') ? s.redfish.uri : `https://${host}${s.redfish.uri}`;
    await fetch(u, { method: 'DELETE', dispatcher, headers: { 'X-Auth-Token': s.redfish.token } }).catch(() => {});
  }
  fs.rmSync(f, { force: true });
  process.stderr.write(`Sessions ended on the card and ${f} removed.\n`);
}
