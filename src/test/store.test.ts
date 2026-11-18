import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store, memoryScope, searchTerms } from '../runtime/store.js';
import { envelope, temporary, removeTemporary, assistant } from './helpers.js';
import type { RunContext } from '../shared/types.js';
test('history pages use room-local row cursors and delivery updates refresh the displayed receipt', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const room = 'desktop:owner';
  for (let i = 0; i < 205; i++) {
    store.ingest(envelope(String(i), { timestamp: 1000 }));
    store.ingest(envelope('其他会话', { conversationId: 'onebot:private:22222', timestamp: 1000 }));
  }
  const recent = store.history(room, undefined, 101).slice(-100);
  const middle = store.history(room, recent[0]!.seq, 101).slice(-100);
  const oldest = store.history(room, middle[0]!.seq, 101);
  assert.deepEqual(
    [...oldest, ...middle, ...recent].map((m) => m.text),
    Array.from({ length: 205 }, (_, i) => String(i)),
  );
  const out = store.createOutbox(room, '发送中');
  store.appendAssistant(room, '发送中', out, 'pending');
  const before = store.rooms().find((r) => r.id === room)!.updatedAt;
  store.finishOutbox(out, 'unknown');
  assert.ok(store.rooms().find((r) => r.id === room)!.updatedAt > before);
  assert.equal(store.history(room).at(-1)!.status, 'unknown');
});
test('SQLite persists facts, keeps people/groups isolated, and deduplicates incoming messages', (t) => {
  const dir = temporary();
  let store = new Store(join(dir, 'state.sqlite'));
  t.after(() => {
    store.close();
    removeTemporary(dir);
  });
  const local = envelope('我喜欢蓝色饭团'),
    privateOwner = envelope('私聊', { conversationId: 'onebot:private:10001', channel: 'onebot' }),
    other = envelope('我喜欢红色', {
      actorId: 'qq:20002',
      conversationId: 'onebot:private:20002',
      channel: 'onebot',
    }),
    group = envelope('我不吃香菜', {
      isGroup: true,
      actorId: 'qq:20002',
      conversationId: 'onebot:group:30003',
      channel: 'onebot',
    });
  for (const e of [local, privateOwner, other, group]) assert.equal(store.ingest(e), true);
  assert.equal(store.ingest(local), false);
  store.remember(memoryScope(local), 'owner', '我喜欢蓝色饭团', 'preference', [local.id]);
  store.remember(memoryScope(group), group.actorId, '我不吃香菜', 'preference', [group.id]);
  assert.equal(memoryScope(local), memoryScope(privateOwner));
  assert.equal(store.search(memoryScope(privateOwner), '喜欢')[0]?.content, '我喜欢蓝色饭团');
  assert.equal(store.search(memoryScope(other), '喜欢').length, 0);
  assert.equal(store.facts(memoryScope(group))[0]?.subject, 'qq:20002');
  assert.throws(
    () => store.remember(memoryScope(other), 'qq:20002', '这是别人的话', 'event', [local.id]),
    /来源/,
  );
  assert.throws(
    () => store.remember(memoryScope(local), 'owner', '密码是123456', 'event', [local.id]),
    /敏感/,
  );
  store.close();
  store = new Store(join(dir, 'state.sqlite'));
  assert.equal(store.counts().facts, 2);
  assert.equal(store.history(local.conversationId).length, 1);
});
test('forget excludes old source, complete wire turn and summary, preventing extraction resurrection', (t) => {
  const dir = temporary(),
    store = new Store(join(dir, 'state.sqlite'));
  t.after(() => {
    store.close();
    removeTemporary(dir);
  });
  const e = envelope('我喜欢蓝色');
  store.ingest(e);
  const fact = store.remember(memoryScope(e), e.actorId, '我喜欢蓝色', 'preference', [e.id]);
  const run: RunContext = {
    id: 'run',
    conversationId: e.conversationId,
    actorId: 'owner',
    isGroup: false,
    channel: 'desktop',
    trigger: 'direct',
    mode: 'companion',
    sourceIds: [e.id],
    startedAt: Date.now(),
  };
  store.saveRun(
    run,
    [{ role: 'user', content: e.text, timestamp: e.timestamp }, assistant('蓝色记住了')],
    'complete',
  );
  store.setSummary(e.conversationId, '喜欢蓝色', [e.id]);
  store.queueMemory(memoryScope(e), [e]);
  store.forget(fact.id);
  assert.equal(store.context(e.conversationId).length, 0);
  assert.equal(store.getSummary(e.conversationId), '');
  assert.equal(store.recentEnvelopes(e.conversationId).length, 0);
  assert.equal(store.history(e.conversationId).length, 1);
  assert.equal(store.memoryJobs().length, 0);
  assert.throws(
    () => store.remember(memoryScope(e), e.actorId, '我喜欢蓝色', 'preference', [e.id]),
    /来源/,
  );
});
test('Chinese segmentation finds short terms instead of comparing the whole question', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const e = envelope('我喜欢蓝色饭团');
  store.ingest(e);
  store.remember(memoryScope(e), 'owner', '我喜欢蓝色饭团', 'preference', [e.id]);
  assert.ok(searchTerms('喜欢什么颜色').includes('喜欢'));
  assert.equal(store.search(memoryScope(e), '喜欢什么颜色')[0]?.content, e.text);
});
test('an existing message database gains web receipts without changing earlier replies', (t) => {
  const directory = temporary();
  const file = join(directory, 'state.sqlite');
  let store = new Store(file);
  t.after(() => {
    store.close();
    removeTemporary(directory);
  });
  const room = 'desktop:owner';
  const oldId = store.appendAssistant(room, '旧版回复');
  store.close();
  const previous = new DatabaseSync(file);
  try {
    previous.exec('ALTER TABLE messages DROP COLUMN web_reads');
  } finally {
    previous.close();
  }
  store = new Store(file);
  const receipts = [{ host: 'example.org', status: 'read' as const }];
  const newId = store.appendAssistant(room, '新版回复', undefined, 'sent', '小鱼', receipts);
  store.close();
  store = new Store(file);
  assert.deepEqual(
    store.history(room).map((m) => [m.id, m.text, m.webReads]),
    [
      [oldId, '旧版回复', undefined],
      [newId, '新版回复', receipts],
    ],
  );
});
test('incomplete outbound delivery becomes unknown on restart and is not replayed', (t) => {
  const dir = temporary();
  let store = new Store(join(dir, 's.sqlite'));
  t.after(() => {
    store.close();
    removeTemporary(dir);
  });
  const e = envelope('hello');
  store.ingest(e);
  const out = store.createOutbox(e.conversationId, 'reply');
  store.appendAssistant(e.conversationId, 'reply', out, 'pending');
  store.close();
  store = new Store(join(dir, 's.sqlite'));
  assert.equal(store.outbox().find((r) => r.id === out)?.status, 'unknown');
  assert.equal(store.history(e.conversationId).find((m) => m.id === out)?.status, 'unknown');
});
test('summary compaction removes only selected complete runs and forgetting restores safe unsummarized turns', (t) => {
  const s = new Store(':memory:');
  t.after(() => s.close());
  for (let i = 0; i < 6; i++) {
    const e = envelope('消息' + i);
    s.ingest(e);
    s.saveRun(
      {
        id: 'r' + i,
        conversationId: e.conversationId,
        actorId: e.actorId,
        isGroup: false,
        channel: 'desktop',
        trigger: 'direct',
        mode: 'companion',
        sourceIds: [e.id],
        startedAt: Date.now(),
      },
      [{ role: 'user', content: e.text, timestamp: e.timestamp }, assistant('回答' + i)],
      'complete',
    );
  }
  const runs = s.contextRuns('desktop:owner');
  s.setSummary(
    'desktop:owner',
    '前两轮摘要',
    runs.slice(0, 2).flatMap((r) => r.sources),
    runs.slice(0, 2).map((r) => r.id),
  );
  assert.equal(s.contextRuns('desktop:owner').length, 4);
  assert.equal(s.context('desktop:owner').length, 8);
});
