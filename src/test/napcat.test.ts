import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { NapCatSession } from '../desktop/napcat.js';

async function fixture(t: TestContext) {
  const data = {
    status: {
      isLogin: false,
      coreReady: false,
      loginPhase: 'waiting_qrcode',
      qrcodeurl: 'https://txz.qq.com/p?k=fixture-only',
      loginError: '',
    },
    account: '10001',
    refreshes: 0,
    saves: 0,
    logins: 0,
    invalidCredential: false,
    passkey: false,
    config: {
      network: {
        httpServers: [{ name: 'ChatDS', enable: false, port: 3001 }],
        websocketServers: [] as Record<string, unknown>[],
      },
      keepMe: { setting: true },
    },
  };
  const server = createServer(async (req, res) => {
    const json = (value: unknown) => res.end(JSON.stringify({ code: 0, data: value }));
    let input = '';
    for await (const chunk of req) input += chunk;
    const body = JSON.parse(input);
    if (req.url === '/api/auth/login') {
      assert.equal(body.hash, createHash('sha256').update('webui-fixture.napcat').digest('hex'));
      assert.equal(req.headers.authorization, undefined);
      data.logins++;
      return json(data.passkey ? { require2FA: true } : { Credential: 'temporary-credential' });
    }
    assert.equal(req.headers.authorization, 'Bearer temporary-credential');
    if (data.invalidCredential) {
      data.invalidCredential = false;
      return res.end(JSON.stringify({ code: -1, message: 'Unauthorized' }));
    }
    switch (req.url) {
      case '/api/QQLogin/CheckLoginStatus':
        return json(data.status);
      case '/api/QQLogin/GetQQLoginInfo':
        return json({ uin: data.account });
      case '/api/QQLogin/RefreshQRcode':
        data.refreshes++;
        return json({ qrcodeurl: 'https://txz.qq.com/p?k=refreshed' });
      case '/api/OB11Config/GetConfig':
        return json(data.config);
      case '/api/OB11Config/SetConfig':
        data.saves++;
        assert.equal(typeof body.config, 'string');
        data.config = JSON.parse(body.config);
        return json(null);
      default:
        res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const client = new NapCatSession('http://127.0.0.1:' + port, 'webui-fixture');
  t.after(() => {
    client.close();
    server.close();
  });
  function ready() {
    Object.assign(data.status, { isLogin: true, coreReady: true, loginPhase: 'ready' });
  }
  return { client, data, ready };
}

test('NapCat follows scan, refresh, expiry, phone confirmation and ready transitions with local PNGs', async (t) => {
  const { client, data, ready } = await fixture(t);
  const waiting = await client.status();
  assert.match(waiting.qr!, /^data:image\/png;base64,/);
  assert.equal(waiting.phase, 'waiting');
  assert(!JSON.stringify(waiting).includes('webui-fixture'));
  assert.equal((await client.status()).qr, waiting.qr);
  data.status.loginError = '二维码已过期';
  assert.deepEqual((await client.status()).phase, 'expired');
  assert.notEqual((await client.refresh()).qr, waiting.qr);
  data.status.loginError = '';
  data.status.loginPhase = 'qrcode_scanned';
  assert.deepEqual(await client.refresh(), { phase: 'scanned' });
  data.status.loginPhase = 'initializing';
  assert.deepEqual(await client.status(), { phase: 'initializing' });
  await assert.rejects(client.provision(), /确认/);
  ready();
  data.invalidCredential = true;
  assert.deepEqual(await client.refresh(), { phase: 'ready', botQQ: '10001' });
  assert.equal(data.logins, 2);
  assert.equal(data.refreshes, 1);
});

test('NapCat preserves independent adapters, creates a loopback listener once and rejects switched QQ', async (t) => {
  const { client, data, ready } = await fixture(t);
  ready();
  const previous = {
    name: 'external',
    host: '0.0.0.0',
    port: 1234,
    token: 'external-token',
    messagePostFormat: 'array',
    enable: true,
  };
  data.config.network.websocketServers.push(previous);
  const result = await client.provision('10001');
  assert.equal(result.botQQ, '10001');
  assert.match(result.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
  assert.match(result.token, /^[a-f0-9]{64}$/);
  assert.equal(data.config.network.websocketServers[1]?.name, 'ChatDS-2');
  assert.equal(data.config.network.websocketServers[1]?.token, result.token);
  assert.deepEqual(data.config.network.websocketServers[0], previous);
  assert.deepEqual(data.config.network.httpServers, [
    { name: 'ChatDS', enable: false, port: 3001 },
  ]);
  assert.deepEqual(data.config.keepMe, { setting: true });
  assert.deepEqual(await client.provision(), result);
  data.account = '10002';
  await assert.rejects(client.provision(), /账号已变更/);
  assert.equal(data.saves, 1);
});

test('NapCat reuses a compatible existing loopback socket without modifying service config', async (t) => {
  const { client, data, ready } = await fixture(t);
  data.config.network.websocketServers.push({
    enable: true,
    host: '::1',
    port: 3002,
    messagePostFormat: 'array',
    token: 'existing-token',
  });
  ready();
  assert.deepEqual(await client.provision(), {
    botQQ: '10001',
    url: 'ws://[::1]:3002',
    token: 'existing-token',
  });
  assert.equal(data.saves, 0);
});

test('NapCat refuses remote origins, redirects, non-QQ login links and revoked sessions', async (t) => {
  for (const origin of [
    'http://example.org',
    'http://127.0.0.1@outside.example',
    'http://user@127.0.0.1',
    'http://127.0.0.1/?token=oops',
    'file:///tmp/path',
  ])
    assert.throws(() => new NapCatSession(origin, 'fixture'));
  const { client, data } = await fixture(t);
  data.status.qrcodeurl = 'https://qq.com.evil.test/p';
  await assert.rejects(client.status(), /无法识别/);
  client.close();
  await assert.rejects(client.status());
  let redirected = false;
  const server = createServer((req, res) => {
    if (req.url === '/redirected') redirected = true;
    res.writeHead(307, { Location: '/redirected' }).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const other = new NapCatSession(
    'http://127.0.0.1:' + (server.address() as { port: number }).port,
    'fixture',
  );
  t.after(() => other.close());
  await assert.rejects(other.status(), /不可用/);
  assert.equal(redirected, false);
});

test('NapCat explicitly handles WebUI two-factor authentication', async (t) => {
  const { client, data } = await fixture(t);
  data.passkey = true;
  await assert.rejects(client.status(), /双重验证/);
  assert.equal(data.logins, 1);
});
