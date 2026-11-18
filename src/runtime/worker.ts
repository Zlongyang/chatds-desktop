import { join } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { RpcPeer } from '../shared/rpc.js';
import { id, stableDay } from '../shared/util.js';
import { configSchema } from '../shared/config.js';
import type {
  AppConfig,
  CapabilitySnapshot,
  RunContext,
  MessageEnvelope,
  ToolId,
} from '../shared/types.js';
import { RuntimeCore } from './core.js';
import { Store } from './store.js';
import type { RuntimeHost } from './host.js';
import { previewImport, importLegacy } from './import.js';
const port = (
  process as NodeJS.Process & {
    parentPort?: {
      on: (event: string, fn: (event: { data: unknown }) => void) => void;
      postMessage: (data: unknown) => void;
    };
  }
).parentPort;
if (!port) throw new Error('This entry point must run as an Electron utility process');
const peer = new RpcPeer((packet) => port.postMessage(packet));
port.on('message', (event) => peer.receive(event.data));
let core: RuntimeCore | undefined, config: AppConfig, directory: string;
const host: RuntimeHost = {
  register: (runId, sourceIds, conversationId) =>
    peer.call<RunContext>('run.register', { runId, sourceIds, conversationId }),
  capabilities: (runId) => peer.call<CapabilitySnapshot>('run.capabilities', { runId }),
  tool: (runId, tool, args, signal) => peer.call('tool.execute', { runId, tool, args }, signal),
  send: (runId, text, outboxId, signal) =>
    peer.call<string>('reply.send', { runId, text, outboxId }, signal),
  finish: (runId) => peer.call<void>('run.finish', { runId }),
  stream: (runId, budget, thinking) => (model, context, options) => {
    const result = new AssistantMessageEventStream(),
      streamId = id();
    const off = peer.on('model.event', (p: { streamId: string; event: AssistantMessageEvent }) => {
      if (p.streamId === streamId) result.push(p.event);
    });
    void peer
      .call<AssistantMessage>(
        'model.stream',
        { runId, streamId, context, budget, thinking },
        options?.signal,
      )
      .then(
        (message) => result.end(message),
        (error) => {
          const message: AssistantMessage = {
            role: 'assistant',
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: options?.signal?.aborted ? 'aborted' : 'error',
            errorMessage: String(error.message),
            timestamp: Date.now(),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          result.push({
            type: 'error',
            reason: message.stopReason as 'aborted' | 'error',
            error: message,
          });
          result.end(message);
        },
      )
      .finally(off);
    return result;
  },
};
function runtime(): RuntimeCore {
  if (!core) throw new Error('运行时未初始化');
  return core;
}
peer.handle('initialize', (p) => {
  if (core) throw new Error('运行时已初始化');
  directory = p.directory;
  config = configSchema.parse(p.config) as AppConfig;
  core = new RuntimeCore(
    new Store(join(directory, 'chatds.sqlite')),
    config,
    host,
    p.testMode ? { timingScale: 0 } : {},
  );
  core.on('event', (event) => peer.notify('runtime.event', event));
  return { ready: true };
});
peer.handle('configure', (p) => {
  config = configSchema.parse(p) as AppConfig;
  runtime().configure(config);
  return true;
});
peer.handle('ingest', (p) => runtime().ingest(p as MessageEnvelope));
peer.handle('state', () => ({
  rooms: runtime().rows(),
  memoryCount: runtime().store.counts().facts,
  usage: runtime().store.usage(stableDay()),
  stats: runtime().stats,
}));
peer.handle('history', (p) => runtime().store.history(p.id, p.before, p.limit));
peer.handle('memories', (p) => runtime().store.facts(p?.scope));
peer.handle('forget', (p) => {
  runtime().stop();
  runtime().store.forget(p.id);
  return true;
});
peer.handle('stop', (p) => {
  runtime().stop(p?.conversationId);
  return true;
});
peer.handle('previewImport', (p) => previewImport(p.file, config));
peer.handle('import', (p) => {
  runtime().stop();
  return importLegacy(p.file, p.hash, config, runtime().store, directory);
});
peer.handle('close', async () => {
  await runtime().close();
  setTimeout(() => process.exit(0), 50).unref();
  return true;
});
