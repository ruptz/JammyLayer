/**
 * Generates build/icon.png for electron-builder, which converts it to the .ico
 * and .icns the installers want. It is the same mark as public/logo.png, only
 * larger: electron-builder refuses anything under 256×256, and the source is a
 * 128px sprite.
 *
 * Scaling is nearest-neighbour on purpose. The mark has hard edges and flat
 * fills, and doubling it exactly keeps them hard — a smooth filter would just
 * put a halo around every one of them. `npm run dist` runs this first.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ------------------------------------------------------------------- decoding

/** Splits a PNG into its header fields and the concatenated image data. */
function readChunks(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');

  const parts = [];
  let header = null;

  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);

    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colour: body[9],
        interlace: body[12],
      };
    } else if (type === 'IDAT') {
      parts.push(body);
    } else if (type === 'IEND') {
      break;
    }

    at += 12 + length; // length + type + body + CRC
  }

  if (!header) throw new Error('PNG has no IHDR');
  return { header, data: Buffer.concat(parts) };
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** Reverses the per-row filters and returns tightly packed RGBA. */
function decode(png) {
  const { header, data } = readChunks(png);
  const { width, height, depth, colour, interlace } = header;

  // Enough for a mark exported from any editor. Palettes, 16-bit samples and
  // Adam7 would each need their own path, and none of them are worth carrying
  // for a file this project produces itself.
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth} (need 8)`);
  if (colour !== 6 && colour !== 2) throw new Error(`unsupported colour type ${colour} (need RGB or RGBA)`);
  if (interlace !== 0) throw new Error('interlaced PNGs are not supported');

  const channels = colour === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(data);
  const out = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start];
    raw.copy(line, 0, start + 1, start + 1 + stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;

      switch (filter) {
        case 1: line[x] = (line[x] + left) & 0xff; break;
        case 2: line[x] = (line[x] + up) & 0xff; break;
        case 3: line[x] = (line[x] + ((left + up) >> 1)) & 0xff; break;
        case 4: line[x] = (line[x] + paeth(left, up, upLeft)) & 0xff; break;
        case 0: break;
        default: throw new Error(`unknown row filter ${filter}`);
      }
    }

    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = line[from];
      out[to + 1] = line[from + 1];
      out[to + 2] = line[from + 2];
      out[to + 3] = channels === 4 ? line[from + 3] : 255;
    }

    previous = Buffer.from(line);
  }

  return { width, height, pixels: out };
}

// ------------------------------------------------------------------- encoding

function resize(source, size) {
  // One filter byte (0 = None) per row, then RGBA.
  const raw = Buffer.alloc(size * (1 + size * 4));

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    const sy = Math.min(source.height - 1, Math.floor((y * source.height) / size));

    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor((x * source.width) / size));
      source.pixels.copy(raw, rowStart + 1 + x * 4, (sy * source.width + sx) * 4, (sy * source.width + sx) * 4 + 4);
    }
  }

  return raw;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// ----------------------------------------------------------------------- main

const source = decode(await readFile(fileURLToPath(new URL('../public/logo.png', import.meta.url))));

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// bytes 10-12 stay zero: deflate compression, adaptive filtering, no interlace

const png = Buffer.concat([
  SIGNATURE,
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(resize(source, SIZE), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const dir = fileURLToPath(new URL('../build/', import.meta.url));
await mkdir(dir, { recursive: true });
await writeFile(`${dir}icon.png`, png);
console.log(`[icon] wrote ${dir}icon.png (${SIZE}×${SIZE} from ${source.width}×${source.height}, ${png.length} bytes)`);
