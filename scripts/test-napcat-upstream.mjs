// Opt-in interoperability test. The pinned third-party source remains on the operator's machine.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import unzipper from 'unzipper';
import WebSocket from 'ws';
import { NapCatSession } from '../dist/desktop/napcat.js';
import { OneBot } from '../dist/connectors/onebot.js';

const revision = '9335843246e3b7a17944861f3ac8731a259732c2';
const expectedSHA = 'cff1482513eb4fecc49a8a8bff58d89fb3dda11fc5889231b1c55abce6eabd56';
const expectedSize = 59_557_769;
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    tools: { type: 'string', default: join(project, '.cache', 'napcat-upstream-tools') },
  },
});
assert.ok(
  values.source,
  'Pass --source with the original v4.18.42 source ZIP. See docs/validation.md.',
);
const toolsDir = resolve(values.tools);
const requireTools = createRequire(join(toolsDir, 'fixture-tools.cjs'));
const esbuild = requireTools('esbuild');
const express = requireTools('express');
const files = [
  'router/auth',
  'router/QQLogin',
  'router/OB11Config',
  'router/index',
  'middleware/auth',
  'api/Auth',
  'api/QQLogin',
  'api/OB11Config',
  'utils/response',
  'utils/check',
  'helper/Data',
  'helper/SignToken',
  'onebot/config',
  'types/index',
  'const/status',
];
const wsFiles = {
  'upstream-ws': 'network/websocket-server',
  'ws-adapter': 'network/adapter',
  'ws-event': 'event/OneBotEvent',
  'ws-index': 'network/index',
  'ws-actions': 'action/router',
  'ws-stream': 'action/stream/StreamBasic',
  'ws-response': 'action/OneBotAction',
  'ws-meta': 'event/meta/OB11BaseMetaEvent',
  'ws-lifecycle': 'event/meta/OB11LifeCycleEvent',
  'ws-heartbeat': 'event/meta/OB11HeartbeatEvent',
};

async function runOriginal(dir) {
  const src = (p) => join(dir, p);
  const info = await fs.stat(values.source);
  assert.ok(info.isFile() && info.size === expectedSize, 'Expected the pinned v4.18.42 source ZIP');
  const bytes = await fs.readFile(values.source);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    expectedSHA,
    'Source ZIP SHA-256 mismatch',
  );
  const archived = await unzipper.Open.buffer(bytes);
  const inputs = Object.fromEntries(
    files.map((name) => [name, 'napcat-webui-backend/src/' + name]),
  );
  inputs['common-store'] = 'napcat-common/src/store';
  for (const [alias, name] of Object.entries(wsFiles)) inputs[alias] = 'napcat-onebot/' + name;
  for (const [local, path] of Object.entries(inputs)) {
    const entry = archived.files.find(
      (x) => x.path === 'NapCatQQ-' + revision + '/packages/' + path + '.ts',
    );
    assert.ok(entry, 'Pinned source is missing ' + path);
    const dest = src(local + '.ts');
    await fs.mkdir(dirname(dest), { recursive: true });
    await fs.writeFile(dest, await entry.buffer(), { flag: 'wx' });
  }
  // Mount the original Router modules. Unrelated file uploads and device management never run.
  const dormantRoutes = [
    'Base',
    'File',
    'Log',
    'Mirror',
    'NapCatConfig',
    'Plugin',
    'Process',
    'UpdateNapCat',
    'WebUIConfig',
  ];
  const hooks = {
    name: 'isolate-unrelated-services',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const name = args.path,
          pref = '@/napcat-webui-backend/src/';
        const wsOwner = wsFiles[basename(args.importer, '.ts')];
        const wsDep =
          name.startsWith('./') || name.startsWith('../')
            ? wsOwner
              ? new URL(name, 'https://fixture.invalid/' + wsOwner).pathname.slice(1)
              : ''
            : name.replace(/^@\/napcat-onebot\//, '');
        const wsFile = Object.entries(wsFiles).find(([, p]) => p === wsDep)?.[0];
        if (wsFile) return { path: src(wsFile + '.ts') };
        if (wsOwner === 'network/index' && name.startsWith('./'))
          return { path: 'unused', namespace: 'fixture' };
        if (name.startsWith(pref) && files.includes(name.slice(pref.length)))
          return { path: src(name.slice(pref.length) + '.ts') };
        if (name === 'napcat-common/src/store') return { path: src('common-store.ts') };
        if (name === 'napcat-common/src/version') return { path: 'version', namespace: 'fixture' };
        if (name === '@/napcat-webui-backend/index') return { path: 'host', namespace: 'fixture' };
        if (
          dormantRoutes.includes(name.split('/').at(-1)) &&
          args.importer.endsWith(
            'router' + (process.platform === 'win32' ? '\\' : '/') + 'index.ts',
          )
        )
          return { path: 'routes', namespace: 'fixture' };
        if (name.endsWith('/api/Debug')) return { path: 'routes', namespace: 'fixture' };
        if (name === 'multer' || name.endsWith('/api/BackupConfig'))
          return { path: 'uploads', namespace: 'fixture' };
        if (
          name.endsWith('/utils/guid') ||
          name.endsWith('/PasskeyHelper') ||
          name.endsWith('/TotpHelper')
        )
          return { path: 'unused', namespace: 'fixture' };
      });
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
        if (path === 'version') return { contents: "export const napCatVersion='4.18.42'" };
        if (path === 'uploads')
          return {
            contents:
              "function dormant(){throw new Error('Unrelated upload route invoked')}module.exports=Object.assign(()=>({single:()=>dormant}),{memoryStorage:()=>({}),BackupExportConfigHandler:dormant,BackupImportConfigHandler:dormant})",
          };
        if (path === 'host')
          return {
            contents:
              'export const {webUiPathWrapper,WebUiConfig,getInitialWebUiToken,setInitialWebUiToken}=globalThis.testNapCatHost',
          };
        if (path === 'routes')
          return {
            contents:
              "const r=require('express').Router();module.exports=r;" +
              dormantRoutes.map((n) => 'module.exports.' + n + 'Router=r;').join(''),
            resolveDir: dir,
          };
        return { contents: 'module.exports={};' };
      });
    },
  };

  const bundle = src('original-routes.cjs');
  await esbuild.build({
    stdin: {
      contents:
        "export {ALLRouter} from './router/index';export {WebUiDataRuntime} from './helper/Data';export {OB11WebSocketServerAdapter as WS} from './upstream-ws';export {OB11Response as Resp} from './ws-response';",
      resolveDir: dir,
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['express', '@sinclair/typebox', '@sinclair/typebox/*', 'json5', 'ws'],
    plugins: [hooks],
    logLevel: 'warning',
  });
  const temp = await fs.mkdtemp(join(tmpdir(), 'chatds-napcat-original-'));
  let secret = randomBytes(24).toString('hex');
  const hostConfig = { loginRate: 30, enable2FA: false, totpSecret: '' };
  globalThis.testNapCatHost = {
    webUiPathWrapper: { configPath: temp },
    WebUiConfig: { GetWebUIConfig: async () => hostConfig },
    getInitialWebUiToken: () => secret,
  };
  const requireFixture = createRequire(bundle);
  const {
    ALLRouter,
    WebUiDataRuntime: runtime,
    WS: ForwardServer,
    Resp: Reply,
  } = requireFixture(bundle);
  let server, client, other, forward, connector;
  try {
    const trace = [];
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      trace.push(req.method + ' ' + req.url);
      next();
    });
    app.use('/api', ALLRouter);
    server = createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    await fs.writeFile(
      join(temp, 'onebot11.json'),
      JSON.stringify({
        network: {
          httpServers: [{ name: 'leave-alone', host: '127.0.0.1', port: 29155, enable: false }],
          websocketServers: [],
        },
      }),
    );
    runtime.setOnOB11ConfigChanged(async (binding) =>
      fs.writeFile(join(temp, 'onebot11_10001.json'), JSON.stringify(binding)),
    );
    client = new NapCatSession(origin, secret);
    await client.checkWebUI();
    const oldSecret = secret;
    secret = randomBytes(24).toString('hex');
    await assert.rejects(client.status(), /认证失败/);
    secret = oldSecret;
    await client.checkWebUI();
    other = new NapCatSession(origin, 'deliberately-incorrect');
    await assert.rejects(other.checkWebUI(), /认证失败/);
    other.close();
    hostConfig.enable2FA = true;
    hostConfig.totpSecret = 'fixture';
    await assert.rejects(client.checkWebUI(), /双重验证/);
    hostConfig.enable2FA = false;
    runtime.setQQLoginQrcodeURL('https://txz.qq.com/p?k=fixture-one');
    const firstStatus = await client.status();
    assert.match(firstStatus.qr, /^data:image\/png/);
    runtime.setRefreshQRCodeCallback(async () =>
      runtime.setQQLoginQrcodeURL('https://txz.qq.com/p?k=fixture-two'),
    );
    assert.notEqual((await client.refresh()).qr, firstStatus.qr);
    runtime.setQQLoginError('二维码已过期');
    assert.equal((await client.status()).phase, 'expired');
    runtime.setQQLoginError('');
    runtime.setQQLoginPhase('qrcode_scanned');
    assert.equal((await client.status()).phase, 'scanned');
    runtime.setQQLoginPhase('initializing');
    runtime.setQQLoginStatus(true);
    assert.equal((await client.status()).phase, 'initializing');
    runtime.setQQLoginInfo({ uin: '10001', uid: 'uid-fixture', nick: 'test' });
    runtime.setOneBotContext({ core: { selfInfo: { online: true } } });
    assert.deepEqual(await client.status(), { phase: 'ready', botQQ: '10001' });
    const binding = await client.provision('10001');
    assert.equal(binding.botQQ, '10001');
    assert.match(binding.token, /^[0-9a-f]{64}$/);
    const stored = JSON.parse(await fs.readFile(join(temp, 'onebot11_10001.json'), 'utf8'));
    assert.ok(
      stored.network.websocketServers[0].token === binding.token,
      'OneBot token did not round-trip',
    );
    assert.equal(stored.network.httpServers[0].name, 'leave-alone');
    assert.deepEqual(await client.provision(), binding);
    const core = {
      selfInfo: { uin: '10001', online: true },
      context: { logger: { log() {}, logDebug() {}, logError() {} } },
    };
    // The NTQQ action result is the only simulated part of this WebSocket request.
    const actions = new Map([
      [
        'get_login_info',
        { websocketHandle: async (_p, e) => Reply.ok({ user_id: 10001, nickname: 'tester' }, e) },
      ],
    ]);
    forward = new ForwardServer('ChatDS', stored.network.websocketServers[0], core, {}, actions);
    await once(forward.wsServer, 'listening');
    await forward.open();
    const wrong = new WebSocket(binding.url, {
      headers: { Authorization: 'Bearer wrong-fixture' },
    });
    const rejected = await once(wrong, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(JSON.parse(rejected[0]).retcode, 1403);
    wrong.close();
    connector = new OneBot(
      () => ({ url: binding.url, botQQ: binding.botQQ }),
      () => binding.token,
    );
    const online = new Promise((ok, fail) => {
      const expiry = setTimeout(
        () => fail(new Error('adapter online timeout: ' + connector.status)),
        5000,
      );
      connector.on('status', (s) => {
        if (s.status === 'online') {
          clearTimeout(expiry);
          ok();
        }
      });
    });
    connector.start();
    await online;
    const received = once(connector, 'message', { signal: AbortSignal.timeout(3000) });
    await forward.onEvent({
      post_type: 'message',
      message_type: 'group',
      self_id: 10001,
      group_id: 22001,
      user_id: 11002,
      message_id: 42,
      message: [{ type: 'text', data: { text: 'offline fixture' } }],
    });
    const event = (await received)[0];
    assert.equal(event.message[0].data.text, 'offline fixture');
    console.log(
      JSON.stringify({
        ok: true,
        sourceRevision: revision,
        sourceSha256: expectedSHA,
        originalRoutesHit: [...new Set(trace)],
        webuiPort: server.address().port,
        onebotPort: stored.network.websocketServers[0].port,
        states: ['waiting', 'expired', 'scanned', 'initializing', 'ready'],
        forwardWS: {
          rejectedToken: 1403,
          chatds: connector.status,
          account: connector.account,
          receivedGroup: event.group_id,
        },
        secretLogged: false,
      }),
    );
  } finally {
    connector?.stop();
    await forward?.close();
    client?.close();
    other?.close();
    if (server) {
      const stopped = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await stopped;
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
}

const scratch = await fs.mkdtemp(join(toolsDir, 'chatds-protocol-'));
let exitCode = 0;
try {
  await runOriginal(scratch);
} catch (error) {
  console.error(String(error?.message ?? error).replace(/[a-f0-9]{48,}/gi, '[digest or token]'));
  exitCode = 1;
} finally {
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
// Upstream's in-memory credential store schedules one-hour expiry timers.
process.exit(exitCode);
