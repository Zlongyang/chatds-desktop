import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeBlindReview } from './blind-review.mjs';

async function output(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chatds-blind-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function user(text) {
  return { role: 'user', speaker: '木子', actorId: 'qq:20001', text };
}

function sample() {
  const first = {
    ...user('池边有什么？'),
    mention: true,
    quote: { actorId: 'bot', text: '我想在池边坐坐。' },
  };
  const last = user('你先忙。');
  function variant(text) {
    return {
      complete: true,
      errors: [],
      modelCalls: 2,
      turns: [
        {
          events: [first, { role: 'assistant', speaker: '小鱼', text }],
          errors: [],
          action: 'reply',
        },
        { events: [last], errors: [], action: 'end' },
      ],
    };
  }
  return {
    id: 'pond',
    title: '小水池',
    variants: { baseline: variant('芦苇。'), current: variant('石头。') },
  };
}

test('blind review preserves turns and quotes, keeps identities in a separate key, and protects filled-in votes', async (t) => {
  const scenario = sample();
  const directory = await output(t);
  const { reviewPath, keyPath } = await writeBlindReview({ directory, cases: [scenario] });
  const report = await readFile(reviewPath, 'utf8');
  const {
    assignments: [key],
  } = JSON.parse(await readFile(keyPath, 'utf8'));
  assert.deepEqual([key.A, key.B].sort(), ['baseline', 'current']);
  assert.equal(key.caseId, 'pond');
  const sections = report.split(/### 对话 [AB]/);
  for (const [index, side] of ['A', 'B'].entries()) {
    const block = sections[index + 1];
    assert.match(block, /木子\*\*（@小鱼，引用小鱼“我想在池边坐坐。”）/);
    assert.ok(block.includes(scenario.variants[key[side]].turns[0].events[1].text));
    assert.match(block, /第 2 轮[\s\S]*你先忙。[\s\S]*小鱼没有发言/);
  }
  assert.doesNotMatch(report, /baseline|current|modelCalls|chat_end|expectedAction|answer-key/);
  assert.match(report, /\|  \|  \|  \|  \|  \|/);
  await assert.rejects(writeBlindReview({ directory, cases: [scenario] }), { code: 'EEXIST' });
  assert.equal(await readFile(reviewPath, 'utf8'), report);
});

test('technical failures, missing turns and unequal inputs are excluded from blind scoring', async (t) => {
  const directory = await output(t);
  const broken = sample(),
    missing = sample(),
    different = sample(),
    namesake = sample();
  broken.variants.current.turns[1].errors.push('network secret marker');
  missing.variants.current.turns.pop();
  different.variants.current.turns[1].events = [user('另一条输入')];
  namesake.variants.current.turns[1].events = [{ ...user('你先忙。'), actorId: 'qq:20003' }];
  const { reviewPath, keyPath } = await writeBlindReview({
    directory,
    cases: [broken, missing, different, namesake],
  });
  const content = await readFile(reviewPath, 'utf8');
  assert.equal((content.match(/跳过评分/g) ?? []).length, 4);
  assert.doesNotMatch(content, /### 对话|### 你的选择|network secret marker|小鱼没有发言。/);
  assert.ok(JSON.parse(await readFile(keyPath, 'utf8')).assignments.every((k) => !k.comparable));
});

test('illustrative fixtures are labelled and chat text stays inert when rendered', async (t) => {
  const directory = await output(t);
  const scenario = sample();
  scenario.variants.current.turns[0].events[1].text = '![猫](https://example.org/)\n<b>test</b>';
  const { reviewPath } = await writeBlindReview({
    directory,
    cases: [scenario],
    source: 'fixture',
  });
  const content = await readFile(reviewPath, 'utf8');
  assert.match(content, /脚本生成的格式样例/);
  assert.doesNotMatch(content, /### 你的选择|!\[猫\]|<b>/);
  assert.match(content, /&lt;b&gt;test&lt;\/b&gt;/);
});
