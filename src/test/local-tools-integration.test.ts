import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RuntimeCore } from '../runtime/core.js';
import { Store } from '../runtime/store.js';
import { digest } from '../shared/util.js';
import { ToolBroker } from '../tools/broker.js';
import { DockerSandbox } from '../tools/docker.js';
import { SkillRegistry } from '../tools/skills.js';
import {
  FakeHost,
  assistant,
  envelope,
  removeTemporary,
  temporary,
  toolCall,
  until,
} from './helpers.js';

function fixture(t: TestContext) {
  const directory = temporary();
  const host = new FakeHost();
  host.config.conversations['desktop:owner'] = { mode: 'assistant', ambient: false, muted: false };
  host.config.tools.read_file = true;
  host.config.tools.write_file = true;
  const store = new Store(join(directory, 'chat.sqlite'));
  const skills = new SkillRegistry(join(directory, 'skills'));
  const broker = new ToolBroker(
    directory,
    () => host.config,
    skills,
    new DockerSandbox(() => host.config.sandbox, directory),
    (key) => host.sources.get(key),
    {
      call: async () => {
        throw new Error('Unexpected OneBot call in a desktop test');
      },
    },
  );
  host.register = async (id, sources, room) => {
    const run = broker.register(id, sources, room);
    host.runs.set(id, run);
    return run;
  };
  host.capabilities = (id) => broker.snapshot(id);
  host.tool = (id, tool, args, signal) => broker.execute(id, tool, args, signal);
  host.finish = async (id) => {
    broker.finish(id);
    host.runs.delete(id);
  };
  const core = new RuntimeCore(store, host.config, host, { timingScale: 0 });
  t.after(async () => {
    try {
      await core.close();
      assert.equal(broker.stats.runs, 0);
      assert.equal(broker.pendingApprovals.length, 0);
    } finally {
      removeTemporary(directory);
    }
  });
  function send(text: string) {
    const source = host.remember(envelope(text));
    core.ingest(source);
    return source;
  }
  return { directory, host, store, broker, skills, core, send };
}

function resultAfter(host: FakeHost, step: number, name: string, isError = false) {
  const result = host.requests[step]?.messages.findLast((message) => message.role === 'toolResult');
  assert.ok(result, `Missing tool result after ${name}`);
  assert.equal(result.toolName, name);
  assert.equal(result.isError, isError);
  const content = result.content[0];
  assert.ok(content?.type === 'text');
  return content.text;
}

test('the assistant receives SQLite memory results tied to an explicit user message', async (t) => {
  const { host, store, core, send } = fixture(t);
  host.steps.push(
    () => toolCall('memory_remember', { content: '模型自己添加的事实' }),
    () => toolCall('memory_search', { query: '柠檬茶' }),
    () => assistant('我记住了。'),
  );
  const source = send('记住：我喜欢柠檬茶');
  await core.idle();
  const facts = store.facts('person:owner');
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.content, '我喜欢柠檬茶');
  assert.deepEqual(facts[0]?.sourceIds, [source.id]);
  assert.deepEqual(JSON.parse(resultAfter(host, 1, 'memory_remember')), facts[0]);
  assert.deepEqual(JSON.parse(resultAfter(host, 2, 'memory_search')), facts);
});

test('an unrequested memory returns a tool error and leaves SQLite empty', async (t) => {
  const { host, store, core, send } = fixture(t);
  host.steps.push(
    () => toolCall('memory_remember', { content: 'fixture' }),
    () => assistant('好。'),
  );
  send('我们随便聊聊吧');
  await core.idle();
  assert.match(resultAfter(host, 1, 'memory_remember', true), /明确要求记住/);
  assert.deepEqual(store.facts(), []);
});

test('a skill listed in the model prompt loads its instructions and resource through the broker', async (t) => {
  const { directory, host, skills, core, send } = fixture(t);
  const source = join(directory, 'source');
  await mkdir(source);
  const main = '---\nname: tea-skill\ndescription: Tea instructions\n---\nRead recipe.txt.';
  await writeFile(join(source, 'SKILL.md'), main);
  await writeFile(join(source, 'recipe.txt'), 'Add lemon.');
  const skill = await skills.importDirectory(source);
  host.steps.push(
    () => toolCall('skills_load', { id: skill.id }),
    () => toolCall('skills_load', { id: skill.id, resource: 'recipe.txt' }),
    () => toolCall('skills_load', { id: skill.id, resource: 'missing.txt' }),
    () => assistant('用柠檬。'),
  );
  send('查一下茶的做法');
  await core.idle();
  const system = host.requests[0]?.messages.find((message) => message.role === 'system');
  assert.ok(typeof system?.content === 'string' && system.content.includes(skill.id));
  assert.equal(JSON.parse(resultAfter(host, 1, 'skills_load')).instruction, main);
  assert.equal(JSON.parse(resultAfter(host, 2, 'skills_load')).instruction, 'Add lemon.');
  assert.match(resultAfter(host, 3, 'skills_load', true), /技能或资源不可用/);
});

test('write approval and refusal are observable in both the workspace and the next model request', async (t) => {
  const { directory, host, broker, core, send } = fixture(t);
  const workspace = join(directory, 'workspaces', digest('person:owner').slice(0, 32));
  const path = 'memo.txt';
  const content = 'Reading this proves the write completed.';
  host.steps.push(
    () => toolCall('write_file', { path, content }),
    () => toolCall('read_file', { path }),
    () => toolCall('write_file', { path, content: 'rejected replacement' }),
    () => toolCall('read_file', { path: 'missing.txt' }),
    () => assistant('写入后已经读回。'),
  );
  send('写一份备忘录，然后读回来');
  for (const allow of [true, false]) {
    await until(() => broker.pendingApprovals.length === 1);
    const approval = broker.pendingApprovals[0]!;
    assert.equal(approval.tool, 'write_file');
    assert.deepEqual(JSON.parse(approval.detail), {
      path,
      content: allow ? content : 'rejected replacement',
    });
    broker.answer(approval.id, allow);
  }
  await core.idle();
  assert.deepEqual(JSON.parse(resultAfter(host, 1, 'write_file')), { saved: true, path });
  assert.equal(resultAfter(host, 2, 'read_file'), content);
  assert.match(resultAfter(host, 3, 'write_file', true), /没有获得此次操作的确认/);
  const missing = resultAfter(host, 4, 'read_file', true);
  assert.match(missing, /ENOENT/);
  assert.match(missing, /missing\.txt/);
  assert.ok(!missing.includes(directory), 'the model must only receive a workspace-relative path');
  assert.equal(await readFile(join(workspace, path), 'utf8'), content);
});

test('an unavailable workspace reports a relative path for reads and approved writes', async (t) => {
  const { directory, host, broker, core, send } = fixture(t);
  const blocked = join(directory, 'workspaces');
  await writeFile(blocked, 'fixture occupies the directory name');
  const path = 'note.txt';
  host.steps.push(
    () => toolCall('read_file', { path }),
    () => toolCall('write_file', { path, content: 'sample' }),
    () => assistant('工作区不可用。'),
  );
  send('读写工作区中的笔记');
  await until(() => broker.pendingApprovals.length === 1);
  broker.answer(broker.pendingApprovals[0]!.id, true);
  await core.idle();
  for (const [index, tool] of ['read_file', 'write_file'].entries()) {
    const message = resultAfter(host, index + 1, tool, true);
    assert.ok(message.includes(path));
    assert.ok(!message.includes(directory));
  }
  assert.equal(await readFile(blocked, 'utf8'), 'fixture occupies the directory name');
});
