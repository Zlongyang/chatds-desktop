import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { validateOneBotUrl } from '../shared/config.js';
import type { AppConfig, MessageEnvelope } from '../shared/types.js';
export class DeliveryUnknownError extends Error {}
export class OneBot extends EventEmitter {
  private socket: WebSocket | null = null;
  private pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      mutating: boolean;
    }
  >();
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private attempts = 0;
  private generation = 0;
  private verified = false;
  private sent = new Map<string, { conversationId: string; text: string }>();
  status = 'offline';
  account?: string;
  constructor(
    private config: () => AppConfig['onebot'],
    private token: () => string | undefined,
  ) {
    super();
  }
  start(): void {
    if (!this.stopped) return;
    const c = this.config();
    if (!c.botQQ || !c.ownerQQ) throw new Error('请先设置机器人账号和主号');
    if (!validateOneBotUrl(c.url)) throw new Error('OneBot 地址无效');
    if (!this.token()) throw new Error('请先设置 OneBot Access Token');
    this.stopped = false;
    this.connect();
  }
  private connect(): void {
    if (this.stopped) return;
    const epoch = ++this.generation;
    this.setStatus('connecting');
    const ws = new WebSocket(this.config().url, {
      headers: { Authorization: 'Bearer ' + this.token() },
      maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: 10000,
    });
    this.socket = ws;
    ws.on('open', () => {
      void (async () => {
        try {
          const info = await this.call('get_login_info');
          if (epoch !== this.generation || this.stopped) return;
          this.account = String(info.user_id);
          if (this.account !== this.config().botQQ) {
            this.stop();
            this.setStatus('wrong-account');
            return;
          }
          this.verified = true;
          this.attempts = 0;
          this.setStatus('online');
        } catch {
          if (epoch === this.generation) {
            this.setStatus('authentication-or-protocol-error');
            ws.close();
          }
        }
      })();
    });
    ws.on('message', (bytes) => {
      if (epoch !== this.generation) return;
      let value: any;
      try {
        value = JSON.parse(bytes.toString());
      } catch {
        return;
      }
      if (value.echo && this.pending.has(String(value.echo))) {
        const p = this.pending.get(String(value.echo))!;
        this.pending.delete(String(value.echo));
        clearTimeout(p.timer);
        value.status === 'ok' && value.retcode === 0
          ? p.resolve(value.data)
          : p.reject(
              new Error(String(value.wording ?? value.message ?? 'OneBot 操作失败').slice(0, 200)),
            );
        return;
      }
      if (this.verified && value.post_type === 'message') this.emit('message', value);
      if (this.verified && value.post_type === 'request') this.emit('request', value);
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (epoch !== this.generation) return;
      this.verified = false;
      this.account = undefined;
      this.rejectPending();
      if (!this.stopped) {
        this.setStatus('reconnecting');
        const delay =
          Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)) +
          Math.floor(Math.random() * 250);
        this.reconnect = setTimeout(() => this.connect(), delay);
        this.reconnect.unref();
      }
    });
  }
  private setStatus(status: string): void {
    this.status = status;
    this.emit('status', { status, account: this.account });
  }
  call(action: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('OneBot 尚未连接'));
    if (signal?.aborted) return Promise.reject(new Error('操作已取消'));
    if (this.pending.size >= 64) return Promise.reject(new Error('OneBot 请求过多'));
    return new Promise((resolve, reject) => {
      const echo = randomUUID(),
        mutating = !action.startsWith('get_') && !action.startsWith('can_');
      const finishReject = (error: Error) => {
        const p = this.pending.get(echo);
        if (!p) return;
        this.pending.delete(echo);
        clearTimeout(p.timer);
        signal?.removeEventListener('abort', abort);
        reject(error);
      };
      const abort = () =>
        finishReject(
          mutating
            ? new DeliveryUnknownError('操作取消，发送结果未知；请先核实后重试')
            : new Error('请求取消'),
        );
      const timer = setTimeout(
        () =>
          finishReject(
            mutating
              ? new DeliveryUnknownError('操作超时，结果未知；没有自动重试')
              : new Error('OneBot 请求超时'),
          ),
        15000,
      );
      timer.unref();
      const wrap = (fn: (v: any) => void) => (v: any) => {
        signal?.removeEventListener('abort', abort);
        fn(v);
      };
      this.pending.set(echo, { resolve: wrap(resolve), reject: wrap(reject), timer, mutating });
      signal?.addEventListener('abort', abort, { once: true });
      this.socket!.send(JSON.stringify({ action, params, echo }), (error) => {
        if (error)
          finishReject(mutating ? new DeliveryUnknownError('连接中断，发送结果未知') : error);
      });
    });
  }
  async send(conversationId: string, text: string, signal?: AbortSignal): Promise<string> {
    if (!this.verified) throw new Error('QQ 账号尚未验证');
    const match = /^onebot:(private|group):(\d{5,12})$/.exec(conversationId);
    if (!match) throw new Error('QQ 会话无效');
    const response = await this.call(
      match[1] === 'group' ? 'send_group_msg' : 'send_private_msg',
      {
        [match[1] === 'group' ? 'group_id' : 'user_id']: Number(match[2]),
        message: [{ type: 'text', data: { text } }],
      },
      signal,
    );
    const key = String(response.message_id);
    this.sent.set(key, { conversationId, text });
    while (this.sent.size > 1000) this.sent.delete(this.sent.keys().next().value!);
    return key;
  }
  async normalize(raw: any): Promise<MessageEnvelope | null> {
    const generation = this.generation;
    const c = this.config();
    if (
      !this.verified ||
      String(raw.self_id) !== c.botQQ ||
      String(raw.user_id) === c.botQQ ||
      !['private', 'group'].includes(raw.message_type)
    )
      return null;
    const user = String(raw.user_id),
      group = String(raw.group_id ?? '');
    if (!/^\d{5,12}$/.test(user)) return null;
    const isGroup = raw.message_type === 'group';
    if (
      isGroup
        ? !/^\d{5,12}$/.test(group) || !c.groups.includes(group)
        : user !== c.ownerQQ && !c.users.includes(user)
    )
      return null;
    const segments = Array.isArray(raw.message)
      ? raw.message.slice(0, 100)
      : [{ type: 'text', data: { text: String(raw.message ?? '') } }];
    const text = segments
      .filter((x: any) => x?.type === 'text')
      .map((x: any) => String(x.data?.text ?? ''))
      .join('')
      .trim()
      .slice(0, 6000);
    if (!text) return null;
    const conversationId = `onebot:${isGroup ? 'group' : 'private'}:${isGroup ? group : user}`;
    const mention = segments.some((s: any) => s?.type === 'at' && String(s.data?.qq) === c.botQQ);
    const reply = segments.find((s: any) => s?.type === 'reply');
    const known = reply ? this.sent.get(String(reply.data?.id)) : undefined;
    const e: MessageEnvelope = {
      id: `qq:${c.botQQ}:${isGroup ? 'g' + group : 'p' + user}:${String(raw.message_id).slice(0, 80)}`,
      conversationId,
      channel: 'onebot',
      actorId: user === c.ownerQQ ? 'owner' : 'qq:' + user,
      displayName: String(raw.sender?.card || raw.sender?.nickname || user).slice(0, 80),
      text,
      timestamp: Date.now(),
      isGroup,
      trigger:
        !isGroup || mention || known?.conversationId === conversationId ? 'direct' : 'ambient',
      mention,
    };
    if (reply) {
      e.replyTo = String(reply.data?.id).slice(0, 80);
      if (known?.conversationId === conversationId)
        e.quoted = { actorId: 'bot', text: known.text.slice(0, 3000) };
      else {
        try {
          const msg = await this.call('get_msg', { message_id: reply.data.id });
          const same = isGroup && String(msg.group_id) === group;
          if (same && String(msg.sender?.user_id) !== c.botQQ) {
            const quotedText = (Array.isArray(msg.message) ? msg.message : [])
              .filter((x: any) => x.type === 'text')
              .map((x: any) => String(x.data?.text ?? ''))
              .join('')
              .slice(0, 3000);
            if (quotedText)
              e.quoted = {
                actorId:
                  String(msg.sender?.user_id) === c.ownerQQ
                    ? 'owner'
                    : 'qq:' + String(msg.sender?.user_id),
                text: quotedText,
              };
          }
        } catch {
          /* Missing/unverifiable quotes do not cross conversation boundaries. */
        }
      }
    }
    if (!this.verified || generation !== this.generation) return null;
    return e;
  }
  private rejectPending(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        p.mutating
          ? new DeliveryUnknownError('连接断开，结果未知；没有自动重试')
          : new Error('连接已断开'),
      );
    }
    this.pending.clear();
  }
  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.reconnect);
    this.verified = false;
    this.account = undefined;
    this.rejectPending();
    this.socket?.terminate();
    this.socket = null;
    this.setStatus('offline');
  }
  get stats() {
    return {
      pending: this.pending.size,
      connected: this.verified,
      reconnectTimer: !!this.reconnect && !this.stopped,
    };
  }
}
