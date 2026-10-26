// HTTP access to the BMC: AMI MegaRAC web API (session + CSRF) and Redfish.
// Two ways to authenticate: a password (ASUS_IPMI_PASSWORD), or session tokens made by
// `asus-ipmi-mcp login` (src/session.js), in which case no password is ever held here.
import { Agent, fetch } from 'undici';

export class Bmc {
  constructor({ host, user, password, session = null, insecure = true }) {
    if (!host) throw new Error('BMC host not set (ASUS_IPMI_HOST)');
    if (!password && !session) throw new Error(`no credentials: run "asus-ipmi-mcp login ${host}" or set ASUS_IPMI_PASSWORD`);
    this.host = host;
    this.user = (session && session.user) || user || 'admin';
    this.password = password || null;
    this.session = session;
    this.dispatcher = new Agent({ connect: { rejectUnauthorized: !insecure } });
    this.csrf = session?.web?.csrf || null;
    this.cookie = session?.web?.cookie || null;
    this.redfishToken = session?.redfish?.token || null;
  }

  sessionExpired(what) {
    return new Error(`${what}: the stored session has expired or was ended; run "asus-ipmi-mcp login ${this.host}" again`);
  }

  url(p) { return `https://${this.host}${p}`; }

  // ---------- AMI web API ----------
  async login() {
    if (!this.password) {
      // Token mode: reuse the stored web session; it cannot be renewed without the password.
      if (this.session?.web?.csrf) {
        this.csrf = this.session.web.csrf; this.cookie = this.session.web.cookie;
        return { CSRFToken: this.csrf };
      }
      throw this.sessionExpired('web login');
    }
    const r = await fetch(this.url('/api/session'), {
      method: 'POST', dispatcher: this.dispatcher,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: this.user, password: this.password }).toString(),
    });
    const text = await r.text();
    if (!r.ok) {
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
    if (!this.csrf) await this.login();
    const doFetch = () => fetch(this.url(p), {
      method, dispatcher: this.dispatcher,
      headers: { 'X-CSRFTOKEN': this.csrf, cookie: this.cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let r = await doFetch();
    if (r.status === 401) {
      if (!this.password) throw this.sessionExpired(`${method} ${p}`);
      await this.login(); r = await doFetch();
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async logout() {
    if (!this.password) return; // token mode: sessions are ended with `asus-ipmi-mcp logout`
    if (!this.csrf) return;
    try {
      await fetch(this.url('/api/session'), { method: 'DELETE', dispatcher: this.dispatcher, headers: { 'X-CSRFTOKEN': this.csrf, cookie: this.cookie } });
    } catch { /* ignore */ }
    this.csrf = null; this.cookie = null;
  }

  // ---------- Redfish ----------
  async redfish(method, p, body) {
    const r = await fetch(this.url(p), {
      method, dispatcher: this.dispatcher,
      headers: {
        ...(this.password
          ? { authorization: 'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64') }
          : { 'X-Auth-Token': this.redfishToken || '' }),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (r.status === 401 && !this.password) throw this.sessionExpired(`Redfish ${method} ${p}`);
    if (!r.ok) throw new Error(`Redfish ${method} ${p}: HTTP ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  /** Download a static file from the BMC web root (e.g. the KVM decoder). */
  async getStatic(p) {
    const r = await fetch(this.url(p), { dispatcher: this.dispatcher });
    if (!r.ok) throw new Error(`GET ${p}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
}
