import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { openDesktop } from './desktop-journey.mjs';

const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    live: { type: 'boolean' },
    'require-official': { type: 'boolean' },
    label: { type: 'string', default: 'web-chat' },
  },
});
const key = process.env.DEEPSEEK_API_KEY;
assert.ok(values.live && key, 'Use --live and set DEEPSEEK_API_KEY to run the paid desktop test.');
delete process.env.DEEPSEEK_API_KEY;
assert.match(values.label, /^[a-z0-9-]{1,40}$/);
const entry = values.archive
  ? join(resolve(values.archive), 'dist/desktop/main.js')
  : resolve('dist/desktop/main.js');
await access(values.archive ? resolve(values.archive) : entry);
const out = resolve(
  'test-results',
  values.label + '-' + new Date().toISOString().replace(/[:.]/g, '-'),
);
await mkdir(out, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'chatds-test-web-chat-'));
const report = {
  started: new Date().toISOString(),
  source: values.archive ? 'packaged app.asar' : 'built desktop',
  steps: [],
  turns: [],
  restartVerified: false,
};
if (values.archive) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(resolve(values.archive))) digest.update(chunk);
  report.archiveSha256 = digest.digest('hex');
}
const redact = (value) =>
  String(value)
    .replaceAll(key, '[redacted]')
    .replace(/sk-[\w.-]{12,}/gi, '[redacted]');
const writeReport = () =>
  writeFile(join(out, 'report.json'), redact(JSON.stringify(report, null, 2)));
let desktop;
async function wait(check, reason, ms = 25000) {
  const end = Date.now() + ms;
  do {
    if (await check()) return;
    await delay(200);
  } while (Date.now() < end);
  throw new Error(reason);
}
const click = (id) => desktop.evaluate((id) => document.getElementById(id).click(), id);
const navigate = (page) =>
  desktop.evaluate((page) => document.querySelector('[data-page="' + page + '"]').click(), page);
const messages = () =>
  desktop.evaluate(() =>
    Array.from(document.querySelectorAll('#messages .message'), (row) => ({
      role: row.classList.contains('assistant') ? 'assistant' : 'user',
      text: row.querySelector('.bubble').textContent,
      reads: Array.from(row.querySelectorAll('.web-receipts li'), (item) => item.textContent),
      unreadStatus: row.querySelector('small.web-receipts')?.textContent ?? null,
    })),
  );
async function screenshot(name) {
  assert.ok(
    await desktop.evaluate(
      () =>
        document.getElementById('page-chat').getClientRects().length > 0 &&
        !Array.from(document.querySelectorAll('input[type=password]')).some(
          (el) => el.getClientRects().length,
        ),
    ),
    'Capture only the chat screen',
  );
  assert.ok(
    !(await desktop.evaluate(() => document.body.innerText)).includes(key),
    'Cannot capture sensitive content',
  );
  await desktop.screenshot(join(out, name + '.png'));
}
async function turn(question, mode) {
  const previous = (await messages()).length,
    started = Date.now(),
    phases = new Set();
  await desktop.evaluate((question) => {
    const box = document.getElementById('message');
    box.value = question;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send').click();
  }, question);
  await wait(
    async () =>
      (await messages())
        .slice(previous)
        .some((row) => row.role === 'user' && row.text === question),
    'User message missing',
  );
  do {
    const rows = (await messages()).slice(previous);
    const phase = await desktop.evaluate(() => document.getElementById('chat-phase').textContent);
    phases.add(phase);
    if (rows.some((row) => row.role === 'assistant') || (phase === '空闲' && phases.size > 1))
      break;
    if (Date.now() - started > 5000 && /错误|失败|aborted|timeout|error/i.test(phase)) break;
    await delay(300);
  } while (Date.now() - started < 165000);
  const rows = (await messages()).slice(previous);
  report.turns.push({ mode, question, elapsedMs: Date.now() - started, phases: [...phases], rows });
  await writeReport();
  await screenshot('turn-' + report.turns.length);
  console.log(
    'GUI turn ' +
      report.turns.length +
      ', assistant replies ' +
      rows.filter((row) => row.role === 'assistant').length,
  );
}
async function configure() {
  await wait(
    () =>
      desktop.evaluate(
        () =>
          document.getElementById('model-form')?.getClientRects().length > 0 &&
          !document.getElementById('model-fields').disabled,
      ),
    'Fresh desktop model form unavailable',
  );
  const config = await desktop.evaluate(() =>
    Object.fromEntries(
      ['provider', 'base-url', 'model-id'].map((id) => [id, document.getElementById(id).value]),
    ),
  );
  assert.equal(config.provider, 'deepseek');
  assert.equal(config['base-url'], 'https://api.deepseek.com');
  report.model = config['model-id'];
  await desktop.evaluate(() => document.getElementById('api-key').focus());
  await desktop.insertText(key);
  assert.ok(
    await desktop.evaluate(
      () =>
        document.getElementById('api-key').value.length > 0 &&
        !document.getElementById('model-test').disabled,
    ),
    'Password input did not enable verification',
  );
  await click('model-test');
  try {
    await wait(
      () =>
        desktop.evaluate(
          () =>
            document.getElementById('model-status').textContent.includes('验证通过') &&
            !document.getElementById('setup-chat').disabled,
        ),
      'Model verification timed out',
      55000,
    );
  } catch (error) {
    report.verification = redact(
      await desktop.evaluate(
        () =>
          document.getElementById('model-result')?.textContent ||
          document.getElementById('model-status').textContent,
      ),
    );
    throw error;
  }
  report.steps.push('Verified and saved DeepSeek using the first-run form');
  await writeReport();
  await desktop.evaluate(() => {
    const box = document.getElementById('auto-memory');
    if (box.checked) box.click();
  });
  await click('setup-chat');
  await wait(
    () =>
      desktop.evaluate(
        () =>
          document.getElementById('page-chat').getClientRects().length > 0 &&
          !document.getElementById('send').disabled,
      ),
    'Chat unavailable',
  );
  assert.equal(await desktop.evaluate(() => document.getElementById('mode').value), 'companion');
  report.defaultModeLabel = await desktop.evaluate(
    () => document.getElementById('mode').selectedOptions[0].textContent,
  );
}
async function enableWeb() {
  await desktop.evaluate(() => {
    const mode = document.getElementById('mode');
    mode.value = 'assistant';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const hasShortcut = await desktop.evaluate(() =>
    Boolean(document.getElementById('chat-web-settings')),
  );
  if (hasShortcut) {
    await wait(
      () =>
        desktop.evaluate(
          () => document.getElementById('chat-web-settings').getClientRects().length > 0,
        ),
      'Chat web permission shortcut did not open',
    );
    report.permissionBefore = await desktop.evaluate(
      () => document.getElementById('chat-web-settings').textContent,
    );
    await click('chat-web-settings');
  } else {
    await navigate('tools');
  }
  const web = (action) =>
    desktop.evaluate((action) => {
      const box = Array.from(document.querySelectorAll('#tools .tool-row'))
        .find((row) => row.querySelector('code')?.textContent === 'web_read')
        ?.querySelector('input');
      if (action === 'enable' && box && !box.checked) box.click();
      return box?.checked;
    }, action);
  await wait(async () => (await web('checked')) !== undefined, 'Web permission unavailable');
  await web('enable');
  await wait(() => web('checked'), 'Web permission could not be enabled');
  await navigate('chat');
  await wait(
    () =>
      desktop.evaluate(
        () =>
          document.getElementById('mode').value === 'assistant' &&
          !document.getElementById('send').disabled,
      ),
    'Assistant mode did not persist',
  );
  if (hasShortcut) {
    await wait(
      () =>
        desktop.evaluate(() =>
          document.getElementById('chat-web-settings').textContent.includes('已开启'),
        ),
      'Chat did not show saved web permission',
    );
    report.permissionAfter = await desktop.evaluate(
      () => document.getElementById('chat-web-settings').textContent,
    );
  }
  report.steps.push('Enabled web_read in the tools page in assistant mode');
}
try {
  desktop = await openDesktop(profile, entry);
  await configure();
  await turn('Anthropic 最近公开了什么消息？', 'companion');
  await turn('我问的是最近公开的，能讲一条具体的吗？', 'companion');
  await enableWeb();
  await turn(
    'Anthropic 最近公开了什么消息？请查 Anthropic 或 Claude 的官方来源，给出一条能核实的消息、发布日期和来源链接。',
    'assistant',
  );
  const original = await messages();
  await desktop.close();
  desktop = await openDesktop(profile, entry);
  await wait(
    async () => (await messages()).length === original.length,
    'Restart did not restore chat',
  );
  assert.deepEqual(await messages(), original);
  report.restartVerified = true;
  await screenshot('restart');
  const assistant = report.turns.at(-1).rows.find((row) => row.role === 'assistant');
  const companionReplies = report.turns
    .slice(0, 2)
    .map((turn) => turn.rows.find((row) => row.role === 'assistant')?.text);
  report.evidence = {
    companionReportedNoRead: report.turns[0].rows.some(
      (row) =>
        row.role === 'assistant' && row.unreadStatus === '本轮未读取网页' && row.reads.length === 0,
    ),
    distinctCompanionReplies:
      companionReplies.every(Boolean) && new Set(companionReplies).size === 2,
    officialRead:
      assistant?.reads.some((text) =>
        /^网页已读取\s*·\s*(?:[\w-]+\.)*(?:anthropic\.com|claude\.com)(?:[/:\s]|$)/i.test(text),
      ) ?? false,
    includesOfficialURL:
      /https?:\/\/(?:[\w-]+\.)*(?:anthropic\.com|claude\.com)(?:[/:\s)]|$)/i.test(
        assistant?.text ?? '',
      ),
    includesDate:
      /\d{1,2}\s*(?:月|[-/])\s*\d{1,2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/i.test(
        assistant?.text ?? '',
      ),
  };
  if (values['require-official'])
    assert.ok(
      Object.values(report.evidence).every(Boolean),
      'Missing distinct companion responses, no-read status, official read, source link, or publication date',
    );
} catch (error) {
  report.error = redact(error.message);
  process.exitCode = 1;
} finally {
  try {
    await desktop?.close();
  } finally {
    await writeReport();
    console.log('GUI report ' + out);
    const path = await realpath(profile);
    assert.equal(dirname(path), await realpath(tmpdir()));
    assert.ok(basename(path).startsWith('chatds-test-web-chat-'));
    await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
}
