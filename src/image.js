// Frame -> PNG/JPEG encoding, optional downscale and crop.
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

function rgbaView(img) {
  return Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
}

/** Copy (and optionally crop) an RGBA image. region = {x,y,width,height}. */
export function crop(img, region) {
  if (!region) return { width: img.width, height: img.height, data: Buffer.from(rgbaView(img)) };
  const x = Math.max(0, Math.floor(region.x)), y = Math.max(0, Math.floor(region.y));
  const w = Math.min(img.width - x, Math.floor(region.width)), h = Math.min(img.height - y, Math.floor(region.height));
  if (w <= 0 || h <= 0) throw new Error('crop region is outside the screen');
  const src = rgbaView(img), out = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) src.copy(out, row * w * 4, ((y + row) * img.width + x) * 4, ((y + row) * img.width + x + w) * 4);
  return { width: w, height: h, data: out };
}

/** Box-filter downscale by an integer-ish factor so the long side <= maxSide. */
export function downscale(img, maxSide) {
  const long = Math.max(img.width, img.height);
  if (!maxSide || long <= maxSide) return img;
  const f = long / maxSide;
  const w = Math.round(img.width / f), h = Math.round(img.height / f);
  const out = Buffer.alloc(w * h * 4);
  for (let oy = 0; oy < h; oy++) {
    const y0 = Math.floor(oy * f), y1 = Math.min(img.height, Math.floor((oy + 1) * f));
    for (let ox = 0; ox < w; ox++) {
      const x0 = Math.floor(ox * f), x1 = Math.min(img.width, Math.floor((ox + 1) * f));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
      const o = (oy * w + ox) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

export function encode(img, format = 'png', quality = 85) {
  if (format === 'jpeg' || format === 'jpg') {
    return { mimeType: 'image/jpeg', data: jpeg.encode({ width: img.width, height: img.height, data: img.data }, quality).data };
  }
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy ? img.data.copy(png.data) : png.data.set(img.data);
  return { mimeType: 'image/png', data: PNG.sync.write(png) };
}

/** Fraction of pixels that differ between two RGBA buffers of the same size. */
export function diffRatio(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let d = 0, n = a.length / 4;
  for (let i = 0; i < a.length; i += 16) {          // sample every 4th pixel
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) d++;
  }
  return d / (n / 4);
}
