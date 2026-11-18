import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DockerApi, DockerSandbox, sandboxSpecification } from '../tools/docker.js';
import { packTar, unpackTar } from '../tools/archive.js';
import { ModelHost, keyReference } from '../desktop/model.js';
import { defaultConfig } from '../shared/config.js';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { temporary, removeTemporary, until } from './helpers.js';
test('model requests carry exact Chinese system text and explicit DeepSeek thinking state', async (t) => {
  const payloads: any[] = [],
    headers: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const b of req) body += b;
    payloads.push(JSON.parse(body));
    headers.push(req.headers.authorization ?? '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          model: 'fixture',
          choices: [
            { index: 0, delta: { role: 'assistant', content: '连接成功' }, finish_reason: null },
          ],
        }) +
        '\n\n',
    );
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          model: 'fixture',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }) +
        '\n\n',
    );
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const profile = defaultConfig().model;
  profile.baseUrl = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/v1';
  const host = new ModelHost(() => profile, {
    get: (key) => (key === keyReference(profile) ? 'test-only-key' : undefined),
  });
  const persona = '中文提示词，不能被管道编码损坏。'.repeat(100);
  for (const thinking of ['off', 'low', 'high'] as const)
    await host.stream(
      {
        context: {
          messages: [
            { role: 'system', content: persona, timestamp: 1 },
            { role: 'user', content: '你好小鱼', timestamp: 2 },
          ],
        } as unknown as TranscriptContext,
        thinking,
      },
      () => {},
      new AbortController().signal,
    );
  assert.equal(payloads.length, 3);
  for (const p of payloads) assert.equal(p.messages[0].content, persona);
  assert.deepEqual(
    payloads.map((p) => p.thinking.type),
    ['disabled', 'enabled', 'enabled'],
  );
  assert.deepEqual(
    payloads.slice(1).map((p) => p.reasoning_effort),
    ['low', 'high'],
  );
  assert.ok(headers.every((h) => h === 'Bearer test-only-key'));
});
test('model credentials are bound to endpoint identity and redirects are refused', async (t) => {
  const profile = defaultConfig().model;
  let secondHits = 0;
  const sink = createServer((_q, r) => {
    secondHits++;
    r.end();
  });
  sink.listen(0, '127.0.0.1');
  await once(sink, 'listening');
  const redirect = createServer((_q, r) => {
    r.writeHead(302, { Location: 'http://127.0.0.1:' + (sink.address() as { port: number }).port });
    r.end();
  });
  redirect.listen(0, '127.0.0.1');
  await once(redirect, 'listening');
  t.after(async () => {
    await Promise.all([
      new Promise<void>((r) => redirect.close(() => r())),
      new Promise<void>((r) => sink.close(() => r())),
    ]);
  });
  profile.baseUrl = 'http://127.0.0.1:' + (redirect.address() as { port: number }).port;
  const original = keyReference(profile);
  const host = new ModelHost(() => profile, {
    get: (key) => (key === original ? 'fixture-secret' : undefined),
  });
  await assert.rejects(
    host.stream(
      {
        context: {
          messages: [{ role: 'user', content: 'test', timestamp: 1 }],
        } as unknown as TranscriptContext,
      },
      () => {},
      AbortSignal.timeout(3000),
    ),
  );
  assert.equal(secondHits, 0);
  profile.baseUrl = 'https://different.example';
  assert.notEqual(keyReference(profile), original);
  await assert.rejects(
    host.stream(
      { context: { messages: [] } as unknown as TranscriptContext },
      () => {},
      AbortSignal.timeout(1000),
    ),
    /API Key/,
  );
});
function frame(text: string, stream = 1) {
  const b = Buffer.from(text),
    header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(b.length, 4);
  return Buffer.concat([header, b]);
}
test('Docker jobs use isolated anonymous volumes, fixed image ID, quotas, and guaranteed deletion', async (t) => {
  const directory = temporary();
  await mkdir(join(directory, 'workspace'));
  await writeFile(join(directory, 'workspace', 'input.txt'), 'source');
  let spec: any;
  let removed = 0;
  let inputs: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const b of req) chunks.push(b);
    const body = Buffer.concat(chunks),
      url = req.url ?? '';
    res.setHeader('Content-Type', 'application/json');
    if (url === '/info') res.end(JSON.stringify({ OSType: 'linux' }));
    else if (url.startsWith('/images/'))
      res.end(
        JSON.stringify({
          Id: 'sha256:' + '1'.repeat(64),
          Config: { Labels: { 'org.chatds.sandbox.version': '1' } },
        }),
      );
    else if (url.startsWith('/containers/create')) {
      spec = JSON.parse(body.toString());
      res.end(JSON.stringify({ Id: 'a'.repeat(64) }));
    } else if (req.method === 'PUT') {
      inputs = unpackTar(body, 8 * 1024 * 1024).map((f) => f.name);
      res.end();
    } else if (url.includes('/wait'))
      res.end(JSON.stringify({ StatusCode: spec.Cmd[0] === 'python3' ? 5 : 0 }));
    else if (url.includes('/logs'))
      res.end(spec.Cmd[0] === 'python3' ? frame('脚本错误', 2) : frame('完成'));
    else if (
      req.method === 'GET' &&
      url === '/containers/' + 'a'.repeat(64) + '/archive?path=%2Fworkspace%2Fanswer.txt'
    )
      res.end(packTar([{ name: 'answer.txt', data: Buffer.from('abc') }]));
    else if (req.method === 'GET' && url.includes('/archive?')) {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'File not found' }));
    } else if (req.method === 'DELETE') {
      removed++;
      res.end();
    } else res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const api = new DockerApi('unused', (server.address() as { port: number }).port),
    sandbox = new DockerSandbox(() => defaultConfig().sandbox, directory, api);
  t.after(async () => {
    await sandbox.close();
    await new Promise<void>((r) => server.close(() => r()));
    removeTemporary(directory);
  });
  assert.equal((await sandbox.check()).available, true);
  const result = (await sandbox.execute(
    join(directory, 'workspace'),
    { language: 'javascript', code: 'console.log(1)', outputs: ['answer.txt'] },
    new AbortController().signal,
  )) as { stdout: string; outputs: unknown[] };
  assert.equal(result.stdout, '完成');
  assert.deepEqual(result.outputs, [
    {
      path: 'answer.txt',
      text: 'abc',
      bytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    },
  ]);
  assert.deepEqual(spec.Cmd, ['node', '--disable-proto=throw', '--eval', 'console.log(1)']);
  assert.deepEqual(inputs, ['input.txt']);
  assert.equal(removed, 1);
  assert.equal(sandbox.stats.containers, 0);
  assert.equal(spec.Image, 'sha256:' + '1'.repeat(64));
  assert.equal(spec.User, '10001:10001');
  assert.equal(spec.HostConfig.NetworkMode, 'none');
  assert.equal(spec.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(spec.HostConfig.CapDrop, ['ALL']);
  assert.equal(spec.HostConfig.Mounts[0].Type, 'volume');
  assert.equal(spec.HostConfig.Binds, undefined);
  assert.ok(!JSON.stringify(spec.Env).match(/key|token|secret/i));
  const failure = (await sandbox.execute(
    join(directory, 'workspace'),
    { language: 'python', code: 'raise SystemExit(5)' },
    new AbortController().signal,
  )) as { stdout: string; stderr: string; exitCode: number };
  assert.deepEqual(spec.Cmd, ['python3', '-I', '-c', 'raise SystemExit(5)']);
  assert.equal(failure.exitCode, 5);
  assert.equal(failure.stdout, '');
  assert.equal(failure.stderr, '脚本错误');
  await assert.rejects(
    sandbox.execute(
      join(directory, 'workspace'),
      { language: 'javascript', code: '', outputs: ['missing.txt'] },
      new AbortController().signal,
    ),
    /HTTP 404/,
  );
  assert.equal(removed, 3);
  assert.equal(sandbox.stats.containers, 0);
});
test('Docker cancellation also removes a container whose wait request was interrupted', async (t) => {
  const directory = temporary();
  await mkdir(join(directory, 'work'));
  let waiting = false,
    removed = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    const url = req.url ?? '';
    if (url === '/info') res.end(JSON.stringify({ OSType: 'linux' }));
    else if (url.startsWith('/images/'))
      res.end(
        JSON.stringify({
          Id: 'sha256:' + '1'.repeat(64),
          Config: { Labels: { 'org.chatds.sandbox.version': '1' } },
        }),
      );
    else if (url.startsWith('/containers/create')) res.end(JSON.stringify({ Id: 'b'.repeat(64) }));
    else if (url.startsWith('/containers/json?'))
      res.end(
        JSON.stringify([...(removed ? [] : [{ Id: 'b'.repeat(64) }]), { Id: 'c'.repeat(64) }]),
      );
    else if (url.includes('/wait')) {
      waiting = true;
      req.on('close', () => res.destroy());
    } else if (req.method === 'DELETE') {
      removed++;
      res.end();
    } else res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const sandbox = new DockerSandbox(
    () => defaultConfig().sandbox,
    directory,
    new DockerApi('unused', (server.address() as { port: number }).port),
  );
  t.after(async () => {
    await sandbox.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    removeTemporary(directory);
  });
  await sandbox.check();
  const controller = new AbortController(),
    run = sandbox.execute(
      join(directory, 'work'),
      { language: 'python', code: 'pass' },
      controller.signal,
    );
  await until(() => waiting);
  assert.equal((await sandbox.check()).available, true);
  await sandbox.reap();
  assert.equal(removed, 0, 'checking the environment must preserve the executing job');
  assert.equal(sandbox.stats.containers, 1);
  controller.abort();
  await assert.rejects(run);
  assert.equal(removed, 1);
  assert.equal(sandbox.stats.containers, 0);
  await sandbox.reap();
  assert.equal(removed, 2, 'the next idle check reclaims abandoned containers');
});
test('archive decoder rejects traversal, symlinks, corrupt sizes and checksum changes', () => {
  const tar = packTar([{ name: 'answer.txt', data: Buffer.from('safe') }]);
  assert.equal(unpackTar(tar)[0]?.data.toString(), 'safe');
  assert.throws(() => packTar([{ name: '../escape', data: Buffer.from('x') }]));
  const corrupt = Buffer.from(tar);
  corrupt[0] = 0;
  assert.throws(() => unpackTar(corrupt));
  const link = Buffer.from(tar);
  link[156] = 50;
  assert.throws(() => unpackTar(link));
});
