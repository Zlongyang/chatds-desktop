import { once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

// Exercise the actual renderer, IPC bridge, HTTP client and OneBot socket with a local account fixture.
export async function startQQFixture() {
  let polls = 0;
  const server = createServer((req, res) => {
    req.resume();
    const reply = (data) => res.end(JSON.stringify({ code: 0, data }));
    if (req.url === '/api/auth/login') return reply({ Credential: 'smoke-session' });
    if (req.headers.authorization !== 'Bearer smoke-session') return res.writeHead(401).end();
    if (req.url === '/api/QQLogin/CheckLoginStatus') {
      polls++;
      if (polls === 1)
        return reply({ isLogin: false, qrcodeurl: 'https://txz.qq.com/p?k=local-fixture' });
      if (polls === 2) return reply({ isLogin: false, loginPhase: 'qrcode_scanned' });
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
      const { action, echo } = JSON.parse(raw.toString());
      if (action === 'get_login_info')
        ws.send(JSON.stringify({ retcode: 0, status: 'ok', echo, data: { user_id: 10001 } }));
      else ws.close();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    close() {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      server.close();
    },
  };
}
