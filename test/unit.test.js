// Unit tests against a fake card (no hardware): node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeBmc, ivtp } from './fake-bmc.js';
import { Bmc } from '../src/bmc.js';
import { cancelFlashMode, waitForBmc, normalizeVersion, currentFirmware, resetBmc } from '../src/firmware.js';
import { login, loadSession } from '../src/session.js';
import { KvmSession, CMD, PRIV, REQ } from '../src/kvm.js';
import { createTools } from '../src/tools.js';
import { resolveRefs, runSteps } from '../src/cli.js';

const FAST = { pollMs: 50, stableChecks: 2, downMs: 3000, upMs: 5000 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aim-test-'));

async function tokenBmc(fake, extra = {}) {
  // a real web + redfish session, as `login` would store it
  const pw = new Bmc({ host: 'card', password: 'pw', origin: fake.origin });
  await pw.login();
  const r = await fetch(`${fake.origin}/redfish/v1/SessionService/Sessions`, { method: 'POST' });
  const session = { user: 'admin', created: 'A', web: { csrf: pw.csrf, cookie: pw.cookie }, redfish: { token: r.headers.get('x-auth-token') } };
  return new Bmc({ host: 'card', session, origin: fake.origin, ...extra });
}

// ---------- 1. restart detection ----------
test('isUp: unauthenticated /redfish/v1', async () => {
  const fake = await startFakeBmc();
  const bmc = new Bmc({ host: 'card', password: 'pw', origin: fake.origin });
  assert.equal(await bmc.isUp(), true);
  fake.st.up = false;
  assert.equal(await bmc.isUp(), false);
  await fake.close();
});

test('dry-run cancel in token mode: follows the restart, no false "back", reports ended session', async () => {
  const fake = await startFakeBmc({ restartDownMs: 400 });
  const bmc = await tokenBmc(fake);
  const lines = [];
  const r = await cancelFlashMode(bmc, (l) => lines.push(l), FAST);
  assert.equal(r.recovered, true);
  assert.equal(r.bmc_up, true);
  assert.equal(r.restart_seen, true, lines.join('; '));
  assert.match(r.session, /ended by card restart.*login card/);
  assert.equal(r.firmware, undefined);
  assert.ok(lines.some((l) => /went down/.test(l)) && lines.some((l) => /back after/.test(l)), lines.join('; '));
  // later calls name the real reason
  await assert.rejects(bmc.api('GET', '/api/Information'), /ended \(card restart\).*login card/);
  await fake.close();
});

test('flash wait in token mode: bmc_up instead of a false timeout', async () => {
  const fake = await startFakeBmc({ restartDownMs: 300 });
  const bmc = await tokenBmc(fake);
  setTimeout(() => { fake.st.up = false; fake.st.sessions.clear(); setTimeout(() => { fake.st.version = '1.3.13'; fake.st.up = true; }, 300); }, 100);
  const r = await waitForBmc(bmc, { ...FAST, timeoutMs: 5000 });
  assert.equal(r.bmc_up, true);
  assert.match(r.session, /login card/);
  await fake.close();
});

test('restart in password mode: logs in again and reports the normalised version', async () => {
  const fake = await startFakeBmc({ restartDownMs: 200 });
  const bmc = new Bmc({ host: 'card', password: 'pw', origin: fake.origin });
  await bmc.login();
  const r = await cancelFlashMode(bmc, () => {}, FAST);
  assert.equal(r.recovered, true);
  assert.deepEqual(r.firmware.version, '1.1.35');
  await fake.close();
});

test('card that never comes back: recovered false', async () => {
  const fake = await startFakeBmc({ restartDownMs: 1e9 });
  const bmc = new Bmc({ host: 'card', password: 'pw', origin: fake.origin });
  await bmc.login();
  const r = await cancelFlashMode(bmc, () => {}, { ...FAST, downMs: 500, upMs: 500 });
  assert.equal(r.recovered, false);
  await fake.close();
});

test('token mode: a new login (token file) is picked up without restarting the server', async () => {
  const fake = await startFakeBmc({ restartDownMs: 100 });
  let stored = null;
  const bmc = await tokenBmc(fake, { reloadSession: () => stored });
  await cancelFlashMode(bmc, () => {}, FAST);
  await assert.rejects(bmc.api('GET', '/api/Information'), /login/);
  const fresh = await tokenBmc(fake);
  stored = { ...fresh.session, created: 'B' };
  const info = await bmc.api('GET', '/api/Information');
  assert.equal(info.FWVersion, '1.1.35');
  assert.ok((await bmc.redfish('GET', '/redfish/v1/Managers/Self')).FirmwareVersion);
  await fake.close();
});

test('expired token (no restart): reloads a newer token file on 401', async () => {
  const fake = await startFakeBmc();
  let stored = null;
  const bmc = await tokenBmc(fake, { reloadSession: () => stored });
  fake.st.sessions.clear();
  await assert.rejects(bmc.api('GET', '/api/chassis-status'), /expired or was ended/);
  stored = { ...(await tokenBmc(fake)).session, created: 'C' };
  assert.equal((await bmc.api('GET', '/api/chassis-status')).power_status, 1);
  await fake.close();
});

test('bmc_reset path: token mode restarts with the stored web session, reports re-login', async () => {
  const fake = await startFakeBmc({ restartDownMs: 200 });
  const bmc = await tokenBmc(fake);
  const r = await resetBmc(bmc, () => {}, FAST);
  assert.equal(r.bmc_up, true);
  assert.equal(r.restart_seen, true);
  assert.match(r.session, /login card/);
  assert.ok(fake.st.calls.includes('POST /api/maintenance/reset'));
  await fake.close();
});

test('bmc_reset refuses while a flash is in progress', async () => {
  const fake = await startFakeBmc({ flashing: true });
  const bmc = await tokenBmc(fake);
  await assert.rejects(resetBmc(bmc, () => {}, FAST), /flash is in progress/);
  assert.ok(!fake.st.calls.includes('POST /api/maintenance/reset'));
  await fake.close();
});

test('token mode keeps the Redfish session alive', async () => {
  const fake = await startFakeBmc();
  const bmc = await tokenBmc(fake);
  const { close } = createTools({ bmc, flags: { maxSide: 1024, redfishKeepAliveMs: 50 } });
  await new Promise((r) => setTimeout(r, 180));
  await close();
  assert.ok(fake.st.calls.filter((c) => c === 'GET /redfish/v1/SessionService').length >= 2);
  await fake.close();
});

// ---------- 2. password change required ----------
test('password change required: clear message from web API and Redfish', async () => {
  const fake = await startFakeBmc();
  const bmc = await tokenBmc(fake);
  fake.st.passwordChange = true;
  await assert.rejects(bmc.api('GET', '/api/chassis-status'), /requires a new password for admin \(default password still set\)/);
  await assert.rejects(bmc.redfish('GET', '/redfish/v1/Managers/Self'), /requires a new password/);
  await fake.close();
});

test('login refuses to store tokens when the password must be changed', async () => {
  const fake = await startFakeBmc({ passwordChange: true });
  const dir = tmp();
  const file = path.join(dir, 'card.json');
  await assert.rejects(login({ host: 'card', file, origin: fake.origin, readPassword: async () => 'pw' }), /requires a new password/);
  assert.equal(fs.existsSync(file), false);
  assert.ok(fake.st.deleted.includes('web'), 'web session ended again');
  await fake.close();
});

test('login stores tokens after a successful check', async () => {
  const fake = await startFakeBmc();
  const file = path.join(tmp(), 'card.json');
  const r = await login({ host: 'card', file, origin: fake.origin, readPassword: async () => 'pw' });
  assert.deepEqual(r.warnings, []);
  const s = loadSession('card', file);
  assert.ok(s.web.csrf && s.redfish.token);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await fake.close();
});

test('no session file: error names the file', () => {
  assert.throws(() => new Bmc({ host: 'h', sessionPath: '/x/h.json' }), /looked for \/x\/h\.json/);
});

// ---------- 3. KVM errors ----------
function kvmFor(fake, bmc) {
  const k = new KvmSession(bmc);
  k.decoder = { width: 0, height: 0, image: null };
  return k;
}

test('KVM: RSV1 frame fails fast with a hint, and no deflate is offered', async () => {
  // what the card really sends: an HTTP response inside the websocket stream ('H' = 0x48: RSV1 set)
  const fake = await startFakeBmc({ kvm: (ws, socket) => socket.write('HTTP/1.1 200 OK\r\nServer: lighttpd\r\n\r\n') });
  const bmc = new Bmc({ host: 'card', password: 'pw', origin: fake.origin });
  const k = kvmFor(fake, bmc);
  const t0 = Date.now();
  await assert.rejects(k.ensure(), /RSV1.*not answering.*bmc_reset/s);
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(fake.st.lastUpgradeHeaders['sec-websocket-extensions'], undefined);
  assert.match(k.lastError.message, /RSV1/);
  await fake.close();
});

test('KVM: viewer holds control and denies -> clear message', async () => {
  const fake = await startFakeBmc({
    kvm: (ws) => {
      ws.send(ivtp(CMD.CONNECTION_ALLOWED));
      ws.once('message', () => {
        const who = Buffer.alloc(134); who.write('admin'); who.write('10.0.0.5', 64);
        ws.send(ivtp(CMD.KVM_SHARING, PRIV.WAIT_SLAVE, who));
        setTimeout(() => ws.send(ivtp(CMD.KVM_SHARING, PRIV.RESPONSE_TO_SLAVE | (REQ.DENIED << 8), who)), 100);
      });
    },
  });
  const bmc = new Bmc({ host: 'card', password: 'pw', origin: fake.origin });
  const k = kvmFor(fake, bmc);
  await assert.rejects(k.ensure(), /web KVM viewer.*holds control.*denied/);
  assert.equal(k.control.state, 'denied');
  assert.equal(k.control.other.ip, '10.0.0.5');
  await fake.close();
});

test('KVM: card closes before validation -> immediate error, not a 15 s timeout', async () => {
  const fake = await startFakeBmc({ kvm: (ws) => ws.close(1011, 'busy') });
  const bmc = new Bmc({ host: 'card', password: 'pw', origin: fake.origin });
  const k = kvmFor(fake, bmc);
  const t0 = Date.now();
  await assert.rejects(k.ensure(), /closed by the card before the session was validated.*1011/);
  assert.ok(Date.now() - t0 < 3000);
  await fake.close();
});

test('KVM: validates normally', async () => {
  const fake = await startFakeBmc({
    kvm: (ws) => { ws.send(ivtp(CMD.CONNECTION_ALLOWED)); ws.once('message', () => ws.send(ivtp(CMD.VALIDATED_VIDEO_SESSION, 0, Buffer.from([1])))); },
  });
  const bmc = new Bmc({ host: 'card', password: 'pw', origin: fake.origin });
  const k = kvmFor(fake, bmc);
  await k.ensure();
  assert.equal(k.validated, true);
  assert.equal(k.control.state, 'ours');
  k.close();
  await fake.close();
});

// ---------- 5. then_screenshot / expect_screen ----------
function fakeScreenTools() {
  const bmc = { host: 'card', tokenMode: true, origin: 'http://x', logout: async () => {}, api: async () => [] };
  const { tools, kvm } = createTools({ bmc, flags: { maxSide: 1024 } });
  const W = 40, H = 30;
  const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(10) };
  kvm.decoder = { width: W, height: H, image: img };
  kvm.ensure = async () => {};
  kvm.waitForFrame = async () => true;
  kvm.send = () => {};
  kvm.mouse = () => {};
  const keys = [];
  // each key paints one row, as typing would change the screen
  kvm.key = (u) => { keys.push(u); const row = keys.length % H; img.data.fill(200, row * W * 4, (row + 1) * W * 4); };
  const t = Object.fromEntries(tools.map((x) => [x.name, x.handler]));
  return { t, img, keys };
}
const meta = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);

test('expect_screen: refuses to type when the screen changed since the screenshot', async () => {
  const { t, img, keys } = fakeScreenTools();
  const shot = await t.screenshot({});
  const id = meta(shot).screen_id;
  img.data.fill(255); // e.g. lock screen appeared
  const r = await t.type_text({ text: 'rm -rf /tmp/x\n', expect_screen: id });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Refused: the screen changed/);
  assert.ok(r.content.some((c) => c.type === 'image'), 'current screen attached');
  assert.equal(keys.length, 0);
});

test('expect_screen: types when unchanged; then_screenshot returns the settled screen', async () => {
  const { t, keys } = fakeScreenTools();
  const id = meta(await t.screenshot({})).screen_id;
  const r = await t.type_text({ text: 'ls\n', expect_screen: id, then_screenshot: { timeout_seconds: 2 } });
  assert.equal(r.isError, undefined);
  assert.equal(keys.length, 3);
  assert.ok(r.content.some((c) => c.type === 'image'));
  const m = meta(r);
  assert.equal(m.done, 'typed 3 characters');
  assert.ok(m.screen_id && m.screen_id !== id);
  assert.match(m.note, /settled/);
});

test('expect_screen: unknown id is an error', async () => {
  const { t } = fakeScreenTools();
  const r = await t.press_keys({ keys: ['enter'], expect_screen: 'nope' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknown or too old screen_id/);
});

// ---------- 4. CLI ----------
test('resolveRefs: $prev and $steps', () => {
  const results = [{ id: 'prep', value: { confirm_token: 'abc', n: { x: 1 } } }, { value: { screen_id: 's1' } }];
  assert.deepEqual(resolveRefs({ a: '$prev.screen_id', b: '$steps.prep.confirm_token', c: '$steps.0.n', d: 'plain $prev' }, results),
    { a: 's1', b: 'abc', c: { x: 1 }, d: 'plain $prev' });
  assert.throws(() => resolveRefs('$prev.missing', results), /field not found/);
  assert.throws(() => resolveRefs('$steps.9.x', results), /no such step/);
});

test('runSteps: one session, JSON per step, stops at the first failure', async () => {
  const fake = await startFakeBmc();
  const bmc = await tokenBmc(fake);
  const lines = [];
  const { failed } = await runSteps({
    host: 'card', bmc, env: {}, write: (o) => lines.push(o), log: () => {},
    steps: [
      { tool: 'system_info', id: 'info' },
      { tool: 'sensors', args: { include_absent: true } },
      { tool: 'no_such_tool' },
      { tool: 'system_info' },
    ],
  });
  assert.equal(failed, 1);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].ok, true);
  assert.equal(lines[0].result.bmc.FirmwareVersion, '1.01.35');
  assert.equal(lines[0].result.bmc.firmware_version, '1.1.35');
  assert.equal(lines[2].ok, false);
  assert.match(lines[2].result, /unknown tool/);
  await fake.close();
});

test('all tools are available without any env flag', () => {
  const bmc = { host: 'card', tokenMode: true, origin: 'http://x', logout: async () => {} };
  const names = createTools({ bmc, flags: { maxSide: 1024 } }).tools.map((t) => t.name);
  for (const n of ['power', 'set_boot_once', 'media_mount', 'media_configure_share', 'firmware_prepare', 'firmware_flash', 'bmc_reset']) assert.ok(names.includes(n), n);
});

test('runSteps: invalid args are reported per step', async () => {
  const fake = await startFakeBmc();
  const bmc = await tokenBmc(fake);
  const lines = [];
  const { failed } = await runSteps({ host: 'card', bmc, env: {}, write: (o) => lines.push(o), log: () => {}, steps: [{ tool: 'click', args: { x: 'a' } }] });
  assert.equal(failed, 1);
  assert.match(lines[0].result, /invalid args for click/);
  await fake.close();
});

// ---------- 6. versions ----------
test('normalizeVersion', async () => {
  assert.equal(normalizeVersion('1.01.35'), '1.1.35');
  assert.equal(normalizeVersion('1.3.13'), '1.3.13');
  assert.equal(normalizeVersion('1.03.13'), '1.3.13');
  const fake = await startFakeBmc({ version: '1.03.13' });
  const bmc = new Bmc({ host: 'card', password: 'pw', origin: fake.origin });
  assert.equal((await currentFirmware(bmc)).version, '1.3.13');
  await fake.close();
});
