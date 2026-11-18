import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import electron from 'electron';
import WebSocket from 'ws';

// Drives the installed renderer through the same controls shown in the README.
const [target, data] = process.argv.slice(2);
const switches = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'];
let exe = target;
let scratch;
if (target === '--archive') {
  const archive = resolve(data);
  assert.ok(basename(archive) === 'app.asar' && existsSync(archive));
  scratch = await mkdtemp(join(tmpdir(), 'chatds-test-first-chat-'));
  const entry = join(scratch, 'start.cjs');
  // Keep the real renderer, model client and utility process; move all application data to a fresh directory.
  await writeFile(
    entry,
    "const { app } = require('electron');\napp.setPath('appData', __dirname);\napp.setPath('userData', __dirname);\n" +
      "app.on('browser-window-created', (_, win) => { win.setFocusable(false); win.setSkipTaskbar(true); win.setPosition(-32000,-32000,false); });\nimport(" +
      JSON.stringify(pathToFileURL(join(archive, 'dist/desktop/main.js')).href) +
      ').catch(error => { console.error(error); app.exit(1); });\n',
  );
  exe = electron;
  switches.push(entry);
} else {
  assert.ok(process.env.RUNNER_ENVIRONMENT === 'github-hosted' && exe && data && !existsSync(data));
}
const question = 'First desktop message';
const answer = 'First desktop reply';
let tested = false;
let chatted = false;
const model = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  if (payload.model !== 'first-chat-fixture') return res.writeHead(400).end();
  const isChat = JSON.stringify(payload.messages).includes(question);
  tested ||= !isChat;
  chatted ||= isChat;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [delta, finish_reason] of [
    [{ role: 'assistant', content: isChat ? answer : 'Connected' }, null],
    [{}, 'stop'],
  ]) {
    const event = {
      id: 'acceptance',
      model: payload.model,
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason }],
    };
    res.write('data: ' + JSON.stringify(event) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
});
model.listen(0, '127.0.0.1');
await once(model, 'listening');
const env = { ...process.env };
for (const key of [
  'CHATDS_TEST_MODE',
  'CHATDS_TEST_DATA',
  'CHATDS_SMOKE_REPORT',
  'ELECTRON_RUN_AS_NODE',
])
  delete env[key];
const child = spawn(exe, switches, {
  env,
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let output = '';
child.stderr.on('data', (chunk) => {
  output = (output + chunk).slice(-12000);
});
let socket;
try {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !socket && child.exitCode === null) {
    const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
    if (port) {
      const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json());
      const renderer = targets.find(
        (t) =>
          t.type === 'page' && t.url.startsWith('file:') && t.url.includes('/renderer/index.html'),
      );
      if (renderer) {
        socket = new WebSocket(renderer.webSocketDebuggerUrl);
        await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
        break;
      }
    }
    await delay(150);
  }
  assert.ok(socket, 'Installed renderer did not start.');
  async function runFirstChat(endpoint, question, answer) {
    const get = (id) => document.getElementById(id);
    const visible = (id) => !!get(id)?.getClientRects().length;
    async function wait(test, label) {
      const end = Date.now() + 15000;
      while (!(await test())) {
        if (Date.now() > end) throw new Error(label);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await wait(
      () => visible('page-connections') && visible('qq-desktop-only'),
      'First-launch QQ setup missing',
    );
    get('qq-desktop-only').click();
    await wait(
      () =>
        visible('model-form') &&
        !get('model-fields').disabled &&
        get('model-status').textContent === '待配置',
      'First-launch model setup missing',
    );
    if (visible('test-badge') || visible('qq-management'))
      throw new Error('Unexpected test mode or bound QQ account');
    const change = (id, value, event) => {
      get(id).value = value;
      get(id).dispatchEvent(new Event(event, { bubbles: true }));
    };
    change('provider', 'local', 'change');
    change('base-url', endpoint, 'input');
    change('model-id', 'first-chat-fixture', 'input');
    get('model-test').click();
    await wait(
      () =>
        visible('model-summary') &&
        !get('setup-chat').disabled &&
        get('model-status').textContent.includes('验证通过'),
      'Local model verification failed',
    );
    get('setup-chat').click();
    await wait(() => visible('message') && !get('message').disabled, 'Desktop composer disabled');
    change('message', question, 'input');
    get('send').click();
    await wait(
      () =>
        [...get('messages').querySelectorAll('.bubble')].some((el) => el.textContent === answer),
      'First desktop reply missing',
    );
    return true;
  }
  const response = once(socket, 'message', { signal: AbortSignal.timeout(55000) });
  const params = ['http://127.0.0.1:' + model.address().port + '/v1', question, answer];
  socket.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: '(' + runFirstChat.toString() + ')(...' + JSON.stringify(params) + ')',
        awaitPromise: true,
        returnByValue: true,
      },
    }),
  );
  const packet = JSON.parse((await response)[0].toString());
  assert.equal(
    packet.result?.result?.value,
    true,
    packet.result?.exceptionDetails?.exception?.description ?? 'First launch checks failed.',
  );
  assert.ok(tested && chatted, 'Expected model verification and a separate desktop chat request.');
  console.log(
    JSON.stringify({
      freshProfile: true,
      normalMode: true,
      configuredFromUI: true,
      firstChat: true,
      source: scratch ? 'archive' : 'installed',
    }),
  );
} finally {
  socket?.terminate();
  if (child.exitCode === null && child.pid)
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  if (scratch) {
    const directory = await realpath(scratch);
    assert.equal(dirname(directory), await realpath(tmpdir()));
    assert.ok(basename(directory).startsWith('chatds-test-first-chat-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
