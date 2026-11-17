import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, writeFile, readFile, symlink, link, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ToolBroker } from '../tools/broker.js';
import { SkillRegistry } from '../tools/skills.js';
import type { DockerSandbox } from '../tools/docker.js';
import { workspacePath, readWorkspace, writeWorkspace } from '../tools/workspace.js';
import { publicAddress } from '../tools/web.js';
import { defaultConfig } from '../shared/config.js';
import { digest, id } from '../shared/util.js';
import { envelope, temporary, removeTemporary, until } from './helpers.js';
test('approval revocation prevents file effect and releases pending confirmations', async (t) => {
  const directory = temporary();
  t.after(() => removeTemporary(directory));
  const c = defaultConfig();
  c.conversations['desktop:owner'] = { mode: 'assistant', ambient: false, muted: false };
  c.tools.write_file = true;
  const source = envelope('请写一个文件');
  const broker = new ToolBroker(
    directory,
    () => c,
    new SkillRegistry(join(directory, 'skills')),
    { state: { available: false } } as DockerSandbox,
    (key) => (key === source.id ? source : undefined),
    {
      call: async () => {
        throw new Error('No QQ in tests');
      },
    },
  );
  const run = broker.register(id(), [source.id], source.conversationId);
  const pending = broker.execute(run.id, 'write_file', { path: 'test.txt', content: 'x' });
  await until(() => broker.pendingApprovals.length === 1);
  c.tools.write_file = false;
  c.revision++;
  broker.permissionsChanged();
  await assert.rejects(pending);
  assert.equal(broker.pendingApprovals.length, 0);
  assert.equal(
    existsSync(join(directory, 'workspaces', digest('person:owner').slice(0, 32), 'test.txt')),
    false,
  );
  broker.finish(run.id);
  assert.equal(broker.stats.runs, 0);
});
test('approved exact action writes only its own workspace and cannot forge identity in arguments', async (t) => {
  const directory = temporary();
  t.after(() => removeTemporary(directory));
  const c = defaultConfig();
  c.conversations['desktop:owner'] = { mode: 'assistant', ambient: false, muted: false };
  c.tools.write_file = true;
  const source = envelope('写文件');
  const broker = new ToolBroker(
    directory,
    () => c,
    new SkillRegistry(join(directory, 'skills')),
    { state: { available: false } } as DockerSandbox,
    (key) => (key === source.id ? source : undefined),
    { call: async () => ({}) },
  );
  const run = broker.register(id(), [source.id], source.conversationId);
  await assert.rejects(
    broker.execute(run.id, 'write_file', { path: 'hello.txt', content: 'hello', actorId: 'owner' }),
  );
  const pending = broker.execute(run.id, 'write_file', { path: 'hello.txt', content: 'hello' });
  await until(() => broker.pendingApprovals.length === 1);
  const view = broker.pendingApprovals[0]!;
  assert.ok(view.detail.includes('hello.txt'));
  broker.answer(view.id, true);
  await pending;
  const workspace = join(directory, 'workspaces', digest('person:owner').slice(0, 32));
  assert.equal(await readFile(join(workspace, 'hello.txt'), 'utf8'), 'hello');
  const attack = broker.execute(run.id, 'write_file', { path: '../outside.txt', content: 'x' });
  await until(() => broker.pendingApprovals.length === 1);
  broker.answer(broker.pendingApprovals[0]!.id, true);
  await assert.rejects(attack, /越过/);
  assert.equal(existsSync(join(directory, 'outside.txt')), false);
  broker.finish(run.id);
});
test('workspace guards reject traversal, absolute paths, junctions and hard links', async (t) => {
  const directory = temporary();
  t.after(() => removeTemporary(directory));
  const root = join(directory, 'work'),
    outside = join(directory, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'not for this room');
  for (const p of [
    '../outside/secret.txt',
    'C:\\secret',
    '/etc/passwd',
    'a:stream',
    'a\\..\\secret',
  ])
    await assert.rejects(workspacePath(root, p));
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readWorkspace(root, 'escape/secret.txt'), /链接|越过/);
  await link(join(outside, 'secret.txt'), join(root, 'hard.txt'));
  await assert.rejects(readWorkspace(root, 'hard.txt'), /硬链接/);
});
test('web address classification denies all non-public ranges including mapped IPv6', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '224.0.0.1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('1.1.1.1'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('revocation at write commit leaves neither a file nor a temporary payload', async (t) => {
  const directory = temporary();
  t.after(() => removeTemporary(directory));
  await assert.rejects(
    writeWorkspace(directory, 'file.txt', 'private synthetic payload', () => {
      throw new Error('revoked');
    }),
    /revoked/,
  );
  assert.deepEqual(await readdir(directory), []);
});
test('skill import is snapshot based, blocks unregistered paths and tampered resources', async (t) => {
  const directory = temporary();
  t.after(() => removeTemporary(directory));
  const source = join(directory, 'sample');
  await mkdir(join(source, 'references'), { recursive: true });
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: tiny-skill\ndescription: >\n  A useful test skill.\n---\nRead references/note.txt.',
  );
  await writeFile(join(source, 'references', 'note.txt'), 'original');
  const registry = new SkillRegistry(join(directory, 'skills'));
  const imported = await registry.importDirectory(source);
  assert.equal((await registry.list()).length, 1);
  assert.match(await registry.load(imported.id), /useful/);
  assert.equal(await registry.load(imported.id, 'references/note.txt'), 'original');
  await assert.rejects(registry.load(imported.id, '../../secrets.bin'));
  await writeFile(join(registry.root, imported.id, 'references', 'note.txt'), 'changed');
  await assert.rejects(registry.load(imported.id, 'references/note.txt'), /变更/);
  await registry.remove(imported.id);
  assert.equal((await registry.list()).length, 0);
});
