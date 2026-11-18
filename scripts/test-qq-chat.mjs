import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { openDesktop } from './desktop-journey.mjs';
import { startQQFixture } from './smoke-qq.mjs';

const { values } = parseArgs({
  options: { archive: { type: 'string' }, 'napcat-zip': { type: 'string' } },
});
const archive = values.archive && resolve(values.archive);
const entry = archive && join(archive, 'dist/desktop/main.js');
const nickname = '本机验收用户';
const userId = 10002;
const question = '小鱼，今天的车票放在哪里了？';
const answer = '车票夹在蓝色笔记本里。';
const friendId = 10003;
const friendName = '普通好友';
const friendAnswer = '我在，想聊些什么？';
const groupId = 31001;
const poolQuestion = '你那个小水池一般拿来干什么呀？';
const clarification = '我是说，除了游泳的时候。';
const poolReply = '发呆呀，坐在边上晃脚，偶尔还会看雨点掉进去。';
const groupBatches = [];
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
  } else if (
    user.includes('/状态') &&
    user.includes('qq:' + friendId) &&
    tools.includes('chat_reply')
  ) {
    requests.push('ordinary friend without owner');
    call = { name: 'chat_reply', arguments: JSON.stringify({ text: friendAnswer }) };
  } else if (user.includes(question) && tools.includes('chat_reply')) {
    requests.push('QQ private chat');
    call = { name: 'chat_reply', arguments: JSON.stringify({ text: answer }) };
  } else if (user.includes(poolQuestion) && tools.includes('chat_reply')) {
    requests.push('QQ group chat');
    const message = payload.messages[userIndex].content;
    const text = Array.isArray(message) ? message.map((part) => part.text).join('') : message;
    groupBatches.push(
      text.split('\n').map((line) => {
        const { name, text, actor, trigger, mention, channel } = JSON.parse(line);
        return { name, text, actor, trigger, mention, channel };
      }),
    );
    call = { name: 'chat_reply', arguments: JSON.stringify({ text: poolReply }) };
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
  } else {
    requests.push('unexpected model request');
    return res.writeHead(422).end();
  }
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
async function waitFor(label, test, timeout = 20000) {
  const deadline = Date.now() + timeout;
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
async function checkConversation(name = nickname, q = question, a = answer) {
  await waitVisible('[data-page="chat"]');
  await click('[data-page="chat"]');
  await waitFor('private room ' + name, () =>
    app.evaluate((name) => {
      const button = [...document.querySelectorAll('#rooms button')].find(
        (el) => el.querySelector('strong')?.textContent === name,
      );
      if (!button?.getClientRects().length) return false;
      button.click();
      return true;
    }, name),
  );
  await waitVisible('#chat-name', name);
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
      q,
      a,
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

async function checkGroup(output) {
  await click('[data-page="connections"]');
  await waitVisible('#qq-groups');
  await fill('#qq-groups', String(groupId));
  await click('#qq-access button');
  await waitVisible('#notice', '聊天名单已保存');
  const start = requests.length;
  const count = qq.sends.length;
  const muzi = { groupId, userId: 20003, nickname: '木子' };
  const azhu = { groupId, userId: 20002, nickname: '阿竹' };
  qq.message({ ...muzi, messageId: 51001, mention: 10001, text: poolQuestion });
  qq.message({ ...muzi, messageId: 51002, text: clarification });
  await waitFor('send_group_msg', () => qq.sends.length > count);
  const sent = qq.sends[count];
  assert.equal(sent.action, 'send_group_msg');
  assert.deepEqual(sent.params, {
    group_id: groupId,
    message: [{ type: 'text', data: { text: poolReply } }],
  });
  const author = { name: '木子', actor: 'qq:20003', channel: 'QQ群' };
  assert.deepEqual(groupBatches, [
    [
      { ...author, text: poolQuestion, trigger: 'direct', mention: true },
      { ...author, text: clarification, trigger: 'continuation', mention: false },
    ],
  ]);
  await click('[data-page="chat"]');
  const title = '群聊 ' + groupId;
  await waitFor('whitelisted group conversation', () =>
    app.evaluate((name) => {
      const room = [...document.querySelectorAll('#rooms button')].find(
        (b) => b.querySelector('strong')?.textContent === name,
      );
      if (!room?.getClientRects().length) return false;
      room.click();
      return true;
    }, title),
  );
  await waitVisible('#chat-name', title);
  await waitVisible('#messages .assistant .bubble', poolReply);
  await waitVisible('#chat-phase', '空闲');
  await click('#ambient');
  // Reopen the room so the checkbox reflects saved settings before testing other-directed mentions.
  await click('#local-room');
  await app.evaluate((name) => {
    [...document.querySelectorAll('#rooms button')]
      .find((b) => b.querySelector('strong')?.textContent === name)
      .click();
  }, title);
  await waitFor('group ambient replies enabled', () =>
    app.evaluate(() => document.querySelector('#ambient').checked),
  );
  const busQuestion = '阿竹，明天那班车改几点了？';
  const busAnswer = '七点半，还是老地方见。';
  qq.message({ ...muzi, messageId: 51003, mention: azhu.userId, text: busQuestion });
  qq.message({ ...azhu, messageId: 51004, mention: muzi.userId, text: busAnswer });
  await waitFor('both group members visible', () =>
    app.evaluate(
      (text) =>
        [...document.querySelectorAll('#messages .user .bubble')].some(
          (bubble) => bubble.textContent === text,
        ),
      busAnswer,
    ),
  );
  // Observe longer than the normal group's eight-second maximum collection window.
  await delay(8500);
  const transcript = await app.evaluate(() =>
    [...document.querySelectorAll('#messages .message')].map((r) => ({
      name: r.querySelector('.message-name').textContent,
      text: r.querySelector('.bubble').textContent,
    })),
  );
  assert.deepEqual(transcript, [
    { name: '木子', text: poolQuestion },
    { name: '木子', text: clarification },
    { name: '小鱼', text: poolReply },
    { name: '木子', text: busQuestion },
    { name: '阿竹', text: busAnswer },
  ]);
  assert.deepEqual(requests.slice(start), ['QQ group chat']);
  assert.equal(qq.sends.length - count, 1);
  await app.screenshot(join(output, '07-pool-group.png'));
  return {
    groupId,
    transcript,
    modelBatches: groupBatches,
    ambientEnabled: true,
    quietObservationMs: 8500,
  };
}

const profile = await mkdtemp(join(tmpdir(), 'chatds-test-qq-chat-'));
await mkdir('test-results', { recursive: true });
const output = await mkdtemp(join(resolve('test-results'), 'qq-journey-'));
async function checkZipImport(source) {
  const zipProfile = await mkdtemp(join(tmpdir(), 'chatds-test-qq-chat-zip-'));
  let managedPeer;
  try {
    const input = join(zipProfile, 'NapCat.Shell.zip');
    await copyFile(source, input);
    const sha256 = createHash('sha256')
      .update(await readFile(input))
      .digest('hex');
    assert.equal(sha256, '02e5ff0f79916c1e04c81c1b4590056406fb4293f1f1300c955e71fd08b2829d');
    app = await openDesktop(zipProfile, entry, { captureNapcatLaunch: true });
    await waitVisible('#napcat-import-zip');
    await app.chooseNextFile(input, '选择 NapCat.Shell.zip');
    await click('#napcat-import-zip');
    const record = await waitFor(
      'managed NapCat startup request',
      async () => {
        const file = await readFile(join(zipProfile, 'journey-napcat-launch.jsonl'), 'utf8').catch(
          (error) => {
            if (error.code !== 'ENOENT') throw error;
            return '';
          },
        );
        if (file.trim()) return JSON.parse(file.trim().split('\n')[0]);
        const missing = await app.evaluate(() =>
          /未找到已安装的 Windows QQ|安装或修复 QQ NT/.test(document.body.innerText),
        );
        return missing && { missingQQ: true };
      },
      90000,
    );
    const expected = join(zipProfile, 'ChatDS', 'napcat-packages', '4.18.42');
    assert.ok((await stat(join(expected, 'napcat.mjs'))).size > 0);
    const webui = JSON.parse(await readFile(join(expected, 'config', 'webui.json'), 'utf8'));
    assert.equal(webui.host, '127.0.0.1');
    assert.ok(Number.isInteger(webui.port) && webui.port > 0 && webui.port !== 6099);
    assert.ok(typeof webui.token === 'string' && webui.token.length >= 32);
    if (!record.missingQQ) {
      assert.equal(await realpath(record.cwd), await realpath(expected));
      assert.ok((await stat(join(expected, record.script))).isFile());
      managedPeer = await startQQFixture({
        port: webui.port,
        token: webui.token,
        autoConfirm: false,
      });
      await waitFor(
        'QR from imported Shell profile',
        () =>
          app.evaluate(() => {
            const img = document.querySelector('#napcat-qr');
            return img?.getClientRects().length && img.naturalWidth > 0;
          }),
        60000,
      );
    }
    await waitVisible('#napcat-directory', expected);
    await app.screenshot(join(output, '08-imported-shell.png'));
    return {
      version: '4.18.42',
      sha256,
      managedDirectory: 'napcat-packages/4.18.42',
      interceptedLauncher: record.script,
      qqClientMissing: !!record.missingQQ,
      simulatedManagedQR: !!managedPeer,
    };
  } finally {
    await app?.close();
    managedPeer?.close();
    app = undefined;
    const target = await realpath(zipProfile);
    assert.ok(
      dirname(target) === (await realpath(tmpdir())) &&
        basename(target).startsWith('chatds-test-qq-chat-zip-'),
    );
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
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
  await waitVisible('#page-connections');
  await waitVisible('#qq-desktop-only');
  await waitVisible('#napcat-installation');
  await waitVisible('#napcat-import-zip');
  await waitVisible('#napcat-download');
  assert.equal(
    await app.evaluate(() => !!document.querySelector('#test-badge').getClientRects().length),
    false,
  );
  await app.screenshot(join(output, '00-setup.png'));
  const runningFolder = join(profile, 'NapCat fixture');
  await mkdir(join(runningFolder, 'config'), { recursive: true });
  await writeFile(
    join(runningFolder, 'config', 'webui.json'),
    JSON.stringify({
      host: '127.0.0.1',
      port: qq.port,
      token: 'fixture',
    }),
  );
  await app.chooseNextFolder(runningFolder, '选择本机 NapCat 安装目录');
  await click('#napcat-installation');
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
  await waitVisible('[data-page="connections"]');
  await click('[data-page="connections"]');
  await waitVisible('#qq-status', 'QQ 在线');
  await waitVisible('#qq-owner-manage');
  assert.equal(await app.evaluate(() => document.querySelector('#qq-owner-manage').value), '');
  await app.screenshot(join(output, '02-bound-without-owner.png'));
  const firstAccountChecks = qq.accountChecks;
  await app.close();
  app = await openDesktop(profile, entry, { blockQzone: true });
  await waitVisible('[data-page="connections"]');
  await click('[data-page="connections"]');
  await waitVisible('#qq-status', 'QQ 在线');
  assert.ok(qq.accountChecks > firstAccountChecks);
  assert.equal(await app.evaluate(() => document.querySelector('#qq-owner-manage').value), '');
  await click('[data-page="settings"]');
  await waitVisible('#model-status', '待配置');
  await fill('#provider', 'local');
  await fill('#base-url', 'http://127.0.0.1:' + model.address().port + '/v1');
  await fill('#model-id', 'qq-fixture');
  await click('#model-test');
  await waitVisible('#model-status', '验证通过');
  if (await app.evaluate(() => document.querySelector('#auto-memory').checked))
    await click('#auto-memory');
  qq.message({ userId, nickname, subType: 'other', text: '/状态', messageId: 49998 });
  qq.message({ userId, nickname, subType: 'other', text: '空主号陌生私聊', messageId: 49999 });
  qq.message({ userId: friendId, nickname: friendName, text: '/状态', messageId: 50000 });
  await click('[data-page="chat"]');
  await waitVisible('#room-connect');
  await checkConversation(friendName, '/状态', friendAnswer);
  assert.deepEqual(requests, ['model verification', 'ordinary friend without owner']);
  assert.equal(qq.sends.length, 1);
  assert.equal(qq.sends[0].params.user_id, friendId);
  assert.equal(await app.evaluate(() => document.querySelectorAll('#rooms button').length), 1);
  await click('#room-connect');
  await waitVisible('#qq-owner-manage');
  await fill('#qq-owner-manage', String(userId));
  await click('#qq-owner-form button[type="submit"]');
  await waitVisible('#qq-account', '主号 ' + userId);
  await app.screenshot(join(output, '02-bound.png'));
  qq.message({ userId, nickname, text: question, messageId: 50001 });
  await waitFor('outbound owner chat action', () => qq.sends.length === 2);
  assert.equal(qq.sends[1].params.user_id, userId);
  assert.deepEqual(qq.sends[1].params.message, [{ type: 'text', data: { text: answer } }]);
  const live = await checkConversation();
  await app.screenshot(join(output, '03-chat.png'));
  const checksBeforeRestart = qq.accountChecks;
  await app.close();
  app = undefined;
  app = await openDesktop(profile, entry, { blockQzone: true });
  const restored = await checkConversation();
  assert.deepEqual(restored, live);
  assert.ok(qq.accountChecks > checksBeforeRestart, 'Restart did not verify the QQ account again');
  assert.equal(qq.sends.length, 2, 'Unexpected duplicate delivery');
  assert.deepEqual(requests, [
    'model verification',
    'ordinary friend without owner',
    'QQ private chat',
  ]);
  await app.screenshot(join(output, '04-restarted.png'));
  const approval = await denyPublish(output);
  assert.deepEqual(requests.slice(3), [
    'publish approval request',
    'publish denial returned to model',
  ]);
  const cookieRequests = qq.actions.filter((action) => action === 'get_cookies').length;
  assert.equal(cookieRequests, 0);
  assert.equal(await readFile(fetchLog, 'utf8'), '', 'Unexpected outbound Qzone fetch');
  assert.equal(qq.sends.length, 2);
  const group = await checkGroup(output);
  let zipImport;
  if (values['napcat-zip']) {
    await app.close();
    app = undefined;
    zipImport = await checkZipImport(resolve(values['napcat-zip']));
  }
  const report = {
    passed: true,
    source: archive || resolve('dist/desktop/main.js'),
    archiveSha256,
    freshProfile: true,
    normalMode: true,
    simulatedServices: ['NapCat WebUI and phone login', 'OneBot v11', 'local model'],
    login: {
      qrWidth,
      phoneConfirmationPromptSeen: true,
      bot: 10001,
      owner: userId,
      autoBoundWithoutOwner: true,
      ownerlessRestart: true,
      unboundStrangerIgnored: true,
      friendWithOwnIdentity: friendId,
    },
    zipImport,
    requests,
    toolCall: 'chat_reply',
    accountChecks: qq.accountChecks,
    acknowledged: qq.sends,
    historyBeforeRestart: live,
    historyAfterRestart: restored,
    group,
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
