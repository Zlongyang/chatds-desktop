import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { defaultConfig } from '../dist/shared/config.js';
import { ModelHost } from '../dist/desktop/model.js';
import { readReplayCases, runReplay } from '../scripts/replay.mjs';

async function endpoint(t, eventFor) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const payload = JSON.parse(body);
    requests.push(payload);
    const content = eventFor(payload);
    if (typeof content === 'number') {
      res
        .writeHead(content, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'fixture unavailable' } }));
      return;
    }
    const delta =
      typeof content === 'string'
        ? { role: 'assistant', content }
        : {
            role: 'assistant',
            tool_calls: [
              {
                type: 'function',
                index: 0,
                id: 'call_' + requests.length,
                function: { name: content.action, arguments: '{}' },
              },
            ],
          };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-fixture',
          model: 'fixture',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta, finish_reason: null }],
        }) +
        '\n\n',
    );
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-fixture',
          model: 'fixture',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: typeof content === 'string' ? 'stop' : 'tool_calls',
            },
          ],
        }) +
        '\n\n',
    );
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((done) => server.close(done)));
  const profile = {
    ...defaultConfig().model,
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    keyRequired: false,
  };
  return {
    requests,
    profile,
    model: new ModelHost(() => profile, { get: () => undefined }),
    takeCall: () => {},
  };
}

test('pond replay groups bursts, preserves previous replies, and passes the same attributed human inputs to both variants', async (t) => {
  const deps = await endpoint(t, () => '回放回执');
  const [scenario] = await readReplayCases('pond');
  const current = await runReplay(scenario, 'current', deps);
  assert.ok(current.complete, JSON.stringify(current.errors));
  assert.deepEqual(
    current.turns.map((s) => s.action),
    ['reply', 'reply', 'ignored'],
  );
  assert.equal(deps.requests.length, 2);
  assert.ok(
    deps.requests[1].messages.some((m) => m.role === 'assistant' && m.content === '回放回执'),
  );
  const baseline = await runReplay(scenario, 'baseline', deps);
  assert.ok(baseline.complete, JSON.stringify(baseline.errors));
  assert.equal(deps.requests.length, 7);
  assert.deepEqual(
    baseline.turns[0].events.map((e) => e.role),
    ['user', 'assistant', 'user', 'assistant'],
  );
  assert.deepEqual(
    current.turns[0].events.map((e) => e.role),
    ['user', 'user', 'assistant'],
  );
  for (const [index, turn] of current.turns.entries()) {
    assert.deepEqual(
      turn.events.filter((e) => e.role === 'user'),
      baseline.turns[index].events.filter((e) => e.role === 'user'),
    );
  }
  assert.equal(baseline.turns[2].structuralMatch, false);
  assert.ok(
    deps.requests[3].messages.some((m) => m.role === 'assistant' && m.content === '回放回执'),
  );
  assert.deepEqual(new Set(deps.requests.map((r) => r.model)), new Set([deps.profile.model]));
});

test('wait and end are distinct and ambient chatter after ending costs zero calls', async (t) => {
  let n = 0;
  const deps = await endpoint(
    t,
    () => [{ action: 'chat_wait' }, '接到你的补充', { action: 'chat_end' }][n++],
  );
  const [s] = await readReplayCases('unfinished-voice');
  const variant = await runReplay(s, 'current', deps);
  assert.ok(variant.complete, JSON.stringify(variant.errors));
  assert.deepEqual(
    variant.turns.map((t) => t.action),
    ['wait', 'reply', 'end', 'ignored'],
  );
  assert.deepEqual(
    variant.turns.map((t) => t.structuralMatch),
    [true, true, true, true],
  );
  assert.equal(deps.requests.length, 3);
});

test('HTTP failure never counts as silence, never retries and stops the case', async (t) => {
  const deps = await endpoint(t, () => 503);
  const [scenario] = await readReplayCases('unfinished-voice');
  const result = await runReplay(scenario, 'current', deps);
  assert.equal(result.complete, false);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].structuralMatch, null);
  assert.equal(result.turns[0].action, 'error');
  assert.equal(result.modelCalls, 1);
  assert.equal(deps.requests.length, 1);
  const exhausted = await runReplay(scenario, 'current', {
    ...deps,
    takeCall() {
      throw new Error('调用上限');
    },
  });
  assert.equal(exhausted.turns[0].structuralMatch, null);
  assert.equal(exhausted.modelCalls, 0);
  assert.equal(deps.requests.length, 1);
});
