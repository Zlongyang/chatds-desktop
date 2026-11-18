import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { locationFromFolder, locationFromLink } from '../desktop/napcat-location.js';

test('uses the selected NapCat config folder and connects only on loopback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'chatds-test-webui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cfg = join(root, 'config');
  await mkdir(cfg);
  const file = join(cfg, 'webui.json');
  const sample = { host: '0.0.0.0', port: 7088, token: 'fixture-only' };
  await writeFile(file, '\uFEFF' + JSON.stringify(sample));
  const expected = { origin: 'http://127.0.0.1:7088', token: 'fixture-only' };
  assert.deepEqual(await locationFromFolder(root), expected);
  assert.deepEqual(await locationFromFolder(cfg), expected);
  await writeFile(file, JSON.stringify({ ...sample, disableWebUI: true }));
  await assert.rejects(locationFromFolder(root), /开启 WebUI/);
  await writeFile(file, JSON.stringify({ ...sample, host: 'example.com' }));
  await assert.rejects(locationFromFolder(root), /无法识别/);
});

test('extracts only the local origin and token from a pasted WebUI link', () => {
  assert.deepEqual(locationFromLink('http://localhost:6099/webui?token=sample%2Bvalue'), {
    origin: 'http://127.0.0.1:6099',
    token: 'sample+value',
  });
  for (const input of [
    'http://example.com/?token=private-value',
    'http://127.0.0.1:6099/webui',
    'http://user@localhost/?token=private-value',
    'file:///etc/?token=private-value',
  ])
    assert.throws(
      () => locationFromLink(input),
      (e) => e instanceof Error && !e.message.includes('private-value'),
    );
});
