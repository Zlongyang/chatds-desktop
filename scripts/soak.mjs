import assert from 'node:assert/strict';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { RuntimeCore } from '../dist/runtime/core.js';
import { Store } from '../dist/runtime/store.js';
import { FakeHost, envelope, temporary, removeTemporary } from '../dist/test/helpers.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const count = Number(args.messages ?? 10000),
  duration = Number(args['duration-ms'] ?? 0);
if (
  !Number.isInteger(count) ||
  count < 100 ||
  count > 1_000_000 ||
  !Number.isFinite(duration) ||
  duration < 0
)
  throw new Error('Use --messages=10000 and optional --duration-ms=28800000');
const directory = temporary(),
  file = join(directory, 'soak.sqlite'),
  host = new FakeHost();
host.config.limits.idleRoomMs = 1000;
const started = performance.now();
let now = Date.now(),
  accepted = 0,
  modelCalls = 0,
  peakRooms = 0,
  peakRss = 0;
const core = new RuntimeCore(new Store(file), host.config, host, {
  timingScale: 0,
  now: () => now,
});
const samples = [],
  rounds = Math.ceil(count / 100);
try {
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < 100 && accepted < count; i++) {
      const person = 50000 + round * 25 + Math.floor(i / 4);
      const message = host.remember(
        envelope('连续小事 ' + accepted, {
          conversationId: 'onebot:private:' + person,
          actorId: 'qq:' + person,
          channel: 'onebot',
          timestamp: now,
        }),
      );
      assert.equal(core.ingest(message), true);
      accepted++;
    }
    await core.idle();
    modelCalls += host.requests.length;
    host.requests = [];
    host.sources.clear();
    host.sent = [];
    peakRooms = Math.max(peakRooms, core.stats.rooms);
    now += (8 * 3600000) / rounds;
    core.evict();
    assert.equal(core.stats.rooms, 0);
    assert.equal(core.stats.pending, 0);
    assert.equal(core.stats.timers, 0);
    assert.equal(core.stats.foreground.active, 0);
    assert.equal(core.stats.foreground.waiting, 0);
    assert.equal(host.runs.size, 0);
    global.gc?.();
    const rss = process.memoryUsage().rss;
    peakRss = Math.max(peakRss, rss);
    if (round % 10 === 0)
      samples.push({ messages: accepted, rss, heapUsed: process.memoryUsage().heapUsed });
    if (duration) {
      const target = (duration * (round + 1)) / rounds;
      await pause(Math.max(0, target - (performance.now() - started)));
    }
  }
  assert.equal(core.store.counts().messages, accepted + modelCalls);
  assert.ok(peakRss < 512 * 1024 * 1024, 'Runtime RSS exceeded 512 MiB');
  await core.close();
  const finalStats = core.stats;
  assert.equal(finalStats.memory.timer, false);
  assert.equal(finalStats.memory.active, false);
  const report = {
    ok: true,
    kind: duration ? 'paced-wall-clock' : 'accelerated-logical-clock',
    messages: accepted,
    modelCalls,
    logicalHours: 8,
    wallTimeMs: Math.round(performance.now() - started),
    peakRooms,
    peakRss,
    finalStats,
    databaseBytes: (await stat(file)).size,
    samples,
    limitations:
      'Scripted model; no real API, QQ service or Docker. Accelerated logical time is not an eight-hour wall-clock leak test.',
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/soak.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await core.close();
  removeTemporary(directory);
}
