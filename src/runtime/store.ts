import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { id, sensitive } from '../shared/util.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  ChatMessage,
  MemoryFact,
  MessageEnvelope,
  RunContext,
  WebReadReceipt,
} from '../shared/types.js';

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export function searchTerms(text: string): string[] {
  return [
    ...new Set(
      [...segmenter.segment(text.normalize('NFKC').toLowerCase())]
        .filter((s) => s.isWordLike)
        .map((s) => s.segment)
        .filter((s) => s.length > 1),
    ),
  ].slice(0, 24);
}
export function memoryScope(
  context: Pick<RunContext, 'isGroup' | 'conversationId' | 'actorId'>,
): string {
  return context.isGroup ? 'group:' + context.conversationId : 'person:' + context.actorId;
}
interface FactRow {
  id: string;
  scope: string;
  subject: string;
  content: string;
  kind: MemoryFact['kind'];
  sources: string;
  created: number;
  updated: number;
}
interface MessageRow {
  seq: number;
  id: string;
  conv: string;
  role: ChatMessage['role'];
  actor: string;
  name: string;
  text: string;
  time: number;
  reply: string | null;
  status: ChatMessage['status'];
  envelope: string | null;
  web_reads: string | null;
}
export class Store {
  private db: DatabaseSync;
  private closed = false;
  private depth = 0;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,name TEXT NOT NULL,is_group INTEGER NOT NULL,updated INTEGER NOT NULL,processed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,conv TEXT NOT NULL,role TEXT NOT NULL,actor TEXT NOT NULL,name TEXT NOT NULL,text TEXT NOT NULL,time INTEGER NOT NULL,reply TEXT,status TEXT,envelope TEXT,excluded INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS messages_room ON messages(conv,seq);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,conv TEXT NOT NULL,sources TEXT NOT NULL,wire TEXT NOT NULL,status TEXT NOT NULL,time INTEGER NOT NULL,excluded INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS runs_room ON runs(conv,time);
      CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY,scope TEXT NOT NULL,subject TEXT NOT NULL,content TEXT NOT NULL,kind TEXT NOT NULL,sources TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,removed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS facts_scope ON facts(scope,subject,removed);
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_search USING fts5(fact_id UNINDEXED,search_text,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS summaries(conv TEXT PRIMARY KEY,text TEXT NOT NULL,sources TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(scope TEXT PRIMARY KEY,payload TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS summary_jobs(conv TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,conv TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,remote_id TEXT,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS imports(hash TEXT PRIMARY KEY,time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quotas(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(day TEXT PRIMARY KEY,input INTEGER NOT NULL,output INTEGER NOT NULL,ambient INTEGER NOT NULL);
    `);
    const version = this.db.prepare('SELECT value FROM meta WHERE key=?').get('version') as
      { value: string } | undefined;
    if (version && version.value !== '1') throw new Error('不支持的数据库版本，请保留数据库及备份');
    this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('version', '1');
    if (
      !(this.db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).some(
        (c) => c.name === 'web_reads',
      )
    )
      this.db.exec('ALTER TABLE messages ADD COLUMN web_reads TEXT');
    if (
      !(this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).some(
        (c) => c.name === 'summarized',
      )
    )
      this.db.exec('ALTER TABLE runs ADD COLUMN summarized INTEGER NOT NULL DEFAULT 0');
    if (
      !(this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).some(
        (c) => c.name === 'fact_refs',
      )
    )
      this.db.exec("ALTER TABLE runs ADD COLUMN fact_refs TEXT NOT NULL DEFAULT '[]'");
    if (
      !(this.db.prepare('PRAGMA table_info(usage)').all() as { name: string }[]).some(
        (c) => c.name === 'background',
      )
    )
      this.db.exec('ALTER TABLE usage ADD COLUMN background INTEGER NOT NULL DEFAULT 0');
    this.db.prepare("UPDATE outbox SET status='unknown' WHERE status='pending'").run();
    this.db
      .prepare(
        "UPDATE messages SET status='unknown' WHERE status='pending' AND id IN (SELECT id FROM outbox WHERE status='unknown')",
      )
      .run();
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }
  backup(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(file);
  }
  ingest(message: MessageEnvelope): boolean {
    return this.transaction(() => {
      const inserted = this.db
        .prepare(
          'INSERT OR IGNORE INTO messages(id,conv,role,actor,name,text,time,reply,envelope,status) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          message.id,
          message.conversationId,
          'user',
          message.actorId,
          message.displayName,
          message.text,
          message.timestamp,
          message.replyTo ?? null,
          JSON.stringify(message),
          'sent',
        );
      if (!inserted.changes) return false;
      this.db
        .prepare(
          'INSERT INTO conversations(id,name,is_group,updated) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=MAX(conversations.updated+1,excluded.updated),name=excluded.name',
        )
        .run(
          message.conversationId,
          message.isGroup
            ? '群聊 ' + message.conversationId.split(':').at(-1)
            : message.channel === 'desktop'
              ? '桌面聊天'
              : message.displayName,
          Number(message.isGroup),
          message.timestamp,
        );
      return true;
    });
  }
  getEnvelope(messageId: string): MessageEnvelope | undefined {
    const r = this.db
      .prepare('SELECT envelope FROM messages WHERE id=? AND role=?')
      .get(messageId, 'user') as { envelope: string | null } | undefined;
    return r?.envelope ? JSON.parse(r.envelope) : undefined;
  }
  recentEnvelopes(conv: string, limit = 40): MessageEnvelope[] {
    return (
      this.db
        .prepare(
          'SELECT envelope FROM messages WHERE conv=? AND role=? AND excluded=0 ORDER BY seq DESC LIMIT ?',
        )
        .all(conv, 'user', limit) as { envelope: string | null }[]
    )
      .reverse()
      .flatMap((r) => (r.envelope ? [JSON.parse(r.envelope) as MessageEnvelope] : []));
  }
  history(
    conv: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 100,
  ): (ChatMessage & { seq: number })[] {
    return (
      this.db
        .prepare('SELECT * FROM messages WHERE conv=? AND seq<? ORDER BY seq DESC LIMIT ?')
        .all(conv, before, limit) as unknown as MessageRow[]
    )
      .reverse()
      .map((r) => ({
        id: r.id,
        seq: r.seq,
        conversationId: r.conv,
        role: r.role,
        actorId: r.actor,
        name: r.name,
        text: r.text,
        timestamp: r.time,
        replyTo: r.reply ?? undefined,
        status: r.status,
        ...(r.web_reads ? { webReads: JSON.parse(r.web_reads) as WebReadReceipt[] } : {}),
      }));
  }
  rooms(): { id: string; name: string; isGroup: boolean; updatedAt: number }[] {
    return (
      this.db.prepare('SELECT * FROM conversations ORDER BY updated DESC LIMIT 500').all() as {
        id: string;
        name: string;
        is_group: number;
        updated: number;
      }[]
    ).map((r) => ({ id: r.id, name: r.name, isGroup: !!r.is_group, updatedAt: r.updated }));
  }
  appendAssistant(
    conv: string,
    text: string,
    messageId = id(),
    status: ChatMessage['status'] = 'sent',
    name = '小鱼',
    webReads: WebReadReceipt[] = [],
  ): string {
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO messages(id,conv,role,actor,name,text,time,status,web_reads) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          messageId,
          conv,
          'assistant',
          'bot',
          name,
          text,
          Date.now(),
          status ?? 'sent',
          webReads.length ? JSON.stringify(webReads) : null,
        );
      this.db
        .prepare('UPDATE conversations SET updated=MAX(updated+1,?) WHERE id=?')
        .run(Date.now(), conv);
    });
    return messageId;
  }
  archiveAssistant(message: ChatMessage): void {
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO conversations(id,name,is_group,updated) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=max(updated,excluded.updated)',
        )
        .run(
          message.conversationId,
          '历史会话 ' + message.conversationId.split(':').at(-1),
          Number(message.conversationId.includes(':group:')),
          message.timestamp,
        );
      this.db
        .prepare(
          'INSERT INTO messages(id,conv,role,actor,name,text,time,status) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          message.id,
          message.conversationId,
          'assistant',
          'bot',
          message.name,
          message.text,
          message.timestamp,
          'sent',
        );
    });
  }
  saveRun(
    context: RunContext,
    messages: AgentMessage[],
    status: string,
    factRefs: string[] = [],
  ): void {
    const wire = messages.filter((m) => m.role !== 'system');
    this.db
      .prepare(
        'INSERT OR REPLACE INTO runs(id,conv,sources,wire,status,time,fact_refs) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        context.id,
        context.conversationId,
        JSON.stringify(context.sourceIds),
        JSON.stringify(wire),
        status,
        Date.now(),
        JSON.stringify([...new Set(factRefs)]),
      );
  }
  contextRuns(
    conv: string,
    limit = 24,
  ): { id: string; messages: AgentMessage[]; sources: string[]; factRefs: string[] }[] {
    const rows = this.db
      .prepare(
        "SELECT id,wire,sources,fact_refs FROM runs WHERE conv=? AND excluded=0 AND summarized=0 AND status='complete' ORDER BY time DESC,rowid DESC LIMIT ?",
      )
      .all(conv, limit) as { id: string; wire: string; sources: string; fact_refs: string }[];
    return rows.reverse().map((r) => ({
      id: r.id,
      messages: JSON.parse(r.wire),
      sources: JSON.parse(r.sources),
      factRefs: JSON.parse(r.fact_refs),
    }));
  }
  context(conv: string, limit = 24): AgentMessage[] {
    return this.contextRuns(conv, limit).flatMap((r) => r.messages);
  }
  getSummary(conv: string): string {
    return (
      (
        this.db.prepare('SELECT text FROM summaries WHERE conv=?').get(conv) as
          { text: string } | undefined
      )?.text ?? ''
    );
  }
  setSummary(conv: string, text: string, sources: string[], runs: string[] = []): void {
    this.transaction(() => {
      this.db
        .prepare('INSERT OR REPLACE INTO summaries VALUES (?,?,?,?)')
        .run(conv, text.slice(0, 6000), JSON.stringify(sources), Date.now());
      for (const run of runs)
        this.db
          .prepare('UPDATE runs SET summarized=1 WHERE id=? AND conv=? AND excluded=0')
          .run(run, conv);
    });
  }
  queueSummary(
    conv: string,
    runs: { id: string; messages: AgentMessage[]; sources: string[] }[],
  ): void {
    this.db.prepare('INSERT OR REPLACE INTO summary_jobs VALUES (?,?)').run(
      conv,
      JSON.stringify({
        runIds: runs.map((r) => r.id),
        wire: runs.flatMap((r) => r.messages),
        sources: [...new Set(runs.flatMap((r) => r.sources))],
      }),
    );
  }
  summaryJobs(): { conv: string; runIds: string[]; wire: AgentMessage[]; sources: string[] }[] {
    return (
      this.db.prepare('SELECT * FROM summary_jobs LIMIT 100').all() as {
        conv: string;
        payload: string;
      }[]
    ).map((r) => ({ conv: r.conv, ...JSON.parse(r.payload) }));
  }
  finishSummaryJob(conv: string): void {
    this.db.prepare('DELETE FROM summary_jobs WHERE conv=?').run(conv);
  }
  remember(
    scope: string,
    subject: string,
    content: string,
    kind: MemoryFact['kind'],
    sourceIds: string[],
  ): MemoryFact {
    content = content.trim();
    if (!content || content.length > 800 || sensitive(content))
      throw new Error('不能保存空白、敏感或过长的记忆');
    if (
      !sourceIds.length ||
      sourceIds.some((source) => {
        const e = this.getEnvelope(source);
        return (
          !e ||
          e.actorId !== subject ||
          memoryScope({
            isGroup: e.isGroup,
            conversationId: e.conversationId,
            actorId: e.actorId,
          }) !== scope ||
          this.isExcluded(source)
        );
      })
    )
      throw new Error('记忆的来源或身份范围无效');
    const old = this.db
      .prepare('SELECT * FROM facts WHERE scope=? AND subject=? AND content=? AND removed=0')
      .get(scope, subject, content) as unknown as FactRow | undefined;
    if (old) return this.fact(old);
    const value: MemoryFact = {
      id: id(),
      scope,
      subject,
      content,
      kind,
      sourceIds,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.transaction(() => {
      this.db
        .prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?,?,0)')
        .run(
          value.id,
          scope,
          subject,
          content,
          kind,
          JSON.stringify(sourceIds),
          value.createdAt,
          value.updatedAt,
        );
      this.db
        .prepare('INSERT INTO facts_search VALUES (?,?)')
        .run(value.id, searchTerms(content).join(' '));
    });
    return value;
  }
  private fact(r: FactRow): MemoryFact {
    return {
      id: r.id,
      scope: r.scope,
      subject: r.subject,
      content: r.content,
      kind: r.kind,
      sourceIds: JSON.parse(r.sources),
      createdAt: r.created,
      updatedAt: r.updated,
    };
  }
  facts(scope?: string): MemoryFact[] {
    const rows = scope
      ? this.db
          .prepare(
            'SELECT * FROM facts WHERE scope=? AND removed=0 ORDER BY updated DESC LIMIT 1000',
          )
          .all(scope)
      : this.db
          .prepare('SELECT * FROM facts WHERE removed=0 ORDER BY updated DESC LIMIT 1000')
          .all();
    return (rows as unknown as FactRow[]).map((r) => this.fact(r));
  }
  search(scope: string, query: string, limit = 8): MemoryFact[] {
    const terms = searchTerms(query);
    if (!terms.length) return this.facts(scope).slice(0, limit);
    const match = terms.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR ');
    const hits = this.db
      .prepare(
        'SELECT f.* FROM facts_search s JOIN facts f ON f.id=s.fact_id WHERE facts_search MATCH ? AND f.scope=? AND f.removed=0 ORDER BY rank LIMIT ?',
      )
      .all(match, scope, limit) as unknown as FactRow[];
    const result = hits.map((r) => this.fact(r));
    for (const fact of this.facts(scope))
      if (result.length < limit && !result.some((f) => f.id === fact.id)) result.push(fact);
    return result;
  }
  forget(factId: string): void {
    const r = this.db
      .prepare('SELECT * FROM facts WHERE id=? AND removed=0')
      .get(factId) as unknown as FactRow | undefined;
    if (!r) throw new Error('记忆不存在');
    const sources = JSON.parse(r.sources) as string[];
    this.transaction(() => {
      this.db.prepare('UPDATE facts SET removed=1 WHERE id=?').run(factId);
      this.db.prepare('DELETE FROM facts_search WHERE fact_id=?').run(factId);
      for (const source of sources) {
        this.db.prepare('UPDATE messages SET excluded=1 WHERE id=?').run(source);
        this.db
          .prepare(
            'UPDATE runs SET excluded=1 WHERE EXISTS (SELECT 1 FROM json_each(runs.sources) WHERE value=?)',
          )
          .run(source);
      }
      this.db
        .prepare(
          'UPDATE runs SET excluded=1 WHERE EXISTS (SELECT 1 FROM json_each(runs.fact_refs) WHERE value=?)',
        )
        .run(factId);
      this.db.prepare('DELETE FROM summaries').run();
      this.db.prepare('DELETE FROM jobs').run();
      this.db.prepare('DELETE FROM summary_jobs').run();
      this.db.prepare('UPDATE runs SET summarized=0').run();
    });
  }
  supersede(factId: string, scope: string, subject: string): void {
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT id FROM facts WHERE id=? AND scope=? AND subject=? AND removed=0')
        .get(factId, scope, subject);
      if (!row) throw new Error('更正对象不属于当前身份范围');
      this.db.prepare('UPDATE facts SET removed=1 WHERE id=?').run(factId);
      this.db.prepare('DELETE FROM facts_search WHERE fact_id=?').run(factId);
      this.db.prepare('DELETE FROM summaries').run();
      this.db.prepare('DELETE FROM summary_jobs').run();
      this.db.prepare('UPDATE runs SET summarized=0').run();
    });
  }
  isExcluded(messageId: string): boolean {
    const r = this.db.prepare('SELECT excluded FROM messages WHERE id=?').get(messageId) as
      { excluded: number } | undefined;
    return !r || !!r.excluded;
  }
  queueMemory(scope: string, messages: MessageEnvelope[]): void {
    const existing = this.db.prepare('SELECT payload FROM jobs WHERE scope=?').get(scope) as
      { payload: string } | undefined;
    const ids = [
      ...new Set([
        ...(existing ? (JSON.parse(existing.payload) as string[]) : []),
        ...messages.map((m) => m.id),
      ]),
    ].slice(-80);
    this.db
      .prepare('INSERT OR REPLACE INTO jobs VALUES (?,?,?)')
      .run(scope, JSON.stringify(ids), Date.now());
  }
  memoryJobs(): { scope: string; messages: MessageEnvelope[]; updated: number }[] {
    return (
      this.db.prepare('SELECT * FROM jobs ORDER BY updated LIMIT 100').all() as {
        scope: string;
        payload: string;
        updated: number;
      }[]
    ).map((j) => ({
      scope: j.scope,
      updated: j.updated,
      messages: (JSON.parse(j.payload) as string[])
        .filter((x) => !this.isExcluded(x))
        .flatMap((x) => {
          const e = this.getEnvelope(x);
          return e ? [e] : [];
        }),
    }));
  }
  finishMemoryJob(scope: string, sourceIds: string[]): void {
    const current = this.memoryJobs().find((j) => j.scope === scope);
    if (!current) return;
    const remaining = current.messages.filter((m) => !sourceIds.includes(m.id));
    if (!remaining.length) this.db.prepare('DELETE FROM jobs WHERE scope=?').run(scope);
    else
      this.db
        .prepare('UPDATE jobs SET payload=? WHERE scope=?')
        .run(JSON.stringify(remaining.map((m) => m.id)), scope);
  }
  createOutbox(conv: string, text: string): string {
    const key = id();
    this.db
      .prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?)')
      .run(key, conv, text, 'pending', null, Date.now());
    return key;
  }
  finishOutbox(key: string, status: 'sent' | 'unknown' | 'failed', remoteId?: string): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE outbox SET status=?,remote_id=? WHERE id=?')
        .run(status, remoteId ?? null, key);
      this.db.prepare('UPDATE messages SET status=? WHERE id=?').run(status, key);
      this.db
        .prepare(
          'UPDATE conversations SET updated=MAX(updated+1,?) WHERE id=(SELECT conv FROM outbox WHERE id=?)',
        )
        .run(Date.now(), key);
    });
  }
  outbox(): { id: string; conv: string; status: string }[] {
    return this.db
      .prepare('SELECT id,conv,status FROM outbox ORDER BY time DESC LIMIT 100')
      .all() as { id: string; conv: string; status: string }[];
  }
  hasImport(hash: string): boolean {
    return !!this.db.prepare('SELECT hash FROM imports WHERE hash=?').get(hash);
  }
  markImport(hash: string): void {
    this.db.prepare('INSERT INTO imports VALUES (?,?)').run(hash, Date.now());
  }
  quota(key: string, maximum: number, increment = false): boolean {
    const current =
      (
        this.db.prepare('SELECT value FROM quotas WHERE key=?').get(key) as
          { value: number } | undefined
      )?.value ?? 0;
    if (current >= maximum) return false;
    if (increment)
      this.db
        .prepare('INSERT INTO quotas VALUES (?,1) ON CONFLICT(key) DO UPDATE SET value=value+1')
        .run(key);
    return true;
  }
  addUsage(day: string, input: number, output: number, ambient: boolean, background = false): void {
    this.db
      .prepare(
        'INSERT INTO usage(day,input,output,ambient,background) VALUES (?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET input=input+excluded.input,output=output+excluded.output,ambient=ambient+excluded.ambient,background=background+excluded.background',
      )
      .run(day, input, output, ambient ? input + output : 0, background ? input + output : 0);
  }
  usage(day: string): { input: number; output: number; ambient: number; background: number } {
    return (
      (this.db.prepare('SELECT input,output,ambient,background FROM usage WHERE day=?').get(day) as
        { input: number; output: number; ambient: number; background: number } | undefined) ?? {
        input: 0,
        output: 0,
        ambient: 0,
        background: 0,
      }
    );
  }
  counts() {
    return {
      messages: (this.db.prepare('SELECT count(*) n FROM messages').get() as { n: number }).n,
      facts: (
        this.db.prepare('SELECT count(*) n FROM facts WHERE removed=0').get() as { n: number }
      ).n,
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
