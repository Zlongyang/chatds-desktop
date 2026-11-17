import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
const forbiddenNames =
  /^(?:secrets\.bin|config\.local\.json|local-credentials\.json|api-key\.dpapi|fish\.json|\.env(?:\..*)?|.*\.(?:sqlite|db)(?:-wal|-shm)?)$/i;
const forbiddenContent = /(?:[A-Z]:[\\/]+Codestudy[\\/]|sk-[A-Za-z0-9_-]{24,})/;
const files = [];
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === 'test') continue;
    const file = join(directory, item.name);
    if (forbiddenNames.test(item.name)) throw new Error('Private file in package: ' + file);
    if (item.isSymbolicLink()) throw new Error('Unexpected link in build: ' + file);
    if (item.isDirectory()) await walk(file);
    else {
      files.push(file);
      if (
        /\.(?:js|cjs|html|css|json|map)$/.test(file) &&
        forbiddenContent.test(await readFile(file, 'utf8'))
      )
        throw new Error('Potential private content: ' + file);
    }
  }
}
await walk('dist');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.build.extraResources) throw new Error('Review extraResources before shipping');
if (pkg.license !== 'GPL-3.0-only') throw new Error('Review license before shipping');
for (const path of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await stat(path);
console.log(JSON.stringify({ ok: true, ownedBuildFiles: files.length, extraResources: 0 }));
