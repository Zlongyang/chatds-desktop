import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, TranscriptContext } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { defaultConfig } from '../shared/config.js';
import type {
  AppConfig,
  CapabilitySnapshot,
  MessageEnvelope,
  RunContext,
  ToolId,
} from '../shared/types.js';
import { id } from '../shared/util.js';
import { capabilities } from '../runtime/policy.js';
import type { RuntimeHost } from '../runtime/host.js';
export function temporary(): string {
  return mkdtempSync(join(tmpdir(), 'chatds-test-'));
}
export function removeTemporary(directory: string): void {
  assert.equal(dirname(realpathSync(directory)), realpathSync(tmpdir()));
  assert.ok(basename(directory).startsWith('chatds-test-'));
  rmSync(directory, { recursive: true, force: true });
}
export function envelope(text: string, overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: id(),
    conversationId: 'desktop:owner',
    actorId: 'owner',
    channel: 'desktop',
    displayName: '测试者',
    text,
    timestamp: Date.now(),
    isGroup: false,
    trigger: 'direct',
    mention: false,
    ...overrides,
  };
}
export function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export function toolCall(name: string, args: Record<string, any>): AssistantMessage {
  const message = assistant('');
  message.content = [{ type: 'toolCall', id: id(), name, arguments: args }];
  message.stopReason = 'toolUse';
  return message;
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out');
    await delay(5);
  }
}
type Step = (
  context: TranscriptContext,
  signal?: AbortSignal,
) => AssistantMessage | Promise<AssistantMessage>;
export class FakeHost implements RuntimeHost {
  config: AppConfig = defaultConfig();
  sources = new Map<string, MessageEnvelope>();
  runs = new Map<string, RunContext>();
  requests: TranscriptContext[] = [];
  sent: { room: string; text: string }[] = [];
  tools: { tool: ToolId; args: unknown }[] = [];
  steps: Step[] = [];
  sandboxAvailable = false;
  active = 0;
  peak = 0;
  toolHandler?: (tool: ToolId, args: unknown, signal: AbortSignal) => Promise<unknown>;
  constructor() {
    this.config.memory.automatic = false;
  }
  remember(message: MessageEnvelope): MessageEnvelope {
    this.sources.set(message.id, message);
    return message;
  }
  async register(runId: string, sourceIds: string[], conversationId: string): Promise<RunContext> {
    const source = sourceIds.map((key) => this.sources.get(key));
    assert.ok(source.every((m) => m?.conversationId === conversationId));
    const last = source.at(-1)!;
    const ctx: RunContext = {
      id: runId,
      conversationId,
      sourceIds,
      actorId: last!.actorId,
      isGroup: last!.isGroup,
      channel: last!.channel,
      trigger: last!.trigger,
      mode: this.config.conversations[conversationId]?.mode ?? 'companion',
      startedAt: Date.now(),
    };
    this.runs.set(runId, ctx);
    return ctx;
  }
  async capabilities(runId: string): Promise<CapabilitySnapshot> {
    const run = this.runs.get(runId);
    if (!run) throw new Error('missing run');
    return capabilities(this.config, run, [], this.sandboxAvailable);
  }
  async tool(_runId: string, tool: ToolId, args: unknown, signal: AbortSignal): Promise<unknown> {
    this.tools.push({ tool, args });
    return this.toolHandler ? this.toolHandler(tool, args, signal) : { ok: true };
  }
  async send(runId: string, text: string): Promise<string> {
    this.sent.push({ room: this.runs.get(runId)!.conversationId, text });
    return id();
  }
  async finish(runId: string): Promise<void> {
    this.runs.delete(runId);
  }
  stream(_runId: string): StreamFn {
    return (_model, context, options) => {
      const out = new AssistantMessageEventStream();
      this.requests.push(structuredClone(context));
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      const step = this.steps.shift() ?? (() => assistant('我在听。'));
      setImmediate(() => {
        void Promise.resolve()
          .then(() => step(context, options?.signal))
          .then(
            (message) => {
              if (options?.signal?.aborted) {
                const aborted = assistant('');
                aborted.stopReason = 'aborted';
                out.push({ type: 'error', reason: 'aborted', error: aborted });
                out.end(aborted);
                return;
              }
              out.push({ type: 'start', partial: { ...message, content: [] } });
              for (const [i, c] of message.content.entries())
                if (c.type === 'text')
                  out.push({
                    type: 'text_delta',
                    contentIndex: i,
                    delta: c.text,
                    partial: message,
                  });
              out.push({
                type: 'done',
                reason: message.stopReason as 'stop' | 'length' | 'toolUse',
                message,
              });
              out.end(message);
            },
            (error) => {
              const failed = assistant('');
              failed.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
              failed.errorMessage = String(error.message);
              out.push({ type: 'error', reason: failed.stopReason, error: failed });
              out.end(failed);
            },
          )
          .finally(() => this.active--);
      });
      return out;
    };
  }
}
