import { open } from 'node:fs/promises';
import { join } from 'node:path';

export interface NapCatLocation {
  origin: string;
  token: string;
}

function validToken(token: unknown): token is string {
  return typeof token === 'string' && token.trim().length > 0 && token.length <= 1024;
}

// Only these two known config paths are inspected after a user selects a directory.
export async function locationFromFolder(directory: string): Promise<NapCatLocation> {
  for (const filename of [join(directory, 'config', 'webui.json'), join(directory, 'webui.json')]) {
    const file = await open(filename, 'r').catch((error) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw new Error('无法读取 NapCat 配置，请检查目录的读取权限。');
    });
    if (!file) continue;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 128 * 1024) throw new Error();
      const cfg = JSON.parse((await file.readFile('utf8')).replace(/^\uFEFF/, ''));
      if (cfg.disableWebUI) throw new Error('disabled');
      if (!validToken(cfg.token)) throw new Error('token');
      if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error();
      if (
        cfg.host &&
        !['localhost', '0.0.0.0', '127.0.0.1', '::', '::1', '[::1]'].includes(cfg.host)
      )
        throw new Error();
      const host = ['::', '::1', '[::1]'].includes(cfg.host) ? '[::1]' : '127.0.0.1';
      return { origin: 'http://' + host + ':' + cfg.port, token: cfg.token };
    } catch (error) {
      if (error instanceof Error && error.message === 'disabled')
        throw new Error('请先在 NapCat 开启 WebUI，然后重试。');
      if (error instanceof Error && error.message === 'token')
        throw new Error('请先在 NapCat 设置 WebUI 令牌，或使用启动窗口中的登录链接。');
      throw new Error('无法识别 webui.json，请使用 NapCat 启动窗口中的 WebUI 登录链接。');
    } finally {
      await file.close();
    }
  }
  throw new Error(
    '这个目录里没有 webui.json。请启动 NapCat，选择包含 config 的目录，或粘贴启动窗口中的 WebUI 登录链接。',
  );
}

export function locationFromLink(input: unknown): NapCatLocation {
  // Never include a pasted URL or a parser error in diagnostics. It contains an admin token.
  try {
    if (typeof input !== 'string' || input.length > 4096) throw new Error();
    const link = new URL(input.trim());
    if (
      !['http:', 'https:'].includes(link.protocol) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(link.hostname) ||
      link.username ||
      link.password ||
      link.hash
    )
      throw new Error();
    const token = link.searchParams.get('token');
    if (!validToken(token)) throw new Error();
    if (link.hostname === 'localhost') link.hostname = '127.0.0.1';
    return { origin: link.origin, token };
  } catch {
    throw new Error('请粘贴 NapCat 启动窗口中带 token 的本机 WebUI 登录链接。');
  }
}
