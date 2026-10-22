// Runs AMI's ASPEED video decoder inside a Node vm context.
//
// The decoder (decode_worker.js) is copyrighted AMI code and is NOT shipped with this
// package. It is downloaded from the user's own BMC (/libs/kvm/ast/decode_worker.js) on
// first use and cached per BMC firmware version.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

const DECODER_PATH = '/libs/kvm/ast/decode_worker.js';

function cacheDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  for (const d of [path.join(base, 'asus-ipmi-mcp'), path.join(os.tmpdir(), 'asus-ipmi-mcp')]) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch { /* try next */ }
  }
  return os.tmpdir();
}

/** Returns the decoder source, downloading it from the BMC if not cached. */
export async function loadDecoderSource(bmc, firmwareTag = 'unknown') {
  const key = crypto.createHash('sha1').update(`${bmc.host}|${firmwareTag}`).digest('hex').slice(0, 12);
  const file = path.join(cacheDir(), `decode_worker-${key}.js`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'latin1');
  const buf = await bmc.getStatic(DECODER_PATH);
  const src = buf.toString('latin1');
  if (!src.includes('Decoder.prototype') || !src.includes("cmd: 'draw'")) {
    throw new Error(`Unexpected content at ${DECODER_PATH}; this BMC may use a different video engine`);
  }
  fs.writeFileSync(file, src, 'latin1');
  return src;
}

export class AstDecoder {
  constructor(source) {
    const listeners = [];
    this._onDraw = null;
    const self = {
      addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
      postMessage: (msg) => {
        if (msg.cmd === 'draw' && this._onDraw) this._onDraw(msg.ibuf);
        else if (msg.cmd === 'exception') process.stderr.write(`[asus-ipmi-mcp] decoder exception: ${msg.ex}\n`);
      },
    };
    const ctx = {
      self, console: { log() {}, error() {}, warn() {} },
      setTimeout, clearTimeout,
      Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
      Float32Array, Float64Array, Uint8ClampedArray, ArrayBuffer, DataView, Math, Error,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: 'decode_worker.js' });
    this._post = (data) => listeners.forEach((fn) => fn({ data }));
    this.width = 0;
    this.height = 0;
    this.image = null;
  }

  setResolution(w, h) {
    this.width = w; this.height = h;
    this.image = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let i = 3; i < this.image.data.length; i += 4) this.image.data[i] = 255;
    this._post({ cmd: 'resolution_changed', imageBuffer: this.image });
  }

  decode(header, int32Buffer, cb) {
    this._onDraw = cb;
    this._post({ header, buffer: int32Buffer });
  }
}
