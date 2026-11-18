import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { DockerApi, DockerSandbox } from '../dist/tools/docker.js';
import { packTar } from '../dist/tools/archive.js';
import { defaultConfig } from '../dist/shared/config.js';
const directory = await mkdtemp(join(tmpdir(), 'chatds-test-docker-'));
const api = new DockerApi();
const sandbox = new DockerSandbox(
  () => ({ ...defaultConfig().sandbox, timeoutMs: 15000 }),
  directory,
  api,
);
const ownedContainers = () =>
  api.json(
    'GET',
    '/containers/json?all=1&filters=' +
      encodeURIComponent(
        JSON.stringify({ label: ['org.chatds.owner=' + sandbox.owner, 'org.chatds.job=1'] }),
      ),
    undefined,
    AbortSignal.timeout(3000),
  );
async function runningContainer() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const container = (await ownedContainers()).find((row) => row.State === 'running');
    if (container) return container;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('Container did not reach running state');
}
try {
  const status = await sandbox.check();
  assert.equal(status.available, true, status.reason);
  await sandbox.reap();
  await writeFile(join(directory, 'input.txt'), 'hello');
  const output = await sandbox.execute(
    directory,
    {
      language: 'python',
      code: `import os, socket
print(open('input.txt').read())
assert os.getuid() == 10001
mounts = [line.split() for line in open('/proc/self/mounts')]
assert any(path == '/' and 'ro' in opts.split(',') for _, path, _, opts, *_ in mounts)
assert os.listdir('/sys/class/net') == ['lo']
try:
    socket.create_connection(('1.1.1.1', 443), .3)
    raise AssertionError('network reachable')
except OSError:
    pass
open('answer.txt', 'w').write('safe output')`,
      outputs: ['answer.txt'],
    },
    new AbortController().signal,
  );
  assert.equal(output.exitCode, 0, output.stderr);
  assert.match(output.stdout, /hello/);
  assert.equal(output.outputs[0].text, 'safe output');
  assert.equal(await readFile(join(directory, 'input.txt'), 'utf8'), 'hello');
  await assert.rejects(readFile(join(directory, 'answer.txt')), { code: 'ENOENT' });
  assert.equal(sandbox.stats.containers, 0);
  const jsJob = sandbox.execute(
    directory,
    {
      language: 'javascript',
      code: `const fs = require('node:fs');
const timer = setInterval(() => {
  if (!fs.existsSync('resume.txt')) return;
  clearInterval(timer);
  fs.writeFileSync('js.txt', 'abc');
  console.log('JS');
  console.error('exit 5');
  process.exitCode = 5;
}, 50);`,
      outputs: ['js.txt'],
    },
    new AbortController().signal,
  );
  const [js] = await Promise.all([
    jsJob,
    (async () => {
      const running = await runningContainer();
      assert.equal((await sandbox.check()).available, true);
      await sandbox.reap();
      assert.ok(
        (await ownedContainers()).some((row) => row.Id === running.Id && row.State === 'running'),
      );
      await api.request(
        'PUT',
        `/containers/${running.Id}/archive?path=/workspace`,
        packTar([{ name: 'resume.txt', data: Buffer.from('ok') }]),
        AbortSignal.timeout(3000),
      );
    })(),
  ]);
  assert.equal(js.exitCode, 5);
  assert.equal(js.stdout.trim(), 'JS');
  assert.equal(js.stderr.trim(), 'exit 5');
  assert.deepEqual(js.outputs, [
    {
      path: 'js.txt',
      bytes: 3,
      text: 'abc',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
  ]);
  const controller = new AbortController();
  const cancelled = assert.rejects(
    sandbox.execute(
      directory,
      { language: 'javascript', code: 'setInterval(() => {}, 1000)' },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  try {
    await runningContainer();
  } finally {
    controller.abort();
    await cancelled;
  }
  assert.equal(sandbox.stats.containers, 0);
  assert.deepEqual(await ownedContainers(), []);
  await mkdir('test-results', { recursive: true });
  await writeFile(
    'test-results/sandbox-real.json',
    JSON.stringify({
      ok: true,
      uid: 10001,
      rootReadOnly: true,
      networkBlocked: true,
      javascriptAndPython: true,
      outputChecksumVerified: true,
      runningJobSurvivedRecheck: true,
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
