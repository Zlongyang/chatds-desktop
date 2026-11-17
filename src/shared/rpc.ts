import { id } from './util.js';
import { errorText } from './config.js';
type Packet =
  | { kind: 'request'; id: string; method: string; params: unknown }
  | { kind: 'result'; id: string; value?: unknown; error?: string }
  | { kind: 'notify'; method: string; params: unknown }
  | { kind: 'cancel'; id: string };
export class RpcPeer {
  private pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      cleanup: () => void;
    }
  >();
  private handlers = new Map<string, (p: any, s: AbortSignal) => unknown | Promise<unknown>>();
  private running = new Map<string, AbortController>();
  private listeners = new Map<string, Set<(p: any) => void>>();
  private closed = false;
  constructor(private send: (packet: unknown) => void) {}
  handle(
    method: string,
    handler: (params: any, signal: AbortSignal) => unknown | Promise<unknown>,
  ): void {
    this.handlers.set(method, handler);
  }
  on(method: string, listener: (params: any) => void): () => void {
    const list = this.listeners.get(method) ?? new Set();
    list.add(listener);
    this.listeners.set(method, list);
    return () => {
      list.delete(listener);
      if (!list.size) this.listeners.delete(method);
    };
  }
  notify(method: string, params: unknown): void {
    if (!this.closed) this.send({ kind: 'notify', method, params });
  }
  call<T = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = 150000,
  ): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('连接已关闭或操作已取消'));
    if (this.pending.size >= 256) return Promise.reject(new Error('运行时请求过多'));
    const key = id();
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const pending = this.pending.get(key);
        if (!pending) return;
        this.pending.delete(key);
        clearTimeout(pending.timer);
        pending.cleanup();
        this.send({ kind: 'cancel', id: key });
        reject(new Error('操作已取消'));
      };
      const timer = setTimeout(() => {
        abort();
      }, timeoutMs);
      timer.unref();
      this.pending.set(key, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener('abort', abort),
      });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.send({ kind: 'request', id: key, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(key);
        signal?.removeEventListener('abort', abort);
        reject(e);
      }
    });
  }
  receive(input: unknown): void {
    if (this.closed || !input || typeof input !== 'object') return;
    const p = input as Packet;
    if (p.kind === 'result') {
      const pending = this.pending.get(p.id);
      if (!pending) return;
      this.pending.delete(p.id);
      clearTimeout(pending.timer);
      pending.cleanup();
      p.error ? pending.reject(new Error(p.error)) : pending.resolve(p.value);
      return;
    }
    if (p.kind === 'notify') {
      for (const fn of this.listeners.get(p.method) ?? []) fn(p.params);
      return;
    }
    if (p.kind === 'cancel') {
      this.running.get(p.id)?.abort();
      return;
    }
    if (p.kind === 'request') {
      if (this.running.size >= 256) {
        this.send({ kind: 'result', id: p.id, error: '运行时请求过多' });
        return;
      }
      const controller = new AbortController();
      this.running.set(p.id, controller);
      const handler = this.handlers.get(p.method);
      Promise.resolve()
        .then(() => {
          if (!handler) throw new Error('未知运行时方法');
          return handler(p.params, controller.signal);
        })
        .then(
          (value) => {
            if (!this.closed) this.send({ kind: 'result', id: p.id, value });
          },
          (e) => {
            if (!this.closed) this.send({ kind: 'result', id: p.id, error: errorText(e) });
          },
        )
        .finally(() => this.running.delete(p.id));
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.cleanup();
      p.reject(new Error('运行时连接关闭'));
    }
    this.pending.clear();
    for (const c of this.running.values()) c.abort();
    this.running.clear();
    this.listeners.clear();
  }
  get stats() {
    return {
      pending: this.pending.size,
      running: this.running.size,
      listeners: [...this.listeners.values()].reduce((n, s) => n + s.size, 0),
    };
  }
}
