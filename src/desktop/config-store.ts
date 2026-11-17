import { join } from 'node:path';
import { configSchema, defaultConfig } from '../shared/config.js';
import { atomicJson, readJson } from '../shared/util.js';
import type { AppConfig } from '../shared/types.js';
export class ConfigStore {
  readonly path: string;
  value: AppConfig;
  constructor(directory: string) {
    this.path = join(directory, 'config.json');
    this.value = configSchema.parse(readJson(this.path, defaultConfig())) as AppConfig;
  }
  preview(patch: Partial<Omit<AppConfig, 'version' | 'revision'>>): AppConfig {
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
  update(patch: Partial<Omit<AppConfig, 'version' | 'revision'>>): AppConfig {
    return this.commit(this.preview(patch));
  }
  save(): void {
    atomicJson(this.path, this.value);
  }
}
