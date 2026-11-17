import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { MessageDebouncer } from '../dist/runtime/debounce.js';
const meta = JSON.parse(await readFile('third_party/maibot/SOURCE.json', 'utf8'));
const source = (await readFile('third_party/maibot/controller.py', 'utf8')).replaceAll(
  '\r\n',
  '\n',
);
assert.equal(
  createHash('sha256').update(source).digest('hex'),
  meta.canonicalUtf8LfSha256,
  'Upstream reference changed',
);
let seed = 20261117;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
const cases = [];
for (const mode of ['fast', 'natural', 'steady'])
  for (let n = 0; n < 1000; n++) {
    let now = 100;
    const events = [];
    for (let i = 0; i < 40; i++) {
      now += i ? random() * 0.3 : 0;
      events.push({
        author: random() < 0.5 ? 'A' : 'B',
        bareImage: random() < 0.1,
        pureEmoji: random() < 0.1,
        mention: random() < 0.08,
        receivedAt: now,
        wallTime: now,
        now,
        mode,
      });
    }
    cases.push(events);
  }
const python = process.env.CHATDS_TEST_PYTHON || 'python';
const code = `import json,sys,types\nd=json.load(sys.stdin)\nm=types.ModuleType('reference');sys.modules['reference']=m\nexec(compile(d['source'],'controller.py','exec'),m.__dict__)\nresult=[]\nfor case in d['cases']:\n b=m.MessageDebouncer();row=[]\n for e in case:\n  b.observe(author=e['author'],is_bare_image=e['bareImage'],is_pure_emoji=e['pureEmoji'],at_bot=e['mention'],received_at=e['receivedAt'],wall_time=e['wallTime'],now=e['now'],mode=e['mode']);row.append(b.deadline)\n result.append(row)\nprint(json.dumps(result))\n`;
const processRef = spawn(python, ['-c', code], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PYTHONUTF8: '1' },
});
let stdout = '',
  stderr = '';
processRef.stdout.on('data', (b) => (stdout += b));
processRef.stderr.on('data', (b) => (stderr += b));
processRef.stdin.end(JSON.stringify({ source, cases }));
const result = await new Promise((resolve, reject) => {
  processRef.on('close', resolve);
  processRef.on('error', reject);
});
if (result !== 0) throw new Error(stderr);
const expected = JSON.parse(stdout);
let observations = 0;
for (const [index, events] of cases.entries()) {
  const actual = new MessageDebouncer();
  for (const [eventIndex, event] of events.entries()) {
    actual.observe(event);
    assert.ok(
      Math.abs(actual.deadline - expected[index][eventIndex]) < 1e-9,
      `Stream ${index}, event ${eventIndex}`,
    );
    observations++;
  }
}
console.log(
  JSON.stringify({
    ok: true,
    commit: meta.commit,
    streams: cases.length,
    observations,
    sourceHash: meta.canonicalUtf8LfSha256,
  }),
);
