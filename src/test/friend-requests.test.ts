import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FriendRequests } from '../desktop/friend-requests.js';
import { DeliveryUnknownError } from '../connectors/onebot.js';
import { atomicJson, id } from '../shared/util.js';
import { temporary, removeTemporary } from './helpers.js';

test('friend requests belong to their verified recipient, including when accounts change inside the confirmation dialog', async (t) => {
  const directory = temporary();
  t.after(() => removeTemporary(directory));
  const file = join(directory, 'requests.json');
  let account: string | undefined = '10001';
  atomicJson(file, [{ id: id(), qq: '22222', flag: 'old', comment: '', handled: false }]);
  const inbox = new FriendRequests(file, () => account);
  assert.equal(inbox.list().length, 0);
  inbox.receive('10001', '22222', 'shared-flag', '第一账号');
  inbox.receive('10001', '22222', 'shared-flag', '重复事件');
  const [first] = inbox.list();
  assert.equal(inbox.list().length, 1);
  assert.equal(first!.comment, '第一账号');
  await assert.rejects(
    inbox.review(
      first!.id,
      async () => {
        account = '10002';
        return 'accept';
      },
      async () => assert.fail(),
    ),
    /已变化/,
  );
  assert.equal(inbox.list().length, 0);
  inbox.receive('10002', '22222', 'shared-flag', '第二账号');
  const [second] = inbox.list();
  const decisions: boolean[] = [];
  await inbox.review(
    second!.id,
    async () => 'decline',
    async (flag, allow) => {
      assert.equal(flag, 'shared-flag');
      decisions.push(allow);
      await inbox.review(
        second!.id,
        async () => 'accept',
        async () => assert.fail('重复发送'),
      );
    },
  );
  assert.deepEqual(decisions, [false]);
  account = undefined;
  assert.equal(inbox.list().length, 0);
  account = '10001';
  assert.deepEqual(inbox.list(), [first]);
});

test('unacknowledged friend decisions survive restart and can only be dismissed locally', async (t) => {
  const directory = temporary();
  t.after(() => removeTemporary(directory));
  const file = join(directory, 'requests.json');
  let inbox = new FriendRequests(file, () => '10001');
  inbox.receive('10001', '22222', 'flag', '待处理');
  const key = inbox.list()[0]!.id;
  await assert.rejects(
    inbox.review(
      key,
      async () => 'accept',
      async () => {
        throw new Error('服务拒绝操作');
      },
    ),
  );
  assert.ok(!inbox.list()[0]!.uncertain);
  await assert.rejects(
    inbox.review(
      key,
      async () => 'accept',
      async () => {
        throw new DeliveryUnknownError('发送结果未知');
      },
    ),
  );
  inbox = new FriendRequests(file, () => '10001');
  assert.equal(inbox.list()[0]!.uncertain, true);
  await assert.rejects(
    inbox.review(
      key,
      async () => 'accept',
      async () => assert.fail(),
    ),
    /核实/,
  );
  await inbox.review(
    key,
    async () => 'dismiss',
    async () => assert.fail('不得重发'),
  );
  assert.equal(inbox.list().length, 0);
});
