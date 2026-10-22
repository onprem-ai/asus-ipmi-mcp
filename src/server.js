// MCP server: exposes screen, mouse, keyboard, power, sensors and virtual media of an
// ASUS IPMI Expansion Card (AMI MegaRAC BMC, ASPEED AST2600) as tools.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bmc } from './bmc.js';
import { KvmSession } from './kvm.js';
import { parseCombo, CHARS } from './keymap.js';
import { crop, downscale, encode, diffRatio } from './image.js';
import { systemInfo, sensors, power, setBootOnce, POWER_ACTIONS } from './redfish.js';
import { mediaStatus, configureShare, listImages, startImage, stopImage } from './media.js';

const VERSION = '0.1.0';
const env = process.env;
const ALLOW_POWER = /^(1|true|yes)$/i.test(env.ASUS_IPMI_ALLOW_POWER || '');
const ALLOW_MEDIA = /^(1|true|yes)$/i.test(env.ASUS_IPMI_ALLOW_MEDIA || '');
const MAX_SIDE = +(env.ASUS_IPMI_SCREENSHOT_MAX || 1024);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`[asus-ipmi-mcp] ${msg}\n`);

const bmc = new Bmc({ host: env.ASUS_IPMI_HOST, user: env.ASUS_IPMI_USER || 'admin', password: env.ASUS_IPMI_PASSWORD });
const kvm = new KvmSession(bmc, { log });

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `Error: ${e.message || e}` }] });
const wrap = (fn) => async (args) => { try { return await fn(args || {}); } catch (e) { return fail(e); } };

/** Make sure we have a session and a current picture; nudge the mouse to wake a blanked display. */
async function freshScreen({ wake = true, timeoutMs = 6000 } = {}) {
  await kvm.ensure();
  const before = kvm.frames;
  // First frames arrive right after connecting; otherwise ask for a refresh.
  if (await kvm.waitForFrame(before, 1500)) return true;
  if (wake && (kvm.blank || !kvm.image)) {
    const p = kvm.lastMouse || { x: Math.floor((kvm.width || 1024) / 2), y: Math.floor((kvm.height || 768) / 2) };
    kvm.mouse(p.x + 1, p.y, 0); await sleep(80); kvm.mouse(p.x, p.y, 0);
  }
  try { kvm.send(11, 1); } catch { /* GET_FULL_SCREEN */ }
  return kvm.waitForFrame(before, timeoutMs);
}

function screenshotContent(img, { format, region, maxSide, note }) {
  const cropped = crop(img, region);
  const scaled = downscale(cropped, maxSide);
  const enc = encode(scaled, format);
  const meta = {
    screen: { width: img.width, height: img.height },
    image: { width: scaled.width, height: scaled.height, format: enc.mimeType },
    region: region || null,
    scale: scaled.width / cropped.width,
    hint: 'Coordinates for click/move are in SCREEN pixels (screen.width x screen.height). If the image is scaled or cropped, convert: screen_x = region.x + image_x / scale.',
    ...(note ? { note } : {}),
  };
  return { content: [{ type: 'image', data: enc.data.toString('base64'), mimeType: enc.mimeType }, { type: 'text', text: JSON.stringify(meta) }] };
}

const server = new McpServer({ name: 'asus-ipmi-mcp', version: VERSION }, {
  instructions:
    'Controls a physical server through its ASUS IPMI card (remote screen, keyboard, mouse, power). ' +
    'Typical loop: screenshot -> decide -> click/type/press_keys -> screenshot. ' +
    'Mouse coordinates are absolute screen pixels. Keyboard assumes a US layout on the host. ' +
    'A black screen usually means the host display is asleep; screenshot nudges the mouse to wake it. ' +
    'Only one controlling KVM session exists per card: using these tools takes control from an open browser viewer.',
});

// ---------------- screen ----------------
server.registerTool('screenshot', {
  title: 'Screenshot of the host screen',
  description: 'Returns the current host screen (via the IPMI card KVM). Wakes a blanked display by nudging the mouse. Optional crop region (screen pixels) to read small text.',
  inputSchema: {
    format: z.enum(['png', 'jpeg']).optional().describe('Default jpeg for full screen (smaller), png for crops'),
    region: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional().describe('Crop in screen pixels'),
    max_side: z.number().int().min(200).max(4096).optional().describe(`Downscale so the long side <= this (default ${MAX_SIDE})`),
  },
}, wrap(async ({ format, region, max_side }) => {
  const fresh = await freshScreen();
  if (!kvm.image) {
    return text({ status: kvm.blank ? 'no_signal' : 'no_frame', detail: kvm.blank
      ? 'The card reports a blank screen: the host display is off (power saving), the host is off/booting, or video goes to another output. Try move_mouse/press_keys, check power_status, or wait.'
      : 'No video frame received yet.' });
  }
  return screenshotContent(kvm.image, {
    format: format || (region ? 'png' : 'jpeg'), region, maxSide: max_side || MAX_SIDE,
    note: fresh ? undefined : (kvm.blank ? 'Display reported blank; showing the last received picture.' : 'No new frame (screen unchanged); showing the current picture.'),
  });
}));

server.registerTool('wait_for_screen_change', {
  title: 'Wait until the screen changes',
  description: 'Blocks until the host screen changes noticeably (or timeout), then returns a screenshot. Use after actions that take time (boot, install steps, page loads).',
  inputSchema: {
    timeout_seconds: z.number().min(1).max(600).optional().describe('Default 30'),
    min_changed_fraction: z.number().min(0).max(1).optional().describe('Fraction of pixels that must change (default 0.01)'),
  },
}, wrap(async ({ timeout_seconds = 30, min_changed_fraction = 0.01 }) => {
  await freshScreen();
  const base = kvm.image ? Buffer.from(kvm.image.data.buffer, kvm.image.data.byteOffset, kvm.image.data.length) : null;
  const ref = base ? Buffer.from(base) : null;
  const end = Date.now() + timeout_seconds * 1000;
  let changed = false;
  while (Date.now() < end) {
    await sleep(500);
    if (!kvm.image) continue;
    const cur = Buffer.from(kvm.image.data.buffer, kvm.image.data.byteOffset, kvm.image.data.length);
    if (!ref || cur.length !== ref.length || diffRatio(ref, cur) >= min_changed_fraction) { changed = true; break; }
  }
  if (!kvm.image) return text({ changed: false, status: 'no_signal' });
  const r = screenshotContent(kvm.image, { format: 'jpeg', maxSide: MAX_SIDE, note: changed ? 'screen changed' : `no change within ${timeout_seconds}s` });
  return r;
}));

// ---------------- mouse ----------------
const BUTTON = { left: 1, right: 2, middle: 4 };

server.registerTool('click', {
  title: 'Mouse click',
  description: 'Clicks at absolute screen coordinates (pixels of the full host screen, see screenshot metadata).',
  inputSchema: {
    x: z.number().describe('Screen x in pixels'),
    y: z.number().describe('Screen y in pixels'),
    button: z.enum(['left', 'right', 'middle']).optional(),
    double: z.boolean().optional(),
  },
}, wrap(async ({ x, y, button = 'left', double = false }) => {
  await kvm.ensure();
  const b = BUTTON[button];
  for (let i = 0; i < (double ? 2 : 1); i++) {
    kvm.mouse(x, y, 0); await sleep(50);
    kvm.mouse(x, y, b); await sleep(70);
    kvm.mouse(x, y, 0); await sleep(double ? 90 : 0);
  }
  return text(`clicked ${button}${double ? ' (double)' : ''} at ${x},${y}`);
}));

server.registerTool('move_mouse', {
  title: 'Move mouse',
  description: 'Moves the pointer to absolute screen coordinates (also wakes a sleeping display).',
  inputSchema: { x: z.number(), y: z.number() },
}, wrap(async ({ x, y }) => { await kvm.ensure(); kvm.mouse(x, y, 0); return text(`moved to ${x},${y}`); }));

server.registerTool('drag', {
  title: 'Mouse drag',
  description: 'Press left button at (x1,y1), move to (x2,y2), release.',
  inputSchema: { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() },
}, wrap(async ({ x1, y1, x2, y2 }) => {
  await kvm.ensure();
  kvm.mouse(x1, y1, 0); await sleep(50); kvm.mouse(x1, y1, 1); await sleep(80);
  for (let i = 1; i <= 10; i++) { kvm.mouse(x1 + (x2 - x1) * i / 10, y1 + (y2 - y1) * i / 10, 1); await sleep(30); }
  kvm.mouse(x2, y2, 0);
  return text(`dragged ${x1},${y1} -> ${x2},${y2}`);
}));

server.registerTool('scroll', {
  title: 'Mouse wheel',
  description: 'Scrolls at a position. Positive amount scrolls up, negative down (wheel notches).',
  inputSchema: { x: z.number(), y: z.number(), amount: z.number().int().min(-20).max(20) },
}, wrap(async ({ x, y, amount }) => {
  await kvm.ensure();
  const step = Math.sign(amount);
  for (let i = 0; i < Math.abs(amount); i++) { kvm.mouse(x, y, 0, step); await sleep(40); }
  kvm.mouse(x, y, 0, 0);
  return text(`scrolled ${amount} at ${x},${y}`);
}));

// ---------------- keyboard ----------------
server.registerTool('type_text', {
  title: 'Type text',
  description: 'Types text on the host keyboard (US layout; use \\n for Enter, \\t for Tab). Non-ASCII characters are not supported.',
  inputSchema: {
    text: z.string().max(4000),
    delay_ms: z.number().int().min(10).max(1000).optional().describe('Delay between keys (default 30)'),
  },
}, wrap(async ({ text: t, delay_ms = 30 }) => {
  await kvm.ensure();
  const bad = [...t].filter((c) => !CHARS[c]);
  if (bad.length) throw new Error(`cannot type characters: ${JSON.stringify([...new Set(bad)].join(''))}`);
  for (const c of t) { const [u, m] = CHARS[c]; kvm.key(u, m); await sleep(delay_ms); }
  return text(`typed ${t.length} characters`);
}));

server.registerTool('press_keys', {
  title: 'Press key / key combination',
  description: 'Presses keys, e.g. "enter", "esc", "f2", "del", "tab", "up", "ctrl+alt+delete", "ctrl+alt+f3", "super", "alt+f4". Several can be given in order.',
  inputSchema: {
    keys: z.array(z.string()).min(1).max(50).describe('List of keys/combos pressed one after another'),
    repeat: z.number().int().min(1).max(50).optional().describe('Repeat the whole list (e.g. press down 5 times)'),
    delay_ms: z.number().int().min(20).max(5000).optional().describe('Delay between presses (default 120)'),
  },
}, wrap(async ({ keys, repeat = 1, delay_ms = 120 }) => {
  await kvm.ensure();
  const parsed = keys.map(parseCombo);
  for (let r = 0; r < repeat; r++) for (const [u, m] of parsed) { kvm.key(u, m); await sleep(delay_ms); }
  return text(`pressed ${keys.join(', ')}${repeat > 1 ? ` x${repeat}` : ''}`);
}));

// ---------------- info ----------------
server.registerTool('kvm_status', {
  title: 'KVM session status',
  description: 'Connection state, screen resolution, whether the host display is blank, mouse mode, other KVM clients.',
  inputSchema: {},
}, wrap(async () => {
  await kvm.ensure();
  await kvm.waitForFrame(kvm.frames, 1500);
  return text({
    connected: kvm.connected, validated: kvm.validated,
    resolution: kvm.image ? `${kvm.width}x${kvm.height}` : null,
    display_blank: kvm.blank, frames_received: kvm.frames,
    last_frame_age_s: kvm.lastFrameAt ? Math.round((Date.now() - kvm.lastFrameAt) / 1000) : null,
    mouse_mode: { 1: 'relative', 2: 'absolute', 3: 'other' }[kvm.mouseMode] || kvm.mouseMode,
    other_clients: kvm.otherClients,
  });
}));

server.registerTool('system_info', {
  title: 'BMC and host info',
  description: 'BMC firmware, host power state, host BIOS/model (via Redfish).',
  inputSchema: {},
}, wrap(async () => text(await systemInfo(bmc))));

server.registerTool('sensors', {
  title: 'Sensor readings',
  description: 'Temperatures, fans, voltages from the BMC (Redfish).',
  inputSchema: { include_absent: z.boolean().optional() },
}, wrap(async ({ include_absent }) => text(await sensors(bmc, { includeAbsent: include_absent }))));

// ---------------- power (opt-in) ----------------
if (ALLOW_POWER) {
  server.registerTool('power', {
    title: 'Host power control',
    description: `Power the host on/off/restart via the BMC. Actions: ${POWER_ACTIONS.join(', ')}. ForceOff/ForceRestart cut power immediately (data loss possible).`,
    inputSchema: { action: z.enum(POWER_ACTIONS) },
    annotations: { destructiveHint: true },
  }, wrap(async ({ action }) => text(await power(bmc, action))));

  server.registerTool('set_boot_once', {
    title: 'One-time boot device',
    description: 'Boot override for the next boot only (e.g. Cd for a virtual-media ISO, BiosSetup to enter BIOS). Needs host BIOS support.',
    inputSchema: {
      target: z.enum(['None', 'Pxe', 'Cd', 'Usb', 'Hdd', 'BiosSetup']),
      mode: z.enum(['UEFI', 'Legacy']).optional(),
    },
  }, wrap(async ({ target, mode }) => text(await setBootOnce(bmc, target, mode))));
}

// ---------------- virtual media (opt-in) ----------------
server.registerTool('media_status', {
  title: 'Virtual media status',
  description: 'Remote-media settings (share), images found on the share, active redirections.',
  inputSchema: {},
}, wrap(async () => text(await mediaStatus(bmc))));

if (ALLOW_MEDIA) {
  server.registerTool('media_configure_share', {
    title: 'Configure virtual-media share',
    description: 'Sets the NFS/CIFS share the BMC reads ISO/IMG files from and enables remote media. Changes BMC settings.',
    inputSchema: {
      server: z.string().describe('IP of the NFS/CIFS server reachable from the BMC network'),
      path: z.string().describe('NFS export path (e.g. /srv/isos) or CIFS share name'),
      share_type: z.enum(['nfs', 'cifs']).optional(),
      kind: z.enum(['cd', 'hd']).optional(),
      user: z.string().optional(), password: z.string().optional(), domain: z.string().optional(),
    },
  }, wrap(async (a) => text(await configureShare(bmc, { kind: a.kind, server: a.server, path: a.path, shareType: a.share_type || 'nfs', user: a.user, password: a.password, domain: a.domain }))));

  server.registerTool('media_list_images', {
    title: 'List images on the share',
    description: 'Refreshes and lists ISO/IMG files the BMC sees on the configured share.',
    inputSchema: {},
  }, wrap(async () => text(await listImages(bmc))));

  server.registerTool('media_mount', {
    title: 'Mount image as virtual CD/HDD',
    description: 'Attaches an image from the share to the host as virtual CD (iso) or hard disk (img).',
    inputSchema: { image: z.string(), kind: z.enum(['cd', 'hd']).optional() },
  }, wrap(async ({ image, kind }) => text(await startImage(bmc, { image, kind }))));

  server.registerTool('media_unmount', {
    title: 'Unmount virtual media',
    inputSchema: { image: z.string(), kind: z.enum(['cd', 'hd']).optional() },
  }, wrap(async ({ image, kind }) => text(await stopImage(bmc, { image, kind }))));
}

export async function main() {
  if (!env.ASUS_IPMI_HOST || !env.ASUS_IPMI_PASSWORD) {
    log('ASUS_IPMI_HOST and ASUS_IPMI_PASSWORD must be set (ASUS_IPMI_USER defaults to admin).');
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${VERSION} ready for ${env.ASUS_IPMI_HOST} (power tools: ${ALLOW_POWER ? 'on' : 'off'}, media write tools: ${ALLOW_MEDIA ? 'on' : 'off'})`);
  const shutdown = async () => { kvm.close(); await bmc.logout(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}
