import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { DockerSandbox } from '../dist/tools/docker.js';
import { defaultConfig } from '../dist/shared/config.js';
const directory = await mkdtemp(join(tmpdir(), 'chatds-test-docker-'));
const sandbox = new DockerSandbox(
  () => ({ ...defaultConfig().sandbox, timeoutMs: 4000 }),
  directory,
);
try {
  const status = await sandbox.check();
  assert.equal(status.available, true, status.reason);
  await sandbox.reap();
  await writeFile(join(directory, 'input.txt'), 'hello');
  const output = await sandbox.execute(
    directory,
    {
      language: 'python',
      code: "import os,socket\nprint(open('input.txt').read())\nassert os.getuid() == 10001\ntry:\n open('/etc/forbidden','w').write('x')\n raise AssertionError('writable root')\nexcept OSError: pass\ntry:\n socket.create_connection(('1.1.1.1',443),.3)\n raise AssertionError('network reachable')\nexcept OSError: pass\nopen('answer.txt','w').write('safe output')",
      outputs: ['answer.txt'],
    },
    new AbortController().signal,
  );
  assert.equal(output.exitCode, 0);
  assert.match(output.stdout, /hello/);
  assert.equal(output.outputs[0].text, 'safe output');
  assert.equal(await readFile(join(directory, 'input.txt'), 'utf8'), 'hello');
  assert.equal(sandbox.stats.containers, 0);
  await assert.rejects(
    sandbox.execute(
      directory,
      { language: 'javascript', code: 'while(true){}' },
      AbortSignal.timeout(500),
    ),
  );
  assert.equal(sandbox.stats.containers, 0);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/sandbox-real.json',
    JSON.stringify({
      ok: true,
      uid: 10001,
      rootReadOnly: true,
      networkBlocked: true,
      cancelledAndRemoved: true,
    }),
  );
  console.log('Real Docker isolation and cancellation passed');
} finally {
  await sandbox.close();
  assert.equal(dirname(await realpath(directory)), await realpath(tmpdir()));
  assert.ok(basename(directory).startsWith('chatds-test-docker-'));
  await rm(directory, { recursive: true, force: true });
}
