import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
export const id = (): string => randomUUID();
export const digest = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  if (existsSync(file)) copyFileSync(file, file + '.bak');
  renameSync(temp, file);
}
export function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
}
export function abortError(): Error {
  return new Error('本次操作已取消');
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
export function boundText(value: unknown, max = 6000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`文字需为 1 至 ${max} 字符`);
  return value.trim();
}
export function sensitive(text: string): boolean {
  return /(?:密[码钥]|验证码|api[ _-]?key|access[ _-]?token|Bearer\s|sk-[\w-]{12,}|身份证|银行卡|恢复码|私钥|-----BEGIN)/i.test(
    text,
  );
}
export function stableDay(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export class Semaphore {
  private active = 0;
  private queue: {
    resolve: (release: () => void) => void;
    reject: (e: Error) => void;
    signal?: AbortSignal;
    abort: () => void;
  }[] = [];
  constructor(
    public limit: number,
    private maxWaiting = 200,
  ) {}
  acquire(signal?: AbortSignal): Promise<() => void> {
    checkAbort(signal);
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.release());
    }
    if (this.queue.length >= this.maxWaiting)
      return Promise.reject(new Error('等待任务过多，请稍后重试'));
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        abort: () => {
          this.queue = this.queue.filter((x) => x !== entry);
          reject(abortError());
        },
      };
      this.queue.push(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
    });
  }
  private release(): () => void {
    let used = false;
    return () => {
      if (used) return;
      used = true;
      this.active--;
      while (this.queue.length) {
        const next = this.queue.shift()!;
        next.signal?.removeEventListener('abort', next.abort);
        if (next.signal?.aborted) {
          next.reject(abortError());
          continue;
        }
        this.active++;
        next.resolve(this.release());
        break;
      }
    };
  }
  get stats() {
    return { active: this.active, waiting: this.queue.length };
  }
}
