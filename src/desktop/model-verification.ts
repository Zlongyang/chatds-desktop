import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelProfile } from '../shared/types.js';
import { atomicJson, digest, readJson } from '../shared/util.js';
import type { ModelHost } from './model.js';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';

type ProbeResult = { ok: boolean; detail: string };

export async function probeModel(host: Pick<ModelHost, 'stream'>): Promise<ProbeResult> {
  const result = await host.stream(
    {
      context: normalizeContext({
        messages: [{ role: 'user', content: '请回答连接成功', timestamp: Date.now() }],
      }),
      budget: 64,
      thinking: 'off',
    },
    () => {},
    AbortSignal.timeout(20000),
  );
  const reply = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
  return result.stopReason === 'stop' && reply
    ? { ok: true, detail: '模型已返回正文' }
    : { ok: false, detail: '模型没有返回完整的文字回复。' };
}

function fingerprint(profile: ModelProfile): string {
  return digest([
    profile.protocol,
    profile.provider,
    profile.baseUrl,
    profile.model,
    profile.contextWindow,
    profile.maxOutputTokens,
    profile.thinking,
    profile.keyRequired,
  ]);
}

export class ModelVerification {
  private readonly path: string;
  private marker = '';
  private generation = 0;
  private pending?: { key: string; result: Promise<ProbeResult> };

  constructor(directory: string) {
    this.path = join(directory, 'model-verification.json');
    try {
      const value = readJson<unknown>(this.path, null);
      if (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) this.marker = value;
    } catch {
      // A missing or unreadable marker leaves the model unverified.
    }
  }

  verified(profile: ModelProfile): boolean {
    return this.marker === fingerprint(profile);
  }

  saveSuccess(profile: ModelProfile): void {
    const key = fingerprint(profile);
    if (this.marker !== key) atomicJson(this.path, key);
    this.marker = key;
    this.generation++;
    this.pending = undefined;
  }

  invalidate(): void {
    this.generation++;
    this.pending = undefined;
    this.marker = '';
    rmSync(this.path, { force: true });
  }

  run(profile: ModelProfile, probe: () => Promise<ProbeResult>): Promise<ProbeResult> {
    const key = fingerprint(profile);
    if (this.pending?.key === key) return this.pending.result;
    if (this.pending || (this.marker && this.marker !== key)) this.invalidate();
    const generation = this.generation;
    const superseded = { ok: false, detail: '模型配置已变更，请重新测试' };
    // Publish pending before invoking the probe, including probes that throw synchronously.
    const result = Promise.resolve()
      .then(() => (this.generation === generation ? probe() : superseded))
      .then(
        (outcome) => {
          if (this.generation !== generation) return superseded;
          if (!outcome.ok) this.invalidate();
          else this.saveSuccess(profile);
          return outcome;
        },
        (error: unknown) => {
          if (this.generation !== generation) return superseded;
          this.invalidate();
          throw error;
        },
      )
      .finally(() => {
        if (this.generation === generation) this.pending = undefined;
      });
    this.pending = { key, result };
    return result;
  }
}
