import { randomInt } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// The model's text must stay readable without becoming a Markdown link, image or heading.
function plain(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_~\[\]|!])/g, '\\$1')
    .replace(/\r\n?|\n/g, '<br>');
}

function messageLine(event) {
  const who = event.role === 'assistant' ? '小鱼' : event.speaker;
  const context = [];
  if (event.mention) context.push('@小鱼');
  if (event.directedElsewhere) context.push('对群友说');
  if (event.quote) {
    const author = event.quote.actorId === 'bot' ? '小鱼' : event.quote.speaker || '群友';
    context.push(`引用${author}“${event.quote.text}”`);
  }
  const metadata = context.length ? '（' + plain(context.join('，')) + '）' : '';
  return `- **${plain(who)}**${metadata}　${plain(event.text)}`;
}

function dialogue(label, turns) {
  const lines = [`### 对话 ${label}`, ''];
  for (const [index, turn] of turns.entries()) {
    lines.push(`**第 ${index + 1} 轮**`, '', ...turn.events.map(messageLine));
    if (!turn.events.some((event) => event.role === 'assistant')) lines.push('- *小鱼没有发言。*');
    lines.push('');
  }
  return lines;
}

function humanInput(turn) {
  return turn.events
    .filter((event) => event.role === 'user')
    .map((event) => [
      event.actorId,
      event.speaker,
      event.text,
      !!event.mention,
      !!event.directedElsewhere,
      event.quote?.actorId,
      event.quote?.speaker,
      event.quote?.text,
    ]);
}

function canCompare(variants) {
  const { baseline, current } = variants;
  if (
    ![baseline, current].every(
      (v) =>
        v?.complete === true &&
        !v.errors.length &&
        v.turns.length > 0 &&
        v.turns.every((t) => !t.errors.length),
    )
  )
    return false;
  return (
    baseline.turns.length === current.turns.length &&
    baseline.turns.every((turn, index) => {
      const human = humanInput(turn);
      return human.length > 0 && isDeepStrictEqual(human, humanInput(current.turns[index]));
    })
  );
}

export async function writeBlindReview({ directory, cases, source = 'model' }) {
  if (!['fixture', 'model'].includes(source)) throw new Error('评测来源无效');
  const fixture = source === 'fixture';
  const lines = [
    '# 小鱼的多轮聊天对照',
    '',
    fixture
      ? '这是一份脚本生成的格式样例。评测自然度时请使用真实模型的记录。'
      : '请先读完每个场景的两份对话，再填写自己的选择。A、B 的顺序按场景随机决定。',
    '',
    '每一轮都按消息出现的顺序排列。连续几行来自同一人，表示对方连发了几句。小鱼没有发言时会单独标出。',
    '',
  ];
  if (!fixture)
    lines.push(
      '评分可填 A、B、相当或无法判断。留意发言时机、说话人及引用归属、对前文细节的承接，以及说话方式是否贴合这段聊天。两边各有好坏时，可以逐项选择。',
      '',
    );
  const assignments = [];
  for (const scenario of cases) {
    const order = randomInt(2) === 0 ? ['current', 'baseline'] : ['baseline', 'current'];
    const comparable = canCompare(scenario.variants);
    assignments.push({ caseId: scenario.id, A: order[0], B: order[1], comparable });
    lines.push(`## ${plain(scenario.title)}`, '');
    if (!comparable) {
      lines.push('本组缺少一对输入一致、运行完整的记录，跳过评分。', '');
      continue;
    }
    lines.push(
      ...dialogue('A', scenario.variants[order[0]].turns),
      ...dialogue('B', scenario.variants[order[1]].turns),
    );
    if (!fixture)
      lines.push(
        '### 你的选择',
        '',
        '| 发言时机 | 说话人和引用 | 承接前文 | 聊天口吻 | 整体偏好 |',
        '| --- | --- | --- | --- | --- |',
        '|  |  |  |  |  |',
        '',
        '请记下一处影响判断的原话，或指出哪一轮保持安静更合适。',
        '',
      );
  }
  const reviewPath = join(directory, 'blind-review.md');
  const keyPath = join(directory, 'answer-key.json');
  await mkdir(directory, { recursive: true });
  await writeFile(keyPath, JSON.stringify({ source, assignments }, null, 2) + '\n', { flag: 'wx' });
  try {
    await writeFile(reviewPath, lines.join('\n'), { flag: 'wx' });
  } catch (error) {
    await unlink(keyPath);
    throw error;
  }
  return { reviewPath, keyPath };
}
