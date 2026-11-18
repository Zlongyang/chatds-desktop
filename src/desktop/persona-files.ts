import { randomUUID } from 'node:crypto';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { personaCardSchema } from '../shared/config.js';
import { exportPersonaJson, importPersonaJson } from '../shared/persona.js';
import type { PersonaCard } from '../shared/types.js';

type ImageCodec = Pick<
  typeof import('electron').nativeImage,
  'createFromBuffer' | 'createFromBitmap'
>;
export type CardFormat = 'png' | 'json';
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxPngBytes = 16 * 1024 * 1024;
const maxJsonBytes = 512 * 1024;
const maxPortraitBytes = 32 * 1024;
const cardKeys = ['ccv3', 'chara', 'ch'];
const visualChunks = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
const malformed = () => new Error('PNG 文件损坏，请重新选择角色卡。');

function parsePng(bytes: Buffer) {
  if (!bytes.subarray(0, 8).equals(pngSignature) || bytes.length > maxPngBytes) throw malformed();
  const pixels: Buffer[] = [pngSignature];
  const metadata = new Map<string, Buffer[]>();
  let width = 0;
  let height = 0;
  let hasPixels = false;
  let offset = 8;
  for (let count = 0; count < 8192 && offset + 12 <= bytes.length; count++) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (
      end > bytes.length ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      throw malformed();
    const data = bytes.subarray(offset + 8, end - 4);
    if (count === 0 && type !== 'IHDR') throw malformed();
    if (type === 'IHDR') {
      if (count !== 0 || length !== 13) throw malformed();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (!width || !height) throw malformed();
    }
    if (visualChunks.has(type)) pixels.push(bytes.subarray(offset, end));
    if (type === 'IDAT') hasPixels = true;
    if (type === 'tEXt' && length <= 4 * Math.ceil(maxJsonBytes / 3) + 6) {
      const split = data.subarray(0, 6).indexOf(0);
      const key = split > 0 ? data.toString('latin1', 0, split).toLowerCase() : '';
      if (cardKeys.includes(key)) {
        const entries = metadata.get(key) ?? [];
        entries.push(data.subarray(split + 1));
        metadata.set(key, entries);
      }
    }
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length || !hasPixels) throw malformed();
      return { pixels, width, height, metadata };
    }
    offset = end;
  }
  throw malformed();
}

function cardFromPng(metadata: Map<string, Buffer[]>, id: string): PersonaCard {
  for (const key of cardKeys) {
    for (const entry of metadata.get(key) ?? []) {
      try {
        let json: Buffer;
        if (key === 'ch' && entry.toString('utf8', 0, 32).trimStart().startsWith('{')) {
          json = entry;
        } else {
          const encoded = entry.toString('latin1').replace(/\s/g, '');
          if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
          json = Buffer.from(encoded, 'base64');
        }
        if (json.length <= maxJsonBytes) return parseWriting(json, id);
      } catch {
        // Some editors leave stale or unreadable duplicates next to a valid card.
      }
    }
  }
  throw new Error('PNG 中没有可用的酒馆角色卡资料，请检查角色名称、正文和文件格式。');
}

function parseWriting(bytes: Buffer, id: string) {
  const card = importPersonaJson(bytes.toString('utf8'), id);
  const result = personaCardSchema.safeParse(card);
  if (!result.success) throw new Error('角色卡资料过长或格式不正确，请缩短正文、名称或作者信息。');
  return result.data;
}

function thumbnail(png: ReturnType<typeof parsePng>, codec: ImageCodec): Buffer | undefined {
  // Inspect dimensions before handing any compressed pixel data to the native decoder.
  if (png.width > 8192 || png.height > 8192 || png.width * png.height > 12_000_000) return;
  const original = codec.createFromBuffer(Buffer.concat(png.pixels));
  if (original.isEmpty()) return;
  for (const maxSide of [96, 64]) {
    const ratio = Math.min(1, maxSide / Math.max(png.width, png.height));
    const size = {
      width: Math.max(1, Math.round(png.width * ratio)),
      height: Math.max(1, Math.round(png.height * ratio)),
    };
    const resized = ratio === 1 ? original : original.resize({ ...size, quality: 'good' });
    if (resized.isEmpty()) return;
    // Build a fresh PNG from only the visible pixels, including for images already small enough.
    const bitmap = resized.toBitmap();
    if (bitmap.length !== size.width * size.height * 4) return;
    if (!bitmap.some((value, index) => index % 4 === 3 && value !== 0)) return;
    const result = codec.createFromBitmap(bitmap, size).toPNG();
    if (result.length && result.length <= maxPortraitBytes) return result;
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}

function plainArtwork() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return [
    pngSignature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(5))),
    chunk('IEND', Buffer.alloc(0)),
  ];
}

export function decodePersonaFile(
  bytes: Buffer,
  format: CardFormat,
  id: string,
  codec: ImageCodec,
): PersonaCard {
  if (format === 'json') {
    if (bytes.length > maxJsonBytes) throw new Error('JSON 角色卡超过 512 KiB。');
    return parseWriting(bytes, id);
  }
  const png = parsePng(bytes);
  const card = cardFromPng(png.metadata, id);
  const portrait = thumbnail(png, codec);
  return portrait ? { ...card, portrait: portrait.toString('base64') } : card;
}

export function encodePersonaFile(
  card: PersonaCard,
  format: CardFormat,
  codec: ImageCodec,
): Buffer {
  const json = Buffer.from(exportPersonaJson(personaCardSchema.parse(card)), 'utf8');
  if (format === 'json') return json;
  let pixels = plainArtwork();
  if (card.portrait) {
    const bytes = Buffer.from(card.portrait, 'base64');
    if (bytes.length <= maxPortraitBytes) {
      const clean = thumbnail(parsePng(bytes), codec);
      if (clean) pixels = parsePng(clean).pixels;
    }
  }
  const encoded = json.toString('base64');
  // SillyTavern reads "chara" for V2, while DSH Tavern reads "ch".
  const writing = ['chara', 'ch'].map((key) =>
    chunk('tEXt', Buffer.from(key + '\0' + encoded, 'ascii')),
  );
  return Buffer.concat([...pixels.slice(0, -1), ...writing, pixels.at(-1)!]);
}

export function suggestedCardName(name: string, format: CardFormat) {
  const safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[ .]+$/g, '');
  return (
    (!safe || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe) ? '角色卡' : safe) +
    '.' +
    format
  );
}

export async function readPersonaFile(path: string, codec: ImageCodec): Promise<PersonaCard> {
  const ext = extname(path).toLowerCase();
  if (ext !== '.png' && ext !== '.json') throw new Error('请选择 .json 或 .png 角色卡。');
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    const limit = ext === '.png' ? maxPngBytes : maxJsonBytes;
    if (!info.isFile() || info.size > limit)
      throw new Error(
        ext === '.png'
          ? '请选择不超过 16 MiB 的 PNG 角色卡。'
          : '请选择不超过 512 KiB 的 JSON 角色卡。',
      );
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('角色卡内容已更改，请重新选择。');
      offset += bytesRead;
    }
    return decodePersonaFile(bytes, ext === '.png' ? 'png' : 'json', randomUUID(), codec);
  } finally {
    await file.close();
  }
}

export async function writePersonaFile(
  path: string,
  card: PersonaCard,
  format: CardFormat,
  codec: ImageCodec,
) {
  const bytes = encodePersonaFile(card, format, codec);
  const temporary = join(dirname(path), '.chatds-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
