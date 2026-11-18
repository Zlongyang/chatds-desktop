import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import {
  decodePersonaFile,
  encodePersonaFile,
  readPersonaFile,
  suggestedCardName,
  writePersonaFile,
} from '../desktop/persona-files.js';

const card = {
  id: 'test',
  name: '小雨',
  description: '喜欢小池塘。',
  personality: '',
  examples: '',
  avatar: '🐟',
};
type Codec = Parameters<typeof decodePersonaFile>[3];
const neverDecode: Codec = {
  createFromBuffer() {
    throw new Error('Unexpected native image decode');
  },
  createFromBitmap() {
    throw new Error('Unexpected bitmap conversion');
  },
};
const generated = encodePersonaFile(card, 'png', neverDecode);
function chunks(bytes: Buffer) {
  const result: { type: string; data: Buffer }[] = [];
  for (let i = 8; i < bytes.length;) {
    const length = bytes.readUInt32BE(i);
    result.push({
      type: bytes.toString('ascii', i + 4, i + 8),
      data: bytes.subarray(i + 8, i + length + 8),
    });
    i += 12 + length;
  }
  return result;
}
function png(parts: ReturnType<typeof chunks>) {
  return Buffer.concat([
    generated.subarray(0, 8),
    ...parts.map(({ type, data }) => {
      const size = Buffer.alloc(4),
        sum = Buffer.alloc(4),
        body = Buffer.concat([Buffer.from(type), data]);
      size.writeUInt32BE(data.length);
      sum.writeUInt32BE(crc32(body));
      return Buffer.concat([size, body, sum]);
    }),
  ]);
}
const visual = chunks(generated).filter((c) => c.type !== 'tEXt');
const clean = png(visual);
function writing(key: string, name: string) {
  const text = JSON.stringify({
    data: {
      name,
      description: '你好',
      system_prompt: 'PRIVATE OVERRIDE',
      extensions: { path: 'C:/secret.txt' },
    },
  });
  return { type: 'tEXt', data: Buffer.from(key + '\0' + Buffer.from(text).toString('base64')) };
}
const noPicture = {
  ...neverDecode,
  createFromBuffer: () => ({ isEmpty: () => true }),
} as unknown as Codec;

test('exports one DSH and one standard V2 chunk with identical writing, independent of the local card id', () => {
  const texts = chunks(generated)
    .filter((c) => c.type === 'tEXt')
    .map((c) => c.data.toString().split('\0'));
  assert.deepEqual(
    texts.map((t) => t[0]),
    ['chara', 'ch'],
  );
  assert.equal(texts[0]![1], texts[1]![1]);
  const json = encodePersonaFile(card, 'json', neverDecode);
  assert.equal(Buffer.from(texts[0]![1]!, 'base64').toString(), json.toString());
  assert.equal(JSON.parse(json.toString()).data.name, card.name);
  assert.equal(decodePersonaFile(json, 'json', 'new-id', neverDecode).id, 'new-id');
});

test('prefers first usable CCV3, then standard V2 then DSH, and strips prompt overrides', () => {
  const entries = [
    writing('ch', 'DSH'),
    writing('CHARA', 'V2'),
    writing('ccv3', 'V3'),
    writing('ccv3', 'Stale'),
  ];
  for (const [length, name] of [
    [4, 'V3'],
    [2, 'V2'],
    [1, 'DSH'],
  ] as const) {
    const bytes = png([
      ...visual.slice(0, -1),
      { type: 'tEXt', data: Buffer.from('ccv3\0?') },
      ...entries.slice(0, length),
      visual.at(-1)!,
    ]);
    const imported = decodePersonaFile(bytes, 'png', 'new', noPicture);
    assert.equal(imported.name, name);
    assert.doesNotMatch(JSON.stringify(imported), /PRIVATE OVERRIDE|secret\.txt/);
  }
  assert.throws(() => decodePersonaFile(clean, 'png', 'id', neverDecode), /没有可用/);
});

test('artwork excludes foreign chunks, is recreated from pixels, and transparent placeholders keep their emoji', () => {
  const bytes = png([
    ...chunks(generated).slice(0, -1),
    { type: 'zTXt', data: Buffer.from('private comment') },
    visual.at(-1)!,
  ]);
  let alpha = 255;
  const codec = {
    createFromBuffer: (data: Buffer) => {
      assert.deepEqual(data, clean);
      return { isEmpty: () => false, toBitmap: () => Buffer.from([0, 0, 0, alpha]) };
    },
    createFromBitmap: (_bitmap: Buffer, size: object) => {
      assert.deepEqual(size, { width: 1, height: 1 });
      return { toPNG: () => clean };
    },
  } as unknown as Codec;
  const imported = decodePersonaFile(bytes, 'png', 'new', codec);
  assert.equal(imported.portrait, clean.toString('base64'));
  const exported = encodePersonaFile(
    { ...imported, portrait: bytes.toString('base64') },
    'png',
    codec,
  );
  assert.deepEqual(
    chunks(exported).map((c) => c.type),
    ['IHDR', 'IDAT', 'tEXt', 'tEXt', 'IEND'],
  );
  alpha = 0;
  const transparent = decodePersonaFile(bytes, 'png', 'new', codec);
  assert.equal(transparent.portrait, undefined);
  assert.equal(transparent.avatar, card.avatar);
});

test('keeps writing from oversized artwork without invoking the decoder and detects truncation and CRC damage', () => {
  const parts = chunks(generated);
  const header = Buffer.from(parts[0]!.data);
  header.writeUInt32BE(7000);
  header.writeUInt32BE(7000, 4);
  const large = png([{ type: 'IHDR', data: header }, ...parts.slice(1)]);
  assert.equal(decodePersonaFile(large, 'png', 'new', neverDecode).name, card.name);
  assert.throws(
    () => decodePersonaFile(generated.subarray(0, -1), 'png', 'id', neverDecode),
    /损坏/,
  );
  const damaged = Buffer.from(generated);
  damaged[30] = damaged[30]! ^ 1;
  assert.throws(() => decodePersonaFile(damaged, 'png', 'id', neverDecode), /损坏/);
  assert.throws(
    () => decodePersonaFile(Buffer.alloc(512 * 1024 + 1), 'json', 'id', neverDecode),
    /512 KiB/,
  );
});

test('imports selected local files with independent ids and atomically replaces the requested export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatds-persona-files-'));
  try {
    const path = join(directory, 'card.json');
    await writeFile(path, 'old');
    await writePersonaFile(path, card, 'json', neverDecode);
    const first = await readPersonaFile(path, neverDecode);
    assert.notEqual(first.id, (await readPersonaFile(path, neverDecode)).id);
    assert.equal(first.name, card.name);
    assert.deepEqual(await readdir(directory), ['card.json']);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).spec, 'chara_card_v2');
    assert.equal(suggestedCardName('CON', 'json'), '角色卡.json');
    assert.equal(suggestedCardName('..\\A/B.', 'png'), '.._A_B.png');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
