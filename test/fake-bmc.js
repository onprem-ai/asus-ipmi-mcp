// Minimal fake of the card's HTTP API, Redfish and KVM websocket for unit tests (plain HTTP).
import http from 'node:http';
import { WebSocketServer } from 'ws';

export async function startFakeBmc(opts = {}) {
  const st = {
    up: true,
    passwordChange: false,          // default password still set: refuse every call like the card does
    version: '1.1.35',              // web API spelling; Redfish gets "1.01.35"
    restartDownMs: 300,             // POST /api/maintenance/reset: down this long
    sessions: new Set(),            // valid web CSRF tokens
    redfishTokens: new Set(),
    calls: [],
    deleted: [],
    kvm: opts.kvm || null,          // (ws, socket) => void : KVM behaviour
    n: 0,
    ...opts,
  };
  const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  const restart = () => {
    st.up = false; st.sessions.clear(); st.redfishTokens.clear();
    setTimeout(() => { st.up = true; }, st.restartDownMs).unref();
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      st.calls.push(`${req.method} ${req.url}`);
      if (!st.up) { req.socket.destroy(); return; }
      const url = req.url.split('?')[0];
      if (url === '/redfish/v1' && req.method === 'GET') return json(res, 200, { Product: 'AMI Redfish Server' });
      if (url === '/api/session' && req.method === 'POST') {
        const p = new URLSearchParams(body);
        if (p.get('password') !== 'pw') return json(res, 401, { cc: 7, error: 'Invalid Authentication', code: 17000 });
        const csrf = `c${++st.n}`; st.sessions.add(csrf);
        return json(res, 200, { ok: 0, CSRFToken: csrf }, { 'set-cookie': `QSESSIONID=q${csrf}; path=/; secure` });
      }
      if (url === '/api/session' && req.method === 'DELETE') { st.deleted.push('web'); st.sessions.delete(req.headers['x-csrftoken']); return json(res, 200, {}); }
      if (url === '/redfish/v1/SessionService/Sessions' && req.method === 'POST') {
        const t = `r${++st.n}`; st.redfishTokens.add(t);
        return json(res, 201, {}, { 'x-auth-token': t, location: `/redfish/v1/SessionService/Sessions/${t}` });
      }
      if (url.startsWith('/redfish/v1/SessionService/Sessions/') && req.method === 'DELETE') { st.deleted.push('redfish'); return json(res, 204, {}); }
      if (url.startsWith('/redfish/')) {
        if (st.passwordChange) return json(res, 403, { error: { message: 'The password for this account must be changed before access is granted. PATCH the \'Password\' property for this account located at the target URI \'/redfish/v1/AccountService/Accounts/1\' to complete this process.' } });
        const tok = req.headers['x-auth-token'];
        const basic = req.headers.authorization === 'Basic ' + Buffer.from('admin:pw').toString('base64');
        if (!basic && !st.redfishTokens.has(tok)) return json(res, 401, { error: 'denied' });
        if (url === '/redfish/v1/Managers/Self') return json(res, 200, { Model: 'AST2600', FirmwareVersion: st.version.split('.').map((x, i) => (i === 1 ? x.padStart(2, '0') : x)).join('.') });
        if (url === '/redfish/v1/Systems/Self') return json(res, 200, { PowerState: 'On' });
        return json(res, 200, {});
      }
      if (url.startsWith('/api/')) {
        if (st.passwordChange) return json(res, 401, { cc: 7, error: 'Password should be changed for default user and should have a minimum of 8 characters.' });
        if (!st.sessions.has(req.headers['x-csrftoken'])) return json(res, 401, { cc: 7, error: 'Invalid Authentication' });
        if (url === '/api/maintenance/reset') { json(res, 200, {}); setTimeout(restart, 20); return; }
        if (url === '/api/Information') return json(res, 200, { FWVersion: st.version, FWDate: 'x', FWModels: [{ Model: 'KOMMANDO' }] });
        if (url === '/api/chassis-status') return json(res, 200, { power_status: 1 });
        if (url === '/api/settings/media/h5viewercfg') return json(res, 200, { kvm_service_status: 1, token: 't', session: 's', client_ip: '1.2.3.4', server_ip: '127.0.0.1' });
        if (url === '/api/settings/service-sessions') return json(res, 200, []);
        return json(res, 200, {});
      }
      json(res, 404, {});
    });
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
  server.on('upgrade', (req, socket, head) => {
    st.lastUpgradeHeaders = req.headers;
    if (!st.up) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => st.kvm && st.kvm(ws, socket));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { st, origin, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections?.(); server.close(() => r()); }) };
}

/** IVTP packet: u16 type | u32 size | u16 status | payload */
export function ivtp(type, status = 0, payload = Buffer.alloc(0)) {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt16LE(type, 0); b.writeUInt32LE(payload.length, 2); b.writeUInt16LE(status, 6); payload.copy(b, 8);
  return b;
}
