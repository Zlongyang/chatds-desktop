import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelVerification, probeModel } from '../desktop/model-verification.js';
import { defaultConfig } from '../shared/config.js';
import { assistant, temporary, removeTemporary } from './helpers.js';

const profile = defaultConfig().model;
const success = { ok: true, detail: 'fixture response, never persist' };

test('a completed model probe requires a nonblank text reply', async () => {
  assert.equal((await probeModel({ stream: async () => assistant('  ') })).ok, false);
  assert.equal((await probeModel({ stream: async () => assistant('连接成功') })).ok, true);
});

function pendingProbe() {
  let resolve!: (value: typeof success) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<typeof success>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

test('success survives restart for one exact model profile without storing credentials or responses', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const before = new ModelVerification(dir);
  const model = { ...profile, baseUrl: 'https://fixture.test/api?opaque=private-marker' };
  assert.equal(before.verified(model), false);
  assert.deepEqual(await before.run(model, async () => success), success);
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(readFileSync(join(dir, files[0]!), 'utf8'), /^"[0-9a-f]{64}"$/);
  const reopened = new ModelVerification(dir);
  assert.equal(reopened.verified(model), true);
  assert.equal(
    reopened.verified({ ...model, thinking: model.thinking === 'high' ? 'off' : 'high' }),
    false,
  );
  reopened.invalidate();
  assert.equal(new ModelVerification(dir).verified(model), false);
  writeFileSync(join(dir, files[0]!), '{bad json');
  assert.equal(new ModelVerification(dir).verified(model), false);
});

test('concurrent probes are coalesced and invalidation discards pending success across key changes', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const store = new ModelVerification(dir);
  const deferred = pendingProbe();
  let calls = 0;
  const probe = () => {
    calls++;
    return deferred.promise;
  };
  const a = store.run(profile, probe);
  const b = store.run({ ...profile }, probe);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(a, b);
  store.invalidate();
  deferred.resolve(success);
  assert.equal((await a).ok, false);
  assert.equal(new ModelVerification(dir).verified(profile), false);
  const skipped = store.run(profile, probe);
  store.invalidate();
  assert.equal((await skipped).ok, false);
  assert.equal(calls, 1);
});

test('superseded failures preserve the latest verification; failed rechecks clear persisted success', async (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const store = new ModelVerification(dir);
  const deferred = pendingProbe();
  const other = { ...profile, model: 'a different model' };
  const old = store.run(profile, () => deferred.promise);
  await Promise.resolve();
  await store.run(other, async () => success);
  deferred.reject(Error('late'));
  assert.equal((await old).ok, false);
  assert.equal(new ModelVerification(dir).verified(other), true);
  const failure = { ok: false, detail: 'no text returned' };
  assert.deepEqual(await store.run(other, async () => failure), failure);
  assert.equal(new ModelVerification(dir).verified(other), false);
  await store.run(other, async () => success);
  await assert.rejects(
    store.run(other, () => {
      throw Error('unreachable');
    }),
    /unreachable/,
  );
  assert.equal(new ModelVerification(dir).verified(other), false);
});
