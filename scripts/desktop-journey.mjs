import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import electron from 'electron';
import WebSocket from 'ws';

// The window, IPC, worker, broker and model client all run in the ordinary application.
// Only the OS profile, window focus and optional native folder selection are controlled.
export async function openDesktop(
  profileDir,
  entry = resolve('dist/desktop/main.js'),
  { blockQzone = false } = {},
) {
  const profile = await realpath(profileDir);
  assert.equal(dirname(profile), await realpath(tmpdir()));
  assert.ok(basename(profile).startsWith('chatds-test-'), 'Expected an isolated temporary profile');
  const launcher = join(profile, 'journey-entry.cjs');
  const failure = join(profile, 'journey-start-error.json');
  const selection = join(profile, 'journey-folder.json');
  await writeFile(
    launcher,
    [
      "const {app, dialog} = require('electron');",
      "const fs = require('node:fs');",
      "app.setPath('appData', __dirname);",
      "app.setPath('userData', __dirname);",
      "app.on('browser-window-created', (_, win) => { win.setFocusable(false); win.setSkipTaskbar(true); win.setPosition(-32000,-32000,false); });",
      'const picker = ' + JSON.stringify(selection) + ';',
      'dialog.showOpenDialog = async (_, options) => {',
      '  if (!fs.existsSync(picker)) return {canceled:true, filePaths:[]};',
      "  const {title, path} = JSON.parse(fs.readFileSync(picker, 'utf8'));",
      "  if (title !== options.title || !options.properties?.includes('openDirectory')) throw new Error('Unexpected directory dialog');",
      '  fs.unlinkSync(picker);',
      '  return {canceled:false, filePaths:[path]};',
      '};',
      ...(blockQzone
        ? [
            'const fetchNormally = globalThis.fetch;',
            'globalThis.fetch = (input, init) => {',
            "  if (new URL(input?.url ?? input).hostname === 'user.qzone.qq.com') {",
            '    fs.appendFileSync(' +
              JSON.stringify(join(profile, 'qzone-fetch-attempts.log')) +
              ", 'blocked\\n');",
            "    throw new Error('External Qzone fetch blocked in this journey');",
            '  }',
            '  return fetchNormally(input, init);',
            '};',
          ]
        : []),
      "require('node:readline').createInterface({input: process.stdin}).on('line', line => { if (line === 'quit') app.quit(); });",
      'import(' +
        JSON.stringify(pathToFileURL(resolve(entry)).href) +
        ').catch(error => {fs.writeFileSync(' +
        JSON.stringify(failure) +
        ', JSON.stringify({name:error.name, code:error.code})); app.exit(1);});',
    ].join('\n'),
  );
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (/^(CHATDS_TEST_|CHATDS_SMOKE_|ELECTRON_RUN_AS_NODE$)|_API_KEY$/i.test(key)) delete env[key];
  const child = spawn(
    electron,
    ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', launcher],
    {
      env,
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  let output = '',
    socket,
    id = 0;
  child.stderr.on('data', (chunk) => {
    output = (output + chunk).slice(-16000);
  });
  child.stdin.on('error', () => {});
  const exited = once(child, 'exit').catch(() => {});
  const pending = new Map();
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const seq = ++id;
      const timer = setTimeout(() => {
        pending.delete(seq);
        reject(new Error('Renderer command timed out: ' + method));
      }, 150000);
      pending.set(seq, (packet) => {
        clearTimeout(timer);
        if (packet.error)
          reject(
            new Error(
              'Renderer command failed: ' + method + ' (' + (packet.error.code ?? 'closed') + ')',
            ),
          );
        else resolve(packet.result);
      });
      socket.send(JSON.stringify({ id: seq, method, params }));
    });
  }
  async function close() {
    socket?.terminate();
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    child.stdin.end('quit\n');
    const stopped = await Promise.race([
      exited.then(() => true),
      delay(8000, false, { ref: false }),
    ]);
    if (!stopped && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32')
        execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      else child.kill('SIGKILL');
      await exited;
    }
  }
  try {
    const end = Date.now() + 45000;
    while (Date.now() < end && child.exitCode === null && !socket) {
      const port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
      if (port) {
        const targets = await fetch('http://127.0.0.1:' + port + '/json/list', {
          signal: AbortSignal.timeout(1500),
        })
          .then((r) => r.json())
          .catch(() => []);
        const page = targets.find(
          (t) =>
            t.type === 'page' &&
            t.url.startsWith('file:') &&
            t.url.includes('/renderer/index.html'),
        );
        if (page) {
          socket = new WebSocket(page.webSocketDebuggerUrl);
          await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
          socket.on('message', (data) => {
            const packet = JSON.parse(data.toString());
            pending.get(packet.id)?.(packet);
            pending.delete(packet.id);
          });
          socket.on('close', () => {
            for (const finish of pending.values()) finish({ error: true });
            pending.clear();
          });
          break;
        }
      }
      await delay(100);
    }
    if (!socket) {
      const reason = await readFile(failure, 'utf8').catch(() => '');
      throw new Error(
        'Normal desktop renderer did not start (process exit ' + child.exitCode + ') ' + reason,
      );
    }
    while (true) {
      const page = await rpc('Runtime.evaluate', {
        expression:
          "document.readyState === 'complete' && location.pathname.endsWith('/renderer/index.html') && !!document.getElementById('chat-name')",
        returnByValue: true,
      }).catch(() => undefined);
      if (page?.result?.value) break;
      if (Date.now() >= end) throw new Error('Desktop renderer did not finish navigation');
      await delay(75);
    }
    return {
      async evaluate(fn, ...args) {
        const packet = await rpc('Runtime.evaluate', {
          expression: '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')',
          awaitPromise: true,
          returnByValue: true,
        });
        if (packet.exceptionDetails) {
          let message = (
            packet.exceptionDetails.exception?.description ?? 'Renderer evaluation failed'
          ).split('\n')[0];
          JSON.stringify(args, (_key, value) => {
            if (typeof value === 'string' && value)
              message = message.replaceAll(value, '[argument]');
            return value;
          });
          throw new Error(message);
        }
        return packet.result?.value;
      },
      async screenshot(path) {
        const { data } = await rpc('Page.captureScreenshot', { format: 'png' });
        await writeFile(path, Buffer.from(data, 'base64'));
      },
      async insertText(text) {
        await rpc('Input.insertText', { text });
      },
      async chooseNextFolder(path, title) {
        const chosen = await realpath(path);
        const rel = relative(profile, chosen);
        assert.ok(
          rel && !rel.startsWith('..') && !isAbsolute(rel),
          'Expected a fixture inside the isolated profile',
        );
        await writeFile(selection, JSON.stringify({ path: chosen, title }), { flag: 'wx' });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
