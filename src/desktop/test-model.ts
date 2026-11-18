import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { ModelRequest } from './model.js';
/** Only selected by an explicit test flag and a disposable OS-temp data directory. */
export class TestModelHost {
  constructor(private readonly model?: string) {}
  async stream(
    request: ModelRequest,
    emit: (event: AssistantMessageEvent) => void,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    if (signal.aborted) throw new Error('已取消');
    if (this.model === 'fixture-unavailable') throw new Error('测试模型暂不可用');
    const user = request.context.messages.filter((m) => m.role === 'user').at(-1);
    const text =
      typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? []);
    const system = request.context.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    let answer = '我在听，你接着说。';
    if (system.includes('长期事实增量提取器')) answer = '{"facts":[]}';
    else if (system.includes('压缩较早对话')) answer = '这是一段已经归档的测试对话。';
    else if (text.includes('连接成功')) answer = '连接成功';
    else if (/口令|记住/.test(text)) answer = '记住了，这件事会留在当前聊天的记忆里。';
    else if (system.includes('蓝色饭团') && /喜欢|记得/.test(text)) answer = '你说过喜欢蓝色饭团。';
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: answer }],
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
    emit({ type: 'start', partial: { ...message, content: [] } });
    emit({ type: 'text_delta', contentIndex: 0, delta: answer, partial: message });
    emit({ type: 'done', reason: 'stop', message });
    return message;
  }
}
