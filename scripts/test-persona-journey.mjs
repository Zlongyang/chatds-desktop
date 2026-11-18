import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';
import { openDesktop } from './desktop-journey.mjs';

const [option, target] = process.argv.slice(2);
assert.ok(
  !option ||
    (option === '--entry' && target) ||
    (option === '--archive' && basename(target) === 'app.asar'),
);
const entry =
  option === '--archive'
    ? resolve(target, 'dist/desktop/main.js')
    : target
      ? resolve(target)
      : undefined;
const profile = await mkdtemp(join(tmpdir(), 'chatds-test-persona-'));
const evidence = resolve('test-results', 'persona-journey-' + basename(profile).slice(-6));
await mkdir(evidence, { recursive: true });
const card = {
  name: '澄灯',
  avatar: '🏮',
  description: '修复旧地图的夜班店员。',
  personality: '说话干脆，喜欢双关。',
  scenario: '海边的旧地图店打烊前。',
  greeting: '{{char}}把门铃扶正了。进来坐吧。',
  examples: '对方：外面在下雨。\n{{char}}：把地图收好，路可以慢慢看。',
  creator: '旅图手记',
};
const question = '那张海图画到了哪里？',
  reply = '画到了灯塔，在雨歇的地方。';
const calls = [];
const model = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return res.writeHead(404).end();
  let body = '';
  for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  const chat = data.messages.some(
    (msg) => msg.role === 'user' && JSON.stringify(msg.content).includes(question),
  );
  if (chat)
    calls.push(data.messages.filter((msg) => msg.role === 'system' || msg.role === 'developer'));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const [delta, finish_reason] of [
    [{ role: 'assistant', content: chat ? reply : 'Connected' }, null],
    [{}, 'stop'],
  ])
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'local',
          model: data.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n',
    );
  res.end('data: [DONE]\n\n');
});

function illustratedCard(json) {
  const chunk = (type, data) => {
    const packet = Buffer.alloc(data.length + 12);
    packet.writeUInt32BE(data.length);
    packet.write(type, 4);
    data.copy(packet, 8);
    packet.writeUInt32BE(crc32(packet.subarray(4, -4)), packet.length - 4);
    return packet;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(8, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = [];
  for (let y = 0; y < 8; y++) {
    rows.push(0);
    for (let x = 0; x < 8; x++)
      rows.push(...(Math.abs(x - y) < 2 ? [60, 93, 110, 255] : [239, 182, 100, 255]));
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from('chara\0' + Buffer.from(JSON.stringify(json)).toString('base64'))),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let desktop;
const evaluate = (fn, ...args) => desktop.evaluate(fn, ...args);
async function waitFor(fn, label, ...args) {
  const until = Date.now() + 15000;
  while (!(await evaluate(fn, ...args))) {
    if (Date.now() > until) throw new Error('Timed out waiting for ' + label);
    await delay(75);
  }
}
const visible = (id) =>
  waitFor((s) => !!document.querySelector(s)?.getClientRects().length, id, id);
const click = (id) =>
  evaluate((s) => {
    const el = document.querySelector(s);
    if (!el?.getClientRects().length || el.disabled) throw new Error('Control unavailable: ' + s);
    el.scrollIntoView({ block: 'nearest' });
    el.click();
  }, id);
const fill = (id, value, event = 'input') =>
  evaluate(
    (s, v, type) => {
      const el = document.querySelector(s);
      if (!el?.getClientRects().length || el.disabled) throw new Error('Field unavailable: ' + s);
      el.value = v;
      el.dispatchEvent(new Event(type, { bubbles: true }));
    },
    id,
    value,
    event,
  );
const page = async (name) => {
  await click('#nav [data-page="' + name + '"]');
  await visible('#page-' + name);
};
const textAt = (id, value) =>
  waitFor((s, v) => document.querySelector(s)?.textContent === v, id, id, value);
const count = (n) => textAt('#persona-count', n + ' 张');
const cardRow = (name) =>
  evaluate(
    (value) =>
      [...document.querySelectorAll('.persona-choice')].find(
        (b) => b.querySelector('strong').textContent === value,
      )?.dataset.personaId,
    name,
  );
const choose = async (name) => {
  const id = await cardRow(name);
  assert.ok(id, 'Missing library card ' + name);
  await click('.persona-choice[data-persona-id="' + id + '"]');
};
const defaultCard = () =>
  evaluate(
    () =>
      [...document.querySelectorAll('.persona-choice')]
        .find((b) => b.querySelector('small').textContent === '默认角色')
        ?.querySelector('strong').textContent,
  );
const tab = (id) => click('[data-persona-tab="' + id + '"]');
const confirm = async (accept) => {
  await visible('#persona-confirm[open]');
  await click(accept ? '#persona-confirm-action' : '#persona-confirm [value="back"]');
  await waitFor(() => !document.querySelector('#persona-confirm').open, 'dialog closed');
};
async function topShot(name) {
  await evaluate(() => window.scrollTo(0, 0));
  await desktop.screenshot(join(evidence, name + '.png'));
}
try {
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  desktop = await openDesktop(profile, entry);
  await visible('#qq-desktop-only');
  await click('#qq-desktop-only');
  await visible('#model-form');
  await fill('#provider', 'local', 'change');
  await fill('#base-url', 'http://127.0.0.1:' + model.address().port + '/v1');
  await fill('#model-id', 'persona-fixture');
  await click('#model-test');
  await waitFor(
    () => document.querySelector('#model-status').textContent.includes('验证通过'),
    'model verification',
  );
  await page('persona');
  await count(1);
  assert.equal(await defaultCard(), '小鱼');
  assert.ok(await evaluate(() => document.querySelector('#delete-persona').disabled));

  await click('#new-persona');
  await fill('#persona-name', card.name);
  await fill('#persona-avatar', card.avatar);
  await fill('#persona-creator', card.creator);
  await fill('#persona', card.description);
  await fill('#persona-style', card.personality);
  await tab('dialogue');
  await fill('#persona-scenario', card.scenario);
  await fill('#persona-greeting', card.greeting);
  await fill('#persona-examples', card.examples);
  await choose('小鱼');
  await confirm(false);
  assert.equal(await evaluate(() => document.querySelector('#persona-name').value), card.name);
  await tab('preview');
  const compiled = await evaluate(() => document.querySelector('#persona-preview').textContent);
  for (const text of [
    card.name,
    card.scenario,
    card.description,
    card.personality,
    '澄灯把门铃扶正了',
    '澄灯：把地图收好',
  ])
    assert.ok(compiled.includes(text));
  assert.ok(!compiled.includes(card.creator));
  await click('#save-persona');
  await count(2);
  assert.equal(await defaultCard(), '小鱼');
  await tab('profile');
  await fill('#persona-name', '未保存的名字');
  await click('#revert-persona');
  await confirm(true);
  assert.equal(await evaluate(() => document.querySelector('#persona-name').value), card.name);
  await click('#apply-persona');
  await textAt('#persona-role', '默认角色');
  assert.equal(await defaultCard(), card.name);
  await choose('小鱼');
  await click('#apply-persona');
  await textAt('#persona-role', '默认角色');
  await choose(card.name);

  const jsonPath = join(profile, 'card.json'),
    pngPath = join(profile, 'card.png');
  async function exportCard(format, path) {
    await desktop.chooseNextSaveFile(path, '导出角色卡');
    await click('#export-persona-' + format);
    await textAt('#persona-status', '已导出 ' + format.toUpperCase() + ' 角色卡。');
    return readFile(path);
  }
  const json = JSON.parse((await exportCard('json', jsonPath)).toString('utf8'));
  assert.equal(json.data.name, card.name);
  assert.equal(json.data.first_mes, card.greeting);
  assert.equal(json.data.creator, card.creator);
  const png = await exportCard('png', pngPath);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await fill('#persona-name', '编辑到一半');
  await desktop.chooseNextFile(jsonPath, '导入角色卡');
  await click('#import-persona');
  await confirm(false);
  assert.equal(await evaluate(() => document.querySelector('#persona-name').value), '编辑到一半');
  await click('#revert-persona');
  await confirm(true);
  async function importCard(path, name) {
    await desktop.chooseNextFile(path, '导入角色卡');
    await click('#import-persona');
    await textAt('#persona-title', name);
    await textAt('#persona-role', '草稿');
  }
  // Read back the exported PNG and JSON through the application's own native file picker.
  await importCard(pngPath, card.name);
  await tab('dialogue');
  assert.equal(
    await evaluate(() => document.querySelector('#persona-scenario').value),
    card.scenario,
  );
  await click('#revert-persona');
  await confirm(true);
  await importCard(jsonPath, card.name);
  await click('#revert-persona');
  await confirm(true);
  const legacy = join(profile, 'legacy.json');
  await writeFile(legacy, JSON.stringify({ name: '旧卡', description: '一份旧卡的介绍。' }));
  await importCard(legacy, '旧卡');
  assert.equal(await evaluate(() => document.querySelector('#persona').value), '一份旧卡的介绍。');
  await click('#revert-persona');
  await confirm(true);
  const illustrated = join(profile, 'illustrated.png');
  json.data.name = '纸舟';
  await writeFile(illustrated, illustratedCard(json));
  await importCard(illustrated, '纸舟');
  await waitFor(
    () => document.querySelector('#persona-avatar-preview img')?.naturalWidth === 8,
    'visible PNG artwork',
  );
  await click('#save-persona');
  await count(3);
  await choose(card.name);
  await topShot('library-editor');
  await click('#persona-context-link');
  await waitFor(() => document.activeElement?.id === 'tavern-room', 'world book entry');
  await tab('dialogue');
  await topShot('dialogue');
  await desktop.resizeViewport(850, 620);
  assert.ok(await evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await topShot('compact');
  await evaluate(() =>
    document.querySelector('#export-persona-png').scrollIntoView({ block: 'center' }),
  );
  assert.ok(
    await evaluate(() => {
      const rect = document.querySelector('#export-persona-png').getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }),
  );
  await desktop.resizeViewport(1164, 750);
  const id = await cardRow(card.name);
  await page('chat');
  await waitFor(
    (id) => [...document.querySelector('#room-persona').options].some((o) => o.value === id),
    'saved session option',
    id,
  );
  await fill('#room-persona', id, 'change');
  await textAt('#messages .card-greeting', '澄灯把门铃扶正了。进来坐吧。');
  await topShot('room-greeting');
  await fill('#message', question);
  await click('#send');
  await waitFor(
    (text) =>
      [...document.querySelectorAll('#messages .bubble')].some((el) => el.textContent === text),
    'actual model reply',
    reply,
  );
  assert.equal(calls.length, 1);
  const request = JSON.stringify(calls[0]);
  for (const value of [
    card.description,
    card.personality,
    card.scenario,
    '澄灯把门铃扶正了',
    '澄灯：把地图收好',
  ])
    assert.ok(request.includes(value));
  assert.ok(!request.includes(card.creator));

  await desktop.close();
  desktop = await openDesktop(profile, entry);
  await visible('#page-chat');
  await waitFor(
    (id) => document.querySelector('#room-persona').value === id,
    'remembered room role',
    id,
  );
  await page('persona');
  await count(3);
  assert.equal(await defaultCard(), '小鱼');
  await choose('纸舟');
  await waitFor(
    () => document.querySelector('#persona-avatar-preview img')?.naturalWidth === 8,
    'persisted PNG artwork',
  );
  await click('#delete-persona');
  await confirm(false);
  await count(3);
  await click('#delete-persona');
  await confirm(true);
  await count(2);
  await choose(card.name);
  await click('#delete-persona');
  await confirm(true);
  await count(1);
  await page('chat');
  await waitFor(
    () =>
      document.querySelector('#room-persona').value === '' &&
      document.querySelector('#room-persona').options.length === 2,
    'deleted room role falls back',
  );
  const report = {
    ordinaryDesktop: true,
    upstreamFormats: ['JSON V2', 'PNG chara'],
    savedWithoutSelectingDefault: true,
    separateRoomSelection: true,
    cancelAndDelete: true,
    roleAfterRestart: true,
    fullWritingInLoopbackModelCall: true,
    pngArtworkAfterRestart: true,
    compactViewport: [850, 620],
    modelCalls: calls.length,
  };
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Persona GUI journey passed: ' + evidence);
} finally {
  await desktop?.close();
  model.closeAllConnections();
  if (model.listening) await new Promise((resolve) => model.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
}
