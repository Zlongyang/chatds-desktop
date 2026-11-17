import assert from 'node:assert/strict';
import { listPackage, extractFile } from '@electron/asar';
const archive = 'release/win-unpacked/resources/app.asar';
const names = listPackage(archive).map((s) => s.replaceAll('\\', '/').replace(/^\//, ''));
for (const required of [
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'dist/desktop/main.js',
  'dist/desktop/preload.cjs',
  'dist/runtime/worker.js',
  'dist/renderer/index.html',
])
  assert.ok(names.includes(required), 'Missing ' + required);
for (const name of names)
  assert.ok(
    !/^dist\/test\//.test(name) &&
      !/(?:^|\/)(?:secrets\.bin|fish\.json|config\.local\.json|\.env(?:\.[^/]*)?|[^/]+\.(?:sqlite|db)(?:-wal|-shm)?)$/i.test(
        name,
      ),
    'Private or test file in artifact: ' + name,
  );
const pkg = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
assert.equal(pkg.license, 'GPL-3.0-only');
console.log(JSON.stringify({ ok: true, archive, packagedFiles: names.length }));
