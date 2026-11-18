import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { openDesktop } from './desktop-journey.mjs';
import { startQQFixture } from './smoke-qq.mjs';

const { values } = parseArgs({ options: { archive: { type: 'string' } } });
const archive = values.archive && resolve(values.archive);
const entry = archive && join(archive, 'dist/desktop/main.js');
const nickname = '本机验收用户';
const userId = 10002;
const question = '小鱼，今天的车票放在哪里了？';
const answer = '车票夹在蓝色笔记本里。';
const post = '今天的雨落在窗沿上。';
const publishPrompt = '帮我在 QQ 空间发一条说说，正文是：' + post;
const deniedAnswer = '已取消，这条说说没有发布。';
const requests = [];
const model = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return res.writeHead(404).end();
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  if (payload.model !== 'qq-fixture') return res.writeHead(400).end();
  const userIndex = payload.messages.findLastIndex((m) => m.role === 'user');
  const user = JSON.stringify(payload.messages[userIndex]);
  const tools = payload.tools?.map((tool) => tool.function.name) ?? [];
  const toolResult = payload.messages.slice(userIndex + 1).find((m) => m.role === 'tool');
  let content, call;
  if (user.includes('请回答连接成功') && !tools.length) {
    requests.push('model verification');
    content = '连接成功';
  } else if (user.includes(question) && tools.includes('chat_reply')) {
    requests.push('QQ private chat');
    call = { name: 'chat_reply', arguments: JSON.stringify({ text: answer }) };
  } else if (user.includes(publishPrompt) && tools.includes('qzone_publish') && !toolResult) {
    requests.push('publish approval request');
    call = { name: 'qzone_publish', arguments: JSON.stringify({ content: post }) };
  } else if (
    user.includes(publishPrompt) &&
    toolResult?.tool_call_id === 'fixture-qzone_publish' &&
    JSON.stringify(toolResult.content).includes('没有获得此次操作的确认')
  ) {
    requests.push('publish denial returned to model');
    content = deniedAnswer;
  } else return res.writeHead(422).end();
  const delta = call
    ? {
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'fixture-' + call.name, type: 'function', function: call }],
      }
    : { role: 'assistant', content };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [part, reason] of [
    [delta, null],
    [{}, call ? 'tool_calls' : 'stop'],
  ]) {
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'qq-chat-fixture',
          model: payload.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: part, finish_reason: reason }],
        }) +
        '\n\n',
    );
  }
  res.end('data: [DONE]\n\n');
});

let app, qq;
async function waitFor(label, test) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await delay(120);
  }
  const status = await app.evaluate(() =>
    ['page-title', 'qq-error', 'notice', 'napcat-state', 'chat-phase', 'model-result']
      .map((id) => document.getElementById(id)?.innerText)
      .filter(Boolean)
      .join(' / '),
  );
  throw new Error(label + ' timed out. UI: ' + status);
}
function waitVisible(selector, text) {
  return waitFor(selector, () =>
    app.evaluate(
      (s, expected) => {
        const node = document.querySelector(s);
        return (
          !!node?.getClientRects().length && (!expected || node.textContent.includes(expected))
        );
      },
      selector,
      text ?? '',
    ),
  );
}
function click(selector) {
  return app.evaluate((s) => {
    const node = document.querySelector(s);
    if (!node?.getClientRects().length || node.matches(':disabled'))
      throw new Error('Unavailable: ' + s);
    node.click();
  }, selector);
}
function fill(selector, value) {
  return app.evaluate(
    (s, text) => {
      const node = document.querySelector(s);
      if (!node?.getClientRects().length || node.matches(':disabled'))
        throw new Error('Unavailable: ' + s);
      node.value = text;
      node.dispatchEvent(
        new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
      );
    },
    selector,
    value,
  );
}
async function checkConversation() {
  await waitVisible('[data-page="chat"]');
  await click('[data-page="chat"]');
  await waitVisible('#rooms button', nickname);
  await click('#rooms button');
  await waitVisible('#chat-name', nickname);
  const history = await waitFor('QQ conversation with both messages and final delivery', () =>
    app.evaluate(
      (q, a) => {
        const user = [...document.querySelectorAll('#messages .user .bubble')].map(
          (e) => e.textContent,
        );
        const assistant = [...document.querySelectorAll('#messages .assistant .bubble')].map(
          (e) => e.textContent,
        );
        const phase = document.querySelector('#chat-phase').textContent;
        if (
          phase !== '空闲' ||
          user.length !== 1 ||
          assistant.length !== 1 ||
          user[0] !== q ||
          assistant[0] !== a
        )
          return null;
        if (document.querySelector('#messages .delivery'))
          throw new Error('Failed or unknown delivery');
        return { user, assistant, phase };
      },
      question,
      answer,
    ),
  );
  return history;
}

async function denyPublish(output) {
  await click('#local-room');
  await waitVisible('#chat-name', '桌面聊天');
  await fill('#mode', 'assistant');
  await click('[data-page="tools"]');
  await waitVisible('#tool-qzone_publish');
  assert.equal(
    await app.evaluate(() => document.querySelector('#tool-qzone_publish').checked),
    false,
  );
  await click('#tool-qzone_publish');
  await click('[data-page="chat"]');
  await waitFor('desktop assistant mode', () =>
    app.evaluate(() => document.querySelector('#mode').value === 'assistant'),
  );
  await fill('#message', publishPrompt);
  await click('#send');
  await waitVisible('#approvals .approval', '发布到 QQ 10001 的空间');
  const approval = await app.evaluate(() => {
    const card = document.querySelector('#approvals .approval');
    return {
      target: card.querySelector('small').textContent,
      args: JSON.parse(card.querySelector('pre').textContent),
    };
  });
  assert.equal(approval.target, '来自桌面聊天 · 发布到 QQ 10001 的空间');
  assert.deepEqual(approval.args, { content: post });
  await app.screenshot(join(output, '05-publish-approval.png'));
  await app.evaluate(() => {
    const deny = [...document.querySelectorAll('#approvals button')].find(
      (el) => el.textContent === '拒绝',
    );
    if (!deny?.getClientRects().length || deny.disabled) throw new Error('No visible deny button');
    deny.click();
  });
  await waitVisible('#messages .assistant .bubble', deniedAnswer);
  await waitVisible('#chat-phase', '空闲');
  await app.screenshot(join(output, '06-publish-denied.png'));
  return approval;
}

const profile = await mkdtemp(join(tmpdir(), 'chatds-test-qq-chat-'));
await mkdir('test-results', { recursive: true });
const output = await mkdtemp(join(resolve('test-results'), 'qq-journey-'));
try {
  const archiveSha256 =
    archive &&
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
  qq = await startQQFixture({ autoConfirm: false });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const fetchLog = join(profile, 'qzone-fetch-attempts.log');
  await writeFile(fetchLog, '', { flag: 'wx' });
  app = await openDesktop(profile, entry, { blockQzone: true });
  await waitVisible('#model-status', '待配置');
  assert.equal(
    await app.evaluate(() => !!document.querySelector('#test-badge').getClientRects().length),
    false,
  );
  await fill('#provider', 'local');
  await fill('#base-url', 'http://127.0.0.1:' + model.address().port + '/v1');
  await fill('#model-id', 'qq-fixture');
  await click('#model-test');
  await waitVisible('#model-status', '验证通过');
  await click('#setup-qq');
  await click('#napcat-alternative summary');
  await fill('#napcat-link', 'http://127.0.0.1:' + qq.port + '/webui?token=fixture');
  await click('#napcat-link-form button');
  const qrWidth = await waitFor('decoded QR image', () =>
    app.evaluate(() => {
      const qr = document.querySelector('#napcat-qr');
      return (
        qr.getClientRects().length && qr.src.startsWith('data:image/png;base64,') && qr.naturalWidth
      );
    }),
  );
  await app.screenshot(join(output, '01-qr.png'));
  qq.advanceLogin();
  await waitVisible('#napcat-state', '在手机 QQ 上确认');
  qq.advanceLogin();
  await waitVisible('#napcat-state', '已登录机器人 QQ 10001');
  await fill('#napcat-owner', String(userId));
  await click('#napcat-finish');
  await waitVisible('#qq-status', 'QQ 在线');
  await waitVisible('#qq-account', '主号 ' + userId);
  await app.screenshot(join(output, '02-bound.png'));
  qq.privateMessage({ userId, nickname, text: question, messageId: 50001 });
  await waitFor('outbound OneBot action', () => qq.sends.length);
  assert.equal(qq.sends[0].params.user_id, userId);
  assert.deepEqual(qq.sends[0].params.message, [{ type: 'text', data: { text: answer } }]);
  const live = await checkConversation();
  await app.screenshot(join(output, '03-chat.png'));
  const checksBeforeRestart = qq.accountChecks;
  await app.close();
  app = undefined;
  app = await openDesktop(profile, entry, { blockQzone: true });
  const restored = await checkConversation();
  assert.deepEqual(restored, live);
  assert.ok(qq.accountChecks > checksBeforeRestart, 'Restart did not verify the QQ account again');
  assert.equal(qq.sends.length, 1, 'Unexpected duplicate delivery');
  assert.deepEqual(requests, ['model verification', 'QQ private chat']);
  await app.screenshot(join(output, '04-restarted.png'));
  const approval = await denyPublish(output);
  assert.deepEqual(requests.slice(2), [
    'publish approval request',
    'publish denial returned to model',
  ]);
  const cookieRequests = qq.actions.filter((action) => action === 'get_cookies').length;
  assert.equal(cookieRequests, 0);
  assert.equal(await readFile(fetchLog, 'utf8'), '', 'Unexpected outbound Qzone fetch');
  assert.equal(qq.sends.length, 1);
  const report = {
    passed: true,
    source: archive || resolve('dist/desktop/main.js'),
    archiveSha256,
    freshProfile: true,
    normalMode: true,
    simulatedServices: ['NapCat WebUI and phone login', 'OneBot v11', 'local model'],
    login: { qrWidth, phoneConfirmationPromptSeen: true, bot: 10001, owner: userId },
    requests,
    toolCall: 'chat_reply',
    accountChecks: qq.accountChecks,
    acknowledged: qq.sends,
    historyBeforeRestart: live,
    historyAfterRestart: restored,
    qzone: {
      approval,
      decision: 'denied',
      modelReceivedDenial: true,
      cookieRequests,
      publishFetchAttempts: 0,
    },
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, report: join(output, 'report.json') }));
} catch (error) {
  const failure = {
    passed: false,
    source: archive || resolve('dist/desktop/main.js'),
    error: error.message,
    requests,
    observedActions: qq?.sends ?? [],
  };
  await writeFile(join(output, 'report.json'), JSON.stringify(failure, null, 2) + '\n');
  console.error(JSON.stringify({ passed: false, report: join(output, 'report.json') }));
  throw error;
} finally {
  await app?.close();
  qq?.close();
  model.closeAllConnections();
  if (model.listening) await new Promise((done) => model.close(done));
  const directory = await realpath(profile);
  assert.equal(dirname(directory), await realpath(tmpdir()));
  assert.ok(basename(directory).startsWith('chatds-test-qq-chat-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
