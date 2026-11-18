import { DeliveryUnknownError } from '../connectors/onebot.js';
import { atomicJson, id, readJson } from '../shared/util.js';

interface Request {
  id: string;
  account?: string;
  qq: string;
  comment: string;
  flag: string;
  handled: boolean;
  uncertain?: boolean;
}

export class FriendRequests {
  private rows: Request[];
  private busy = new Set<string>();

  constructor(
    private file: string,
    private account: () => string | undefined,
  ) {
    this.rows = readJson<Request[]>(file, []);
  }

  receive(account: string, qq: string, flag: string, comment: string) {
    if (account !== this.account() || !/^\d{5,12}$/.test(qq) || !flag || flag.length > 1024) return;
    if (this.rows.some((r) => r.account === account && r.flag === flag)) return;
    this.rows.push({ id: id(), account, qq, flag, comment: comment.slice(0, 500), handled: false });
    this.rows = this.rows.slice(-100);
    atomicJson(this.file, this.rows);
  }

  list() {
    const account = this.account();
    return account
      ? this.rows
          .filter((r) => r.account === account && !r.handled)
          .map(({ id, qq, comment, uncertain }) => ({ id, qq, comment, uncertain }))
      : [];
  }

  async review(
    key: string,
    confirm: (row: Readonly<Request>) => Promise<'cancel' | 'accept' | 'decline' | 'dismiss'>,
    send: (flag: string, allow: boolean) => Promise<void>,
  ) {
    const account = this.account();
    const row = this.rows.find(
      (r) => account && r.account === account && r.id === key && !r.handled,
    );
    if (!row) throw new Error('当前在线账号没有这条好友申请');
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const decision = await confirm(row);
      if (decision === 'cancel') return;
      if (this.account() !== account || !this.rows.includes(row))
        throw new Error('账号或申请已变化，请重新查看');
      if (row.uncertain) {
        if (decision !== 'dismiss') throw new Error('请先去 QQ 核实处理结果');
      } else {
        if (decision !== 'accept' && decision !== 'decline') return;
        row.uncertain = true;
        atomicJson(this.file, this.rows);
        try {
          await send(row.flag, decision === 'accept');
        } catch (error) {
          if (!(error instanceof DeliveryUnknownError)) {
            row.uncertain = false;
            atomicJson(this.file, this.rows);
          }
          throw error;
        }
      }
      row.handled = true;
      atomicJson(this.file, this.rows);
    } finally {
      this.busy.delete(key);
    }
  }
}
