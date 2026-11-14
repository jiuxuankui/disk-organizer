import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

const ROOT = process.cwd();
const PNG_PATH = path.join(ROOT, 'build', 'icon.png');
const ICO_PATH = path.join(ROOT, 'build', 'icon.ico');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

interface IcoEntry {
  width: number;
  height: number;
  planes: number;
  bitCount: number;
  bytes: number;
  offset: number;
}

function pngSize(buffer: Buffer, offset = 0): { width: number; height: number } {
  expect(buffer.subarray(offset, offset + 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(buffer.toString('ascii', offset + 12, offset + 16)).toBe('IHDR');
  return {
    width: buffer.readUInt32BE(offset + 16),
    height: buffer.readUInt32BE(offset + 20),
  };
}

function parseIco(buffer: Buffer): IcoEntry[] {
  expect(buffer.readUInt16LE(0)).toBe(0);
  expect(buffer.readUInt16LE(2)).toBe(1);
  const count = buffer.readUInt16LE(4);
  const entries: IcoEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = 6 + index * 16;
    entries.push({
      width: buffer[start] === 0 ? 256 : buffer[start],
      height: buffer[start + 1] === 0 ? 256 : buffer[start + 1],
      planes: buffer.readUInt16LE(start + 4),
      bitCount: buffer.readUInt16LE(start + 6),
      bytes: buffer.readUInt32LE(start + 8),
      offset: buffer.readUInt32LE(start + 12),
    });
  }
  return entries;
}

describe('application icon assets', () => {
  it('ships a 1024px square PNG with transparent squircle corners', async () => {
    const png = fs.readFileSync(PNG_PATH);
    expect(pngSize(png)).toEqual({ width: 1024, height: 1024 });

    const { data, info } = await sharp(png)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);

    const alphaAt = (x: number, y: number): number => data[(y * info.width + x) * 4 + 3];
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(1023, 0)).toBe(0);
    expect(alphaAt(512, 512)).toBe(255);
    expect(alphaAt(512, 8)).toBe(0);
  });

  it('packages a multi-resolution Windows icon', () => {
    const ico = fs.readFileSync(ICO_PATH);
    const entries = parseIco(ico);
    expect(entries.map((entry) => entry.width)).toEqual(ICO_SIZES);
    expect(entries.map((entry) => entry.height)).toEqual(ICO_SIZES);

    for (const entry of entries) {
      expect(entry.planes).toBe(1);
      expect(entry.bitCount).toBe(32);
      expect(entry.offset + entry.bytes).toBeLessThanOrEqual(ico.length);
      const embedded = ico.subarray(entry.offset, entry.offset + entry.bytes);
      expect(pngSize(embedded)).toEqual({ width: entry.width, height: entry.height });
    }
  });

  it('points the Windows builder at the generated icon', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      build?: { win?: { icon?: string } };
    };
    expect(pkg.build?.win?.icon).toBe('build/icon.ico');
  });
});
