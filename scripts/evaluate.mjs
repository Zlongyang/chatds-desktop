import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ModelHost } from '../dist/desktop/model.js';
import { modelSchema, defaultConfig } from '../dist/shared/config.js';
import { readReplayCases, replayPlan, runReplay, runReplaySuite } from './replay.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const replay = Object.hasOwn(args, 'replay');
const maxCalls = Number(args['max-calls'] ?? 0);
if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > 200)
  throw new Error('--max-calls must be 0..200');
const cases = replay
  ? await readReplayCases(args.case)
  : JSON.parse(await readFile(new URL('../evaluation/cases.json', import.meta.url), 'utf8')).filter(
      (c) => !args.case || c.id === args.case,
    );
if (!cases.length) throw new Error('找不到场景 ' + args.case);
if (!maxCalls) {
  console.log(
    JSON.stringify(
      {
        dryRun: true,
        cases: cases.length,
        calls: 0,
        ...(replay
          ? {
              plan: replayPlan(cases),
              note: 'baselineCalls 为逐条回复请求数。currentMaxCalls 是每轮最多 8 次的上限；合并、静默与工具选择由运行时和模型决定。',
            }
          : {
              instructions:
                'Set CHATDS_EVAL_API_KEY (if required), CHATDS_EVAL_BASE_URL and CHATDS_EVAL_MODEL, then pass --max-calls=30. Reports contain synthetic conversations only. No QQ messages are sent.',
            }),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (!process.env.CHATDS_EVAL_MODEL || !process.env.CHATDS_EVAL_BASE_URL)
  throw new Error('Set CHATDS_EVAL_MODEL and CHATDS_EVAL_BASE_URL explicitly');
const profile = modelSchema.parse({
  ...defaultConfig().model,
  provider: process.env.CHATDS_EVAL_PROVIDER ?? 'deepseek',
  model: process.env.CHATDS_EVAL_MODEL,
  baseUrl: process.env.CHATDS_EVAL_BASE_URL,
  keyRequired: !!process.env.CHATDS_EVAL_API_KEY,
});
const model = new ModelHost(() => profile, { get: () => process.env.CHATDS_EVAL_API_KEY });
if (replay) {
  const report = await runReplaySuite({
    directory: resolve(
      args.out ?? 'test-results/replay-' + new Date().toISOString().replaceAll(':', '-'),
    ),
    scenarios: cases,
    profile,
    model,
    maxCalls,
  });
  console.log(
    JSON.stringify({ directory: report.directory, calls: report.calls, complete: report.complete }),
  );
  process.exit(report.complete ? 0 : 1);
}

// Existing single-burst cases keep their input and report format.
let calls = 0;
const takeCall = () => {
  if (calls >= maxCalls) throw new Error('Evaluation call budget reached');
  calls++;
};
const results = [];
for (const c of cases) {
  if (calls >= maxCalls) break;
  const messages = c.messages.map((text, i) => ({
    actorId: c.group ? 'qq:20002' : 'owner',
    displayName: '测试者',
    text,
    mention: !!c.group && !c.directedElsewhere,
    directedElsewhere: !!c.directedElsewhere,
    ...(i === 0 && c.quote ? { quote: c.quote } : {}),
  }));
  const scenario = { ...c, turns: [{ messages, expectedAction: c.expectedAction ?? 'reply' }] };
  const result = await runReplay(scenario, 'current', { profile, model, takeCall });
  const turn = result.turns[0];
  const replies = turn.events.filter((e) => e.role === 'assistant').map((e) => e.text);
  results.push({
    id: c.id,
    review: c.review,
    input: c.messages,
    replies,
    expectedAction: turn.expectedAction,
    structuralMatch: turn.structuralMatch,
    modelCalls: result.modelCalls,
    wallTimeMs: turn.wallTimeMs,
    usage: result.usage,
    errors: result.errors,
    humanRatings: {
      naturalness: null,
      speakerAccuracy: null,
      contextContinuity: null,
      unwantedAdvice: null,
    },
  });
  console.log(JSON.stringify({ case: c.id, calls, replyCount: replies.length }));
  if (!result.complete) {
    process.exitCode = 1;
    break;
  }
}
await mkdir('test-results', { recursive: true });
await writeFile(
  'test-results/evaluation.json',
  JSON.stringify(
    {
      model: profile.model,
      baseUrl: profile.baseUrl,
      calls,
      maxCalls,
      results,
      limitations:
        'No automatic score proves human-like conversation. Review naturalness, speaker attribution and continuity manually; compare multiple anonymized model/harness variants.',
    },
    null,
    2,
  ),
);
console.log('Saved test-results/evaluation.json. Human review is still required.');
