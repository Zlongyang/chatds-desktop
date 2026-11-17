import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, ChatMessage, MessageEnvelope } from '../shared/types.js';
import { digest, sensitive } from '../shared/util.js';
import { Store, memoryScope } from './store.js';
interface Prepared {
  hash: string;
  messages: (MessageEnvelope | ChatMessage)[];
  facts: { source: MessageEnvelope; content: string }[];
  archived: number;
}
function prepare(file: string, config: AppConfig): Prepared {
  if (!statSync(file).isFile() || statSync(file).size > 20 * 1024 * 1024)
    throw new Error('导入文件需要是 20 MiB 以内的 JSON 文件');
  const raw = readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  if (data.version !== 1 || !data.rooms || !Array.isArray(data.memories))
    throw new Error('只支持旧版 fish.json 或 state.json 的 version 1 格式');
  const hash = digest(raw),
    messages: Prepared['messages'] = [],
    facts: Prepared['facts'] = [];
  let archived = 0;
  const convert = (key: string): { conv: string; isGroup: boolean; actor: string } | undefined => {
    const m = /^(private|group):(\d{5,12})$/.exec(key);
    if (!m) return undefined;
    return {
      conv: 'onebot:' + key,
      isGroup: m[1] === 'group',
      actor: m[2] === config.onebot.ownerQQ ? 'owner' : 'qq:' + m[2],
    };
  };
  for (const [key, room] of Object.entries(data.rooms as Record<string, any>).slice(0, 500)) {
    const target = convert(key);
    if (!target) continue;
    for (const [index, message] of (Array.isArray(room.chat) ? room.chat : [])
      .slice(-10000)
      .entries()) {
      if (messages.length >= 10000) break;
      if (
        !message ||
        !['user', 'assistant'].includes(message.role) ||
        typeof message.text !== 'string'
      )
        continue;
      const timestamp = Number.isFinite(Date.parse(message.time))
        ? Date.parse(message.time)
        : Date.now();
      if (message.role === 'assistant') {
        messages.push({
          id: `import:${hash}:${key}:${index}`,
          conversationId: target.conv,
          role: 'assistant',
          actorId: 'bot',
          name: '历史回复',
          text: message.text.slice(0, 6000),
          timestamp,
          status: 'sent',
        });
        continue;
      }
      messages.push({
        id: `import:${hash}:${key}:${index}`,
        conversationId: target.conv,
        channel: 'onebot',
        actorId: target.isGroup ? 'archived-unknown' : target.actor,
        displayName: target.isGroup ? '历史发言者（未核实）' : '历史私聊',
        text: message.text.slice(0, 6000),
        timestamp,
        isGroup: target.isGroup,
        trigger: 'ambient',
        mention: false,
      });
      if (target.isGroup) archived++;
    }
  }
  for (const [index, fact] of data.memories.slice(0, 5000).entries()) {
    const target = typeof fact.scope === 'string' ? convert(fact.scope) : undefined;
    if (
      !target ||
      target.isGroup ||
      String(fact.senderQQ) !== fact.scope.split(':')[1] ||
      typeof fact.content !== 'string' ||
      fact.content.length > 800 ||
      sensitive(fact.content)
    ) {
      archived++;
      continue;
    }
    const source: MessageEnvelope = {
      id: `import:${hash}:fact:${index}`,
      conversationId: target.conv,
      channel: 'onebot',
      actorId: target.actor,
      displayName: '导入的历史记忆',
      text: fact.content,
      timestamp: Date.now(),
      isGroup: false,
      trigger: 'ambient',
      mention: false,
    };
    facts.push({ source, content: fact.content });
  }
  return { hash, messages, facts, archived };
}
export function previewImport(file: string, config: AppConfig) {
  const p = prepare(file, config);
  return {
    hash: p.hash,
    messages: p.messages.length,
    memories: p.facts.length,
    archived: p.archived,
  };
}
export function importLegacy(
  file: string,
  expectedHash: string,
  config: AppConfig,
  store: Store,
  dataDirectory: string,
) {
  const p = prepare(file, config);
  if (p.hash !== expectedHash) throw new Error('文件在预览后发生变化，请重新选择');
  if (store.hasImport(p.hash)) throw new Error('此文件已导入');
  store.backup(join(dataDirectory, 'backups', 'before-import-' + Date.now() + '.sqlite'));
  store.transaction(() => {
    for (const m of p.messages.sort((a, b) => a.timestamp - b.timestamp)) {
      if ('channel' in m) store.ingest(m);
      else store.archiveAssistant(m);
    }
    for (const f of p.facts) {
      store.ingest(f.source);
      store.remember(memoryScope(f.source), f.source.actorId, f.content, 'event', [f.source.id]);
    }
    store.markImport(p.hash);
  });
  return { messages: p.messages.length, memories: p.facts.length, archived: p.archived };
}
