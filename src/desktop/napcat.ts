import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import QRCode from 'qrcode';
import { isLoopback } from '../shared/config.js';
import type { NapCatLoginStatus } from '../shared/types.js';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const maxResponse = 1024 * 1024;
class Unauthorized extends Error {}

// Let the OS choose a free loopback port. NapCat takes over the listener after SetConfig.
export async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error || !address || typeof address === 'string')
          reject(new Error('无法给 NapCat 分配本机端口'));
        else resolve(address.port);
      });
    });
  });
}

function localListener(row: unknown): { url: string; token: string } | undefined {
  if (
    !record(row) ||
    row.enable !== true ||
    row.messagePostFormat !== 'array' ||
    typeof row.host !== 'string' ||
    !isLoopback(row.host) ||
    typeof row.port !== 'number' ||
    !Number.isInteger(row.port) ||
    row.port < 1 ||
    row.port > 65535 ||
    typeof row.token !== 'string' ||
    !/^[\x21-\x7e]{1,1000}$/.test(row.token)
  )
    return;
  const host = row.host.includes(':') ? '[::1]' : row.host.toLowerCase();
  return { url: `ws://${host}:${row.port}`, token: row.token };
}

export class NapCatSession {
  private readonly origin: string;
  private readonly controller = new AbortController();
  private hash: string;
  private credential = '';
  private qrCache?: { text: string; image: string };
  private lastAccount?: string;

  constructor(origin: string, token: string) {
    const url = new URL(origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !isLoopback(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('请选择本机 NapCat WebUI 地址');
    if (!token.trim() || token.length > 2048) throw new Error('缺少有效的 NapCat WebUI 令牌');
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    this.origin = url.origin;
    this.hash = createHash('sha256')
      .update(token + '.napcat')
      .digest('hex');
  }

  close(): void {
    this.controller.abort();
    this.credential = this.hash = '';
    this.qrCache = undefined;
    this.lastAccount = undefined;
  }

  private async post(
    path: string,
    body: Record<string, unknown> = {},
    auth = true,
  ): Promise<unknown> {
    this.controller.signal.throwIfAborted();
    const target = new URL('/api' + path, this.origin);
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(12000)]);
    const request = target.protocol === 'http:' ? httpRequest : httpsRequest;
    return new Promise((resolve, reject) => {
      const wire = request(
        target,
        {
          method: 'POST',
          agent: false,
          signal,
          headers: {
            'Content-Type': 'application/json',
            ...(auth ? { Authorization: 'Bearer ' + this.credential } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('error', () => reject(new Error('读取 NapCat WebUI 响应失败')));
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxResponse) {
              reject(new Error('NapCat WebUI 响应过大'));
              wire.destroy();
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              if (response.statusCode === 401 || response.statusCode === 403) {
                if (!auth) throw new Error('NapCat WebUI 认证失败，请核对令牌');
                throw new Unauthorized();
              }
              if (response.statusCode !== 200)
                throw new Error('NapCat WebUI 接口不可用，请核对地址和版本');
              let result: unknown;
              try {
                result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                /* Checked below. */
              }
              if (!record(result)) throw new Error('此地址没有返回 NapCat WebUI 接口数据');
              if (result.code !== 0) {
                if (auth && result.message === 'Unauthorized') throw new Unauthorized();
                if (path === '/auth/login')
                  throw new Error('NapCat WebUI 认证失败，请核对令牌，稍后再试');
                throw new Error('NapCat 未完成此操作，请在 NapCat WebUI 查看登录和服务状态');
              }
              resolve(result.data);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      wire.on('error', () =>
        reject(new Error('无法连接本机 NapCat WebUI，请先启动 NapCat 并检查地址')),
      );
      wire.end(JSON.stringify(body));
    });
  }

  private async login(): Promise<void> {
    const response = await this.post('/auth/login', { hash: this.hash }, false);
    if (record(response) && response.require2FA === true)
      throw new Error('NapCat 启用了双重验证，请在 NapCat WebUI 登录后使用手动 OneBot 连接');
    if (
      !record(response) ||
      typeof response.Credential !== 'string' ||
      !/^[\x21-\x7e]{1,8192}$/.test(response.Credential)
    )
      throw new Error('NapCat WebUI 认证失败，请核对令牌');
    this.controller.signal.throwIfAborted();
    this.credential = response.Credential;
  }

  async checkWebUI(): Promise<void> {
    await this.login();
  }

  private async api(path: string, body?: Record<string, unknown>): Promise<unknown> {
    try {
      if (!this.credential) await this.login();
      return await this.post(path, body);
    } catch (error) {
      if (!(error instanceof Unauthorized)) throw error;
      this.credential = '';
      try {
        await this.login();
        return await this.post(path, body);
      } catch (retryError) {
        if (retryError instanceof Unauthorized)
          throw new Error('NapCat WebUI 拒绝认证，请重新连接');
        throw retryError;
      }
    }
  }

  private async waiting(text: unknown): Promise<NapCatLoginStatus> {
    if (!text) return { phase: 'waiting', detail: '正在等待 NapCat 生成二维码' };
    if (typeof text !== 'string' || text.length > 2048)
      throw new Error('NapCat 登录二维码格式无效');
    const link = URL.canParse(text) ? new URL(text) : undefined;
    if (
      !link ||
      link.protocol !== 'https:' ||
      link.port ||
      link.username ||
      link.password ||
      !['txz.qq.com', 'ssl.ptlogin2.qq.com', 'xui.ptlogin2.qq.com'].includes(link.hostname)
    )
      throw new Error('NapCat 返回了无法识别的 QQ 登录二维码');
    if (this.qrCache?.text !== text) {
      const image = await QRCode.toDataURL(text, { width: 256, margin: 4 });
      this.controller.signal.throwIfAborted();
      this.qrCache = { text, image };
    }
    return { phase: 'waiting', qr: this.qrCache.image };
  }

  async status(): Promise<NapCatLoginStatus> {
    const state = await this.api('/QQLogin/CheckLoginStatus');
    if (!record(state) || typeof state.isLogin !== 'boolean')
      throw new Error('无法识别 NapCat 登录状态');
    if (state.isLogin && state.coreReady !== false && !state.isOffline) {
      const info = await this.api('/QQLogin/GetQQLoginInfo');
      const botQQ = record(info) ? String(info.uin ?? '') : '';
      if (!/^\d{5,12}$/.test(botQQ)) throw new Error('NapCat 尚未返回登录的 QQ 号，请稍后重试');
      this.lastAccount = botQQ;
      this.qrCache = undefined;
      return { phase: 'ready', botQQ };
    }
    this.lastAccount = undefined;
    if (state.loginPhase === 'qrcode_scanned') return { phase: 'scanned' };
    if (state.qrLoginAccepted || state.loginPhase === 'initializing')
      return { phase: 'initializing' };
    if (typeof state.loginError === 'string' && /过期|expired/i.test(state.loginError))
      return { phase: 'expired', detail: '二维码已过期，请刷新后重新扫描' };
    if (state.isOffline || state.loginPhase === 'reconnecting' || state.loginError)
      return { phase: 'waiting', detail: '请检查 NapCat 登录状态，稍后刷新二维码' };
    return this.waiting(state.qrcodeurl);
  }

  async refresh(): Promise<NapCatLoginStatus> {
    const state = await this.status();
    if (state.phase !== 'waiting' && state.phase !== 'expired') return state;
    const result = await this.api('/QQLogin/RefreshQRcode');
    this.qrCache = undefined;
    return this.waiting(record(result) && result.qrcodeurl);
  }

  async provision(
    expectedBotQQ = this.lastAccount,
  ): Promise<{ url: string; token: string; botQQ: string }> {
    const { botQQ } = await this.status();
    if (!botQQ) throw new Error('请先在手机 QQ 确认登录');
    if (expectedBotQQ && expectedBotQQ !== botQQ)
      throw new Error('NapCat 登录账号已变更，请重新核对');
    const get = () => this.api('/OB11Config/GetConfig');
    const config = await get();
    if (
      !record(config) ||
      !record(config.network) ||
      !Array.isArray(config.network.websocketServers)
    )
      throw new Error('NapCat OneBot 配置格式不受支持，请使用手动连接');
    const servers: unknown[] = config.network.websocketServers;
    for (const server of servers) {
      const listener = localListener(server);
      if (listener) return { ...listener, botQQ };
    }
    const entries = Object.values(config.network).flatMap((value) =>
      Array.isArray(value) ? value.filter(record) : [],
    );
    const occupied = new Set(entries.map((entry) => entry.port));
    let port = await availablePort();
    for (let i = 0; i < 8 && occupied.has(port); i++) port = await availablePort();
    if (occupied.has(port)) throw new Error('未找到可用的本机 OneBot 端口，请重试');
    const names = new Set(entries.map((entry) => entry.name));
    let name = 'ChatDS';
    for (let n = 2; names.has(name); n++) name = 'ChatDS-' + n;
    const token = randomBytes(32).toString('hex');
    const next = {
      name,
      enable: true,
      host: '127.0.0.1',
      port,
      messagePostFormat: 'array',
      token,
      enableForcePushEvent: true,
      reportSelfMessage: false,
      debug: false,
      heartInterval: 30000,
    };
    // This endpoint replaces the whole document. Avoid overwriting edits made while picking a port.
    if (
      JSON.stringify(await get()) !== JSON.stringify(config) ||
      (await this.status()).botQQ !== botQQ
    )
      throw new Error('NapCat 配置或登录账号已变更，请重试');
    await this.api('/OB11Config/SetConfig', {
      config: JSON.stringify({
        ...config,
        network: { ...config.network, websocketServers: [...servers, next] },
      }),
    });
    return { url: 'ws://127.0.0.1:' + port, token, botQQ };
  }
}
