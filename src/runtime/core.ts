import { EventEmitter } from 'node:events';
import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AppConfig,
  CapabilitySnapshot,
  ConversationRow,
  MessageEnvelope,
  Phase,
  RunContext,
  RuntimeEvent,
  ToolId,
  WebReadReceipt,
} from '../shared/types.js';
import { DEFAULT_CONVERSATION, errorText, TOOL_INFO } from '../shared/config.js';
import { activePersonaName } from '../shared/persona.js';
import { boundText, checkAbort, id, Semaphore, stableDay } from '../shared/util.js';
import { toolArguments, toolSchema } from '../shared/tools.js';
import { piModel } from '../shared/model-definition.js';
import { Store, memoryScope } from './store.js';
import { MessageDebouncer } from './debounce.js';
import { batchText, composePrompt, estimateTokens, trimContext } from './prompt.js';
import { MemoryWorker, explicitFact } from './memory.js';
import type { RuntimeHost } from './host.js';
import {
  asksForWebEvidence,
  captureWebRead,
  claimsWebAccess,
  explainsMissingSource,
} from './web-receipt.js';
import { conversationsToStop } from './policy.js';
import { requestedSilence } from './companion-silence.js';

interface Room {
  id: string;
  phase: Phase;
  pending: MessageEnvelope[];
  batch: MessageEnvelope[];
  debounce: MessageDebouncer;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  agent?: Agent;
  work?: Promise<void>;
  lastSeen: number;
  focusActor?: string;
  focusUntil: number;
  restarts: number;
  committing: boolean;
  draft: string;
  error?: string;
  lastAmbientCheck: number;
}
type Decision = { action: 'reply'; text: string } | { action: 'wait' | 'end' };
export class RuntimeCore extends EventEmitter {
  private config: AppConfig;
  private rooms = new Map<string, Room>();
  private limiter: Semaphore;
  private seq = 0;
  private cleanup: ReturnType<typeof setInterval>;
  private closing = false;
  private reservations = 0;
  readonly memory: MemoryWorker;
  constructor(
    readonly store: Store,
    config: AppConfig,
    private host: RuntimeHost,
    private options: { now?: () => number; timingScale?: number } = {},
  ) {
    super();
    this.config = structuredClone(config);
    this.limiter = new Semaphore(config.limits.foreground, config.limits.totalPending);
    this.memory = new MemoryWorker(
      store,
      () => this.config,
      host,
      () => this.changed(),
      (text) => this.activity(text),
    );
    this.cleanup = setInterval(() => this.evict(), Math.min(60000, config.limits.idleRoomMs));
    this.cleanup.unref();
    this.memory.start();
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private event(type: RuntimeEvent['type'], data: unknown, room?: string, run?: string): void {
    this.emit('event', {
      seq: ++this.seq,
      timestamp: this.now(),
      type,
      data,
      conversationId: room,
      runId: run,
    } satisfies RuntimeEvent);
  }
  private changed(): void {
    this.event('change', null);
  }
  private activity(text: string, room?: string, run?: string): void {
    this.event('activity', { text }, room, run);
  }
  private phase(room: Room, phase: Phase): void {
    room.phase = phase;
    this.event('phase', { phase, error: room.error }, room.id);
  }
  configure(config: AppConfig): void {
    const previous = this.config;
    this.config = structuredClone(config);
    this.limiter.limit = config.limits.foreground;
    const affected = conversationsToStop(previous, config);
    if (affected === 'all') {
      this.stop();
      this.memory.start();
    } else {
      for (const room of affected) this.stop(room);
    }
    this.changed();
  }
  ingest(message: MessageEnvelope): boolean {
    if (this.closing) throw new Error('运行已关闭');
    if (!message.text.trim()) return false;
    const exists = this.store.ingest(message);
    if (!exists) return false;
    this.changed();
    if (!this.config.enabled || this.config.conversations[message.conversationId]?.muted)
      return true;
    let room = this.rooms.get(message.conversationId);
    const latest =
      room?.pending.at(-1) ?? (room?.controller?.signal.aborted ? undefined : room?.batch.at(-1));
    const continuation =
      !message.replyTo &&
      !message.directedElsewhere &&
      (latest
        ? latest.actorId === message.actorId && latest.trigger !== 'ambient'
        : room?.focusActor === message.actorId && room.focusUntil > this.now());
    if (continuation && message.trigger === 'ambient')
      message = { ...message, trigger: 'continuation' };
    const ambient = message.isGroup && message.trigger === 'ambient';
    if (ambient && !this.config.conversations[message.conversationId]?.ambient) return true;
    if (ambient) {
      if (message.directedElsewhere || message.replyTo || (latest && latest.trigger !== 'ambient'))
        return true;
      if (room && this.now() - room.lastAmbientCheck < 60000) return true;
      const hour = Math.floor(this.now() / 3600000),
        key = `check:${message.conversationId}:${hour}`;
      if (!this.store.quota(key, this.config.limits.ambientChecksPerHour)) return true;
      if (
        !this.store.quota(
          `reply:${message.conversationId}:${hour}`,
          this.config.limits.ambientRepliesPerHour,
        )
      )
        return true;
      if (
        this.store.usage(stableDay(this.now())).ambient + this.reservations >=
        this.config.limits.ambientTokenBudget
      )
        return true;
    }
    if (!room) {
      this.evict();
      if (this.rooms.size >= this.config.limits.maxLiveRooms) {
        this.activity('活动会话已达上限，消息已保存', message.conversationId);
        return true;
      }
      room = {
        id: message.conversationId,
        phase: 'idle',
        pending: [],
        batch: [],
        debounce: new MessageDebouncer(),
        lastSeen: this.now(),
        focusUntil: 0,
        restarts: 0,
        committing: false,
        draft: '',
        lastAmbientCheck: 0,
      };
      this.rooms.set(room.id, room);
    }
    room.lastSeen = this.now();
    const total = [...this.rooms.values()].reduce((n, r) => n + r.pending.length, 0);
    if (
      room.pending.length >= this.config.limits.perRoomPending ||
      total >= this.config.limits.totalPending
    ) {
      this.activity('消息已存档，当前待处理消息过多', room.id);
      return true;
    }
    room.pending.push(message);
    if (
      room.agent &&
      !room.controller?.signal.aborted &&
      !room.committing &&
      (this.config.conversations[room.id]?.mode ?? 'companion') === 'companion' &&
      (room.batch.at(-1)?.actorId === message.actorId ||
        message.trigger === 'direct' ||
        !message.isGroup)
    ) {
      const urgent = /^(?:等等|等一下|不是|先别|别回|算了|停止)/.test(message.text);
      if (room.restarts < 1 || urgent) {
        room.restarts++;
        room.pending = [...room.batch, ...room.pending]
          .filter((m, i, a) => a.findIndex((x) => x.id === m.id) === i)
          .slice(-this.config.limits.perRoomPending);
        room.controller?.abort();
        room.agent.abort();
        this.activity('新消息已补充，重新整理回复', room.id);
      }
    }
    const now = this.now() / 1000;
    room.debounce.observe({
      author: message.actorId,
      mention: message.mention,
      receivedAt: message.timestamp / 1000,
      wallTime: this.now() / 1000,
      now,
      mode: message.isGroup ? 'natural' : 'fast',
    });
    if (!room.work) this.schedule(room);
    return true;
  }
  private schedule(room: Room): void {
    if (this.closing || room.work || !room.pending.length) return;
    clearTimeout(room.timer);
    this.phase(room, 'collecting');
    const delay =
      Math.max(0, (room.debounce.deadline ?? this.now() / 1000) * 1000 - this.now()) *
      (this.options.timingScale ?? 1);
    room.timer = setTimeout(() => {
      room.timer = undefined;
      room.work = this.run(room)
        .catch((e) => {
          room.error = errorText(e);
          this.activity(room.error, room.id);
        })
        .finally(() => {
          room.work = undefined;
          room.agent = undefined;
          room.controller = undefined;
          room.batch = [];
          room.committing = false;
          room.draft = '';
          if (room.pending.length && !this.closing && this.config.enabled) this.schedule(room);
          else {
            room.restarts = 0;
            this.phase(room, 'idle');
          }
          this.changed();
        });
    }, delay);
    room.timer.unref();
  }
  private async run(room: Room): Promise<void> {
    if (!this.config.enabled || this.closing || !room.pending.length) return;
    const controller = new AbortController();
    room.controller = controller;
    this.phase(room, 'queued');
    const release = await this.limiter.acquire(controller.signal);
    let run: RunContext | undefined;
    let reserved = 0;
    const timeout = setTimeout(() => {
      controller.abort();
      room.agent?.abort();
    }, this.config.limits.runTimeoutMs);
    timeout.unref();
    try {
      checkAbort(controller.signal);
      room.batch = room.pending.splice(0);
      room.debounce.consume();
      const batch = room.batch;
      run = await this.host.register(
        id(),
        batch.map((m) => m.id),
        room.id,
      );
      checkAbort(controller.signal);
      let cap = await this.host.capabilities(run.id);
      const current = run;
      const ambient = batch.at(-1)!.trigger === 'ambient';
      if (ambient) {
        const hour = Math.floor(this.now() / 3600000);
        if (
          !this.store.quota(
            `check:${room.id}:${hour}`,
            this.config.limits.ambientChecksPerHour,
            true,
          )
        )
          return;
        room.lastAmbientCheck = this.now();
      }
      this.phase(room, 'recalling');
      const saved = this.memory.capture(batch);
      const usedFacts = new Set<string>(saved);
      const input = batchText(
        batch.map((m, i) => ({
          ...m,
          text: m.text.slice(0, i === batch.length - 1 ? 6000 : 1000),
        })),
      );
      const finishDecision = (
        action: Decision['action'],
        wire: AgentMessage[],
        requested = false,
      ) => {
        if (action === 'reply' || (action === 'wait' && !ambient)) {
          room.focusActor = batch.at(-1)!.actorId;
          room.focusUntil = this.now() + 120000;
        } else if (!ambient || room.focusActor === batch.at(-1)!.actorId) {
          room.focusUntil = 0;
        }
        this.store.saveRun(current, wire, requested ? 'user-' + action : 'complete', [
          ...usedFacts,
        ]);
        const extractFrom = requested ? batch.slice(0, -1) : batch;
        if (extractFrom.length) this.memory.enqueue(extractFrom);
        this.memory.summarize(room.id);
        this.changed();
      };
      const requested = cap.mode === 'companion' ? requestedSilence(batch) : undefined;
      if (requested) {
        room.error = undefined;
        this.activity(
          requested === 'wait' ? '对方请稍等，等待补充' : '对方表示不用回复',
          room.id,
          current.id,
        );
        finishDecision(requested, [{ role: 'user', content: input, timestamp: this.now() }], true);
        return;
      }
      const webReads: WebReadReceipt[] = [];
      const lookupRequested = !ambient && asksForWebEvidence(batch.at(-1)!.text);
      let retryWeb = false;
      let decision: Decision | undefined;
      let count = 0;
      const toolsFor = (snapshot: CapabilitySnapshot): AgentTool<any>[] => {
        const tools: AgentTool<any>[] = snapshot.tools.map(
          (tool) =>
            ({
              name: tool.id,
              label: tool.description,
              description: tool.description,
              parameters: toolSchema(tool.id),
              execute: async (_call: string, raw: unknown, signal?: AbortSignal) => {
                const args = toolArguments[tool.id].parse(raw) as any;
                const active = await this.host.capabilities(current.id);
                if (!active.tools.some((t) => t.id === tool.id)) throw new Error('此工具已撤权');
                checkAbort(signal);
                let value: unknown;
                if (tool.id === 'memory_search') {
                  const found = this.store.search(memoryScope(current), args.query);
                  for (const fact of found) usedFacts.add(fact.id);
                  value = found;
                } else if (tool.id === 'memory_remember') {
                  const source = [...batch]
                    .reverse()
                    .find((m) => m.actorId === current.actorId && explicitFact(m));
                  if (!source) throw new Error('仅在当前发送者明确要求记住时使用此工具');
                  const fact = explicitFact(source)!;
                  value = this.store.remember(
                    memoryScope(current),
                    current.actorId,
                    fact,
                    'event',
                    [source.id],
                  );
                  this.changed();
                } else {
                  const invoke = () =>
                    this.host.tool(current.id, tool.id, args, signal ?? controller.signal);
                  value =
                    tool.id === 'web_read'
                      ? await captureWebRead(webReads, args.url, invoke)
                      : await invoke();
                }
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: typeof value === 'string' ? value : JSON.stringify(value),
                    },
                  ],
                  details: {},
                };
              },
            }) satisfies AgentTool<any>,
        );
        if (snapshot.mode === 'companion') {
          const define = (
            name: string,
            description: string,
            parameters: object,
            execute: (a: any) => void,
          ): AgentTool<any> => ({
            name,
            label: description,
            description,
            parameters,
            execute: async (_key, args) => {
              checkAbort(controller.signal);
              if (decision) throw new Error('本轮已经决定如何回应');
              execute(args);
              return { content: [{ type: 'text', text: '决定已保存，本轮结束。' }], details: {} };
            },
          });
          tools.push(
            define(
              'chat_reply',
              '回复当前这批消息，填写自然聊天正文',
              {
                type: 'object',
                properties: { text: { type: 'string', minLength: 1, maxLength: 6000 } },
                required: ['text'],
                additionalProperties: false,
              },
              (a) => {
                decision = { action: 'reply', text: boundText(a.text) };
              },
            ),
          );
          tools.push(
            define(
              'chat_wait',
              '等对方补充；不发消息，不持续调用模型',
              { type: 'object', properties: {}, additionalProperties: false },
              () => {
                decision = { action: 'wait' };
              },
            ),
          );
          tools.push(
            define(
              'chat_end',
              '无需接话，结束本轮并保持安静',
              { type: 'object', properties: {}, additionalProperties: false },
              () => {
                decision = { action: 'end' };
              },
            ),
          );
        }
        return tools;
      };
      let runTools = toolsFor(cap);
      let replyName = activePersonaName(this.config);
      const priorRuns = this.store.contextRuns(room.id);
      const prior = priorRuns.flatMap((r) => r.messages);
      for (const fact of priorRuns.flatMap((r) => r.factRefs)) usedFacts.add(fact);
      const wire: AgentMessage[] = [];
      const agent = new Agent({
        initialState: {
          systemPrompt: composePrompt(this.config.persona, cap, [], ''),
          model: piModel(this.config.model),
          tools: runTools,
          messages: trimContext(prior, 8000),
          thinkingLevel: cap.mode === 'companion' ? 'off' : this.config.model.thinking,
        },
        streamFn: this.host.stream(
          current.id,
          cap.mode === 'companion' ? 512 : undefined,
          cap.mode === 'companion' ? 'off' : undefined,
        ),
        toolExecution: 'sequential',
        sessionId: room.id,
        beforeToolCall: async ({ toolCall }) => {
          try {
            checkAbort(controller.signal);
            const live = await this.host.capabilities(current.id);
            if (['chat_reply', 'chat_wait', 'chat_end'].includes(toolCall.name))
              return live.mode === 'companion' ? undefined : { block: true, reason: '模式已改变' };
            return live.tools.some((t) => t.id === toolCall.name)
              ? undefined
              : { block: true, reason: '此工具当前不可用' };
          } catch {
            return { block: true, reason: '运行已取消', terminate: true };
          }
        },
        finishTurn: ({ message, toolResults }) => {
          if (decision) return { action: 'end' };
          if (toolResults.length || message.stopReason !== 'stop' || webReads.length || retryWeb)
            return;
          const answer = message.content
            .flatMap((c) => (c.type === 'text' ? [c.text] : []))
            .join('');
          if (
            cap.tools.some((t) => t.id === 'web_read') &&
            (lookupRequested || claimsWebAccess(answer))
          ) {
            retryWeb = true;
            // The unsupported draft was never delivered. Retry with the same user
            // input, without teaching the model that this draft was sent.
            if (wire.at(-1)?.role === 'assistant') wire.pop();
            room.draft = '';
            return { action: 'continue' };
          }
        },
        prepareRequest: async (request) => {
          try {
            checkAbort(controller.signal);
            cap = await this.host.capabilities(current.id);
            runTools = toolsFor(cap);
            const facts = this.config.tools.memory_search
              ? this.store.search(memoryScope(current), batch.map((m) => m.text).join('\n'))
              : [];
            for (const fact of facts) usedFacts.add(fact.id);
            const nearby = current.isGroup
              ? this.store
                  .recentEnvelopes(room.id, 20)
                  .filter((m) => !batch.some((x) => x.id === m.id))
                  .map((m) => ({
                    actor: m.actorId,
                    name: m.displayName,
                    text: m.text.slice(0, 400),
                    quoted: m.quoted,
                  }))
              : [];
            replyName = activePersonaName(this.config);
            const system =
              composePrompt(this.config.persona, cap, facts, this.store.getSummary(room.id)) +
              '\n当前时间：' +
              new Date(this.now()).toISOString() +
              (retryWeb && !webReads.length
                ? '\n本轮尚无网页读取记录。请调用 web_read 取得依据。如果无法确定来源，请询问网址。'
                : '') +
              '\n【已完成的本轮记忆保存】\n' +
              JSON.stringify(saved) +
              '\n【本群近旁消息，仅作对话资料】\n' +
              JSON.stringify(nearby);
            const allowedInput =
              this.config.model.contextWindow - this.config.model.maxOutputTokens - 1024;
            const systemTokens =
              estimateTokens(system) + estimateTokens(runTools.map((t) => t.parameters));
            if (systemTokens + 2048 >= allowedInput)
              throw new Error(
                '人设与能力目录超过此模型的上下文预算，请缩短人设或增加正确的模型窗口',
              );
            const budget =
              Math.min(Math.max(16000, systemTokens + 4096), allowedInput) - systemTokens;
            const history = request.context.messages;
            const messages = trimContext(
              retryWeb && !webReads.length && history.at(-1)?.role === 'assistant'
                ? history.slice(0, -1)
                : history,
              budget,
            );
            if (estimateTokens(messages) > budget)
              throw new Error('当前消息或工具结果超过上下文预算，请分段发送或换用更大的模型窗口');
            const projected = [
              {
                role: 'system' as const,
                content: system,
                toolsAdded: runTools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                })),
                timestamp: this.now(),
              },
              ...messages,
            ];
            if (ambient) {
              this.reservations -= reserved;
              reserved = 0;
              const estimate = estimateTokens(projected) + 512;
              if (
                this.store.usage(stableDay(this.now())).ambient + this.reservations + estimate >
                this.config.limits.ambientTokenBudget
              )
                throw new Error('自主判定已达到每日 token 预算');
              reserved = estimate;
              this.reservations += estimate;
            }
            return { context: { messages: projected, tools: runTools } };
          } catch (e) {
            room.error = errorText(e);
            throw e;
          }
        },
      });
      room.agent = agent;
      room.draft = '';
      room.error = undefined;
      this.phase(room, 'generating');
      const abort = () => agent.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === 'turn_start' && ++count > 8) {
          controller.abort();
          agent.abort();
        }
        if (event.type === 'message_end' && event.message.role !== 'system') {
          wire.push(structuredClone(event.message));
          if (event.message.role === 'assistant') {
            const u = event.message.usage;
            const input = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
            this.store.addUsage(stableDay(this.now()), input, u.output ?? 0, ambient);
            this.event('usage', this.store.usage(stableDay(this.now())), room.id, current.id);
          }
        }
        if (
          event.type === 'message_update' &&
          event.assistantMessageEvent.type === 'text_delta' &&
          current.mode === 'assistant'
        ) {
          room.draft += event.assistantMessageEvent.delta;
          this.event('draft', { text: room.draft.slice(0, 12000) }, room.id, current.id);
        }
        if (event.type === 'tool_execution_start') {
          this.phase(room, 'tool');
          this.activity('调用 ' + event.toolName, room.id, current.id);
        }
        if (event.type === 'tool_execution_end') {
          this.phase(room, 'generating');
          this.activity(event.isError ? '工具未完成' : '工具已完成', room.id, current.id);
        }
      });
      try {
        await agent.prompt(input);
        checkAbort(controller.signal);
        if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
        if (!decision) {
          const last = agent.state.messages.filter((m) => m.role === 'assistant').at(-1);
          const answer = last?.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('')
            .trim();
          if (last?.stopReason === 'error' || last?.stopReason === 'aborted')
            throw new Error(last.errorMessage ?? '回复已取消');
          if (answer) decision = { action: 'reply', text: answer.slice(0, 6000) };
          else decision = { action: 'end' };
        }
        if (decision.action === 'reply') {
          checkAbort(controller.signal);
          let text = decision.text.trim();
          if (!text) throw new Error('回复正文为空');
          const claimedRead = !webReads.length && claimsWebAccess(text);
          const receipts = webReads.length || lookupRequested || claimedRead ? webReads : undefined;
          if (
            claimedRead ||
            (!webReads.length && lookupRequested && !explainsMissingSource(text))
          ) {
            const available = cap.tools.some((t) => t.id === 'web_read');
            text = available
              ? '这次还没读到可核实的来源。你有想让我看的官网或文章链接吗？'
              : cap.mode === 'companion'
                ? '纯陪伴模式下我没有读取网页，这条消息还没核实。'
                : '这次没有读取网页。当前会话的网页读取权限未开启。';
            if (current.channel === 'desktop' && !available)
              text +=
                cap.mode === 'companion'
                  ? '切换到「受控助理」，就可以在聊天栏打开网页读取设置。'
                  : '点聊天栏的「网页读取已关闭」可以打开设置。';
            // Keep the delivered answer in history for both plain text and
            // chat_reply. Preserve tool-call IDs and their matching results.
            const assistant = wire.findLast((m) => m.role === 'assistant');
            if (assistant?.role === 'assistant') {
              const call = assistant.content.find(
                (c) => c.type === 'toolCall' && c.name === 'chat_reply',
              );
              if (call?.type === 'toolCall') call.arguments.text = text;
              else assistant.content = [{ type: 'text', text }];
            }
          }
          room.committing = true;
          this.phase(room, 'sending');
          if (current.channel === 'onebot') {
            const outbox = this.store.createOutbox(room.id, text);
            this.store.appendAssistant(room.id, text, outbox, 'pending', replyName, receipts);
            this.changed();
            try {
              const remoteId = await this.host.send(current.id, text, outbox, controller.signal);
              this.store.finishOutbox(outbox, 'sent', remoteId);
            } catch (e) {
              this.store.finishOutbox(
                outbox,
                /未知|unknown/i.test(errorText(e)) ? 'unknown' : 'failed',
              );
              throw e;
            }
          } else this.store.appendAssistant(room.id, text, undefined, 'sent', replyName, receipts);
          if (ambient)
            this.store.quota(
              `reply:${room.id}:${Math.floor(this.now() / 3600000)}`,
              this.config.limits.ambientRepliesPerHour,
              true,
            );
        }
        finishDecision(decision.action, wire);
      } finally {
        unsubscribe();
        controller.signal.removeEventListener('abort', abort);
      }
    } catch (e) {
      if (controller.signal.aborted) {
        this.phase(room, 'cancelled');
        if (room.error) this.activity(room.error, room.id, run?.id);
      } else {
        room.error = errorText(e);
        this.phase(room, 'error');
        this.activity(room.error, room.id, run?.id);
      }
    } finally {
      clearTimeout(timeout);
      this.reservations -= reserved;
      if (run) await this.host.finish(run.id).catch(() => {});
      release();
    }
  }
  stop(conversationId?: string): void {
    for (const room of this.rooms.values())
      if (!conversationId || room.id === conversationId) {
        clearTimeout(room.timer);
        room.timer = undefined;
        room.pending = [];
        room.controller?.abort();
        room.agent?.abort();
        room.debounce.consume();
        room.focusUntil = 0;
        room.draft = '';
        if (!room.work) this.phase(room, 'idle');
      }
    if (!conversationId) this.memory.cancel();
    this.changed();
  }
  rows(): ConversationRow[] {
    return this.store.rooms().map((r) => ({
      ...r,
      unread: 0,
      phase: this.rooms.get(r.id)?.phase ?? 'idle',
      draft: this.rooms.get(r.id)?.draft,
      error: this.rooms.get(r.id)?.error,
      settings: this.config.conversations[r.id] ?? { ...DEFAULT_CONVERSATION },
    }));
  }
  evict(): void {
    for (const [key, room] of this.rooms)
      if (
        !room.work &&
        !room.timer &&
        !room.pending.length &&
        this.now() - room.lastSeen > this.config.limits.idleRoomMs
      )
        this.rooms.delete(key);
  }
  async idle(): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      if (![...this.rooms.values()].some((r) => r.work || r.timer)) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('运行时未进入空闲');
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.cleanup);
    this.stop();
    await this.memory.close();
    await Promise.allSettled([...this.rooms.values()].flatMap((r) => (r.work ? [r.work] : [])));
    this.rooms.clear();
    this.store.close();
  }
  get stats() {
    return {
      rooms: this.rooms.size,
      pending: [...this.rooms.values()].reduce((n, r) => n + r.pending.length, 0),
      timers: [...this.rooms.values()].filter((r) => r.timer).length,
      foreground: this.limiter.stats,
      memory: this.memory.stats,
    };
  }
}
