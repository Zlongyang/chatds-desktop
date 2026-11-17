import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import type {
  AssistantMessage,
  AssistantMessageEvent,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import type { ModelProfile } from '../shared/types.js';
import { modelIdentity } from '../shared/config.js';
import { digest } from '../shared/util.js';
import type { Vault } from './vault.js';
import { piModel } from '../shared/model-definition.js';
export { piModel } from '../shared/model-definition.js';
export function keyReference(profile: ModelProfile): string {
  return 'model:' + digest(modelIdentity(profile));
}
export interface ModelRequest {
  context: TranscriptContext;
  budget?: number;
  thinking?: 'off' | 'low' | 'high';
}
export class ModelHost {
  constructor(
    private profile: () => ModelProfile,
    private vault: Pick<Vault, 'get'>,
  ) {}
  async stream(
    request: ModelRequest,
    onEvent: (event: AssistantMessageEvent) => void,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    const profile = { ...this.profile(), thinking: request.thinking ?? this.profile().thinking };
    const key = this.vault.get(keyReference(profile));
    if (profile.keyRequired && !key) throw new Error('请先为当前模型地址保存 API Key');
    const model = piModel(profile);
    const stream = streamSimple(model, request.context, {
      apiKey: key ?? 'local-no-key',
      maxTokens: Math.min(request.budget ?? profile.maxOutputTokens, profile.maxOutputTokens),
      reasoning: profile.thinking === 'off' ? undefined : profile.thinking,
      signal,
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
      onPayload: (payload) => {
        const p = payload as Record<string, unknown>;
        if (profile.provider === 'deepseek') {
          p.thinking = { type: profile.thinking === 'off' ? 'disabled' : 'enabled' };
          if (profile.thinking !== 'off') p.reasoning_effort = profile.thinking;
          else delete p.reasoning_effort;
        }
        return payload;
      },
    });
    for await (const event of stream) onEvent(event);
    const result = await stream.result();
    if (result.stopReason === 'error')
      throw new Error(
        (result.errorMessage ?? '模型请求失败').replaceAll(key ?? '__no_key__', '[已隐藏]'),
      );
    return result;
  }
}
