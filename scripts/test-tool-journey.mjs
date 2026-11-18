import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { digest } from '../dist/shared/util.js';
import { openDesktop } from './desktop-journey.mjs';

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 ||
    (args.length === 2 && args[0] === '--archive' && basename(args[1]) === 'app.asar'),
);
const entry = args.length ? resolve(args[1], 'dist/desktop/main.js') : undefined;
const token = randomUUID().slice(0, 8);
const fact = '我喜欢桂花茶 ' + token;
const path = 'tea-note.txt',
  content = 'Recipe on disk ' + token,
  replacement = 'Rejected ' + token;
const ingredient = '鲜桂花 ' + token;
const skillText = '---\nname: tea-journey\ndescription: A fixture tea recipe\n---\nSee recipe.txt.';
const script = "console.log(require('node:fs').readFileSync('tea-note.txt','utf8'))";
const turns = {
  companion: '看看当前开放了哪些工具',
  remember: '记住：' + fact,
  recall: '查一下记忆里我的饮品偏好',
  write: '帮我写入一份茶单',
  refuse: '提出替换茶单内容的请求',
  read: '读回刚刚的茶单',
  skill: '帮我查找技能里的茶方',
  sandbox: '在隔离环境打印茶单内容',
};
const calls = [],
  modelErrors = [];
let verified = false,
  available = false,
  seq = 0;
function messageText(message) {
  return Array.isArray(message?.content)
    ? message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
    : message?.content;
}
function answer(payload) {
  assert.equal(payload.model, 'tool-journey-local');
  const user = payload.messages.findLastIndex((m) => m.role === 'user');
  const current = messageText(payload.messages[user]);
  let text;
  try {
    text = JSON.parse(current).text;
  } catch {
    /* The model verification message is plain text. */
  }
  const turn = Object.keys(turns).find((k) => turns[k] === text);
  if (!turn) {
    assert.match(current, /请回答连接成功/);
    assert.ok(!payload.tools?.length && !verified, 'Unexpected model request outside a chat turn');
    verified = true;
    return '已连接';
  }
  const tools = payload.tools?.map((t) => t.function.name) ?? [];
  const exchange = payload.messages.slice(user + 1);
  const results = exchange.filter((m) => m.role === 'tool');
  const result = messageText(results.at(-1));
  const call = (name, args) => {
    assert.ok(tools.includes(name), 'Tool missing from model HTTP request: ' + name);
    calls.push(name);
    return { name, arguments: JSON.stringify(args) };
  };
  if (results.length) {
    const previous = exchange
      .findLast((m) => m.role === 'assistant' && m.tool_calls)
      ?.tool_calls?.at(-1);
    assert.equal(results.at(-1).tool_call_id, previous?.id);
  }
  switch (turn) {
    case 'companion':
      for (const name of ['read_file', 'write_file', 'skills_load', 'sandbox_exec'])
        assert.ok(!tools.includes(name));
      return '已核对陪伴模式权限';
    case 'remember': {
      if (!result) return call('memory_remember', { content: fact });
      const saved = JSON.parse(result);
      assert.equal(saved.content, fact);
      assert.equal(saved.scope, 'person:owner');
      assert.equal(saved.sourceIds.length, 1);
      return '已保存 ' + saved.content;
    }
    case 'recall': {
      if (!result) return call('memory_search', { query: '桂花茶' });
      const found = JSON.parse(result).find(
        (item) => item.content === fact && item.scope === 'person:owner',
      );
      assert.ok(found);
      return '查到 ' + found.content;
    }
    case 'write':
      if (!result) return call('write_file', { path, content });
      assert.deepEqual(JSON.parse(result), { saved: true, path });
      return '已写入 ' + path;
    case 'refuse':
      if (!result) return call('write_file', { path, content: replacement });
      assert.match(result, /没有获得此次操作的确认/);
      return '已收到拒绝';
    case 'read':
      if (!result) return call('read_file', { path });
      assert.equal(result, content);
      return '读回 ' + result;
    case 'skill': {
      const prompt = payload.messages
        .filter((m) => m.role === 'system' || m.role === 'developer')
        .map(messageText)
        .join('\n');
      const key = /"id":"([a-f0-9]{24})","name":"tea-journey"/.exec(prompt)?.[1];
      assert.ok(key, 'Imported skill ID missing from model prompt');
      if (!results.length) return call('skills_load', { id: key });
      if (results.length === 1) {
        assert.equal(JSON.parse(result).instruction, skillText);
        return call('skills_load', { id: key, resource: 'recipe.txt' });
      }
      assert.equal(JSON.parse(result).instruction, ingredient);
      return '配料 ' + JSON.parse(result).instruction;
    }
    case 'sandbox':
      assert.equal(tools.includes('sandbox_exec'), available);
      if (!available) return '当前没有隔离执行工具';
      if (!result) return call('sandbox_exec', { language: 'javascript', code: script });
      assert.equal(JSON.parse(result).exitCode, 0);
      assert.equal(JSON.parse(result).stdout.trim(), content);
      return '隔离环境读回 ' + JSON.parse(result).stdout.trim();
  }
}
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    let body = '';
    for await (const part of req) body += part;
    const payload = JSON.parse(body);
    const output = answer(payload);
    const id = 'call_' + ++seq;
    const tool = typeof output !== 'string';
    const first = tool
      ? { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: output }] }
      : { role: 'assistant', content: output };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finish_reason] of [
      [first, null],
      [{}, tool ? 'tool_calls' : 'stop'],
    ])
      res.write(
        'data: ' +
          JSON.stringify({
            id,
            model: payload.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n',
      );
    res.end('data: [DONE]\n\n');
  } catch (error) {
    modelErrors.push(error);
    res.writeHead(400).end('Unexpected fixture exchange');
  }
});

// Every interaction below goes through the visible ordinary renderer controls.
async function ui(action, data) {
  const $ = (selector) => document.querySelector(selector);
  const visible = (el) => !!el?.getClientRects().length;
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('UI timeout: ' + label);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  };
  const change = (selector, value, type) => {
    $(selector).value = value;
    $(selector).dispatchEvent(new Event(type, { bubbles: true }));
  };
  const nav = async (name) => {
    $('[data-page="' + name + '"]').click();
    await wait(() => visible($('#page-' + name)), name);
  };
  switch (action) {
    case 'setup':
      await wait(
        () =>
          visible($('#model-form')) &&
          !$('#model-fields').disabled &&
          $('#model-status').textContent === '待配置',
        'fresh model form',
      );
      if (visible($('#test-badge'))) throw new Error('Unexpected test mode');
      if ($('#auto-memory').checked) $('#auto-memory').click();
      change('#provider', 'local', 'change');
      change('#base-url', data, 'input');
      change('#model-id', 'tool-journey-local', 'input');
      $('#model-test').click();
      await wait(
        () =>
          visible($('#model-summary')) &&
          !$('#setup-chat').disabled &&
          $('#model-status').textContent.includes('验证通过'),
        'normal model verification',
      );
      $('#setup-chat').click();
      await wait(() => visible($('#message')) && !$('#message').disabled, 'composer');
      if ($('#mode').value !== 'companion') throw new Error('Unexpected initial conversation mode');
      break;
    case 'configure': {
      change('#mode', 'assistant', 'change');
      await nav('tools');
      const row = (tool) =>
        [...document.querySelectorAll('#tools .tool-row')]
          .find((el) => el.querySelector('code').textContent === tool)
          ?.querySelector('input');
      const enable = async (tool) => {
        const item = row(tool);
        if (!item || item.disabled) throw new Error('Tool switch unavailable: ' + tool);
        if (!item.checked) {
          item.click();
          await wait(() => !item.isConnected && row(tool)?.checked, 'save ' + tool);
        }
      };
      for (const tool of [
        'read_file',
        'write_file',
        'skills_load',
        'memory_remember',
        'memory_search',
      ])
        await enable(tool);
      $('#import-skill').click();
      await wait(() => $('#skills .skill strong')?.textContent === 'tea-journey', 'skill import');
      $('#sandbox-check').click();
      await wait(
        () =>
          !$('#sandbox-check').disabled && !$('#sandbox-detail').textContent.includes('尚未检查'),
        'sandbox probe',
      );
      const available = $('#sandbox-badge').textContent === '已准备';
      if (available) await enable('sandbox_exec');
      else if (!row('sandbox_exec')?.disabled || row('sandbox_exec').checked)
        throw new Error('Unavailable sandbox exposed');
      const reason = $('#sandbox-detail').textContent;
      await nav('chat');
      if ($('#mode').value !== 'assistant') throw new Error('Assistant mode was not saved');
      return { available, reason };
    }
    case 'send':
      await wait(() => visible($('#message')) && !$('#message').disabled, 'composer');
      change('#message', data, 'input');
      $('#send').click();
      break;
    case 'reply':
      await wait(
        () =>
          [...document.querySelectorAll('#messages .bubble')].some((b) => b.textContent === data),
        'assistant reply',
      );
      break;
    case 'approval': {
      const card = () => $('#approvals [data-approval-id]');
      await wait(
        () => visible(card()) && card().textContent.includes('桌面聊天'),
        'visible approval',
      );
      return JSON.parse(card().querySelector('pre').textContent);
    }
    case 'decide': {
      const button = [...document.querySelectorAll('#approvals button')].find(
        (b) => b.textContent === (data ? '仅允许这一次' : '拒绝'),
      );
      if (!visible(button)) throw new Error('No approval button');
      button.click();
      break;
    }
    case 'memory':
      await nav('memory');
      await wait(
        () =>
          [...document.querySelectorAll('.memory-card')].some(
            (card) =>
              card.textContent.includes('你 · 私密') &&
              card.querySelector('p').textContent === data,
          ),
        'saved private fact',
      );
      await nav('chat');
      break;
  }
}

const profile = await mkdtemp(join(tmpdir(), 'chatds-test-tools-'));
let desktop;
try {
  const source = join(profile, 'tea-skill');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), skillText);
  await writeFile(join(source, 'recipe.txt'), ingredient);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  desktop = await openDesktop(profile, entry);
  const click = async (action, data) => {
    try {
      return await desktop.evaluate(ui, action, data);
    } catch (error) {
      throw new Error('Desktop tool journey failed during ' + action, { cause: error });
    }
  };
  const chat = async (turn, expected) => {
    await click('send', turns[turn]);
    await click('reply', expected);
  };
  await click('setup', 'http://127.0.0.1:' + server.address().port + '/v1');
  await chat('companion', '已核对陪伴模式权限');
  await desktop.chooseNextFolder(source, '选择包含 SKILL.md 的技能目录');
  const sandbox = await click('configure');
  available = sandbox.available;
  await chat('remember', '已保存 ' + fact);
  await click('memory', fact);
  await chat('recall', '查到 ' + fact);
  const absolute = join(profile, 'ChatDS', 'workspaces', digest('person:owner').slice(0, 32), path);
  await click('send', turns.write);
  assert.deepEqual(await click('approval'), { path, content });
  await assert.rejects(readFile(absolute), { code: 'ENOENT' });
  await click('decide', true);
  await click('reply', '已写入 ' + path);
  assert.equal(await readFile(absolute, 'utf8'), content);
  await click('send', turns.refuse);
  assert.deepEqual(await click('approval'), { path, content: replacement });
  await click('decide', false);
  await click('reply', '已收到拒绝');
  assert.equal(await readFile(absolute, 'utf8'), content);
  await chat('read', '读回 ' + content);
  await chat('skill', '配料 ' + ingredient);
  await click('send', turns.sandbox);
  if (available) {
    assert.deepEqual(await click('approval'), { language: 'javascript', code: script });
    await click('decide', true);
  }
  await click('reply', available ? '隔离环境读回 ' + content : '当前没有隔离执行工具');
  assert.ok(verified);
  assert.deepEqual(calls, [
    'memory_remember',
    'memory_search',
    'write_file',
    'write_file',
    'read_file',
    'skills_load',
    'skills_load',
    ...(available ? ['sandbox_exec'] : []),
  ]);
  assert.deepEqual(modelErrors, []);
  const report = {
    normalDesktop: true,
    model: 'local scripted HTTP/SSE',
    fixtureFolderPicker: true,
    privateMemoryVerified: true,
    writeApproved: true,
    overwriteRejected: true,
    fileReadBack: true,
    skillBodyAndResource: true,
    sandbox: available ? 'executed' : 'unavailable',
    sandboxDetail: sandbox.reason,
    calls,
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/tool-journey.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} catch (error) {
  throw modelErrors[0] ?? error;
} finally {
  await desktop?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  assert.equal(dirname(await realpath(profile)), await realpath(tmpdir()));
  assert.ok(basename(profile).startsWith('chatds-test-tools-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
