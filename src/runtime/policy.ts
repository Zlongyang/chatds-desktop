import { DEFAULT_CONVERSATION, TOOL_INFO } from '../shared/config.js';
import { isDeepStrictEqual } from 'node:util';
import type {
  AppConfig,
  CapabilitySnapshot,
  RunContext,
  SkillInfo,
  ToolId,
} from '../shared/types.js';
const taskTools: ToolId[] = [
  'skills_load',
  'read_file',
  'write_file',
  'web_read',
  'sandbox_exec',
  'qzone_publish',
];
/** Global settings affect every run. Persona writing is refreshed on the next model request. */
export function conversationsToStop(before: AppConfig, after: AppConfig): 'all' | string[] {
  const global = ({
    conversations,
    persona,
    personaLibrary,
    tavernContext,
    revision,
    ...settings
  }: AppConfig) => settings;
  if (!isDeepStrictEqual(global(before), global(after))) return 'all';
  return [
    ...new Set([...Object.keys(before.conversations), ...Object.keys(after.conversations)]),
  ].filter(
    (room) =>
      !isDeepStrictEqual(
        before.conversations[room] ?? DEFAULT_CONVERSATION,
        after.conversations[room] ?? DEFAULT_CONVERSATION,
      ),
  );
}
export function effectiveMode(config: AppConfig, room: string) {
  return config.conversations[room]?.mode ?? DEFAULT_CONVERSATION.mode;
}
export function toolDenial(
  config: AppConfig,
  run: RunContext,
  tool: ToolId,
  sandboxAvailable = true,
  verifiedQQ?: string,
): string | undefined {
  if (!config.enabled) return '运行已暂停';
  if (config.conversations[run.conversationId]?.muted) return '此会话已静音';
  if (!config.tools[tool]) return '此工具已关闭';
  if (taskTools.includes(tool)) {
    if (effectiveMode(config, run.conversationId) !== 'assistant' || run.mode !== 'assistant')
      return '纯陪伴模式不提供任务工具';
    if (run.actorId !== 'owner') return '此工具仅向主号开放';
    if (run.isGroup) return '群聊中不开放私密任务工具，请使用桌面或主号私聊';
    if (run.trigger === 'ambient') return '自主插话不允许调用任务工具';
  }
  if (tool === 'sandbox_exec' && !sandboxAvailable) return 'Docker 隔离环境尚未准备好';
  if (tool === 'qzone_publish' && (!verifiedQQ || verifiedQQ !== config.onebot.botQQ))
    return '请先连接 OneBot 并验证发布用的 QQ 账号';
}
export function capabilities(
  config: AppConfig,
  run: RunContext,
  skills: SkillInfo[],
  sandboxAvailable: boolean,
  verifiedQQ?: string,
): CapabilitySnapshot {
  return {
    revision: config.revision,
    mode: effectiveMode(config, run.conversationId),
    actorIsOwner: run.actorId === 'owner',
    workspace: '/workspace',
    tools: (Object.keys(TOOL_INFO) as ToolId[])
      .filter((tool) => !toolDenial(config, run, tool, sandboxAvailable, verifiedQQ))
      .map((tool) => ({ id: tool, ...TOOL_INFO[tool] })),
    skills: toolDenial(config, run, 'skills_load', sandboxAvailable) ? [] : skills,
  };
}
