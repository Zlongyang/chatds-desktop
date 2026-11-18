import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { installNapCatPackage, NAPCAT_PACKAGE } from '../desktop/napcat-package.js';

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'chatds-test-napcat-package-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

test('import fails before extraction when size or contents do not match the pinned ZIP', async (t) => {
  const root = await fixture(t);
  const archive = join(root, 'wrong.zip');
  const data = join(root, 'app');
  await writeFile(archive, 'PK');
  await assert.rejects(installNapCatPackage(data, { archive }), /大小不匹配/);
  const f = await open(archive, 'r+');
  try {
    await f.truncate(NAPCAT_PACKAGE.size);
  } finally {
    await f.close();
  }
  await assert.rejects(installNapCatPackage(data, { archive }), /SHA-256/);
  assert.deepEqual(await readdir(join(data, 'napcat-packages')), []);
});

test('an existing unmanaged directory is left intact', async (t) => {
  const data = await fixture(t);
  const target = join(data, 'napcat-packages', NAPCAT_PACKAGE.version);
  await mkdir(join(target, 'config'), { recursive: true });
  await writeFile(join(target, 'config', 'onebot11_test.json'), 'existing account');
  await assert.rejects(installNapCatPackage(data), /已存在/);
  assert.equal(
    await readFile(join(target, 'config', 'onebot11_test.json'), 'utf8'),
    'existing account',
  );
});

test('next install reclaims only an abandoned and marked staging directory', async (t) => {
  const data = await fixture(t);
  const base = join(data, 'napcat-packages');
  const child = spawn(process.execPath, ['--version'], { stdio: 'ignore', windowsHide: true });
  await once(child, 'exit');
  const expired = '.install-' + child.pid + '-111111',
    unowned = '.install-' + child.pid + '-222222',
    live = '.install-' + process.pid + '-333333';
  for (const name of [expired, unowned, live]) await mkdir(join(base, name), { recursive: true });
  for (const name of [expired, live])
    await writeFile(join(base, name, '.chatds-package.sha256'), NAPCAT_PACKAGE.sha256 + '\n');
  await assert.rejects(
    installNapCatPackage(data, { archive: join(data, 'missing.zip') }),
    /请选择/,
  );
  assert.deepEqual((await readdir(base)).sort(), [unowned, live].sort());
});

test('a redirected managed directory is rejected', async (t) => {
  const outer = await fixture(t);
  const data = join(outer, 'app'),
    outside = join(outer, 'outside');
  await mkdir(data);
  await mkdir(outside);
  await symlink(
    outside,
    join(data, 'napcat-packages'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(installNapCatPackage(data), /重定向/);
  assert.deepEqual(await readdir(outside), []);
});

test('unsafe redirects are rejected before contacting another destination', async (t) => {
  const data = await fixture(t);
  const request = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/file.zip' } }),
  );
  await assert.rejects(installNapCatPackage(data), /不受信任/);
  assert.equal(request.mock.callCount(), 1);
});

test('unavailable mirror link falls back to the fixed GitHub asset with the same size guard', async (t) => {
  const data = await fixture(t);
  const hosts: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    hosts.push(url.hostname);
    return hosts.length === 1
      ? new Response(null, { status: 503 })
      : new Response('x', { headers: { 'content-length': '1' } });
  });
  await assert.rejects(installNapCatPackage(data), /大小/);
  assert.deepEqual(hosts, ['github.com', 'api.github.com']);
  assert.deepEqual(await readdir(join(data, 'napcat-packages')), []);
});

test('concurrent downloads are refused and cancellation releases the install slot', async (t) => {
  const data = await fixture(t);
  const aborter = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  t.mock.method(
    globalThis,
    'fetch',
    (_url: unknown, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        ready();
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
          once: true,
        });
      }),
  );
  const active = installNapCatPackage(data, { signal: aborter.signal });
  await started;
  await assert.rejects(installNapCatPackage(data), /正在进行/);
  aborter.abort();
  await assert.rejects(active, { name: 'AbortError' });
  const archive = join(data, 'bad.zip');
  await writeFile(archive, 'bad');
  await assert.rejects(installNapCatPackage(data, { archive }), /大小不匹配/);
  assert.deepEqual(await readdir(join(data, 'napcat-packages')), []);
});

// The release archive is intentionally supplied by the operator, never redistributed by ChatDS.
test(
  'the authentic archive installs offline and preserves existing WebUI and account configuration',
  { skip: !process.env.CHATDS_TEST_NAPCAT_ZIP },
  async (t) => {
    const data = await fixture(t);
    const archive = process.env.CHATDS_TEST_NAPCAT_ZIP!;
    const samples: number[] = [];
    const where = await installNapCatPackage(data, {
      archive,
      onProgress: (bytes) => samples.push(bytes),
    });
    assert.equal(where, join(data, 'napcat-packages', NAPCAT_PACKAGE.version));
    assert.equal(samples.at(-1), NAPCAT_PACKAGE.size);
    for (const name of ['launcher.bat', 'launcher-win10.bat', 'napcat.mjs'])
      assert.ok((await readFile(join(where, name))).length);
    const web = JSON.parse(await readFile(join(where, 'config', 'webui.json'), 'utf8'));
    assert.equal(web.host, '127.0.0.1');
    assert.ok(web.port > 0 && web.port <= 65535);
    assert.match(web.token, /^[a-f0-9]{48}$/);
    assert.equal(web.disableWebUI, false);
    const account = join(where, 'config', 'onebot11_test.json');
    await writeFile(account, 'existing account');
    const before = await readFile(join(where, 'config', 'webui.json'), 'utf8');
    assert.equal(await installNapCatPackage(data, { archive: join(data, 'gone.zip') }), where);
    assert.equal(await readFile(account, 'utf8'), 'existing account');
    assert.equal(await readFile(join(where, 'config', 'webui.json'), 'utf8'), before);
    assert.deepEqual(await readdir(join(data, 'napcat-packages')), [NAPCAT_PACKAGE.version]);
  },
);
