import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { z } from 'zod';
import { RuntimeCore } from '../dist/runtime/core.js';
import { Store } from '../dist/runtime/store.js';
import { batchText } from '../dist/runtime/prompt.js';
import { errorText } from '../dist/shared/config.js';
import { stableDay } from '../dist/shared/util.js';
import { FakeHost, assistant, envelope } from '../dist/test/helpers.js';

const inputMessage = z
  .object({
    actorId: z.string().min(1),
    displayName: z.string().min(1),
    text: z.string().trim().min(1).max(6000),
    mention: z.boolean().optional(),
    directedElsewhere: z.boolean().optional(),
    quote: z
      .object({ actorId: z.string().min(1), text: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
const replayCases = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-z0-9-]+$/),
        title: z.string().min(1),
        review: z.string(),
        group: z.boolean(),
        ambient: z.boolean().optional(),
        persona: z.string().min(1).optional(),
        turns: z
          .array(
            z
              .object({
                expectedAction: z.enum(['reply', 'silent', 'wait', 'end', 'either']),
                advanceMs: z.number().int().nonnegative().optional(),
                messages: z.array(inputMessage).min(1).max(20),
              })
              .strict(),
          )
          .min(1)
          .max(20),
      })
      .strict(),
  )
  .min(1);

export async function readReplayCases(caseId) {
  const cases = replayCases.parse(
    JSON.parse(await readFile(new URL('../evaluation/replay-cases.json', import.meta.url), 'utf8')),
  );
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error('评测场景编号重复');
  if (!caseId) return cases;
  const selected = cases.filter((c) => c.id === caseId);
  if (!selected.length) throw new Error('找不到场景 ' + caseId);
  return selected;
}

export function replayPlan(cases) {
  return cases.map(({ id, turns }) => ({
    id,
    turns: turns.length,
    messages: turns.reduce((sum, t) => sum + t.messages.length, 0),
    baselineCalls: turns.reduce((sum, t) => sum + t.messages.length, 0),
    currentMaxCalls: turns.length * 8,
  }));
}

function accepted(expected, action) {
  if (action === 'error') return null;
  if (expected === 'either') return true;
  if (expected === 'silent') return ['ignored', 'wait', 'end'].includes(action);
  return expected === action;
}

// The fake transport records local sends. The model, SQLite, companion actions, and
// RuntimeCore request preparation are real. Time advances between bursts, not during inference.
export async function runReplay(scenario, variant, { profile, model, takeCall, persona }) {
  if (!['baseline', 'current'].includes(variant)) throw new Error('未知回放方式');
  const host = new FakeHost();
  host.config.model = profile;
  host.config.persona = scenario.persona ?? persona ?? host.config.persona;
  const room = scenario.group ? 'onebot:group:30003' : 'desktop:owner';
  host.config.conversations[room] = {
    mode: 'companion',
    muted: false,
    ambient: scenario.ambient ?? false,
  };
  const names = new Map(
    scenario.turns.flatMap((turn) => turn.messages.map((m) => [m.actorId, m.displayName])),
  );
  names.set('bot', '小鱼');
  let now = Date.UTC(2026, 0, 1, 12),
    seq = 0,
    step;
  const turns = [],
    chatHistory = [];
  const store = new Store(':memory:');
  const core = new RuntimeCore(store, host.config, host, { timingScale: 0, now: () => now });
  host.toolHandler = async () => {
    throw new Error('回放不执行外部工具');
  };
  async function call(context, emit, signal, budget = 512, thinking = 'off') {
    takeCall();
    step.modelCalls++;
    const result = await model.stream({ context, budget, thinking, maxRetries: 0 }, emit, signal);
    if (result.stopReason === 'error' || result.stopReason === 'aborted')
      throw new Error(result.errorMessage ?? '模型请求未完成');
    const u = result.usage;
    step.usage.input += (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
    step.usage.output += u?.output ?? 0;
    return result;
  }
  host.stream = (_runId, budget, thinking) => (_model, context, options) => {
    const out = new AssistantMessageEventStream();
    Promise.resolve()
      .then(() =>
        call(
          context,
          (event) => {
            if (event.type !== 'error') out.push(event);
          },
          options.signal,
          budget,
          thinking,
        ),
      )
      .then(
        (msg) => out.end(msg),
        (error) => {
          const msg = assistant('');
          msg.stopReason = 'error';
          msg.errorMessage = errorText(error);
          out.push({ type: 'error', reason: 'error', error: msg });
          out.end(msg);
        },
      );
    return out;
  };
  const baselinePrompt =
    '你正在聊天。以角色的口吻自然交流，根据说话人、引用和前文，直接用聊天正文回复最新的一条消息。\n【角色资料】\n' +
    JSON.stringify(host.config.persona);
  const replies = (text) => ({ role: 'assistant', actorId: 'bot', speaker: '小鱼', text });
  let cancelReason;
  core.on('event', (e) => {
    if (e.type === 'phase' && e.data.phase === 'cancelled') cancelReason = '模型回合被取消或超时';
  });
  let runtimeUsage;
  try {
    for (const [index, turn] of scenario.turns.entries()) {
      now += turn.advanceMs ?? 1500;
      cancelReason = undefined;
      step = {
        turn: index + 1,
        expectedAction: turn.expectedAction,
        events: [],
        modelCalls: 0,
        usage: { input: 0, output: 0 },
        errors: [],
      };
      turns.push(step);
      const started = performance.now();
      try {
        const previousSeq = store.history(room).at(-1)?.seq ?? 0;
        const inputIds = new Set();
        for (const message of turn.messages) {
          const quoted = message.quote;
          const direct = !scenario.group || message.mention || quoted?.actorId === 'bot';
          const input = envelope(message.text, {
            id: scenario.id + '-' + ++seq,
            conversationId: room,
            timestamp: now,
            actorId: message.actorId,
            displayName: message.displayName,
            channel: scenario.group ? 'onebot' : 'desktop',
            isGroup: scenario.group,
            trigger: direct ? 'direct' : 'ambient',
            mention: message.mention ?? false,
            directedElsewhere: message.directedElsewhere ?? false,
            ...(quoted ? { quoted, replyTo: 'quoted-' + seq } : {}),
          });
          inputIds.add(input.id);
          step.events.push({
            role: 'user',
            actorId: input.actorId,
            speaker: input.displayName,
            text: input.text,
            mention: input.mention,
            directedElsewhere: input.directedElsewhere,
            ...(quoted
              ? { quote: { ...quoted, speaker: names.get(quoted.actorId) ?? quoted.actorId } }
              : {}),
          });
          if (variant === 'current') {
            core.ingest(host.remember(input));
          } else {
            chatHistory.push({ role: 'user', content: batchText([input]), timestamp: now });
            const response = await call(
              normalizeContext({ systemPrompt: baselinePrompt, messages: chatHistory }),
              () => {},
              AbortSignal.timeout(host.config.limits.runTimeoutMs),
            );
            const text = response.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('')
              .trim();
            if (response.stopReason !== 'stop' || !text)
              throw new Error('逐条回放没有取得完整文字回复：' + response.stopReason);
            chatHistory.push(response);
            step.events.push(replies(text));
          }
        }
        if (variant === 'current') {
          const deadline = performance.now() + host.config.limits.runTimeoutMs + 5000;
          while (
            core.stats.timers ||
            core.stats.foreground.active ||
            core.stats.foreground.waiting ||
            core.stats.pending
          ) {
            if (performance.now() > deadline) throw new Error('等待回合完成超时');
            await pause(15);
          }
          const roomError = core.rows().find((r) => r.id === room)?.error;
          if (roomError || cancelReason) throw new Error(roomError ?? cancelReason);
          for (const row of store
            .history(room)
            .filter((m) => m.seq > previousSeq && m.role === 'assistant' && m.status === 'sent')) {
            step.events.push(replies(row.text));
          }
        }
        if (step.events.some((e) => e.role === 'assistant')) step.action = 'reply';
        else if (!step.modelCalls) step.action = 'ignored';
        else {
          const last = store.contextRuns(room).at(-1);
          if (!last?.sources.some((id) => inputIds.has(id)))
            throw new Error('模型回合缺少完成记录');
          const wait = last.messages.some(
            (m) => m.role === 'toolResult' && !m.isError && m.toolName === 'chat_wait',
          );
          const end = last.messages.some(
            (m) => m.role === 'toolResult' && !m.isError && m.toolName === 'chat_end',
          );
          if (!wait && !end) throw new Error('模型没有输出正文或明确的静默动作');
          step.action = wait ? 'wait' : 'end';
        }
      } catch (error) {
        step.action = 'error';
        step.errors.push(errorText(error));
      }
      step.structuralMatch = accepted(step.expectedAction, step.action);
      step.wallTimeMs = Math.round(performance.now() - started);
      if (step.errors.length) break;
    }
  } finally {
    runtimeUsage = store.usage(stableDay(now));
    await core.close();
  }
  const errors = turns.flatMap((turn) => turn.errors);
  return {
    turns,
    modelCalls: turns.reduce((sum, t) => sum + t.modelCalls, 0),
    usage:
      variant === 'current'
        ? runtimeUsage
        : turns.reduce(
            (usage, turn) => ({
              input: usage.input + turn.usage.input,
              output: usage.output + turn.usage.output,
            }),
            { input: 0, output: 0 },
          ),
    errors,
    complete: !errors.length && turns.length === scenario.turns.length,
  };
}

export async function runReplaySuite({
  directory,
  scenarios,
  profile,
  model,
  maxCalls,
  source = 'model',
  persona,
}) {
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 200)
    throw new Error('回放预算必须为 1–200 次请求');
  const base = resolve('test-results');
  directory = resolve(directory);
  const sub = relative(base, directory);
  if (!sub || sub === '..' || sub.startsWith('..' + sep) || isAbsolute(sub))
    throw new Error('请在 test-results 下指定新的输出目录');
  await mkdir(base, { recursive: true });
  await mkdir(directory);
  const report = {
    directory,
    source,
    model: profile.model,
    maxCalls,
    calls: 0,
    complete: false,
    cases: [],
  };
  async function save() {
    await writeFile(resolve(directory, 'replay.json'), JSON.stringify(report, null, 2), 'utf8');
  }
  const takeCall = () => {
    if (report.calls >= maxCalls) throw new Error('已达到本次模型调用上限');
    report.calls++;
  };
  // Never continue spending after an incomplete pair. Persist the successful half on disk.
  for (const scenario of scenarios) {
    const item = { id: scenario.id, title: scenario.title, review: scenario.review, variants: {} };
    report.cases.push(item);
    for (const variant of ['current', 'baseline']) {
      item.variants[variant] = await runReplay(scenario, variant, {
        profile,
        model,
        persona,
        takeCall,
      });
      await save();
      if (!item.variants[variant].complete) break;
    }
    if (!item.variants.baseline?.complete) break;
  }
  report.complete =
    report.cases.length === scenarios.length &&
    report.cases.every((c) => c.variants.baseline?.complete && c.variants.current?.complete);
  await save();
  const { writeBlindReview } = await import('../evaluation/blind-review.mjs');
  await writeBlindReview({ directory, cases: report.cases, source });
  return report;
}
