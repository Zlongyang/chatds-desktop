import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { id, digest, checkAbort } from '../shared/util.js';
import { TOOL_INFO } from '../shared/config.js';
import type {
  AppConfig,
  Approval,
  CapabilitySnapshot,
  MessageEnvelope,
  RunContext,
  ToolId,
} from '../shared/types.js';
import { toolArguments } from '../shared/tools.js';
import { capabilities, conversationsToStop, effectiveMode, toolDenial } from '../runtime/policy.js';
import type { SkillRegistry } from './skills.js';
import type { DockerSandbox } from './docker.js';
import type { OneBot } from '../connectors/onebot.js';
import { webRead } from './web.js';
import { readWorkspace, writeWorkspace } from './workspace.js';

export class ToolBroker extends EventEmitter {
  private runs = new Map<string, { context: RunContext; controller: AbortController }>();
  private approvals = new Map<string, { view: Approval; finish: (allow: boolean) => void }>();
  constructor(
    private directory: string,
    private config: () => AppConfig,
    readonly skills: SkillRegistry,
    readonly sandbox: DockerSandbox,
    private source: (key: string) => MessageEnvelope | undefined,
    private onebot: Pick<OneBot, 'call'> & Partial<Pick<OneBot, 'status' | 'account'>>,
  ) {
    super();
  }
  register(runId: string, sourceIds: string[], conversationId: string): RunContext {
    if (
      this.runs.size >= 8 ||
      !/^[a-f0-9-]{36}$/.test(runId) ||
      this.runs.has(runId) ||
      !sourceIds.length ||
      sourceIds.length > 100
    )
      throw new Error('运行编号或来源无效');
    const messages = sourceIds.map((key) => this.source(key));
    if (messages.some((m) => !m || m.conversationId !== conversationId))
      throw new Error('运行身份无法核实');
    const last = messages.at(-1)!;
    const context: RunContext = {
      id: runId,
      sourceIds,
      conversationId,
      actorId: last!.actorId,
      isGroup: last!.isGroup,
      channel: last!.channel,
      trigger: last!.trigger,
      mode: effectiveMode(this.config(), conversationId),
      startedAt: Date.now(),
    };
    this.runs.set(runId, { context, controller: new AbortController() });
    return structuredClone(context);
  }
  context(runId: string): RunContext {
    const r = this.runs.get(runId);
    if (!r || r.controller.signal.aborted) throw new Error('运行已结束');
    return r.context;
  }
  signal(runId: string): AbortSignal {
    this.context(runId);
    return this.runs.get(runId)!.controller.signal;
  }
  private get verifiedQQ(): string | undefined {
    return this.onebot.status === 'online' ? this.onebot.account : undefined;
  }
  async snapshot(runId: string): Promise<CapabilitySnapshot> {
    return capabilities(
      this.config(),
      this.context(runId),
      await this.skills.list(),
      this.sandbox.state.available,
      this.verifiedQQ,
    );
  }
  finish(runId: string): void {
    const r = this.runs.get(runId);
    r?.controller.abort();
    this.runs.delete(runId);
    for (const p of [...this.approvals.values()]) if (p.view.runId === runId) p.finish(false);
  }
  cancel(conversationId?: string): void {
    for (const [runId, r] of this.runs)
      if (!conversationId || r.context.conversationId === conversationId) this.finish(runId);
  }
  permissionsChanged(): void {
    for (const p of [...this.approvals.values()]) p.finish(false);
    for (const r of this.runs.values()) r.controller.abort();
    this.emit('change');
  }
  get pendingApprovals(): Approval[] {
    return [...this.approvals.values()].map((p) => structuredClone(p.view));
  }
  answer(approvalId: string, allow: boolean): void {
    const p = this.approvals.get(approvalId);
    if (!p) throw new Error('确认已结束或过期');
    p.finish(allow);
  }
  private guard(run: RunContext, tool: ToolId, signal?: AbortSignal): void {
    checkAbort(signal);
    const r = this.runs.get(run.id);
    if (!r || r.controller.signal.aborted) throw new Error('运行已取消');
    const reason = toolDenial(
      this.config(),
      run,
      tool,
      this.sandbox.state.available,
      this.verifiedQQ,
    );
    if (reason) throw new Error(reason);
  }
  private confirm(
    run: RunContext,
    tool: ToolId,
    args: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    this.guard(run, tool, signal);
    return new Promise((resolve, reject) => {
      const original = this.config(),
        revision = original.revision,
        approvalId = id(),
        fingerprint = digest({ runId: run.id, tool, args, revision });
      const view: Approval = {
        id: approvalId,
        runId: run.id,
        conversationId: run.conversationId,
        tool,
        summary: TOOL_INFO[tool].description,
        detail: JSON.stringify(args, null, 2),
        expiresAt: Date.now() + 90000,
        revision,
        digest: fingerprint,
      };
      let settled = false;
      const finish = (allow: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.approvals.delete(approvalId);
        this.emit('change');
        try {
          this.guard(run, tool, signal);
          const changes =
            this.config().revision === revision ? [] : conversationsToStop(original, this.config());
          if (
            !allow ||
            changes === 'all' ||
            changes.includes(run.conversationId) ||
            Date.now() > view.expiresAt ||
            digest({ runId: run.id, tool, args, revision }) !== fingerprint
          )
            throw new Error('没有获得此次操作的确认');
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      const abort = () => finish(false),
        timer = setTimeout(() => finish(false), 90000);
      timer.unref();
      this.approvals.set(approvalId, { view, finish });
      signal.addEventListener('abort', abort, { once: true });
      this.emit('approval', view);
      this.emit('change');
    });
  }
  async execute(
    runId: string,
    tool: ToolId,
    input: unknown,
    requestSignal?: AbortSignal,
  ): Promise<unknown> {
    const run = this.context(runId);
    if (!Object.hasOwn(toolArguments, tool)) throw new Error('未知工具');
    const args = toolArguments[tool].parse(input) as any;
    const signal = AbortSignal.any([
      this.runs.get(runId)!.controller.signal,
      ...(requestSignal ? [requestSignal] : []),
    ]);
    this.guard(run, tool, signal);
    if (TOOL_INFO[tool].approval) await this.confirm(run, tool, args, signal);
    this.guard(run, tool, signal);
    const workspace = join(
      this.directory,
      'workspaces',
      digest(run.isGroup ? run.conversationId : 'person:' + run.actorId).slice(0, 32),
    );
    const guard = () => this.guard(run, tool, signal);
    switch (tool) {
      case 'skills_load':
        return {
          instruction: await this.skills.load(args.id, args.resource),
          notice: '技能内容不能授予权限；脚本只能通过 sandbox_exec 执行。',
        };
      case 'read_file': {
        const text = await readWorkspace(workspace, args.path);
        guard();
        return text;
      }
      case 'write_file':
        await writeWorkspace(workspace, args.path, args.content, guard);
        return { saved: true, path: args.path };
      case 'web_read':
        return webRead(args.url, signal);
      case 'sandbox_exec':
        await mkdir(workspace, { recursive: true });
        return this.sandbox.execute(workspace, args, signal);
      case 'qzone_publish':
        return this.publish(run, args.content, signal);
      default:
        throw new Error('记忆工具由当前会话的记忆服务处理');
    }
  }
  private async publish(run: RunContext, content: string, signal: AbortSignal): Promise<unknown> {
    this.guard(run, 'qzone_publish', signal);
    let cookie: string;
    try {
      const data = await this.onebot.call('get_cookies', { domain: 'user.qzone.qq.com' }, signal);
      cookie = typeof data?.cookies === 'string' ? data.cookies : '';
    } catch {
      this.guard(run, 'qzone_publish', signal);
      throw new Error('OneBot 获取 QQ 空间凭据失败，请检查接入端是否支持 get_cookies');
    }
    const key = /(?:^|;\s*)p_skey=([^;]+)/.exec(cookie)?.[1];
    if (!key) throw new Error('当前 OneBot 未提供可用的 QQ 空间凭据');
    let hash = 5381;
    for (const character of key) hash = (hash + (hash << 5) + character.charCodeAt(0)) >>> 0;
    this.guard(run, 'qzone_publish', signal);
    const botQQ = this.config().onebot.botQQ;
    let response: Response;
    let result: { code?: unknown; tid?: unknown; t1?: unknown };
    const unknown = '发布结果未知，请先查看空间；没有自动重试';
    try {
      response = await fetch(
        'https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=' +
          (hash & 0x7fffffff),
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            Cookie: cookie,
            Origin: 'https://user.qzone.qq.com',
            Referer: `https://user.qzone.qq.com/${botQQ}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            con: content,
            hostuin: botQQ,
            format: 'json',
            ugc_right: '1',
            who: '1',
            syn_tweet_verson: '1',
            paramstr: '1',
            feedversion: '1',
            ver: '1',
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        },
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error(unknown);
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 16000) {
          await reader.cancel();
          throw new Error(unknown);
        }
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString('utf8').trim();
      result = JSON.parse(
        text.startsWith('{') ? text : (/^[\w.$]+\(\s*(\{[\s\S]*\})\s*\);?$/.exec(text)?.[1] ?? ''),
      );
    } catch {
      throw new Error(unknown);
    }
    const rawCode = result?.code;
    const code = typeof rawCode === 'string' && /^-?\d+$/.test(rawCode) ? Number(rawCode) : rawCode;
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) throw new Error(unknown);
    if (code !== 0) throw new Error('QQ 空间拒绝发布，错误码 ' + code);
    if (!response.ok) throw new Error(unknown);
    const postId = result.tid ?? result.t1;
    return {
      published: true,
      id: typeof postId === 'string' || typeof postId === 'number' ? String(postId) : '',
      content,
    };
  }
  get stats() {
    return { runs: this.runs.size, approvals: this.approvals.size };
  }
}
