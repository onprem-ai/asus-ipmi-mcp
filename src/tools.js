// Tool definitions, shared by the MCP server (src/server.js) and the command line (src/cli.js).
// Each tool: { name, title, description, inputSchema (zod shape), annotations?, handler(args) }.
// Handlers return MCP-style results: { content: [...], isError? }.
import { z } from 'zod';
import crypto from 'node:crypto';
import { Bmc } from './bmc.js';
import { KvmSession } from './kvm.js';
import { parseCombo, CHARS } from './keymap.js';
import { crop, downscale, encode, diffRatio } from './image.js';
import { systemInfo, sensors, power, setBootOnce, POWER_ACTIONS } from './redfish.js';
import { mediaStatus, configureShare, listImages, startImage, stopImage } from './media.js';
import { checkUpdate, prepareImage, flashImage, waitForBmc, resetBmc } from './firmware.js';
import { loadSession, sessionFile } from './session.js';

export const VERSION = '0.2.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const on = (v) => /^(1|true|yes)$/i.test(v || '');

export function flagsFromEnv(env = process.env) {
  return {
    power: on(env.ASUS_IPMI_ALLOW_POWER),
    media: on(env.ASUS_IPMI_ALLOW_MEDIA),
    firmware: on(env.ASUS_IPMI_ALLOW_FIRMWARE),
    bmcReset: on(env.ASUS_IPMI_ALLOW_BMC_RESET),
    maxSide: +(env.ASUS_IPMI_SCREENSHOT_MAX || 1024),
  };
}

/** Bmc for a host from the environment: password, or tokens from `login` (re-read when they change). */
export function bmcFromEnv(host, env = process.env) {
  const sessionPath = sessionFile(host);
  const session = env.ASUS_IPMI_PASSWORD ? null : loadSession(host);
  if (!env.ASUS_IPMI_PASSWORD && !session) {
    throw new Error(`No credentials for ${host}: no session file at ${sessionPath}. Run once in a terminal: asus-ipmi-mcp login ${host} ` +
      '(asks for the password, stores only session tokens), or set ASUS_IPMI_PASSWORD. If login was run, check that XDG_STATE_HOME / ASUS_IPMI_SESSION_FILE are the same here.');
  }
  return new Bmc({
    host, user: env.ASUS_IPMI_USER || 'admin', password: env.ASUS_IPMI_PASSWORD, session, sessionPath,
    reloadSession: env.ASUS_IPMI_PASSWORD ? null : () => loadSession(host),
  });
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e.message || e}` }] });
const wrap = (fn) => async (args) => { try { return await fn(args || {}); } catch (e) { return fail(e); } };

const REGION = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const THEN_SHOT = z.union([z.boolean(), z.object({
  region: REGION.optional(), format: z.enum(['png', 'jpeg']).optional(), max_side: z.number().int().min(200).max(4096).optional(),
  timeout_seconds: z.number().min(0.5).max(60).optional().describe('Max wait for the screen to react and settle (default 5)'),
})]).optional().describe('After the input, wait for the screen to settle and return a screenshot (true, or {region, format, max_side, timeout_seconds})');
const EXPECT = z.string().optional().describe('screen_id from your last screenshot: refuse to send input if the screen changed since (e.g. a lock screen or password prompt appeared)');

/**
 * Build the tool set for one card. Returns { tools, bmc, kvm, close }.
 * opts: { bmc, flags, log }
 */
export function createTools({ bmc, flags = flagsFromEnv(), log = () => {} }) {
  const kvm = new KvmSession(bmc, { log });
  const MAX_SIDE = flags.maxSide;
  const tools = [];
  const add = (name, def, fn) => tools.push({ name, ...def, handler: wrap(fn) });

  // ---------- screen state for screen_id / expect_screen ----------
  const shots = new Map(); // screen_id -> { w, h, data (copy), at }
  const SHOTS_KEPT = 4;
  const copyImage = () => (kvm.image ? { w: kvm.width, h: kvm.height, data: Buffer.from(Buffer.from(kvm.image.data.buffer, kvm.image.data.byteOffset, kvm.image.data.length)) } : null);
  function remember(img) {
    const id = crypto.randomUUID().slice(0, 8);
    shots.set(id, { ...img, at: Date.now() });
    while (shots.size > SHOTS_KEPT) shots.delete(shots.keys().next().value);
    return id;
  }
  const changedFrom = (a, b) => (!a || !b || a.w !== b.w || a.h !== b.h ? 1 : diffRatio(a.data, b.data));

  /** Make sure we have a session and a current picture; nudge the mouse to wake a blanked display. */
  async function freshScreen({ wake = true, timeoutMs = 6000 } = {}) {
    await kvm.ensure();
    const before = kvm.frames;
    if (await kvm.waitForFrame(before, 1500)) return true;
    try { kvm.send(11, 1); } catch { /* GET_FULL_SCREEN */ }
    if (await kvm.waitForFrame(before, 1500)) return true;
    if (wake) {
      const p = kvm.lastMouse || { x: Math.floor((kvm.width || 1024) / 2), y: Math.floor((kvm.height || 768) / 2) };
      kvm.mouse(p.x + 1, p.y, 0); await sleep(80); kvm.mouse(p.x, p.y, 0);
      try { kvm.send(11, 1); } catch { /* ignore */ }
    }
    return kvm.waitForFrame(before, timeoutMs);
  }

  function screenshotContent({ format, region, maxSide, note, extra }) {
    const snap = copyImage();
    const id = remember(snap);
    const img = { width: snap.w, height: snap.h, data: snap.data };
    const cropped = crop(img, region);
    const scaled = downscale(cropped, maxSide);
    const enc = encode(scaled, format);
    const meta = {
      screen_id: id,
      screen: { width: img.width, height: img.height },
      image: { width: scaled.width, height: scaled.height, format: enc.mimeType },
      region: region || null,
      scale: scaled.width / cropped.width,
      hint: 'Coordinates for click/move are in SCREEN pixels (screen.width x screen.height). If the image is scaled or cropped, convert: screen_x = region.x + image_x / scale. Pass screen_id as expect_screen to type_text/press_keys to refuse input if the screen changed.',
      ...(note ? { note } : {}),
      ...(extra || {}),
    };
    return { content: [{ type: 'image', data: enc.data.toString('base64'), mimeType: enc.mimeType }, { type: 'text', text: JSON.stringify(meta) }] };
  }

  function noFrame() {
    return text({ status: kvm.blank ? 'no_signal' : 'no_frame', detail: kvm.blank
      ? 'The card reports a blank screen: the host display is off (power saving), the host is off/booting, or video goes to another output. Try move_mouse/press_keys, check power_status, or wait.'
      : 'No video frame received yet.' });
  }

  /** Refuse input if the screen differs from the screenshot the agent last looked at. */
  async function guard(expect) {
    if (!expect) return null;
    const ref = shots.get(expect);
    if (!ref) throw new Error(`unknown or too old screen_id "${expect}" (only the last ${SHOTS_KEPT} screenshots are kept): take a new screenshot`);
    await freshScreen();
    const cur = copyImage();
    const ratio = changedFrom(ref, cur);
    if (ratio >= 0.02) {
      const r = kvm.image ? screenshotContent({ format: 'jpeg', maxSide: MAX_SIDE, note: 'current screen' }) : { content: [] };
      return {
        isError: true,
        content: [{ type: 'text', text: `Refused: the screen changed since screenshot ${expect} (${(ratio * 100).toFixed(1)}% of pixels differ). Nothing was typed. Look at the current screen (attached) before sending input.` }, ...r.content],
      };
    }
    return null;
  }

  /** Wait until the screen reacts to the input (or timeout), then until it stops changing. */
  async function settle(before, timeoutMs = 5000, quietMs = 600) {
    const end = Date.now() + timeoutMs;
    let prev = before, changed = false, quietSince = Date.now();
    while (Date.now() < end) {
      await sleep(200);
      const cur = copyImage();
      if (!cur) continue;
      if (!changed && changedFrom(before, cur) > 0.00005) { changed = true; quietSince = Date.now(); }
      if (changedFrom(prev, cur) > 0.00005) quietSince = Date.now();
      prev = cur;
      if (changed && Date.now() - quietSince >= quietMs) break;
    }
    return changed;
  }

  async function afterInput(summary, then, before) {
    if (!then) return text(summary);
    const o = then === true ? {} : then;
    const changed = await settle(before, (o.timeout_seconds || 5) * 1000);
    if (!kvm.image) return text({ done: summary, screenshot: 'no_signal' });
    const shot = screenshotContent({
      format: o.format || (o.region ? 'png' : 'jpeg'), region: o.region, maxSide: o.max_side || MAX_SIDE,
      note: changed ? 'screen after input (settled)' : 'screen did not change after the input',
      extra: { done: summary },
    });
    return shot;
  }

  // ---------------- screen ----------------
  add('screenshot', {
    title: 'Screenshot of the host screen',
    description: 'Returns the current host screen (via the IPMI card KVM) and a screen_id. Wakes a blanked display by nudging the mouse. Optional crop region (screen pixels) to read small text.',
    inputSchema: {
      format: z.enum(['png', 'jpeg']).optional().describe('Default jpeg for full screen (smaller), png for crops'),
      region: REGION.optional().describe('Crop in screen pixels'),
      max_side: z.number().int().min(200).max(4096).optional().describe(`Downscale so the long side <= this (default ${MAX_SIDE})`),
    },
  }, async ({ format, region, max_side }) => {
    const fresh = await freshScreen();
    if (!kvm.image) return noFrame();
    return screenshotContent({
      format: format || (region ? 'png' : 'jpeg'), region, maxSide: max_side || MAX_SIDE,
      note: fresh ? undefined : (kvm.blank ? 'Display reported blank; showing the last received picture.' : 'No new frame (screen unchanged); showing the current picture.'),
    });
  });

  add('wait_for_screen_change', {
    title: 'Wait until the screen changes',
    description: 'Blocks until the host screen changes noticeably (or timeout), then returns a screenshot. Use after actions that take time (boot, install steps, page loads).',
    inputSchema: {
      timeout_seconds: z.number().min(1).max(600).optional().describe('Default 30'),
      min_changed_fraction: z.number().min(0).max(1).optional().describe('Fraction of pixels that must change (default 0.01)'),
    },
  }, async ({ timeout_seconds = 30, min_changed_fraction = 0.01 }) => {
    await freshScreen();
    const ref = copyImage();
    const end = Date.now() + timeout_seconds * 1000;
    let changed = false;
    while (Date.now() < end) {
      await sleep(500);
      const cur = copyImage();
      if (!cur) continue;
      if (changedFrom(ref, cur) >= min_changed_fraction) { changed = true; break; }
    }
    if (!kvm.image) return text({ changed: false, status: 'no_signal' });
    return screenshotContent({ format: 'jpeg', maxSide: MAX_SIDE, note: changed ? 'screen changed' : `no change within ${timeout_seconds}s` });
  });

  // ---------------- mouse ----------------
  const BUTTON = { left: 1, right: 2, middle: 4 };

  add('click', {
    title: 'Mouse click',
    description: 'Clicks at absolute screen coordinates (pixels of the full host screen, see screenshot metadata).',
    inputSchema: {
      x: z.number().describe('Screen x in pixels'),
      y: z.number().describe('Screen y in pixels'),
      button: z.enum(['left', 'right', 'middle']).optional(),
      double: z.boolean().optional(),
    },
  }, async ({ x, y, button = 'left', double = false }) => {
    await kvm.ensure();
    const b = BUTTON[button];
    for (let i = 0; i < (double ? 2 : 1); i++) {
      kvm.mouse(x, y, 0); await sleep(50);
      kvm.mouse(x, y, b); await sleep(70);
      kvm.mouse(x, y, 0); await sleep(double ? 90 : 0);
    }
    return text(`clicked ${button}${double ? ' (double)' : ''} at ${x},${y}`);
  });

  add('move_mouse', {
    title: 'Move mouse',
    description: 'Moves the pointer to absolute screen coordinates (also wakes a sleeping display).',
    inputSchema: { x: z.number(), y: z.number() },
  }, async ({ x, y }) => { await kvm.ensure(); kvm.mouse(x, y, 0); return text(`moved to ${x},${y}`); });

  add('drag', {
    title: 'Mouse drag',
    description: 'Press left button at (x1,y1), move to (x2,y2), release.',
    inputSchema: { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() },
  }, async ({ x1, y1, x2, y2 }) => {
    await kvm.ensure();
    kvm.mouse(x1, y1, 0); await sleep(50); kvm.mouse(x1, y1, 1); await sleep(80);
    for (let i = 1; i <= 10; i++) { kvm.mouse(x1 + (x2 - x1) * i / 10, y1 + (y2 - y1) * i / 10, 1); await sleep(30); }
    kvm.mouse(x2, y2, 0);
    return text(`dragged ${x1},${y1} -> ${x2},${y2}`);
  });

  add('scroll', {
    title: 'Mouse wheel',
    description: 'Scrolls at a position. Positive amount scrolls up, negative down (wheel notches).',
    inputSchema: { x: z.number(), y: z.number(), amount: z.number().int().min(-20).max(20) },
  }, async ({ x, y, amount }) => {
    await kvm.ensure();
    const step = Math.sign(amount);
    for (let i = 0; i < Math.abs(amount); i++) { kvm.mouse(x, y, 0, step); await sleep(40); }
    kvm.mouse(x, y, 0, 0);
    return text(`scrolled ${amount} at ${x},${y}`);
  });

  // ---------------- keyboard ----------------
  add('type_text', {
    title: 'Type text',
    description: 'Types text on the host keyboard (US layout; use \\n for Enter, \\t for Tab). Non-ASCII characters are not supported. ' +
      'Take a screenshot right before and pass its screen_id as expect_screen: if the host locked its screen or shows a password prompt meanwhile, nothing is typed. ' +
      'then_screenshot returns the settled screen afterwards.',
    inputSchema: {
      text: z.string().max(4000),
      delay_ms: z.number().int().min(10).max(1000).optional().describe('Delay between keys (default 30)'),
      expect_screen: EXPECT,
      then_screenshot: THEN_SHOT,
    },
  }, async ({ text: t, delay_ms = 30, expect_screen, then_screenshot }) => {
    const bad = [...t].filter((c) => !CHARS[c]);
    if (bad.length) throw new Error(`cannot type characters: ${JSON.stringify([...new Set(bad)].join(''))}`);
    await kvm.ensure();
    const refused = await guard(expect_screen);
    if (refused) return refused;
    const before = copyImage();
    for (const c of t) { const [u, m] = CHARS[c]; kvm.key(u, m); await sleep(delay_ms); }
    return afterInput(`typed ${t.length} characters`, then_screenshot, before);
  });

  add('press_keys', {
    title: 'Press key / key combination',
    description: 'Presses keys, e.g. "enter", "esc", "f2", "del", "tab", "up", "ctrl+alt+delete", "ctrl+alt+f3", "super", "alt+f4". Several can be given in order. ' +
      'expect_screen and then_screenshot work as in type_text.',
    inputSchema: {
      keys: z.array(z.string()).min(1).max(50).describe('List of keys/combos pressed one after another'),
      repeat: z.number().int().min(1).max(50).optional().describe('Repeat the whole list (e.g. press down 5 times)'),
      delay_ms: z.number().int().min(20).max(5000).optional().describe('Delay between presses (default 120)'),
      expect_screen: EXPECT,
      then_screenshot: THEN_SHOT,
    },
  }, async ({ keys, repeat = 1, delay_ms = 120, expect_screen, then_screenshot }) => {
    const parsed = keys.map(parseCombo);
    await kvm.ensure();
    const refused = await guard(expect_screen);
    if (refused) return refused;
    const before = copyImage();
    for (let r = 0; r < repeat; r++) for (const [u, m] of parsed) { kvm.key(u, m); await sleep(delay_ms); }
    return afterInput(`pressed ${keys.join(', ')}${repeat > 1 ? ` x${repeat}` : ''}`, then_screenshot, before);
  });

  // ---------------- info ----------------
  async function kvmSessions() {
    // Active KVM sessions as the card's web UI lists them (Settings → Services → kvm → sessions).
    try {
      const list = await bmc.api('GET', '/api/settings/service-sessions?service_id=2');
      if (!Array.isArray(list)) return null;
      return list.map((s) => ({ id: s.id ?? s.session_id, user: s.user_name ?? s.username ?? s.user, ip: s.client_ip ?? s.ip, type: s.session_type ?? s.service_name, privilege: s.user_privilege ?? s.privilege }));
    } catch (e) { return { error: e.message }; }
  }

  add('kvm_status', {
    title: 'KVM session status',
    description: 'Connection state, who holds KVM control (this server, the browser viewer, …), the last connect error, screen resolution, whether the host display is blank, mouse mode. Does not fail when the KVM cannot connect: it reports why.',
    inputSchema: {},
  }, async () => {
    let connectError = null;
    try { await kvm.ensure(); await kvm.waitForFrame(kvm.frames, 1500); } catch (e) { connectError = e.message; }
    return text({
      connected: kvm.connected, validated: kvm.validated,
      control: kvm.control,
      ...(connectError ? { connect_error: connectError } : {}),
      last_error: kvm.lastError,
      kvm_sessions_on_card: await kvmSessions(),
      resolution: kvm.image ? `${kvm.width}x${kvm.height}` : null,
      display_blank: kvm.blank, frames_received: kvm.frames,
      last_frame_age_s: kvm.lastFrameAt ? Math.round((Date.now() - kvm.lastFrameAt) / 1000) : null,
      mouse_mode: { 1: 'relative', 2: 'absolute', 3: 'other' }[kvm.mouseMode] || kvm.mouseMode,
      other_clients: kvm.otherClients,
    });
  });

  add('system_info', {
    title: 'BMC and host info',
    description: 'BMC firmware (both version spellings), host power state, host BIOS/model (via Redfish).',
    inputSchema: {},
  }, async () => text(await systemInfo(bmc)));

  add('sensors', {
    title: 'Sensor readings',
    description: 'Temperatures, fans, voltages from the BMC (Redfish).',
    inputSchema: { include_absent: z.boolean().optional() },
  }, async ({ include_absent }) => text(await sensors(bmc, { includeAbsent: include_absent })));

  // ---------------- power (opt-in) ----------------
  if (flags.power) {
    add('power', {
      title: 'Host power control',
      description: `Power the host on/off/restart via the BMC. Actions: ${POWER_ACTIONS.join(', ')}. ForceOff/ForceRestart cut power immediately (data loss possible).`,
      inputSchema: { action: z.enum(POWER_ACTIONS) },
      annotations: { destructiveHint: true },
    }, async ({ action }) => text(await power(bmc, action)));

    add('set_boot_once', {
      title: 'One-time boot device',
      description: 'Boot override for the next boot only (e.g. Cd for a virtual-media ISO, BiosSetup to enter BIOS). Needs host BIOS support.',
      inputSchema: {
        target: z.enum(['None', 'Pxe', 'Cd', 'Usb', 'Hdd', 'BiosSetup']),
        mode: z.enum(['UEFI', 'Legacy']).optional(),
      },
    }, async ({ target, mode }) => text(await setBootOnce(bmc, target, mode)));
  }

  // ---------------- virtual media ----------------
  add('media_status', {
    title: 'Virtual media status',
    description: 'Remote-media settings (share), images found on the share, active redirections.',
    inputSchema: {},
  }, async () => text(await mediaStatus(bmc)));

  if (flags.media) {
    add('media_configure_share', {
      title: 'Configure virtual-media share',
      description: 'Sets the NFS/CIFS share the BMC reads ISO/IMG files from and enables remote media. Changes BMC settings.',
      inputSchema: {
        server: z.string().describe('IP of the NFS/CIFS server reachable from the BMC network'),
        path: z.string().describe('NFS export path (e.g. /srv/isos) or CIFS share name'),
        share_type: z.enum(['nfs', 'cifs']).optional(),
        kind: z.enum(['cd', 'hd']).optional(),
        user: z.string().optional(), password: z.string().optional(), domain: z.string().optional(),
      },
    }, async (a) => text(await configureShare(bmc, { kind: a.kind, server: a.server, path: a.path, shareType: a.share_type || 'nfs', user: a.user, password: a.password, domain: a.domain })));

    add('media_list_images', {
      title: 'List images on the share',
      description: 'Refreshes and lists ISO/IMG files the BMC sees on the configured share.',
      inputSchema: {},
    }, async () => text(await listImages(bmc)));

    add('media_mount', {
      title: 'Mount image as virtual CD/HDD',
      description: 'Attaches an image from the share to the host as virtual CD (iso) or hard disk (img).',
      inputSchema: { image: z.string(), kind: z.enum(['cd', 'hd']).optional() },
    }, async ({ image, kind }) => text(await startImage(bmc, { image, kind })));

    add('media_unmount', {
      title: 'Unmount virtual media',
      description: 'Detaches a virtual-media image from the host.',
      inputSchema: { image: z.string(), kind: z.enum(['cd', 'hd']).optional() },
    }, async ({ image, kind }) => text(await stopImage(bmc, { image, kind })));
  }

  // ---------------- BMC firmware ----------------
  add('firmware_check_update', {
    title: 'Check for IPMI card firmware updates',
    description: 'Compares the card firmware with the releases on the ASUS support page (version, date, SHA-256).',
    inputSchema: {},
  }, async () => text(await checkUpdate(bmc)));

  const restartNote = bmc.tokenMode
    ? ' The card restart ends the stored login session: run "asus-ipmi-mcp login <host>" again afterwards (the server picks up the new tokens by itself).'
    : '';

  if (flags.firmware) {
    const pending = new Map(); // confirmation token -> prepared image

    add('firmware_prepare', {
      title: 'Download and verify card firmware (no flashing)',
      description:
        'Step 1 of 2. Downloads an IPMI card firmware (version from firmware_check_update, an https zip URL, or a local .zip/.ima path), ' +
        'checks the ASUS SHA-256, the MD5 inside the zip and that the image is for this card model. ' +
        'With dry_run=true it also uploads the image to the card and lets the card verify it, then cancels (card restarts ~90 s, firmware unchanged). ' +
        'Returns a confirm_token for firmware_flash.' + restartNote,
      inputSchema: {
        source: z.string().describe('Version like "1.3.13", https URL of the ASUS zip, or local path to .zip/.ima'),
        sha256: z.string().optional().describe('Expected SHA-256 of the zip (taken from the ASUS page automatically for versions)'),
        dry_run: z.boolean().optional().describe('Upload + let the card verify, then cancel (default false)'),
      },
    }, async ({ source, sha256, dry_run = false }) => {
      const prep = await prepareImage(bmc, { source, sha256 });
      let dry = null;
      if (dry_run) {
        kvm.close();
        const lines = [];
        dry = await flashImage(bmc, { imagePath: prep.image_path, flash: false, onProgress: (l) => { lines.push(l); log(l); } });
        dry.progress = lines;
      }
      const token = crypto.randomUUID().slice(0, 8);
      pending.set(token, { ...prep, at: Date.now() });
      return text({
        ...prep, dry_run: dry, confirm_token: token,
        next: `To flash, call firmware_flash with confirm_token "${token}" (valid 30 min). It takes ~10 min plus reboot; never cut power during it. The card has a single firmware slot.` +
          (dry?.after?.session ? ' First run login again: the dry run restarted the card and ended the session.' : ''),
      });
    });

    add('firmware_flash', {
      title: 'Flash prepared IPMI card firmware',
      description:
        'Step 2 of 2. Flashes the image prepared by firmware_prepare (needs its confirm_token). Keeps the card configuration by default. ' +
        'KVM/web UI of the card are unavailable for ~15 min; the host keeps running. NEVER interrupt power during flashing.' + restartNote,
      inputSchema: {
        confirm_token: z.string(),
        preserve_config: z.boolean().optional().describe('Keep IP, users, settings (default true)'),
      },
      annotations: { destructiveHint: true },
    }, async ({ confirm_token, preserve_config = true }) => {
      const prep = pending.get(confirm_token);
      if (!prep || Date.now() - prep.at > 30 * 60000) throw new Error('unknown or expired confirm_token – run firmware_prepare again');
      pending.delete(confirm_token);
      kvm.close();
      const lines = [];
      const onProgress = (l) => { lines.push(l); log(`flash: ${l}`); };
      const res = await flashImage(bmc, { imagePath: prep.image_path, flash: true, preserveConfig: preserve_config, onProgress });
      const after = await waitForBmc(bmc, { onProgress }).catch((e) => ({ bmc_up: false, error: e.message }));
      return text({ ...res, before: prep.current, after, progress: lines.filter((l, i) => i < 3 || !/Flashing\.\.\./.test(l) || i % 10 === 0) });
    });
  }

  if (flags.bmcReset) {
    add('kvm_reset', {
      title: 'Restart the IPMI card (fixes a stuck KVM)',
      description:
        "Restarts the IPMI card itself (same as the card's Maintenance → BMC Reset), e.g. when the KVM keeps failing with an RSV1 / websocket error. " +
        'The host keeps running; the card is unreachable for ~1–3 min.' + restartNote,
      inputSchema: {},
      annotations: { destructiveHint: true },
    }, async () => {
      kvm.close();
      const lines = [];
      const r = await resetBmc(bmc, (l) => { lines.push(l); log(`reset: ${l}`); });
      if (!r.bmc_up) throw new Error(`the card did not come back within ~6 min after the reset (${lines.join('; ')}). Wait longer and check the web UI.`);
      return text({ ...r, progress: lines });
    });
  }

  return { tools, bmc, kvm, close: async () => { kvm.close(); await bmc.logout(); } };
}
