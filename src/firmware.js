// BMC (IPMI card) firmware: check for updates, download + verify, flash.
//
// Flash sequence used by the card's web UI (Maintenance > Firmware Update), all in ONE session:
//   1. PUT  /api/maintenance/flash                     {"preserve_config": 1}   enter flash mode
//   2. POST /api/maintenance/firmware/firmware         multipart "fwimage"      upload
//   3. GET  /api/maintenance/firmware/verification                              check image
//   4. PUT  /api/maintenance/firmware/upgrade          {"preserve_config", "flash_status": 1}
//   5. GET  /api/maintenance/firmware/flash-progress   until done; the BMC reboots
// Lessons learned (see RUNBOOK):
//   - The upload URL is .../firmware/firmware (not .../firmware).
//   - After step 1 the BMC refuses ALL new logins (code 17000) and never times out. Only the same
//     session can continue or cancel (POST /api/maintenance/reset). Lost session => AC power cycle.
//   - The card has a single firmware slot: never interrupt a running flash.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fetch } from 'undici';

const SUPPORT_PAGE = 'https://www.asus.com/us/supportonly/ipmi%20expansion%20card/helpdesk_bios/';
const CDN = 'https://dlcdnets.asus.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function workDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  for (const d of [path.join(base, 'asus-ipmi-mcp', 'firmware'), path.join(os.tmpdir(), 'asus-ipmi-mcp', 'firmware')]) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch { /* next */ }
  }
  throw new Error('no writable cache directory');
}

const verKey = (v) => String(v).split('.').map((x) => x.padStart(4, '0')).join('.');

export async function currentFirmware(bmc) {
  const info = await bmc.api('GET', '/api/Information');
  return { version: info.FWVersion, date: info.FWDate, model: info.FWModels?.[0]?.Model, hardware: info.HWVersion };
}

/** Parse the ASUS support page for firmware releases (version, date, sha256, CDN path). */
export async function availableFirmware() {
  const r = await fetch(SUPPORT_PAGE, { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126 Safari/537.36' } });
  if (!r.ok) throw new Error(`ASUS support page: HTTP ${r.status}`);
  const html = await r.text();
  // The page embeds its data as a Nuxt "devalue" array: objects hold indexes into the array.
  const start = html.indexOf('[["ShallowReactive"');
  if (start < 0) throw new Error('ASUS support page format changed (no embedded data)');
  const arr = JSON.parse(html.slice(start, html.indexOf('</script>', start)));
  const val = (x) => (typeof x === 'number' ? arr[x] : x);
  const out = new Map();
  for (const o of arr) {
    if (!o || typeof o !== 'object' || Array.isArray(o) || !('DownloadUrl' in o) || !('sha256' in o)) continue;
    let dl = val(o.DownloadUrl);
    if (dl && typeof dl === 'object') dl = val(dl.Global);
    const m = typeof dl === 'string' && dl.match(/IPMI_EXPANSION_CARD\/IPMI_EXPANSION_CARD-([\d.]+)\.zip$/);
    if (!m || out.has(m[1])) continue;
    const sha = val(o.sha256);
    out.set(m[1], {
      version: m[1], url: CDN + dl, date: val(o.ReleaseDate) || null,
      sha256: typeof sha === 'string' && /^[A-F0-9]{64}$/i.test(sha) ? sha.toUpperCase() : null,
      title: val(o.Title) || null,
    });
  }
  if (!out.size) throw new Error('no firmware entries found on the ASUS support page');
  return [...out.values()].sort((a, b) => (verKey(b.version) > verKey(a.version) ? 1 : -1));
}

export async function checkUpdate(bmc) {
  const cur = await currentFirmware(bmc);
  const list = await availableFirmware();
  const latest = list[0];
  return {
    current: cur,
    latest: latest || null,
    update_available: !!latest && verKey(latest.version) > verKey(cur.version),
    releases: list.map((r) => ({ version: r.version, date: r.date, sha256: r.sha256 })),
    source: SUPPORT_PAGE,
  };
}

// ---- minimal zip reader (central directory + deflate), enough for ASUS firmware zips ----
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(local + 26), lelen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize);
    if (!name.endsWith('/')) files[name] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    p += 46 + nlen + elen + clen;
  }
  return files;
}

/**
 * Download (or read a local zip/ima), verify, and return the image path + checks.
 * source: version string ("1.3.13"), https URL of the zip, or local path to .zip / .ima
 */
export async function prepareImage(bmc, { source, sha256 }) {
  const dir = workDir();
  let zipBuf = null, imaBuf = null, expectSha = sha256 || null, label = source;
  const checks = [];

  if (/^\d+(\.\d+)+$/.test(source)) {
    const rel = (await availableFirmware()).find((r) => r.version === source);
    if (!rel) throw new Error(`version ${source} not found on the ASUS support page`);
    expectSha = expectSha || rel.sha256; source = rel.url;
  }
  if (/^https?:\/\//.test(source)) {
    const file = path.join(dir, path.basename(new URL(source).pathname));
    if (!fs.existsSync(file)) {
      const r = await fetch(source);
      if (!r.ok) throw new Error(`download ${source}: HTTP ${r.status}`);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    }
    zipBuf = fs.readFileSync(file); label = file;
  } else if (source.toLowerCase().endsWith('.zip')) {
    zipBuf = fs.readFileSync(source);
  } else {
    imaBuf = fs.readFileSync(source);
  }

  if (zipBuf) {
    const sha = crypto.createHash('sha256').update(zipBuf).digest('hex').toUpperCase();
    if (expectSha) {
      if (sha !== expectSha.toUpperCase()) throw new Error(`SHA-256 mismatch: got ${sha}, expected ${expectSha}`);
      checks.push(`zip SHA-256 matches ASUS (${sha.slice(0, 16)}…)`);
    } else checks.push(`zip SHA-256 ${sha} (no reference value to compare)`);
    const files = unzip(zipBuf);
    const imaName = Object.keys(files).find((n) => n.toLowerCase().endsWith('.ima'));
    if (!imaName) throw new Error('no .ima image inside the zip');
    imaBuf = files[imaName];
    const md5Name = Object.keys(files).find((n) => n.toLowerCase().endsWith('.md5'));
    if (md5Name) {
      const want = (files[md5Name].toString().match(/[0-9a-f]{32}/i) || [])[0];
      const got = crypto.createHash('md5').update(imaBuf).digest('hex');
      if (want && want.toLowerCase() !== got) throw new Error(`image MD5 mismatch (${got} vs ${want})`);
      if (want) checks.push('image MD5 matches the .md5 file in the zip');
    }
    label = `${label} :: ${imaName}`;
  }

  // Model check: the image must contain the same firmware model the card runs (e.g. KOMMANDO).
  const cur = await currentFirmware(bmc);
  if (cur.model && !imaBuf.includes(Buffer.from(cur.model))) {
    throw new Error(`image does not contain firmware model "${cur.model}" of this card – wrong firmware?`);
  }
  if (cur.model) checks.push(`image is for firmware model ${cur.model}`);
  const vm = imaBuf.toString('latin1').match(/FW_VERSION=(\d+)\.(\d+)\.(\d+)/g) || [];
  const imgVersion = vm.map((s) => s.split('=')[1]).find((v) => !v.startsWith('13.') && !v.endsWith('000000'));

  const imaPath = path.join(dir, `bmc-${crypto.createHash('sha1').update(imaBuf).digest('hex').slice(0, 10)}.ima`);
  if (!fs.existsSync(imaPath)) fs.writeFileSync(imaPath, imaBuf);
  return { image_path: imaPath, size: imaBuf.length, image_version: imgVersion || null, current: cur, checks, source: label };
}

/**
 * Upload + verify (+ flash if flash=true). Uses one session; cancels flash mode on any error before flashing.
 * onProgress(text) is called with progress lines.
 */
export async function flashImage(bmc, { imagePath, flash = false, preserveConfig = true, onProgress = () => {} }) {
  await bmc.login();
  const track = await bmc.api('GET', '/api/maintenance/flashtrack').catch(() => null);
  if (track && track.status && track.status !== 'ok') throw new Error(`BMC not ready for flashing: ${JSON.stringify(track)}`);
  const preserve = preserveConfig ? 1 : 0;
  const img = fs.readFileSync(imagePath);

  await bmc.api('PUT', '/api/maintenance/flash', { preserve_config: preserve });
  onProgress('flash mode entered (BMC now refuses other logins)');
  let started = false;
  try {
    // Build the multipart body ourselves: the BMC's upload handler needs a Content-Length and
    // fails ({"cc": -1}, then restarts) with the chunked body that fetch() sends for FormData.
    const boundary = '----asusipmimcp' + crypto.randomBytes(12).toString('hex');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="fwimage"; filename="${path.basename(imagePath)}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      img,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await fetch(bmc.url('/api/maintenance/firmware/firmware'), {
      method: 'POST', dispatcher: bmc.dispatcher, body,
      headers: {
        'X-CSRFTOKEN': bmc.csrf, cookie: bmc.cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length),
      },
    });
    const t = await r.text();
    let cc = null; try { cc = JSON.parse(t).cc; } catch { /* not json */ }
    if (!r.ok || (cc !== null && cc !== 0)) throw new Error(`upload rejected by BMC: HTTP ${r.status} ${t.slice(0, 200)}`);
    onProgress(`uploaded ${img.length} bytes`);

    // The BMC needs a moment to check the image; it answers HTTP 500 / code 1306 until then.
    let ver = null, lastErr = null;
    for (let i = 0; i < 20 && !ver; i++) {
      await sleep(3000);
      try { ver = await bmc.api('GET', '/api/maintenance/firmware/verification'); } catch (e) {
        lastErr = e;
        if (!/1306|verification status/i.test(e.message)) throw e;
      }
    }
    if (!ver) throw lastErr || new Error('verification did not complete');
    const v = Array.isArray(ver) ? ver[0] : ver;
    if (!v || v.verification_status === undefined) throw new Error(`verification failed: ${JSON.stringify(ver).slice(0, 300)}`);
    const sections = (Array.isArray(ver) ? ver : [ver]).map((s) => s.current_image_name).filter(Boolean);
    onProgress(`verified by BMC (sections: ${sections.join(', ') || '?'})`);

    if (!flash) {
      const recovered = await cancelFlashMode(bmc, onProgress);
      return {
        flashed: false, verified: true, sections, bmc_recovered: recovered,
        note: recovered ? 'Dry run OK: image uploaded and verified by the card, flash mode cancelled, card back online. Firmware unchanged.'
          : 'Image verified, but the card did not come back after cancelling: AC power cycle the host (PSU off ~30 s). Firmware unchanged.',
      };
    }
    await bmc.api('PUT', '/api/maintenance/firmware/upgrade', { preserve_config: preserve, flash_status: 1 });
    started = true;
  } catch (e) {
    if (!started) {
      onProgress(`error before flashing (${e.message}); cancelling flash mode`);
      const recovered = await cancelFlashMode(bmc, onProgress);
      throw new Error(recovered
        ? `${e.message}. Flash mode cancelled, BMC restarted and accepts logins again; firmware unchanged.`
        : `${e.message}. Cancel did not work: the BMC still refuses logins (locked in flash mode). AC power cycle the host (PSU off ~30 s). Firmware is unchanged.`);
    }
    throw e;
  }

  // Flashing: poll progress until done; BMC reboots afterwards.
  let last = '', fails = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 30 * 60000) {
    let p;
    try { p = await bmc.api('GET', '/api/maintenance/firmware/flash-progress'); fails = 0; } catch {
      if (++fails >= 5) break;
      await sleep(5000); continue;
    }
    const line = `${String(p.action || '').trim()} ${p.progress || ''}`.trim();
    if (line !== last) { onProgress(line); last = line; }
    if (/complete/i.test(String(p.action)) || p.state === 2) break;
    await sleep(3000);
  }
  bmc.csrf = null;
  onProgress('flash finished, BMC rebooting');
  return { flashed: true, duration_s: Math.round((Date.now() - t0) / 1000), last_progress: last };
}

/**
 * Leave flash mode with the same session (POST /api/maintenance/reset restarts the BMC).
 * The reset often drops the connection before replying, so success is judged by whether
 * the BMC accepts a fresh login again within ~4 min.
 */
async function cancelFlashMode(bmc, onProgress = () => {}) {
  try { await bmc.api('POST', '/api/maintenance/reset', {}); } catch (e) { onProgress(`reset call: ${e.message} (expected if the BMC is already restarting)`); }
  bmc.csrf = null;
  const t0 = Date.now();
  await sleep(20000);
  while (Date.now() - t0 < 4 * 60000) {
    try { await bmc.login(); onProgress(`BMC back after ${Math.round((Date.now() - t0) / 1000)} s`); return true; } catch { await sleep(10000); }
  }
  return false;
}

/** After a flash: wait until the BMC answers again and report its version. */
export async function waitForBmc(bmc, timeoutMs = 8 * 60000) {
  const t0 = Date.now();
  await sleep(30000);
  while (Date.now() - t0 < timeoutMs) {
    try { bmc.csrf = null; await bmc.login(); return await currentFirmware(bmc); } catch { await sleep(15000); }
  }
  throw new Error('BMC did not come back within the timeout – do NOT power cycle yet; wait longer, then check the web UI');
}
