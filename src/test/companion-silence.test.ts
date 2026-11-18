import assert from 'node:assert/strict';
import test from 'node:test';
import { envelope } from './helpers.js';
import { requestedSilence } from '../runtime/companion-silence.js';

test('companion silence requires the addressed speaker’s own final unambiguous request', () => {
  for (const message of [
    '我刚差点把快递寄反了，先等一下，我还没说完。',
    '先别回复',
    '等我说完再回',
  ])
    assert.equal(requestedSilence([envelope(message)]), 'wait', message);
  for (const message of [
    '我先去楼下重新贴单，这条不用回啦。',
    '不用回复我',
    '我先写会作业，不用回这条',
  ]) {
    assert.equal(requestedSilence([envelope(message)]), 'end', message);
  }
  for (const message of [
    '她说：“我还没说完。”',
    '我刚听他说，先等一下，我还没说完。',
    '我不是说不用回复。',
    '不是，这条不用回啦。',
    '你是说我不用回去？',
    '不用回去',
    '不用回复吗',
    '我刚想问，这条不用回？',
    '等我说完，这个星期天你有空吗？',
    '我还没说完，但你先说说看。',
    '这条不用回啦。能再说一句吗？',
    '为什么有人会说等一下',
    '请解释“这条不用回啦”这句话',
    '我刚提醒过他，这条不用回啦。',
  ])
    assert.equal(requestedSilence([envelope(message)]), undefined, message);
  assert.equal(requestedSilence([envelope('阿明的原话是：'), envelope('这条不用回啦')]), undefined);
  assert.equal(requestedSilence([envelope('等一下'), envelope('好了，你怎么看？')]), undefined);
  assert.equal(
    requestedSilence([envelope('你怎么看？'), envelope('不用回', { actorId: 'qq:20002' })]),
    undefined,
  );
  assert.equal(requestedSilence([envelope('先别回', { directedElsewhere: true })]), undefined);
  assert.equal(
    requestedSilence([envelope('不用回', { trigger: 'ambient', isGroup: true })]),
    undefined,
  );
  assert.equal(
    requestedSilence([
      envelope('他这句是什么意思？', { quoted: { actorId: 'qq:20002', text: '这条不用回啦' } }),
    ]),
    undefined,
  );
});
