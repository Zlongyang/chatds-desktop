import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { ModelHost } from '../desktop/model.js';
import { RuntimeCore } from '../runtime/core.js';
import type { RuntimeHost } from '../runtime/host.js';
import { Store } from '../runtime/store.js';
import { defaultConfig } from '../shared/config.js';
import { ToolBroker } from '../tools/broker.js';
import { DockerSandbox } from '../tools/docker.js';
import { SkillRegistry } from '../tools/skills.js';
import { assistant, envelope, removeTemporary, temporary } from './helpers.js';

interface CompletionRequest {
  tools: { type: string; function: { name: string; parameters: { required: string[] } } }[];
  messages: {
    role: string;
    content: string;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
  }[];
}

for (const provider of ['deepseek', 'openai-compatible'] as const) {
  test(`${provider} sends web_read schemas and the correlated broker error over HTTP`, async (t) => {
    const url = 'https://127.0.0.1/';
    const callId = 'call_web_01';
    const answer = '该地址受限，未读取到网页正文。';
    const requests: CompletionRequest[] = [];
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      function emit(delta: object, finish: string | null = null) {
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'chatcmpl-fixture',
              model: 'local-fixture',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta, finish_reason: finish }],
            }) +
            '\n\n',
        );
      }
      if (requests.length === 1) {
        emit({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: callId,
              type: 'function',
              function: { name: 'web_read', arguments: '{"url":' },
            },
          ],
        });
        emit({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(url) + '}' } }] });
        emit({}, 'tool_calls');
      } else {
        emit({ role: 'assistant', content: answer });
        emit({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const directory = temporary();
    const config = defaultConfig();
    const source = envelope('请读取这个网页 ' + url);
    config.conversations[source.conversationId] = {
      mode: 'assistant',
      muted: false,
      ambient: false,
    };
    config.tools.web_read = true;
    config.memory.automatic = false;
    Object.assign(config.model, {
      provider,
      model: 'local-fixture',
      keyRequired: false,
      baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1',
    });
    const model = new ModelHost(() => config.model, { get: () => undefined });
    const broker = new ToolBroker(
      directory,
      () => config,
      new SkillRegistry(join(directory, 'skills')),
      new DockerSandbox(() => config.sandbox, directory),
      (key) => (key === source.id ? source : undefined),
      {
        call: async () => {
          throw new Error('Unexpected OneBot call');
        },
      },
    );
    const host: RuntimeHost = {
      register: async (...args) => broker.register(...args),
      capabilities: (id) => broker.snapshot(id),
      tool: (...args) => broker.execute(...args),
      finish: async (id) => broker.finish(id),
      send: async () => {
        throw new Error('Unexpected OneBot reply');
      },
      stream: (_id, budget, thinking) => (_definition, context, options) => {
        const stream = new AssistantMessageEventStream();
        void model
          .stream(
            { context, budget, thinking },
            (event) => stream.push(event),
            options?.signal ?? AbortSignal.timeout(5000),
          )
          .then(
            (message) => stream.end(message),
            (error) => {
              const failed = assistant('');
              failed.stopReason = 'error';
              failed.errorMessage = String(error);
              stream.push({ type: 'error', reason: 'error', error: failed });
              stream.end(failed);
            },
          );
        return stream;
      },
    };
    const store = new Store(join(directory, 'chat.sqlite'));
    const core = new RuntimeCore(store, config, host, { timingScale: 0 });
    t.after(async () => {
      await core.close();
      removeTemporary(directory);
    });
    core.ingest(source);
    await core.idle();
    assert.equal(requests.length, 2, core.rows()[0]?.error);
    for (const payload of requests) {
      const tool = payload.tools.find((t) => t.function.name === 'web_read');
      assert.equal(tool?.type, 'function');
      assert.deepEqual(tool.function.parameters.required, ['url']);
    }
    const messages = requests[1]!.messages;
    const call = messages.find((m) => m.role === 'assistant' && m.tool_calls)?.tool_calls?.[0];
    assert.ok(call);
    assert.equal(call.id, callId);
    assert.equal(call.function.name, 'web_read');
    assert.deepEqual(JSON.parse(call.function.arguments), { url });
    const result = messages.find((m) => m.role === 'tool');
    assert.equal(result?.tool_call_id, callId);
    assert.match(result.content, /网页工具不能访问本机、内网或保留地址/);
    const reply = store.history(source.conversationId).at(-1);
    assert.equal(reply?.text, answer);
    assert.deepEqual(reply.webReads, [{ host: '127.0.0.1', status: 'failed', reason: '地址受限' }]);
    assert.equal(broker.stats.runs, 0);
  });
}
