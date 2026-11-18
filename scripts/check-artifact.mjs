import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, normalize, relative } from 'node:path';
import { listPackage, extractFile, statFile } from '@electron/asar';
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
const ownedFiles = new Set(
  readdirSync('dist', { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative('.', join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .filter((name) => !name.startsWith('dist/test/')),
);
let verifiedFiles = 0;
for (const name of names) {
  assert.ok(
    !/^dist\/test\//.test(name) &&
      !/(?:^|\/)(?:secrets\.bin|fish\.json|config\.local\.json|\.env(?:\.[^/]*)?|[^/]+\.(?:sqlite|db)(?:-wal|-shm)?)$/i.test(
        name,
      ),
    'Private or test file in artifact: ' + name,
  );
  const key = normalize(name);
  const entry = statFile(archive, key, false);
  if ('files' in entry || 'link' in entry) continue;
  const bytes = extractFile(archive, key);
  assert.equal(entry.integrity?.algorithm, 'SHA256', 'Missing SHA-256 in ASAR header: ' + name);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    entry.integrity.hash,
    'ASAR contents do not match the header: ' + name,
  );
  if (name.startsWith('dist/')) {
    assert.ok(ownedFiles.delete(name), 'Unexpected compiled file in ASAR: ' + name);
    assert.ok(bytes.equals(readFileSync(key)), 'Compiled output changed during packaging: ' + name);
  }
  verifiedFiles++;
}
assert.equal(
  ownedFiles.size,
  0,
  'Compiled output missing from ASAR: ' + [...ownedFiles].join(', '),
);
const pkg = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
assert.equal(pkg.license, 'GPL-3.0-only');
console.log(JSON.stringify({ ok: true, archive, packagedFiles: names.length, verifiedFiles }));
