import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../shared/config.js';
import { capabilities, toolDenial } from '../runtime/policy.js';
import { Store, memoryScope } from '../runtime/store.js';
import { MemoryWorker } from '../runtime/memory.js';
import { envelope, FakeHost, assistant } from './helpers.js';
import { stableDay } from '../shared/util.js';
import type { RunContext } from '../shared/types.js';
test('policy intersects mode, owner, channel, trigger, enable flag and sandbox availability', () => {
  const c = defaultConfig();
  c.tools.sandbox_exec = true;
  const r: RunContext = {
    id: 'r',
    conversationId: 'desktop:owner',
    actorId: 'owner',
    channel: 'desktop',
    isGroup: false,
    trigger: 'direct',
    sourceIds: [],
    mode: 'companion',
    startedAt: 0,
  };
  assert.match(toolDenial(c, r, 'sandbox_exec')!, /陪伴/);
  c.conversations[r.conversationId] = { mode: 'assistant', ambient: false, muted: false };
  r.mode = 'assistant';
  assert.match(toolDenial(c, r, 'sandbox_exec', false)!, /Docker/);
  assert.equal(toolDenial(c, r, 'sandbox_exec', true), undefined);
  r.isGroup = true;
  assert.match(toolDenial(c, r, 'sandbox_exec')!, /群聊/);
  r.isGroup = false;
  r.actorId = 'qq:20002';
  assert.match(toolDenial(c, r, 'sandbox_exec')!, /主号/);
  assert.equal(
    capabilities(c, r, [], true).tools.some((t) => t.id === 'sandbox_exec'),
    false,
  );
});
test('automatic memory requires matching source, exact quote and subject; corrections remain scoped', async (t) => {
  const store = new Store(':memory:'),
    host = new FakeHost();
  const worker = new MemoryWorker(
    store,
    () => host.config,
    host,
    () => {},
    () => {},
  );
  t.after(async () => {
    await worker.close();
    store.close();
  });
  const a = envelope('我喜欢蓝色'),
    b = envelope('他说他喜欢红色', {
      actorId: 'qq:20002',
      conversationId: 'onebot:group:30003',
      isGroup: true,
      quoted: { actorId: 'qq:40004', text: '喜欢红色' },
    });
  store.ingest(a);
  store.ingest(b);
  const facts = [
    { sourceId: a.id, quote: '我喜欢蓝色', content: '我喜欢蓝色', kind: 'preference' as const },
    { sourceId: a.id, quote: '我喜欢红色', content: '我喜欢红色', kind: 'preference' as const },
  ];
  assert.equal(worker.apply(memoryScope(a), 'owner', [a], facts).length, 1);
  assert.equal(worker.apply(memoryScope(a), 'qq:20002', [a], facts).length, 0);
  assert.equal(
    worker.apply(
      memoryScope(b),
      b.actorId,
      [b],
      [{ sourceId: b.id, quote: b.text, content: '他喜欢红色', kind: 'preference' }],
    ).length,
    0,
  );
  const correction = envelope('现在不喜欢蓝色了，我喜欢绿色');
  store.ingest(correction);
  const old = store.facts('person:owner')[0]!;
  worker.apply(
    'person:owner',
    'owner',
    [correction],
    [
      {
        sourceId: correction.id,
        quote: correction.text,
        content: '我喜欢绿色，不再喜欢蓝色',
        kind: 'preference',
        replaces: old.id,
      },
    ],
  );
  assert.equal(store.facts('person:owner').length, 1);
  assert.ok(store.facts('person:owner')[0]!.content.includes('绿色'));
  assert.equal(
    worker.apply(
      memoryScope(a),
      'owner',
      [a],
      [
        {
          sourceId: a.id,
          quote: a.text,
          content: '我喜欢其他东西',
          kind: 'preference',
          replaces: 'other-scope-id',
        },
      ],
    ).length,
    0,
  );
});

test('one background call handles several group actors with provenance and accounts actual usage', async (t) => {
  const store = new Store(':memory:'),
    host = new FakeHost();
  host.config.memory.automatic = true;
  const worker = new MemoryWorker(
    store,
    () => host.config,
    host,
    () => {},
    () => {},
  );
  t.after(async () => {
    await worker.close();
    store.close();
  });
  const a = host.remember(
      envelope('我喜欢蓝色', {
        conversationId: 'onebot:group:30003',
        channel: 'onebot',
        isGroup: true,
        actorId: 'qq:20002',
      }),
    ),
    b = host.remember(
      envelope('我喜欢绿色', {
        conversationId: a.conversationId,
        channel: 'onebot',
        isGroup: true,
        actorId: 'qq:40004',
      }),
    );
  store.ingest(a);
  store.ingest(b);
  host.steps.push(() =>
    assistant(
      JSON.stringify({
        facts: [a, b].map((m) => ({
          sourceId: m.id,
          quote: m.text,
          content: m.text,
          kind: 'preference',
        })),
      }),
    ),
  );
  worker.enqueue([a, b]);
  await worker.drain();
  assert.equal(host.requests.length, 1);
  assert.deepEqual(
    store
      .facts(memoryScope(a))
      .map((f) => f.subject)
      .sort(),
    ['qq:20002', 'qq:40004'],
  );
  assert.equal(store.usage(stableDay()).background, 120);
  assert.equal(host.runs.size, 0);
  assert.equal(store.memoryJobs().length, 0);
});

test('background budget prevents provider calls and preserves queued work', async (t) => {
  const store = new Store(':memory:'),
    host = new FakeHost();
  host.config.memory.automatic = true;
  host.config.memory.dailyTokenBudget = 1;
  const worker = new MemoryWorker(
    store,
    () => host.config,
    host,
    () => {},
    () => {},
  );
  t.after(async () => {
    await worker.close();
    store.close();
  });
  const message = host.remember(envelope('我喜欢绿色'));
  store.ingest(message);
  worker.enqueue([message]);
  await worker.drain();
  assert.equal(host.requests.length, 0);
  assert.equal(host.runs.size, 0);
  assert.equal(store.memoryJobs().length, 1);
});

test('small-context background extraction splits a large job and leaves unprocessed sources queued', async (t) => {
  const store = new Store(':memory:'),
    host = new FakeHost();
  host.config.memory.automatic = true;
  host.config.model.contextWindow = 4096;
  host.config.model.maxOutputTokens = 128;
  const worker = new MemoryWorker(
    store,
    () => host.config,
    host,
    () => {},
    () => {},
  );
  t.after(async () => {
    await worker.close();
    store.close();
  });
  const sources = Array.from({ length: 20 }, () =>
    host.remember(envelope('这是一些很长的话'.repeat(300))),
  );
  for (const source of sources) store.ingest(source);
  host.steps.push(() => assistant('{"facts":[]}'));
  worker.enqueue(sources);
  await worker.drain();
  assert.equal(host.requests.length, 1);
  assert.ok(
    store.memoryJobs()[0]!.messages.length > 0 && store.memoryJobs()[0]!.messages.length < 20,
  );
  assert.equal(host.runs.size, 0);
});
