// KVM session over wss://<bmc>/kvm using AMI's IVTP protocol (MegaRAC, ASPEED AST2600).
//
// Packet: u16 type | u32 payload size | u16 status | payload (little endian).
// Handshake as done by AMI's H5Viewer (firmware 1.3.13):
//   <- CONNECTION_ALLOWED(23)
//   -> CONNECTION_COMPLETE(58,st1) + VALIDATE_VIDEO_SESSION(18,st1,438B) + RESUME_REDIRECTION(6)
//   <- VALIDATED_VIDEO_SESSION(19) payload[0]: 1 valid, 0 invalid, 2 no privilege, 3 invalid info
//   <- MEDIA_LICENSE_STATUS(53) -> DISPLAY_LOCK_SET(51,[2]) + GET_USER_MACRO(40) + GET_WEB_TOKEN(21)
//   <- ACTIVE_CLIENTS(39)       -> GET_FULL_SCREEN(11,st1)
//   <- KEEP_ALIVE(57)           -> KEEP_ALIVE(57)
//   <- VIDEO_PACKETS(25) frames, PAINT_BLANK_SCREEN(9) ~1.6/s while the host display is off
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AstDecoder, loadDecoderSource } from './decoder.js';

export const CMD = {
  SEND_HID_PACKET: 1, RESUME_REDIRECTION: 6, STOP_SESSION_IMMEDIATE: 8, PAINT_BLANK_SCREEN: 9,
  USB_MOUSE_MODE: 10, GET_FULL_SCREEN: 11, VALIDATE_VIDEO_SESSION: 18, VALIDATED_VIDEO_SESSION: 19,
  GET_WEB_TOKEN: 21, MAX_SESSION_CLOSE: 22, CONNECTION_ALLOWED: 23, VIDEO_PACKETS: 25,
  KVM_SHARING: 32, POWER_STATUS: 34, ACTIVE_CLIENTS: 39, GET_USER_MACRO: 40, SET_NEXT_MASTER: 50,
  DISPLAY_LOCK_SET: 51, MEDIA_LICENSE_STATUS: 53, KEEP_ALIVE: 57, CONNECTION_COMPLETE: 58,
};
const NAMES = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));
const VALIDATE_RESULT = { 0: 'invalid session', 1: 'valid', 2: 'insufficient privilege (KVM not allowed for this user)', 3: 'invalid session info', 8: 'session unregistered' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function header(type, size, status, payload) {
  const b = Buffer.alloc(8 + size);
  b.writeUInt16LE(type, 0); b.writeUInt32LE(size, 2); b.writeUInt16LE(status, 6);
  if (payload) Buffer.from(payload).copy(b, 8);
  return b;
}
function cstr(str, len) {
  const b = Buffer.alloc(len);
  Buffer.from(str || '', 'latin1').copy(b, 0, 0, len - 1);
  return b;
}

export class KvmSession extends EventEmitter {
  constructor(bmc, { log = () => {} } = {}) {
    super();
    this.bmc = bmc;
    this.log = log;
    this.ws = null;
    this.connected = false;
    this.validated = false;
    this.decoder = null;
    this.reset();
  }

  reset() {
    this.buf = Buffer.alloc(0);
    this.frame = null;
    this.frames = 0;
    this.lastFrameAt = 0;
    this.lastBlankAt = 0;
    this.blank = false;
    this.mouseMode = null;
    this.seq = 0;
    this.otherClients = [];
  }

  get width() { return this.decoder?.width || 0; }
  get height() { return this.decoder?.height || 0; }
  get image() { return this.decoder?.image || null; }

  /** Connect if not connected; resolves when the session is validated. */
  async ensure() {
    if (this.connected && this.validated && this.ws?.readyState === WebSocket.OPEN) return;
    if (this._connecting) return this._connecting;
    this._connecting = this._connect().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _connect() {
    this.close();
    this.reset();
    await this.bmc.login();
    const cfg = await this.bmc.api('GET', '/api/settings/media/h5viewercfg');
    if (cfg.kvm_service_status === 0) throw new Error('KVM service is disabled on the BMC');
    this.session = { client_ip: cfg.client_ip, session: cfg.session, token: cfg.token, server_ip: cfg.server_ip };
    if (!this.decoder) {
      let tag = 'unknown';
      try { const m = await this.bmc.redfish('GET', '/redfish/v1/Managers/Self'); tag = m.FirmwareVersion || tag; } catch { /* ignore */ }
      this.decoder = new AstDecoder(await loadDecoderSource(this.bmc, tag));
    }

    const ws = new WebSocket(`wss://${this.bmc.host}/kvm`, ['binary', 'base64'], {
      rejectUnauthorized: false, origin: `https://${this.bmc.host}`, headers: { cookie: this.bmc.cookie },
    });
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      const chunk = isBinary ? Buffer.from(data) : Buffer.from(data.toString(), 'base64');
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      try { this.parse(); } catch (e) { this.log(`parse error: ${e.message}`); }
    });
    ws.on('close', () => {
      this.connected = false; this.validated = false;
      this.log('KVM websocket closed');
      this.emit('close');
    });
    ws.on('error', (e) => this.log(`KVM websocket error: ${e.message}`));
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    this.connected = true;

    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('KVM session not validated within 15 s')), 15000);
      this.once('validated', (code) => {
        clearTimeout(t);
        if (code === 1) res(); else rej(new Error(`KVM session rejected: ${VALIDATE_RESULT[code] || code}`));
      });
    });
    this.log('KVM session validated');
  }

  send(type, status = 0, payload = null) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('KVM not connected');
    this.ws.send(header(type, payload ? payload.length : 0, status, payload));
  }

  parse() {
    while (this.buf.length >= 8) {
      const type = this.buf.readUInt16LE(0), size = this.buf.readUInt32LE(2), status = this.buf.readUInt16LE(6);
      if (this.buf.length < 8 + size) return;
      const p = this.buf.subarray(8, 8 + size);
      this.buf = this.buf.subarray(8 + size);
      this.handle(type, status, p);
    }
  }

  handle(type, status, p) {
    switch (type) {
      case CMD.CONNECTION_ALLOWED: this.sendValidate(); break;
      case CMD.VALIDATED_VIDEO_SESSION:
        this.validated = p[0] === 1;
        this.emit('validated', p[0]);
        break;
      case CMD.MEDIA_LICENSE_STATUS:
        this.send(CMD.DISPLAY_LOCK_SET, 0, Buffer.from([2]));
        this.send(CMD.GET_USER_MACRO);
        this.send(CMD.GET_WEB_TOKEN, 0, cstr(this.session.session, 35));
        break;
      case CMD.ACTIVE_CLIENTS: {
        this.otherClients = [];
        for (let o = 0; o + 134 <= p.length; o += 134) {
          const name = p.subarray(o, o + 64).toString('latin1').replace(/\0.*$/s, '');
          const ip = p.subarray(o + 64, o + 129).toString('latin1').replace(/\0.*$/s, '');
          this.otherClients.push({ name, ip });
        }
        this.send(CMD.GET_FULL_SCREEN, 1);
        break;
      }
      case CMD.KEEP_ALIVE: this.send(CMD.KEEP_ALIVE); break;
      case CMD.USB_MOUSE_MODE: this.mouseMode = p[0]; break;
      case CMD.PAINT_BLANK_SCREEN: this.blank = true; this.lastBlankAt = Date.now(); this.emit('blank'); break;
      case CMD.STOP_SESSION_IMMEDIATE:
      case CMD.MAX_SESSION_CLOSE:
        this.log(`BMC stopped the KVM session (${NAMES[type]}, status ${status})`);
        this.close();
        break;
      case CMD.KVM_SHARING:
        this.log(`another client requests KVM control (status ${status & 255})`);
        break;
      case CMD.VIDEO_PACKETS: this.onVideoPacket(p); break;
      default: break;
    }
  }

  sendValidate() {
    const body = Buffer.concat([
      Buffer.from([0]),
      cstr(this.session.token, 129),
      cstr(this.session.client_ip || 'No IP', 65),
      cstr('domain/username', 129), // the H5Viewer always sends this literal, not the real user
      cstr('00-00-00-00-00-00', 49),
      cstr(this.session.server_ip || this.bmc.host, 65),
    ]);
    this.ws.send(Buffer.concat([
      header(CMD.CONNECTION_COMPLETE, 0, 1),
      header(CMD.VALIDATE_VIDEO_SESSION, body.length, 1, body),
      header(CMD.RESUME_REDIRECTION, 0, 0),
    ]));
  }

  // VIDEO_PACKETS: 2 bytes, then (first fragment of a frame) an 86-byte engine header, then data.
  onVideoPacket(p) {
    let off = 2;
    if (!this.frame) {
      const e = p.subarray(off, off + 73);
      this.frame = {
        header: {
          SourceModeInfo: { X: e[5] << 8 | e[4], Y: e[7] << 8 | e[6] },
          DestinationModeInfo: { X: e[14] << 8 | e[13], Y: e[16] << 8 | e[15] },
          FrameHeader: { JPEGTableSelector: e[44], JPEGYUVTableMapping: e[45], AdvanceTableSelector: e[47], RC4Enable: e[53] },
          Mode420: e[55],
          CompressData: { CompressSize: (e[72] << 24 | e[71] << 16 | e[70] << 8 | e[69]) >>> 0 },
        },
        chunks: [], size: 0,
      };
      off += 86;
    }
    const data = p.subarray(off);
    this.frame.chunks.push(data); this.frame.size += data.length;
    const want = this.frame.header.CompressData.CompressSize;
    if (this.frame.size >= want) {
      const f = this.frame; this.frame = null;
      this.decodeFrame(f.header, Buffer.concat(f.chunks).subarray(0, want));
    }
  }

  decodeFrame(hdr, data) {
    const { X, Y } = hdr.SourceModeInfo;
    if (!X || !Y) return;
    if (X !== this.decoder.width || Y !== this.decoder.height) this.decoder.setResolution(X, Y);
    const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4); data.copy(padded);
    const ints = Int32Array.from(new Int32Array(padded.buffer, padded.byteOffset, padded.length / 4));
    this.decoder.decode(hdr, ints, () => {
      this.frames++; this.lastFrameAt = Date.now(); this.blank = false;
      this.emit('frame');
    });
  }

  /** Wait until a frame newer than `sinceFrames` arrived (or timeout). */
  async waitForFrame(sinceFrames, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (this.frames <= sinceFrames && Date.now() < end) await sleep(100);
    return this.frames > sinceFrames;
  }

  // ---------------- input: USB HID over IVTP type 1 ----------------
  // IVTP hdr(8) | IUSB hdr(32) | len(1) | report; IUSB checksum at byte 11 of the IUSB header.
  hid(device, proto, ifnum, report) {
    const total = 32 + 1 + report.length;
    const b = Buffer.alloc(8 + total);
    b.writeUInt16LE(CMD.SEND_HID_PACKET, 0); b.writeUInt32LE(total, 2); b.writeUInt16LE(0, 6);
    b.write('IUSB    ', 8, 'latin1');
    b[16] = 1; b[17] = 0; b[18] = 32; b[19] = 0;
    b.writeInt32LE(total - 32, 20);
    b[24] = 0; b[25] = device; b[26] = proto; b[27] = 0x80; b[28] = 2; b[29] = ifnum;
    b.writeInt32LE(++this.seq, 32);
    b[40] = report.length; Buffer.from(report).copy(b, 41);
    let sum = 0; for (let i = 8; i < 40; i++) sum = (sum + b[i]) & 255;
    b[19] = (-sum) & 255;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('KVM not connected');
    this.ws.send(b);
  }

  /** Key press with BMC auto-release. usage 0 = modifiers only. */
  key(usage, modifiers = 0) { this.hid(48, 16, 0, [modifiers, 1, usage, 0, 0, 0, 0, 0]); }

  /** Absolute mouse in screen pixels. buttons: 1 left, 2 right, 4 middle. */
  mouse(x, y, buttons = 0, wheel = 0) {
    const w = this.width || 1024, h = this.height || 768;
    const sx = Math.max(0, Math.min(32767, Math.round(x * 32767 / w + 0.5)));
    const sy = Math.max(0, Math.min(32767, Math.round(y * 32767 / h + 0.5)));
    const r = Buffer.alloc(6);
    r[0] = buttons; r.writeInt16LE(sx, 1); r.writeInt16LE(sy, 3); r.writeInt8(Math.max(-127, Math.min(127, wheel)), 5);
    this.hid(49, 32, 1, r);
    this.lastMouse = { x, y };
  }

  close() {
    if (this.ws) {
      try { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(header(CMD.STOP_SESSION_IMMEDIATE, 0, 0)); } catch { /* ignore */ }
      try { this.ws.terminate(); } catch { /* ignore */ }
    }
    this.ws = null; this.connected = false; this.validated = false;
  }
}
