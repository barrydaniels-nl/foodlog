/**
 * Generates the app icons (a progress ring on green) as PNGs using only
 * node:zlib. Run once with `npm run icons`; the output is committed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../public/icons/', import.meta.url));
const GREEN = [63, 156, 95];
const SUPERSAMPLE = 4;
const RING_FRACTION = 0.75;

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Returns white-ink coverage (0..1) and alpha for a sample point in unit space. */
function sample(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const distance = Math.hypot(dx, dy);
  const radius = 0.27;
  const halfWidth = 0.055;
  if (Math.abs(distance - radius) > halfWidth) return 0;
  // Angle measured clockwise from 12 o'clock.
  const angle = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI);
  return angle <= RING_FRACTION * 2 * Math.PI ? 1 : 0.3;
}

function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const steps = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let ink = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          ink += sample((px + (sx + 0.5) / SUPERSAMPLE) / size, (py + (sy + 0.5) / SUPERSAMPLE) / size);
        }
      }
      const t = ink / steps;
      const offset = (py * size + px) * 4;
      for (let c = 0; c < 3; c += 1) pixels[offset + c] = Math.round(GREEN[c] + (255 - GREEN[c]) * t);
      pixels[offset + 3] = 255;
    }
  }
  return encodePng(size, pixels);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  writeFileSync(OUT_DIR + name, drawIcon(size));
  console.log(`wrote public/icons/${name}`);
}
