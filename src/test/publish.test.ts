import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { OneBot } from '../connectors/onebot.js';
import { defaultConfig } from '../shared/config.js';
import { id } from '../shared/util.js';
import { ToolBroker } from '../tools/broker.js';
import type { DockerSandbox } from '../tools/docker.js';
import { SkillRegistry } from '../tools/skills.js';
import { envelope, removeTemporary, temporary, until } from './helpers.js';

test('QQ space publishes only the approved text through the verified OneBot account', async (t) => {
  const directory = temporary();
  t.after(() => removeTemporary(directory));
  const account = '11000';
  const cookie = 'p_uin=o11000; p_skey=test';
  const origin = 'https://user.qzone.qq.com';
  const posts: {
    body: URLSearchParams;
    path: string;
    cookie?: string;
    referer?: string;
    origin?: string;
    method?: string;
  }[] = [];
  let result = '{"code":0,"tid":"local-post"}';
  let status = 200;
  let interruptResponse = false;
  const http = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    posts.push({
      body: new URLSearchParams(Buffer.concat(parts).toString()),
      path: request.url!,
      cookie: request.headers.cookie,
      referer: request.headers.referer,
      origin: request.headers.origin,
      method: request.method,
    });
    if (interruptResponse) response.destroy();
    else response.writeHead(status).end(result);
  });
  const sockets = new WebSocketServer({ server: http });
  let cookies = cookie;
  let cookiesSupported = true;
  const cookieRequests: unknown[] = [];
  sockets.on('connection', (ws) => {
    ws.on('message', (bytes) => {
      const { action, params, echo } = JSON.parse(bytes.toString());
      if (action === 'get_login_info') {
        ws.send(JSON.stringify({ echo, status: 'ok', retcode: 0, data: { user_id: account } }));
        return;
      }
      assert.equal(action, 'get_cookies');
      cookieRequests.push(params);
      ws.send(
        JSON.stringify(
          cookiesSupported
            ? { echo, status: 'ok', retcode: 0, data: { cookies } }
            : { echo, status: 'failed', retcode: 1404, wording: 'unsupported get_cookies' },
        ),
      );
    });
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const local = '127.0.0.1:' + (http.address() as AddressInfo).port;
  const fetchLocal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string, init: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, origin);
    assert.equal(init.redirect, 'error');
    return fetchLocal('http://' + local + url.pathname + url.search, init);
  });
  const config = defaultConfig();
  Object.assign(config.onebot, {
    enabled: false,
    botQQ: account,
    ownerQQ: '10001',
    url: 'ws://' + local,
  });
  config.conversations['desktop:owner'] = { mode: 'assistant', ambient: false, muted: false };
  config.tools.qzone_publish = true;
  const bot = new OneBot(
    () => config.onebot,
    () => 'local-token',
  );
  const source = envelope('发一条测试说说');
  const broker = new ToolBroker(
    directory,
    () => config,
    new SkillRegistry(join(directory, 'skills')),
    { state: { available: false } } as DockerSandbox,
    (key) => (key === source.id ? source : undefined),
    bot,
  );
  const run = broker.register(id(), [source.id], source.conversationId);
  t.after(async () => {
    broker.finish(run.id);
    bot.stop();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const offered = async () =>
    (await broker.snapshot(run.id)).tools.some((tool) => tool.id === 'qzone_publish');
  const execute = (content: string) => broker.execute(run.id, 'qzone_publish', { content });
  const approval = () => {
    assert.equal(broker.pendingApprovals.length, 1);
    return broker.pendingApprovals[0]!;
  };
  const approved = (content: string) => {
    const request = execute(content);
    broker.answer(approval().id, true);
    return request;
  };
  await t.test('unavailable before account verification', async () => {
    assert.equal(await offered(), false);
    await assert.rejects(execute('离线'), /OneBot|QQ/);
    assert.equal(broker.pendingApprovals.length, 0);
  });
  bot.start();
  await until(() => bot.status === 'online');
  await t.test('manual connection can publish with startup auto-connect off', async () => {
    assert.equal(config.onebot.enabled, false);
    assert.equal(await offered(), true);
  });
  await t.test('denial never requests a cookie or sends a post', async () => {
    assert.equal(await offered(), true);
    const request = execute('不要发布');
    broker.answer(approval().id, false);
    await assert.rejects(request, /确认/);
    assert.deepEqual(cookieRequests, []);
    assert.deepEqual(posts, []);
  });
  await t.test('wire payload matches the approval even if the caller edits its input', async () => {
    const content = '小鱼 & 天气=晴\n重复？+100%';
    const input = { content };
    const request = broker.execute(run.id, 'qzone_publish', input);
    const view = approval();
    input.content = '修改后的文字';
    assert.deepEqual(JSON.parse(view.detail), { content });
    broker.answer(view.id, true);
    assert.deepEqual(await request, { published: true, id: 'local-post', content });
    assert.deepEqual(cookieRequests, [{ domain: 'user.qzone.qq.com' }]);
    assert.equal(posts.length, 1);
    const post = posts[0]!;
    assert.equal(post.method, 'POST');
    assert.equal(post.body.get('con'), content);
    assert.equal(post.body.get('hostuin'), account);
    assert.equal(post.cookie, cookie);
    assert.equal(post.origin, origin);
    assert.equal(post.referer, origin + '/' + account);
    assert.equal(
      post.path,
      '/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=2090756197',
    );
    assert.throws(() => broker.answer(view.id, true), /结束/);
  });
  await t.test('cookie capability is optional and bad credentials do not send a post', async () => {
    const before = posts.length;
    cookiesSupported = false;
    await assert.rejects(approved('不可用'), /get_cookies/);
    assert.equal(bot.status, 'online');
    cookiesSupported = true;
    cookies = 'p_uin=o11000';
    await assert.rejects(approved('空凭据'), /凭据/);
    cookies = cookie;
    assert.equal(posts.length, before);
  });
  await t.test(
    'distinguishes explicit refusal, unknown delivery and a successful JSONP response',
    async () => {
      const before = posts.length;
      result = JSON.stringify({ code: -100, message: cookie });
      await assert.rejects(
        approved('拒绝'),
        (error: Error) => /拒绝.*-100/.test(error.message) && !error.message.includes(cookie),
      );
      for (const body of [
        '<html>login</html>',
        '{"code":null}',
        '{"code":false}',
        '{}',
        JSON.stringify({ code: 0, extra: 'x'.repeat(20000) }),
      ]) {
        result = body;
        await assert.rejects(approved('不明'), /结果未知/);
      }
      status = 502;
      result = '{"code":0}';
      await assert.rejects(approved('网关故障'), /结果未知/);
      status = 200;
      interruptResponse = true;
      await assert.rejects(approved('提交后断线'), /结果未知/);
      interruptResponse = false;
      result = '_Callback({"code":"0","tid":"jsonp"});';
      assert.deepEqual(await approved('正常'), { published: true, id: 'jsonp', content: '正常' });
      assert.equal(posts.length, before + 9);
    },
  );
  await t.test('disconnection after preview blocks the approved action', async () => {
    const count = cookieRequests.length;
    const request = execute('断开连接');
    const view = approval();
    bot.stop();
    broker.answer(view.id, true);
    await assert.rejects(request, /OneBot|QQ/);
    assert.equal(await offered(), false);
    assert.equal(cookieRequests.length, count);
    assert.equal(broker.pendingApprovals.length, 0);
  });
});
