import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, realpath, rename, writeFile, access, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { NapCatInstallation } from '../desktop/napcat-installation.js';
import { temporary, removeTemporary } from './helpers.js';

test('fresh install and empty config selection persist without opening QQ; moved and forgotten directories are recoverable', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const profile = join(dir, 'profile'),
    root = join(dir, 'NapCat.Shell'),
    config = join(root, 'config');
  await mkdir(config, { recursive: true });
  await writeFile(join(root, 'launcher-win10.bat'), 'fixture');
  await writeFile(join(root, 'napcat.mjs'), 'fixture');
  const store = new NapCatInstallation(profile);
  assert.equal((await store.state()).directory, null);
  const fresh = await store.select(root);
  assert.equal(fresh.hasWebUIConfig, false);
  assert.equal(fresh.launcher, 'launcher-win10.bat');
  assert.deepEqual(await store.select(config), fresh);
  const restored = new NapCatInstallation(profile);
  assert.deepEqual(await restored.state(), fresh);
  assert.equal(fresh.directory, await realpath(root));
  const moved = join(dir, 'moved');
  await rename(root, moved);
  assert.match((await restored.state()).guidance, /重新选择/);
  assert.equal((await restored.state()).canStart, false);
  await assert.rejects(restored.start());
  assert.equal((await restored.clear()).directory, null);
  assert.equal((await new NapCatInstallation(profile).state()).directory, null);
  await access(join(moved, 'launcher-win10.bat'));
});

test('external configs and the uninstalled OneKey package provide guidance without executing an installer', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const root = join(dir, 'download'),
    config = join(dir, 'external', 'config');
  await mkdir(root);
  await mkdir(config, { recursive: true });
  const store = new NapCatInstallation(join(dir, 'profile'));
  await assert.rejects(store.select(root), /未找到/);
  await writeFile(join(root, 'NapCatInstaller.exe'), 'fixture');
  assert.match((await store.select(root)).guidance, /NapCatInstaller/);
  await assert.rejects(store.start(), /手动启动/);
  await writeFile(join(config, 'webui.json'), '{}');
  const external = await store.select(config);
  assert.equal(external.canStart, false);
  assert.equal(external.hasWebUIConfig, true);
});

test('only an explicit start uses the fixed batch name and sanitized environment; existing service and duplicate starts are blocked', async (t) => {
  const dir = temporary(),
    root = join(dir, 'NapCat & (100% test)'),
    config = join(root, 'config'),
    profile = join(dir, 'profile');
  t.after(() => removeTemporary(dir));
  await mkdir(config, { recursive: true });
  await writeFile(join(root, 'napcat.bat'), 'fixture, never execute');
  const listener = createServer((socket) => socket.end());
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address() as { port: number };
  await writeFile(
    join(config, 'webui.json'),
    JSON.stringify({ host: '127.0.0.1', port, token: 'fixture-only' }),
  );
  const privateKey = 'CHATDS_TEST_NAPCAT_PRIVATE';
  const previous = process.env[privateKey];
  process.env[privateKey] = 'fixture-only';
  t.after(() => {
    if (previous === undefined) delete process.env[privateKey];
    else process.env[privateKey] = previous;
  });
  let starts = 0;
  const expectedDirectory = await realpath(root);
  const store = new NapCatInstallation(profile, {
    platform: 'win32',
    async startConsole(command, args, options) {
      starts++;
      assert.match(command, /\\System32\\cmd\.exe$/i);
      assert.equal(args.at(-1), '.\\napcat.bat');
      assert(!args.join(' ').includes(root));
      assert.equal(options.cwd, expectedDirectory);
      assert.equal(options.env?.[privateKey], undefined);
      assert.equal(options.env?.NODE_OPTIONS, undefined);
      assert.equal(options.env?.ELECTRON_RUN_AS_NODE, undefined);
    },
  });
  await store.select(root);
  assert.equal(starts, 0);
  try {
    await assert.rejects(store.start(), /端口已在使用/);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
  assert.equal(starts, 0);
  const [first, second] = await Promise.allSettled([store.start(), store.start()]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(starts, 1);
  await assert.rejects(store.start(), /检查连接/);
  await assert.rejects(new NapCatInstallation(profile).start(), /检查连接/);
  await store.clear();
  assert.deepEqual(await readdir(profile), []);
  await access(join(root, 'napcat.bat'));
});
