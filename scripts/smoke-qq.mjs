import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

// Exercise the actual renderer, IPC bridge, HTTP client and OneBot socket with a local account fixture.
export async function startQQFixture({ autoConfirm = true } = {}) {
  let loginStep = 0;
  const sends = [];
  const actions = [];
  let accountChecks = 0;
  const server = createServer(async (req, res) => {
    const reply = (data) => res.end(JSON.stringify({ code: 0, data }));
    if (req.url === '/api/auth/login') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const hash = createHash('sha256').update('fixture.napcat').digest('hex');
      if (JSON.parse(body).hash !== hash) return res.writeHead(401).end();
      return reply({ Credential: 'smoke-session' });
    }
    req.resume();
    if (req.headers.authorization !== 'Bearer smoke-session') return res.writeHead(401).end();
    if (req.url === '/api/QQLogin/CheckLoginStatus') {
      const step = loginStep;
      if (autoConfirm) loginStep++;
      if (step === 0)
        return reply({ isLogin: false, qrcodeurl: 'https://txz.qq.com/p?k=local-fixture' });
      if (step === 1) return reply({ isLogin: false, loginPhase: 'qrcode_scanned' });
      return reply({ isLogin: true, coreReady: true });
    }
    if (req.url === '/api/QQLogin/GetQQLoginInfo') return reply({ uin: '10001' });
    if (req.url === '/api/OB11Config/GetConfig')
      return reply({
        network: {
          websocketServers: [
            {
              name: 'fixture',
              enable: true,
              host: '127.0.0.1',
              port: server.address().port,
              messagePostFormat: 'array',
              token: 'local-message-token',
            },
          ],
        },
      });
    res.writeHead(404).end();
  });
  const sockets = new WebSocketServer({
    server,
    verifyClient: ({ req }) => req.headers.authorization === 'Bearer local-message-token',
  });
  sockets.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const { action, params, echo } = JSON.parse(raw.toString());
      actions.push(action);
      if (action === 'get_login_info') {
        accountChecks++;
        ws.send(JSON.stringify({ retcode: 0, status: 'ok', echo, data: { user_id: 10001 } }));
      } else if (action === 'send_private_msg' || action === 'send_group_msg') {
        const messageId = 60000 + sends.length;
        sends.push({ action, params, messageId });
        ws.send(
          JSON.stringify({ retcode: 0, status: 'ok', echo, data: { message_id: messageId } }),
        );
      } else ws.close();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    sends,
    actions,
    advanceLogin() {
      loginStep++;
    },
    get accountChecks() {
      return accountChecks;
    },
    message({ userId, groupId, mention, nickname, text, messageId }) {
      assert.equal(sockets.clients.size, 1, 'Expected one connected desktop client');
      const [ws] = sockets.clients;
      ws.send(
        JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          self_id: 10001,
          post_type: 'message',
          message_type: groupId ? 'group' : 'private',
          sub_type: groupId ? 'normal' : 'friend',
          ...(groupId ? { group_id: groupId } : {}),
          message_id: messageId,
          user_id: userId,
          sender: { user_id: userId, nickname },
          raw_message: (mention ? '[CQ:at,qq=' + mention + ']' : '') + text,
          message: [
            ...(mention ? [{ type: 'at', data: { qq: String(mention) } }] : []),
            { type: 'text', data: { text } },
          ],
        }),
      );
    },
    close() {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      server.close();
    },
  };
}
