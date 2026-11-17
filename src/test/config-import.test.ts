import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigStore } from '../desktop/config-store.js';
import { Vault, type Encryption } from '../desktop/vault.js';
import { previewImport, importLegacy } from '../runtime/import.js';
import { Store } from '../runtime/store.js';
import { temporary, removeTemporary } from './helpers.js';

test('invalid config and unavailable encryption leave persisted settings and credentials intact', (t) => {
  const directory = temporary();
  t.after(() => removeTemporary(directory));
  const config = new ConfigStore(directory);
  config.save();
  const original = readFileSync(config.path, 'utf8');
  assert.throws(() =>
    config.update({ model: { ...config.value.model, baseUrl: 'http://remote.example/v1' } }),
  );
  assert.equal(readFileSync(config.path, 'utf8'), original);
  assert.equal(config.value.revision, 1);
  const encryption: Encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x55)),
    decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x55)).toString(),
  };
  const vault = new Vault(directory, encryption);
  vault.setMany({ model: 'synthetic-value-a', onebot: 'synthetic-value-b' });
  assert.ok(!readFileSync(vault.path).includes(Buffer.from('synthetic-value-a')));
  const unavailable = new Vault(directory, { ...encryption, isEncryptionAvailable: () => false });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.get('model'), undefined);
  const preserved = readFileSync(vault.path);
  assert.throws(() => unavailable.set('model', 'replacement'));
  assert.deepEqual(readFileSync(vault.path), preserved);
  const next = config.preview({ enabled: false });
  assert.equal(config.value.enabled, true);
  config.commit(next);
  assert.equal(new ConfigStore(directory).value.enabled, false);
});

test('legacy import previews hash, backs up, isolates unknown group authors and is idempotent', (t) => {
  const directory = temporary();
  const store = new Store(join(directory, 'chatds.sqlite'));
  t.after(() => {
    store.close();
    removeTemporary(directory);
  });
  const config = new ConfigStore(directory).value;
  config.onebot.ownerQQ = '10001';
  const file = join(directory, 'legacy.json');
  const data = {
    version: 1,
    rooms: {
      'private:10001': {
        chat: [
          { role: 'user', text: '私聊小事', time: '2025-01-01T00:00:00Z' },
          { role: 'assistant', text: '历史回答', time: '2025-01-01T00:01:00Z' },
        ],
      },
      'group:30003': {
        chat: [{ role: 'user', text: '不知道谁说的话', time: '2025-01-02T00:00:00Z' }],
      },
    },
    memories: [
      { scope: 'private:10001', senderQQ: '10001', content: '喜欢蓝色' },
      { scope: 'group:30003', senderQQ: '10001', content: '不能归入主号私密记忆' },
      { scope: 'private:20002', senderQQ: '10001', content: '归属不符' },
      { scope: 'private:10001', senderQQ: '10001', content: '密码是 synthetic' },
    ],
  };
  writeFileSync(file, JSON.stringify(data));
  const preview = previewImport(file, config);
  assert.equal(preview.messages, 3);
  assert.equal(preview.memories, 1);
  assert.equal(preview.archived, 4);
  const result = importLegacy(file, preview.hash, config, store, directory);
  assert.equal(result.memories, 1);
  assert.equal(store.facts('person:owner')[0]?.content, '喜欢蓝色');
  assert.equal(store.facts('group:onebot:group:30003').length, 0);
  assert.ok(
    store
      .history('onebot:private:10001')
      .some((m) => m.role === 'assistant' && m.text === '历史回答'),
  );
  assert.equal(store.history('onebot:group:30003')[0]?.actorId, 'archived-unknown');
  assert.equal(readdirSync(join(directory, 'backups')).length, 1);
  assert.throws(() => importLegacy(file, preview.hash, config, store, directory), /已导入/);
  writeFileSync(file, JSON.stringify({ ...data, extra: true }));
  assert.throws(() => importLegacy(file, preview.hash, config, store, directory), /发生变化/);
});
