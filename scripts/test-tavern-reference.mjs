import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importPersonaJson, exportPersonaJson } from '../dist/shared/persona.js';

const source = process.argv[2];
if (!source) throw new Error('Pass the checkout of 2380557712/dsh-tavern at b495df2.');
const compiled = resolve(source, 'packages/tavern-toolkit/lib/types/cards.js');
const bytes = await readFile(compiled);
assert.equal(
  createHash('sha256').update(bytes).digest('hex'),
  '12811e1f010fbd479bddfdced2360b3d6fc48aeec192827c43d957c90342da3c',
);
const original = await import(pathToFileURL(compiled));
const fixture = await readFile(join(source, 'examples/amy.json'), 'utf8');
const fields = original.normalizeStCard(JSON.parse(fixture));
const png = original.embedCardJson(undefined, original.serializeStCard(fields));
const originalText = original.cardJsonFromPng(png)?.jsonText;
assert.ok(originalText);
const imported = importPersonaJson(originalText, 'reference');
assert.equal(imported.name, fields.name);
assert.equal(imported.greeting, fields.firstMes);
const back = original.normalizeStCard(JSON.parse(exportPersonaJson(imported)));
for (const key of [
  'name',
  'description',
  'persona',
  'scenario',
  'firstMes',
  'exampleMes',
  'creator',
]) {
  assert.equal(back[key], fields[key], key);
}
console.log('DSH Tavern original JSON → original PNG → ChatDS → original reader passed.');
