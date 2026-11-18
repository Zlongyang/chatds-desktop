import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, realpath, rename, writeFile, access, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { NapCatInstallation } from '../desktop/napcat-installation.js';
import { temporary, removeTemporary, until } from './helpers.js';
import { locationFromFolder } from '../desktop/napcat-location.js';

const offline = {
  platform: 'win32' as const,
  portInUse: async () => false,
  registeredQQ: async () => false,
  running: async () => false,
  startConsole: async () => {
    throw new Error('unexpected launcher');
  },
};

test('fresh install and empty config selection persist without opening QQ; moved and forgotten directories are recoverable', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const profile = join(dir, 'profile'),
    root = join(dir, 'NapCat.Shell'),
    config = join(root, 'config');
  await mkdir(config, { recursive: true });
  await writeFile(join(root, 'launcher-win10.bat'), 'fixture');
  await writeFile(join(root, 'napcat.mjs'), 'fixture');
  const store = new NapCatInstallation(profile, offline);
  assert.equal((await store.state()).directory, null);
  const fresh = await store.select(root);
  assert.equal(fresh.hasWebUIConfig, false);
  assert.equal(fresh.launcher, 'launcher-win10.bat');
  assert.deepEqual(await store.select(config), fresh);
  const restored = new NapCatInstallation(profile, offline);
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
  const store = new NapCatInstallation(join(dir, 'profile'), offline);
  await assert.rejects(store.select(root), /未找到/);
  await writeFile(join(root, 'NapCatInstaller.exe'), 'fixture');
  assert.match((await store.select(root)).guidance, /NapCatInstaller/);
  assert.equal((await store.ensureStarted()).status, 'manual');
  await assert.rejects(store.start(), /NapCatInstaller/);
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
  await writeFile(join(root, 'QQ.exe'), 'fixture, never execute');
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
    running: async () => false,
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
    assert.equal((await store.ensureStarted()).status, 'port-in-use');
    await assert.rejects(store.start(), /端口已在使用/);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
  assert.equal(starts, 0);
  const [first, second] = await Promise.allSettled([store.start(), store.start()]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(starts, 1);
  await assert.rejects(store.start(), /等待 WebUI/);
  await assert.rejects(new NapCatInstallation(profile, offline).start(), /等待 WebUI/);
  await store.clear();
  assert.deepEqual(await readdir(profile), []);
  await access(join(root, 'napcat.bat'));
});

test('Windows Shell launchers use registered QQ and the OS-matched non-elevated batch; cold starts join and survive restarts', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const shell = join(dir, 'user placed package');
  await mkdir(shell);
  for (const name of [
    'launcher-user.bat',
    'launcher-win10-user.bat',
    'launcher.bat',
    'launcher-win10.bat',
  ])
    await writeFile(
      join(shell, name),
      name.includes('-user') ? '@echo off' : 'powershell Start-Process cmd -Verb RunAs',
    );
  for (const filename of ['napcat.mjs', 'NapCatWinBootMain.exe', 'NapCatWinBootHook.dll'])
    await writeFile(join(shell, filename), 'fixture, never execute');
  for (const [build, expected] of [
    [19045, 'launcher-win10-user.bat'],
    [22631, 'launcher-user.bat'],
  ] as const) {
    let registered = false;
    const launched: string[] = [];
    const profile = join(dir, 'profile-' + build);
    const host = {
      ...offline,
      build,
      registeredQQ: async () => registered,
      startConsole: async (
        _cmd: string,
        args: string[],
        options: import('node:child_process').SpawnOptions,
      ) => {
        launched.push(args.at(-1)!);
        assert.equal(options.windowsHide, true);
        return 91011;
      },
    };
    const app = new NapCatInstallation(profile, host);
    assert.equal((await app.ensureStarted()).status, 'unconfigured');
    assert.equal((await app.select(shell)).status, 'missing-qq');
    assert.match((await app.ensureStarted()).guidance, /安装或修复 QQ NT/);
    assert.deepEqual(launched, []);
    registered = true;
    const checks = await Promise.all([app.ensureStarted(), app.ensureStarted()]);
    assert.deepEqual(
      checks.map((s) => s.status),
      ['starting', 'starting'],
    );
    assert.deepEqual(launched, ['.\\' + expected]);
    assert.equal((await new NapCatInstallation(profile, host).ensureStarted()).status, 'starting');
    // Beyond the startup grace period the known launcher's process can still be active.
    const file = join(profile, 'napcat-installation.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.launcherPid, 91011);
    await writeFile(file, JSON.stringify({ ...saved, launchedAt: Date.now() - 90_000 }));
    const restarted = new NapCatInstallation(profile, {
      ...host,
      running: async (_root, value) => value.launcherPid === 91011,
    });
    assert.equal((await restarted.ensureStarted()).status, 'starting');
    assert.equal(launched.length, 1);
  }
});

test('automatic startup leaves an elevated or installer batch to the user', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const shell = join(dir, 'shell');
  await mkdir(shell);
  const app = new NapCatInstallation(join(dir, 'profile'), offline);
  await writeFile(join(shell, 'launcher.bat'), '@echo off');
  assert.equal((await app.select(shell)).status, 'manual');
  for (const line of ['powershell Start-Process cmd -Verb runAs', 'NapCatInstaller.exe']) {
    await writeFile(join(shell, 'launcher-user.bat'), line);
    assert.equal((await app.ensureStarted()).status, 'manual');
  }
});

test('an external listener appearing during preflight prevents launch, and a failed spawn can be retried', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const root = join(dir, 'shell');
  await mkdir(root);
  for (const name of ['QQ.exe', 'napcat.bat']) await writeFile(join(root, name), 'fixture');
  let taken = false,
    conflict = false,
    fail = true,
    launches = 0;
  const store = new NapCatInstallation(join(dir, 'profile'), {
    ...offline,
    portInUse: async () => taken,
    running: async () => {
      if (conflict) taken = true;
      return false;
    },
    startConsole: async () => {
      launches++;
      if (fail) throw new Error('spawn failed');
    },
  });
  await store.select(root);
  conflict = true;
  assert.equal((await store.ensureStarted()).status, 'port-in-use');
  assert.equal(launches, 0);
  conflict = taken = false;
  assert.equal((await store.ensureStarted()).status, 'invalid');
  fail = false;
  assert.equal((await store.ensureStarted()).status, 'starting');
  assert.equal(launches, 2);
});

test('portable Node package inside a downloaded wrapper resolves its nested WebUI and includes its QQ runtime', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const wrapper = join(dir, 'downloads'),
    root = join(wrapper, 'NapCat.Shell.Windows.Node'),
    config = join(root, 'napcat', 'config');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'webui.json'), JSON.stringify({ port: 61234, token: 'fixture' }));
  await writeFile(join(root, 'napcat.bat'), '@echo off');
  const store = new NapCatInstallation(join(dir, 'profile'), offline);
  assert.equal((await store.select(wrapper)).status, 'missing-qq');
  for (const filename of ['node.exe', 'index.js', 'wrapper.node'])
    await writeFile(join(root, filename), 'fixture, never execute');
  const selected = await store.select(config);
  assert.equal(selected.directory, await realpath(root));
  assert.equal(selected.status, 'ready');
  assert.equal(selected.hasWebUIConfig, true);
  assert.deepEqual(await locationFromFolder(selected.directory!), {
    origin: 'http://127.0.0.1:61234',
    token: 'fixture',
  });
});

test(
  'the actual Windows startup invokes only the fixed harmless fixture batch inside the selected directory',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const dir = temporary();
    t.after(() => removeTemporary(dir));
    const root = join(dir, '安装 & 100% (A)');
    await mkdir(root);
    await writeFile(join(root, 'QQ.exe'), 'not an executable');
    await writeFile(join(root, 'napcat.bat'), '@echo off\r\necho fixture>started.txt\r\n');
    const store = new NapCatInstallation(join(dir, 'profile'), {
      ...offline,
      running: async () => {
        throw new Error('PowerShell process enumeration is disabled');
      },
      startConsole: undefined,
    });
    await store.select(root);
    assert.equal((await store.ensureStarted()).status, 'starting');
    const marker = join(root, 'started.txt');
    await until(() => existsSync(marker));
    assert.equal((await readFile(marker, 'utf8')).trim(), 'fixture');
  },
);

test('restricted Windows process enumeration uses the recorded live PID and still rechecks the WebUI port', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const root = join(dir, 'selection'),
    profile = join(dir, 'profile');
  await mkdir(root);
  await mkdir(profile);
  await writeFile(join(root, 'QQ.exe'), 'fixture');
  await writeFile(join(root, 'napcat.bat'), '@echo off');
  const canonical = await realpath(root);
  await writeFile(
    join(profile, 'napcat-installation.json'),
    JSON.stringify({
      directory: canonical,
      launcherPid: process.pid,
      launchedAt: Date.now() - 60000,
    }),
  );
  const restricted = {
    ...offline,
    running: async () => {
      throw new Error('Windows PowerShell unavailable');
    },
  };
  const restored = new NapCatInstallation(profile, restricted);
  assert.equal((await restored.ensureStarted()).status, 'starting');
  await restored.clear();
  let probes = 0;
  const occupiedDuringPreflight = new NapCatInstallation(profile, {
    ...restricted,
    portInUse: async () => ++probes === 3,
  });
  assert.equal((await occupiedDuringPreflight.select(root)).status, 'ready');
  assert.equal((await occupiedDuringPreflight.ensureStarted()).status, 'port-in-use');
  assert.equal(probes, 3);
});
