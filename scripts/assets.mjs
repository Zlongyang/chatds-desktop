import { mkdir, copyFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
await mkdir('dist/renderer', { recursive: true });
await mkdir('dist/desktop', { recursive: true });
await mkdir('dist/assets', { recursive: true });
for (const file of await readdir('src/renderer'))
  if (/\.(html|css)$/.test(file))
    await copyFile(join('src/renderer', file), join('dist/renderer', file));
await copyFile('src/desktop/preload.cjs', 'dist/desktop/preload.cjs');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type),
    out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  t.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, data])), out.length - 4);
  return out;
}
const size = 256,
  pixels = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const p = y * (size * 4 + 1) + 1 + x * 4;
    const fish = (x - 115) ** 2 / 75 ** 2 + (y - 128) ** 2 / 60 ** 2 <= 1;
    const tail = x > 172 && x < 229 && Math.abs(y - 128) < (x - 170) * 0.7;
    if (fish || tail) {
      pixels[p] = 62;
      pixels[p + 1] = 139;
      pixels[p + 2] = 171;
      pixels[p + 3] = 255;
    }
    if ((x - 84) ** 2 + (y - 114) ** 2 < 8 ** 2) {
      pixels[p] = 255;
      pixels[p + 1] = 255;
      pixels[p + 2] = 255;
      pixels[p + 3] = 255;
    }
  }
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(pixels)),
  chunk('IEND', Buffer.alloc(0)),
]);
await writeFile('dist/assets/icon.png', png);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
await writeFile('dist/assets/icon.ico', Buffer.concat([ico, png]));
