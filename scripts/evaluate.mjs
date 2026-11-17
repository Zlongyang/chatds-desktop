import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { RuntimeCore } from '../dist/runtime/core.js';
import { Store } from '../dist/runtime/store.js';
import { ModelHost } from '../dist/desktop/model.js';
import { modelSchema, errorText } from '../dist/shared/config.js';
import { FakeHost, envelope, assistant } from '../dist/test/helpers.js';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

const cases = JSON.parse(await readFile('evaluation/cases.json', 'utf8'));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const maxCalls = Number(args['max-calls'] ?? 0);
if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > 200)
  throw new Error('--max-calls must be 0..200');
if (maxCalls === 0) {
  console.log(
    JSON.stringify({
      dryRun: true,
      cases: cases.length,
      calls: 0,
      instructions:
        'Set CHATDS_EVAL_API_KEY (if required), CHATDS_EVAL_BASE_URL and CHATDS_EVAL_MODEL, then pass --max-calls=30. Reports contain synthetic conversations only. No QQ messages are sent.',
    }),
  );
  process.exit(0);
}
if (!process.env.CHATDS_EVAL_MODEL || !process.env.CHATDS_EVAL_BASE_URL)
  throw new Error('Set CHATDS_EVAL_MODEL and CHATDS_EVAL_BASE_URL explicitly');
let calls = 0;
const results = [];
for (const scenario of cases.filter((c) => !args.case || c.id === args.case)) {
  if (calls >= maxCalls) break;
  const host = new FakeHost();
  host.config.model = modelSchema.parse({
    ...host.config.model,
    provider: process.env.CHATDS_EVAL_PROVIDER ?? 'deepseek',
    model: process.env.CHATDS_EVAL_MODEL,
    baseUrl: process.env.CHATDS_EVAL_BASE_URL,
    keyRequired: !!process.env.CHATDS_EVAL_API_KEY,
  });
  if (scenario.persona) host.config.persona = scenario.persona;
  const model = new ModelHost(() => host.config.model, {
    get: () => process.env.CHATDS_EVAL_API_KEY,
  });
  const store = new Store(':memory:'),
    started = performance.now(),
    before = calls;
  host.stream = (_runId, budget, thinking) => (_definition, context, options) => {
    const stream = new AssistantMessageEventStream();
    const fail = (error) => {
      const message = assistant('');
      message.stopReason = 'error';
      message.errorMessage = errorText(error);
      stream.push({ type: 'error', reason: 'error', error: message });
      stream.end(message);
    };
    if (calls >= maxCalls) {
      fail(new Error('Evaluation call budget reached'));
      return stream;
    }
    calls++;
    void model
      .stream(
        { context, budget, thinking },
        (event) => stream.push(event),
        options?.signal ?? AbortSignal.timeout(60000),
      )
      .then((message) => stream.end(message), fail);
    return stream;
  };
  host.toolHandler = async () => {
    throw new Error('Evaluation does not execute external tools');
  };
  const core = new RuntimeCore(store, host.config, host, { timingScale: 0 });
  try {
    for (const [index, text] of scenario.messages.entries()) {
      const message = host.remember(
        envelope(text, {
          ...(scenario.group
            ? {
                conversationId: 'onebot:group:30003',
                actorId: 'qq:20002',
                channel: 'onebot',
                isGroup: true,
                mention: true,
              }
            : {}),
          ...(index === 0 && scenario.quote ? { quoted: scenario.quote } : {}),
        }),
      );
      core.ingest(message);
    }
    // The production turn timeout is authoritative. No retry or second judge call.
    const deadline = performance.now() + host.config.limits.runTimeoutMs + 5000;
    while (core.stats.timers || core.stats.foreground.active || core.stats.foreground.waiting) {
      if (performance.now() > deadline) throw new Error('Evaluation timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
    const room = scenario.group ? 'onebot:group:30003' : 'desktop:owner';
    const replies = store
      .history(room)
      .filter((m) => m.role === 'assistant')
      .map((m) => m.text);
    results.push({
      id: scenario.id,
      review: scenario.review,
      input: scenario.messages,
      replies,
      expectedAction: scenario.expectedAction ?? 'reply',
      structuralMatch:
        scenario.expectedAction === 'silent' ? replies.length === 0 : replies.length > 0,
      modelCalls: calls - before,
      wallTimeMs: Math.round(performance.now() - started),
      usage: store.usage(new Date().toLocaleDateString('en-CA')),
      errors: core
        .rows()
        .map((r) => r.error)
        .filter(Boolean),
      humanRatings: {
        naturalness: null,
        speakerAccuracy: null,
        contextContinuity: null,
        unwantedAdvice: null,
      },
    });
    console.log(JSON.stringify({ case: scenario.id, calls, replyCount: replies.length }));
  } finally {
    await core.close();
  }
}
await mkdir('test-results', { recursive: true });
await writeFile(
  'test-results/evaluation.json',
  JSON.stringify(
    {
      model: process.env.CHATDS_EVAL_MODEL,
      baseUrl: process.env.CHATDS_EVAL_BASE_URL,
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
