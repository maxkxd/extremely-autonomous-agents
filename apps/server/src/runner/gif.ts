import { inflateSync } from 'node:zlib';

// An animated GIF from PNG frames, with nothing but Node: a browser recording
// (signed_in_browser.record) where ffmpeg isn't installed to make an MP4. Plain on
// purpose - a fixed 252-colour palette, no dithering, every frame whole - since what
// matters is seeing what the agent did, not the picture quality.

export type Pixels = { width: number; height: number; channels: number; data: Uint8Array };

// A PNG as the browser makes one (8 bits a channel, RGB or RGBA, not interlaced).
export function decodePng(png: Buffer): Pixels {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG.');
  let pos = 8;
  let width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8], color = body[9], interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) throw new Error(`A PNG this can't read (depth ${depth}, colour type ${color}).`);
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  // Each row starts with its filter; undone against the row above (PNG spec, 9.2).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y ? out[up + x] : 0;
      const c = y && x >= channels ? out[up + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

// 6 levels of red, 7 of green (the eye sees it best), 6 of blue: 252 colours.
const LEVELS = [6, 7, 6];
function palette(): Buffer {
  const p = Buffer.alloc(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++, i++) p.set([Math.round((r * 255) / 5), Math.round((g * 255) / 6), Math.round((b * 255) / 5)], i * 3);
  return p;
}
// A frame's pixels as palette indices, at width x height (cropped, or padded black,
// when a frame is another size than the first).
function indices(f: Pixels, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < Math.min(height, f.height); y++)
    for (let x = 0; x < Math.min(width, f.width); x++) {
      const s = (y * f.width + x) * f.channels;
      const r = Math.round((f.data[s] * (LEVELS[0] - 1)) / 255), g = Math.round((f.data[s + 1] * (LEVELS[1] - 1)) / 255), b = Math.round((f.data[s + 2] * (LEVELS[2] - 1)) / 255);
      out[y * width + x] = r * 42 + g * 6 + b;
    }
  return out;
}

// GIF's LZW, codes packed least significant bit first, in blocks of up to 255 bytes.
function lzw(index: Uint8Array, minCodeSize = 8): Buffer {
  const bytes: number[] = [];
  let cur = 0, shift = 0;
  const emit = (code: number, size: number) => {
    cur |= code << shift;
    shift += size;
    while (shift >= 8) {
      bytes.push(cur & 255);
      cur >>>= 8;
      shift -= 8;
    }
  };
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let next = eoi + 1, size = minCodeSize + 1;
  let table = new Map<number, number>();
  emit(clear, size);
  let prefix = index[0];
  for (let i = 1; i < index.length; i++) {
    const k = index[i];
    const key = (prefix << 8) | k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix, size);
    if (next === 4096) {
      emit(clear, size);
      next = eoi + 1;
      size = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix, size);
  emit(eoi, size);
  if (shift > 0) bytes.push(cur & 255);
  const out: number[] = [minCodeSize];
  for (let i = 0; i < bytes.length; i += 255) {
    const block = bytes.slice(i, i + 255);
    out.push(block.length, ...block);
  }
  out.push(0);
  return Buffer.from(out);
}

// The frames, each shown for its delay (ms), looping. The first frame sets the size.
export function encodeGif(frames: { pixels: Pixels; delayMs: number }[]): Buffer {
  if (!frames.length) throw new Error('No frames to make a GIF of.');
  const { width, height } = frames[0].pixels;
  const u16 = (n: number) => [n & 255, (n >> 8) & 255];
  const parts: Buffer[] = [
    Buffer.from('GIF89a', 'latin1'),
    // Logical screen: a global table of 256 colours.
    Buffer.from([...u16(width), ...u16(height), 0xf7, 0, 0]),
    palette(),
    // Loop for ever (the Netscape extension).
    Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0, 0, 0]),
  ];
  for (const f of frames) {
    const delay = Math.max(2, Math.round(f.delayMs / 10)); // hundredths; under 2 most viewers ignore
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, ...u16(delay), 0, 0]));
    parts.push(Buffer.from([0x2c, 0, 0, 0, 0, ...u16(width), ...u16(height), 0]));
    parts.push(lzw(indices(f.pixels, width, height)));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
