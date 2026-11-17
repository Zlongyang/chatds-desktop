import { z } from 'zod';
import type { AppConfig, ConversationSettings, ModelProfile, ToolId } from './types.js';

export const TOOL_INFO: Record<ToolId, { description: string; approval: boolean }> = {
  memory_search: { description: '查询当前身份和聊天范围内的记忆', approval: false },
  memory_remember: { description: '记住当前发言者明确提供的事实', approval: false },
  skills_load: { description: '读取已安装技能，不授予额外权限', approval: false },
  read_file: { description: '读取当前会话工作区', approval: false },
  write_file: { description: '写入当前会话工作区', approval: true },
  web_read: { description: '阅读公开 HTTPS 网页', approval: false },
  sandbox_exec: { description: '在隔离 Docker 中执行 JavaScript 或 Python', approval: true },
  qzone_publish: { description: '发布经你确认的纯文字说说', approval: true },
};
export const DEFAULT_PERSONA = `你叫小鱼，是一个有自己喜好和判断的聊天伙伴。你有一点好奇，也会开轻巧的玩笑。
日常聊天说自然口语，接住对方具体在说什么。对方在倾诉时先听，不急着提建议。对方连续说几句时，把它们一起理解。
语气、长短随内容变化。很多时候一句普通话已经足够，不必每轮追问。默认不写括号动作、舞台旁白和长段内心戏。
可以延续一起想象的小场景，但现实经历、账号操作、记忆和工具结果要依据记录。认识一个人需要时间，不预设亲属、恋爱或主仆关系。
示例：
对方：今天又临时加活，烦死了。先别给方案。
小鱼：嗯，先骂两句。明明已经排好了，还得被塞一堆事。
对方：我本来想早点睡。结果又刷到了现在。
小鱼：那个“再看一个”是不是已经续了十集。
对方：这个事先不聊了。
小鱼：行，换个话题。`;
export const DEFAULT_CONVERSATION: ConversationSettings = {
  mode: 'companion',
  ambient: false,
  muted: false,
};
const qq = z.string().regex(/^\d{5,12}$/);
const endpoint = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        !u.username &&
        !u.password &&
        !u.hash &&
        (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname)))
      );
    } catch {
      return false;
    }
  }, '模型地址需要 HTTPS 或本机 HTTP，不得含用户名和密码');
export const modelSchema = z
  .object({
    protocol: z.literal('openai-completions'),
    provider: z.enum(['deepseek', 'openai-compatible']),
    baseUrl: endpoint,
    model: z.string().trim().min(1).max(128),
    contextWindow: z.number().int().min(4096).max(2_000_000),
    maxOutputTokens: z.number().int().min(128).max(32768),
    thinking: z.enum(['off', 'low', 'high']),
    keyRequired: z.boolean(),
  })
  .strict()
  .refine((m) => m.maxOutputTokens < m.contextWindow / 2, '输出预算需要小于上下文的一半');
export function isLoopback(host: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase());
}
export function validateOneBotUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      (u.protocol === 'wss:' || (u.protocol === 'ws:' && isLoopback(u.hostname)))
    );
  } catch {
    return false;
  }
}
export const conversationSchema = z
  .object({ mode: z.enum(['companion', 'assistant']), ambient: z.boolean(), muted: z.boolean() })
  .strict();
export const configSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().positive(),
    enabled: z.boolean(),
    persona: z.string().trim().min(1).max(20000),
    model: modelSchema,
    onebot: z
      .object({
        enabled: z.boolean(),
        url: z.string().max(2048).refine(validateOneBotUrl, 'OneBot 需要本机 ws 或加密 wss 地址'),
        botQQ: z.union([qq, z.literal('')]),
        ownerQQ: z.union([qq, z.literal('')]),
        users: z.array(qq).max(500),
        groups: z.array(qq).max(500),
      })
      .strict(),
    tools: z
      .object(
        Object.fromEntries(Object.keys(TOOL_INFO).map((k) => [k, z.boolean()])) as Record<
          ToolId,
          z.ZodBoolean
        >,
      )
      .strict(),
    conversations: z.record(z.string().max(180), conversationSchema),
    memory: z
      .object({
        automatic: z.boolean(),
        extractionDelayMs: z.number().int().min(1000).max(300000),
        dailyTokenBudget: z.number().int().min(0).max(1_000_000).default(50000),
      })
      .strict(),
    limits: z
      .object({
        foreground: z.number().int().min(1).max(4),
        perRoomPending: z.number().int().min(1).max(50),
        totalPending: z.number().int().min(20).max(1000),
        maxLiveRooms: z.number().int().min(4).max(500),
        idleRoomMs: z.number().int().min(1000).max(3600000),
        runTimeoutMs: z.number().int().min(1000).max(300000),
        ambientChecksPerHour: z.number().int().min(0).max(120),
        ambientRepliesPerHour: z.number().int().min(0).max(60),
        ambientTokenBudget: z.number().int().min(0).max(1_000_000),
      })
      .strict(),
    sandbox: z
      .object({
        image: z.string().regex(/^chatds-sandbox(?::[a-zA-Z0-9_.-]+)?(?:@sha256:[a-f0-9]{64})?$/),
        timeoutMs: z.number().int().min(1000).max(60000),
        memoryMb: z.number().int().min(64).max(2048),
        cpus: z.number().min(0.25).max(2),
        pids: z.number().int().min(8).max(128),
      })
      .strict(),
  })
  .strict();
export function defaultConfig(): AppConfig {
  return {
    version: 1,
    revision: 1,
    enabled: true,
    persona: DEFAULT_PERSONA,
    model: {
      protocol: 'openai-completions',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      contextWindow: 128000,
      maxOutputTokens: 2048,
      thinking: 'off',
      keyRequired: true,
    },
    onebot: {
      enabled: false,
      url: 'ws://127.0.0.1:3001',
      botQQ: '',
      ownerQQ: '',
      users: [],
      groups: [],
    },
    tools: {
      memory_search: true,
      memory_remember: true,
      skills_load: true,
      read_file: false,
      write_file: false,
      web_read: false,
      sandbox_exec: false,
      qzone_publish: false,
    },
    conversations: {},
    memory: { automatic: true, extractionDelayMs: 30000, dailyTokenBudget: 50000 },
    limits: {
      foreground: 2,
      perRoomPending: 20,
      totalPending: 200,
      maxLiveRooms: 128,
      idleRoomMs: 600000,
      runTimeoutMs: 120000,
      ambientChecksPerHour: 60,
      ambientRepliesPerHour: 6,
      ambientTokenBudget: 100000,
    },
    sandbox: { image: 'chatds-sandbox:1', timeoutMs: 30000, memoryMb: 512, cpus: 1, pids: 64 },
  };
}
export function modelIdentity(m: ModelProfile): string {
  const u = new URL(m.baseUrl);
  return `${m.provider}:${u.origin}${u.pathname.replace(/\/$/, '')}`;
}
export function validateConversationId(value: string): string {
  if (!/^(desktop:owner|onebot:(?:private|group):\d{5,12})$/.test(value))
    throw new Error('会话编号无效');
  return value;
}
export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:sk-|Bearer\s+)[\w.-]{10,}/gi, '[已隐藏]')
    .slice(0, 500);
}
