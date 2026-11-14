import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const PNG_PATH = path.join(ROOT, 'build', 'icon.png');
const ICO_PATH = path.join(ROOT, 'build', 'icon.ico');
const SIZE = 1024;
const MARGIN = 32;
const RADIUS = 218;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function squircleMask() {
  const inset = MARGIN;
  const side = SIZE - inset * 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
      `<rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/>` +
      '</svg>',
  );
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

const source = sharp(PNG_PATH).resize(SIZE, SIZE, { fit: 'cover' });
const masked = await source
  .ensureAlpha()
  .composite([{ input: squircleMask(), blend: 'dest-in' }])
  .png({ compressionLevel: 9 })
  .toBuffer();

fs.writeFileSync(PNG_PATH, masked);

const images = [];
for (const size of ICO_SIZES) {
  const data = await sharp(masked)
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  images.push({ size, data });
}

const ico = buildIco(images);
fs.writeFileSync(ICO_PATH, ico);
console.log(`icon.png ${SIZE}x${SIZE} ${masked.length} bytes`);
console.log(`icon.ico ${ICO_SIZES.join('/')} ${ico.length} bytes`);
