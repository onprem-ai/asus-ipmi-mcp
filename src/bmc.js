// HTTP access to the BMC: AMI MegaRAC web API (session + CSRF) and Redfish.
// Two ways to authenticate: a password (ASUS_IPMI_PASSWORD), or session tokens made by
// `asus-ipmi-mcp login` (src/session.js), in which case no password is ever held here.
import { Agent, fetch } from 'undici';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The card refuses access with these bodies while the default password is still set:
//   web API: HTTP 401 {"cc":7,"error":"Password should be changed for default user ..."}
//   Redfish: HTTP 403 "... account must be changed before access is granted. PATCH the 'Password' ..."
const PASSWORD_CHANGE = /Password should be changed|PasswordChangeRequired|must be changed before access/i;
export const isPasswordChangeRequired = (text) => PASSWORD_CHANGE.test(String(text || ''));
export const passwordChangeMessage = (user, host) =>
  `the card requires a new password for ${user} (default password still set). Change it in the card's web UI (https://${host}), then run "asus-ipmi-mcp login ${host}" again`;

export class Bmc {
  /**
   * session: tokens from `asus-ipmi-mcp login`.
   * reloadSession: () => fresh session object or null (re-reads the token file), so a new `login`
   *   in a terminal takes effect without restarting the server.
   * sessionPath: path of the token file (only for messages).
   * origin: base URL override (tests); default https://<host>.
   */
  constructor({ host, user, password, session = null, reloadSession = null, sessionPath = null, insecure = true, origin = null }) {
    if (!host) throw new Error('BMC host not set (ASUS_IPMI_HOST)');
    if (!password && !session) throw new Error(`no credentials: run "asus-ipmi-mcp login ${host}" or set ASUS_IPMI_PASSWORD${sessionPath ? ` (looked for ${sessionPath})` : ''}`);
    this.host = host;
    this.origin = origin || `https://${host}`;
    this.user = (session && session.user) || user || 'admin';
    this.password = password || null;
    this.reloadSession = reloadSession;
    this.sessionPath = sessionPath;
    this.dispatcher = new Agent({ connect: { rejectUnauthorized: !insecure } });
    this.useSession(session);
  }

  get tokenMode() { return !this.password; }

  useSession(session) {
    this.session = session;
    this.sessionEnded = null; // reason, when we know the stored tokens are dead (card restart)
    this.csrf = session?.web?.csrf || null;
    this.cookie = session?.web?.cookie || null;
    this.redfishToken = session?.redfish?.token || null;
    if (session?.user) this.user = session.user;
  }

  /** Token mode: pick up tokens from a newer `login`. Returns true if they changed. */
  tryReloadSession() {
    if (!this.tokenMode || !this.reloadSession) return false;
    let s = null;
    try { s = this.reloadSession(); } catch { return false; }
    if (!s || (s.created && s.created === this.session?.created && s.web?.csrf === this.session?.web?.csrf)) return false;
    this.useSession(s);
    return true;
  }

  /** Mark the stored tokens as dead (the card restarted). */
  endSession(reason) { if (this.tokenMode) this.sessionEnded = reason; }

  reloginHint() { return `run "asus-ipmi-mcp login ${this.host}" again`; }

  sessionExpired(what) {
    const why = this.sessionEnded ? `the stored session was ended (${this.sessionEnded})` : 'the stored session has expired or was ended';
    return new Error(`${what}: ${why}; ${this.reloginHint()}${this.sessionPath ? ` (token file: ${this.sessionPath})` : ''}`);
  }

  url(p) { return `${this.origin}${p}`; }

  /**
   * Is the card's web server up? Unauthenticated GET /redfish/v1 (the Redfish service root needs
   * no login). Used to follow card restarts; never use login() for that: in token mode it does
   * not contact the card.
   */
  async isUp(timeoutMs = 5000) {
    try {
      const r = await fetch(this.url('/redfish/v1'), { dispatcher: this.dispatcher, signal: AbortSignal.timeout(timeoutMs) });
      await r.arrayBuffer().catch(() => {});
      return r.status === 200;
    } catch { return false; }
  }

  /**
   * Follow a card restart: wait until it goes down, then until it is up and stays up.
   * Returns { up, saw_down, seconds }. If it is never seen down within downMs it may have
   * restarted faster than the polling; the caller decides what that means.
   */
  async waitForRestart({ downMs = 120000, upMs = 8 * 60000, pollMs = 3000, stableChecks = 3, onProgress = () => {} } = {}) {
    const t0 = Date.now();
    const secs = () => Math.round((Date.now() - t0) / 1000);
    let sawDown = false;
    while (Date.now() - t0 < downMs) {
      if (!(await this.isUp())) { sawDown = true; onProgress(`card went down after ${secs()} s`); break; }
      await sleep(pollMs);
    }
    if (!sawDown) onProgress(`card not seen down within ${secs()} s`);
    let ok = 0;
    while (Date.now() - t0 < downMs + upMs) {
      if (await this.isUp()) { if (++ok >= stableChecks) { onProgress(`card back after ${secs()} s`); return { up: true, saw_down: sawDown, seconds: secs() }; } }
      else ok = 0;
      await sleep(pollMs);
    }
    return { up: false, saw_down: sawDown, seconds: secs() };
  }

  /** Error for a refused request; detects "default password must be changed". */
  authError(what, status, text) {
    if (isPasswordChangeRequired(text)) return new Error(`${what}: ${passwordChangeMessage(this.user, this.host)}`);
    if (status === 401 && this.tokenMode) return this.sessionExpired(what);
    return null;
  }

  // ---------- AMI web API ----------
  async login() {
    if (this.tokenMode) {
      // Token mode: reuse the stored web session; it cannot be renewed without the password.
      // NOTE: this does not contact the card, so it says nothing about whether the card is up.
      if (this.sessionEnded) this.tryReloadSession();
      if (this.csrf && !this.sessionEnded) return { CSRFToken: this.csrf };
      throw this.sessionExpired('web login');
    }
    const r = await fetch(this.url('/api/session'), {
      method: 'POST', dispatcher: this.dispatcher,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: this.user, password: this.password }).toString(),
    });
    const text = await r.text();
    if (!r.ok) {
      if (isPasswordChangeRequired(text)) throw new Error(`BMC login: ${passwordChangeMessage(this.user, this.host)}`);
      const hint = text.includes('17000') ? ' (code 17000: wrong credentials, or the BMC is locked in firmware-flash mode)' : '';
      throw new Error(`BMC login failed: HTTP ${r.status} ${text.slice(0, 120)}${hint}`);
    }
    const j = JSON.parse(text);
    this.csrf = j.CSRFToken;
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    this.cookie = sc.map((c) => c.split(';')[0]).filter((c) => c.startsWith('QSESSIONID=')).join('; ');
    return j;
  }

  async api(method, p, body) {
    if (!this.csrf || this.sessionEnded) await this.login();
    const doFetch = () => fetch(this.url(p), {
      method, dispatcher: this.dispatcher,
      headers: { 'X-CSRFTOKEN': this.csrf, cookie: this.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let r = await doFetch();
    let text = await r.text();
    if (r.status === 401 && !isPasswordChangeRequired(text)) {
      // Password mode: log in again. Token mode: maybe `login` was run again meanwhile.
      if (!this.tokenMode) { await this.login(); r = await doFetch(); text = await r.text(); }
      else if (this.tryReloadSession()) { r = await doFetch(); text = await r.text(); }
    }
    if (!r.ok) throw this.authError(`${method} ${p}`, r.status, text) || new Error(`${method} ${p}: HTTP ${r.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async logout() {
    if (this.tokenMode) return; // token mode: sessions are ended with `asus-ipmi-mcp logout`
    if (!this.csrf) return;
    try {
      await fetch(this.url('/api/session'), { method: 'DELETE', dispatcher: this.dispatcher, headers: { 'X-CSRFTOKEN': this.csrf, cookie: this.cookie } });
    } catch { /* ignore */ }
    this.csrf = null; this.cookie = null;
  }

  // ---------- Redfish ----------
  async redfish(method, p, body) {
    if (this.sessionEnded) this.tryReloadSession();
    const doFetch = () => fetch(this.url(p), {
      method, dispatcher: this.dispatcher,
      headers: {
        ...(this.password
          ? { authorization: 'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64') }
          : { 'X-Auth-Token': this.redfishToken || '' }),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let r = await doFetch();
    let text = await r.text();
    if (r.status === 401 && this.tryReloadSession()) { r = await doFetch(); text = await r.text(); }
    if (!r.ok) throw this.authError(`Redfish ${method} ${p}`, r.status, text) || new Error(`Redfish ${method} ${p}: HTTP ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  /** Download a static file from the BMC web root (e.g. the KVM decoder). */
  async getStatic(p) {
    const r = await fetch(this.url(p), { dispatcher: this.dispatcher });
    if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
}
