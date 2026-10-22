// HTTP access to the BMC: AMI MegaRAC web API (session + CSRF) and Redfish (basic auth).
import { Agent, fetch } from 'undici';

export class Bmc {
  constructor({ host, user, password, insecure = true }) {
    if (!host) throw new Error('BMC host not set (ASUS_IPMI_HOST)');
    if (!password) throw new Error('BMC password not set (ASUS_IPMI_PASSWORD)');
    this.host = host;
    this.user = user || 'admin';
    this.password = password;
    this.dispatcher = new Agent({ connect: { rejectUnauthorized: !insecure } });
    this.csrf = null;
    this.cookie = null;
  }

  url(p) { return `https://${this.host}${p}`; }

  // ---------- AMI web API ----------
  async login() {
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
    if (r.status === 401) { await this.login(); r = await doFetch(); }
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async logout() {
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
        authorization: 'Basic ' + Buffer.from(`${this.user}:${this.password}`).toString('base64'),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
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
