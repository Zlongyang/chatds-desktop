import type { Model } from '@earendil-works/pi-ai';
import type { ModelProfile } from './types.js';
export function piModel(profile: ModelProfile): Model<'openai-completions'> {
  return {
    id: profile.model,
    name: profile.model,
    api: 'openai-completions',
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    reasoning: profile.thinking !== 'off',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxOutputTokens,
    compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: 'max_tokens' },
  };
}
