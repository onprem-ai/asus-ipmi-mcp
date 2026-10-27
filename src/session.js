// Password-free operation: `asus-ipmi-mcp login <host>` asks for the password once (hidden
// prompt on the terminal), opens a web session and a Redfish session on the card, and stores
// only those session tokens in a file readable by the user alone. The MCP server then runs
// on the tokens; the password is never stored, logged, passed on the command line or put in
// the MCP config. The sessions expire on the card after inactivity; `logout` ends them now.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, fetch } from 'undici';
import { isPasswordChangeRequired, passwordChangeMessage } from './bmc.js';

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

/**
 * One check call per session right after login. The card hands out sessions even while the
 * default password must still be changed, then refuses every call with it; catch that here
 * instead of storing unusable tokens.
 */
async function checkSessions({ origin, dispatcher, web, redfish, user, host }) {
  const problems = [];
  const checks = [
    ['web API', `${origin}/api/chassis-status`, { 'X-CSRFTOKEN': web.csrf, cookie: web.cookie }],
    ...(redfish ? [['Redfish', `${origin}/redfish/v1/Managers/Self`, { 'X-Auth-Token': redfish.token || '' }]] : []),
  ];
  for (const [name, url, headers] of checks) {
    let r, t;
    try { r = await fetch(url, { dispatcher, headers }); t = await r.text(); } catch (e) { problems.push({ name, warn: `${name} check failed: ${e.message}` }); continue; }
    if (isPasswordChangeRequired(t)) return { fatal: passwordChangeMessage(user, host) };
    if (r.status !== 200) problems.push({ name, warn: `${name} check: HTTP ${r.status} ${t.slice(0, 160)}` });
  }
  return { problems };
}

async function deleteSessions({ origin, dispatcher, web, redfish }) {
  if (web) await fetch(`${origin}/api/session`, { method: 'DELETE', dispatcher, headers: { 'X-CSRFTOKEN': web.csrf || '', cookie: web.cookie || '' } }).catch(() => {});
  if (redfish?.uri) {
    const u = redfish.uri.startsWith('http') ? redfish.uri : `${origin}${redfish.uri}`;
    await fetch(u, { method: 'DELETE', dispatcher, headers: { 'X-Auth-Token': redfish.token } }).catch(() => {});
  }
}

export async function login({ host, user = 'admin', file, origin = null, readPassword = promptHidden }) {
  if (!host) throw new Error('usage: asus-ipmi-mcp login <host> [--user <user>]');
  origin = origin || `https://${host}`;
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  let password = await readPassword(`Password for ${user}@${host} (not stored): `);
  try {
    // Web session: used by the KVM, virtual media and firmware tools.
    const r = await fetch(`${origin}/api/session`, {
      method: 'POST', dispatcher,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: user, password }).toString(),
    });
    const t = await r.text();
    if (!r.ok) {
      if (isPasswordChangeRequired(t)) throw new Error(`login: ${passwordChangeMessage(user, host)}`);
      throw new Error(`login failed: HTTP ${r.status}${t.includes('17000') ? ' (wrong credentials, or the card is in flash mode)' : ''}`);
    }
    const j = JSON.parse(t);
    const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [])
      .map((c) => c.split(';')[0]).filter((c) => c.startsWith('QSESSIONID=')).join('; ');

    // Redfish session: used by system_info, sensors, power.
    let redfish = null;
    const rr = await fetch(`${origin}/redfish/v1/SessionService/Sessions`, {
      method: 'POST', dispatcher,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ UserName: user, Password: password }),
    });
    const rt = await rr.text();
    if (rr.ok) redfish = { token: rr.headers.get('x-auth-token'), uri: rr.headers.get('location') };
    else if (isPasswordChangeRequired(rt)) throw new Error(`login: ${passwordChangeMessage(user, host)}`);
    else process.stderr.write(`warning: Redfish session refused (HTTP ${rr.status}); Redfish tools (system_info, sensors, power) will fail\n`);

    const web = { cookie, csrf: j.CSRFToken };
    const check = await checkSessions({ origin, dispatcher, web, redfish, user, host });
    if (check.fatal) {
      await deleteSessions({ origin, dispatcher, web, redfish });
      throw new Error(`login: ${check.fatal}`);
    }
    for (const p of check.problems) process.stderr.write(`warning: ${p.warn}\n`);

    const f = saveSession(host, { host, user, created: new Date().toISOString(), web, redfish }, file);
    process.stderr.write(`Sessions stored in ${f} (mode 600, no password). They expire on the card after inactivity, and a card restart ends them; end them now with: asus-ipmi-mcp logout ${host}\n`);
    return { file: f, warnings: check.problems.map((p) => p.warn) };
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
  await deleteSessions({ origin: `https://${host}`, dispatcher, web: s.web, redfish: s.redfish });
  fs.rmSync(f, { force: true });
  process.stderr.write(`Sessions ended on the card and ${f} removed.\n`);
}
