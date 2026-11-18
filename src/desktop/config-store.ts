import { join } from 'node:path';
import { configSchema, defaultConfig } from '../shared/config.js';
import { atomicJson, readJson } from '../shared/util.js';
import type { AppConfig, SettingsChange } from '../shared/types.js';
export class ConfigStore {
  readonly path: string;
  value: AppConfig;
  constructor(directory: string) {
    this.path = join(directory, 'config.json');
    this.value = configSchema.parse(readJson(this.path, defaultConfig())) as AppConfig;
  }
  preview(patch: NonNullable<SettingsChange['config']>): AppConfig {
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      'version' in patch ||
      'revision' in patch
    )
      throw new Error('配置更新无效');
    const current = this.value;
    const next = { ...current, ...patch, version: 1 as const, revision: current.revision + 1 };
    if (patch.persona !== undefined && current.personaLibrary && !('personaLibrary' in patch)) {
      const { active, cards } = current.personaLibrary;
      next.personaLibrary = {
        active,
        cards: cards.map((card) =>
          card.id === active
            ? {
                id: active,
                name: '小鱼',
                description: patch.persona!,
                personality: '',
                examples: '',
              }
            : card,
        ),
      };
    }
    for (const key of ['model', 'onebot', 'tools', 'memory', 'limits', 'sandbox'] as const)
      if (patch[key]) Object.assign(next, { [key]: { ...current[key], ...patch[key] } });
    return configSchema.parse(next) as AppConfig;
  }
  commit(next: AppConfig): AppConfig {
    const validated = configSchema.parse(next) as AppConfig;
    atomicJson(this.path, validated);
    this.value = validated;
    return structuredClone(this.value);
  }
  update(patch: NonNullable<SettingsChange['config']>): AppConfig {
    return this.commit(this.preview(patch));
  }
  save(): void {
    atomicJson(this.path, this.value);
  }
}
