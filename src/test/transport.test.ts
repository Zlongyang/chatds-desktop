import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { OneBot, DeliveryUnknownError } from '../connectors/onebot.js';
import { defaultConfig } from '../shared/config.js';
import { RpcPeer } from '../shared/rpc.js';
import { until, delay } from './helpers.js';
test('OneBot authenticates, verifies account, matches concurrent responses, and never retries unknown sends', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let authorization = '';
  let sends = 0;
  const config = defaultConfig().onebot;
  Object.assign(config, {
    url: 'ws://127.0.0.1:' + (server.address() as { port: number }).port,
    botQQ: '11000',
    ownerQQ: '10001',
  });
  server.on('connection', (ws, req) => {
    authorization = req.headers.authorization ?? '';
    ws.on('message', (b) => {
      const v = JSON.parse(b.toString());
      if (v.action === 'send_private_msg') {
        sends++;
        ws.close();
        return;
      }
      setTimeout(
        () =>
          ws.send(
            JSON.stringify({
              echo: v.echo,
              retcode: 0,
              status: 'ok',
              data: v.action === 'get_login_info' ? { user_id: 11000 } : { action: v.action },
            }),
          ),
        v.action === 'get_slow' ? 15 : 1,
      );
    });
  });
  const bot = new OneBot(
    () => config,
    () => 'fixture-token',
  );
  t.after(async () => {
    bot.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  bot.start();
  await until(() => bot.status === 'online');
  assert.equal(authorization, 'Bearer fixture-token');
  assert.equal(bot.account, '11000');
  const replies = await Promise.all([bot.call('get_slow'), bot.call('get_fast')]);
  assert.equal(replies[0].action, 'get_slow');
  assert.equal(replies[1].action, 'get_fast');
  await assert.rejects(bot.send('onebot:private:10001', 'hello'), DeliveryUnknownError);
  bot.stop();
  await delay(20);
  assert.equal(sends, 1);
  assert.equal(bot.stats.pending, 0);
});
test('wrong OneBot account is stopped before messages are accepted', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (ws) =>
    ws.on('message', (b) => {
      const p = JSON.parse(b.toString());
      ws.send(JSON.stringify({ echo: p.echo, status: 'ok', retcode: 0, data: { user_id: 99999 } }));
    }),
  );
  const c = defaultConfig().onebot;
  Object.assign(c, {
    url: 'ws://127.0.0.1:' + (server.address() as { port: number }).port,
    ownerQQ: '10001',
    botQQ: '11000',
  });
  const bot = new OneBot(
    () => c,
    () => 'fixture',
  );
  t.after(async () => {
    bot.stop();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  bot.start();
  await until(() => bot.status === 'wrong-account');
  assert.equal(bot.stats.connected, false);
});
test('RPC abort and close release request timers, listeners and remote cancellation scopes', async () => {
  let left: RpcPeer, right: RpcPeer;
  left = new RpcPeer((p) => setImmediate(() => right.receive(p)));
  right = new RpcPeer((p) => setImmediate(() => left.receive(p)));
  right.handle(
    'wait',
    (_p, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      ),
  );
  const controller = new AbortController(),
    request = left.call('wait', {}, controller.signal);
  await until(() => right.stats.running === 1);
  controller.abort();
  await assert.rejects(request);
  await until(() => right.stats.running === 0);
  assert.equal(left.stats.pending, 0);
  const off = left.on('event', () => {});
  assert.equal(left.stats.listeners, 1);
  off();
  left.close();
  right.close();
  assert.equal(left.stats.listeners, 0);
});
