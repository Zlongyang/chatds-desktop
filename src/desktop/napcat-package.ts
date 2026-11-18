import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
import { availablePort } from './napcat.js';

const revision = '9335843246e3b7a17944861f3ac8731a259732c2';
const mirror = 'https://github.com/XingYunStar/NapCatQQ/releases';
const mirrorAsset = 'https://api.github.com/repos/XingYunStar/NapCatQQ/releases/assets/738244282';
// Original NapNeko release 428738017, asset 691263446, published 2026-10-30.
export const NAPCAT_PACKAGE = Object.freeze({
  version: '4.18.42',
  fileName: 'NapCat.Shell.zip',
  size: 35_967_555,
  sha256: '02e5ff0f79916c1e04c81c1b4590056406fb4293f1f1300c955e71fd08b2829d',
  downloadUrl: mirror + '/download/v4.18.42/NapCat.Shell.zip',
  archivePage: mirror + '/tag/v4.18.42',
  sourceUrl: 'https://github.com/NapNeko/NapCatQQ/tree/' + revision,
  licenseName: 'Limited Redistribution License for NapCat',
  licenseUrl: 'https://github.com/NapNeko/NapCatQQ/blob/' + revision + '/LICENSE',
});

export interface NapCatPackageOptions {
  archive?: string;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
}

const installs = new Set<string>();
const marker = '.chatds-package.sha256';

// A terminated process may leave its private staging directory on disk. Never clean a live
// process's directory, and require our package receipt before removing an abandoned one.
async function cleanAbandonedStages(base: string) {
  for (const item of await readdir(base, { withFileTypes: true })) {
    const owner = /^\.install-(\d{1,10})-[a-z0-9]{6}$/i.exec(item.name);
    if (!item.isDirectory() || !owner) continue;
    const pid = Number(owner[1]);
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
    }
    const stage = join(base, item.name);
    if (await hasReceipt(stage))
      await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function exists(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function hasReceipt(path: string): Promise<boolean> {
  const receipt = await exists(join(path, marker));
  if (!receipt?.isFile() || receipt.size !== NAPCAT_PACKAGE.sha256.length + 1) return false;
  return (
    (
      await readFile(join(path, marker), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      })
    ).trim() === NAPCAT_PACKAGE.sha256
  );
}

async function installed(path: string): Promise<boolean> {
  const directory = await exists(path);
  if (!directory) return false;
  if (
    directory.isDirectory() &&
    (await hasReceipt(path)) &&
    (await exists(join(path, 'launcher.bat')))?.isFile() &&
    (await exists(join(path, 'napcat.mjs')))?.isFile()
  ) {
    return true;
  }
  throw new Error('托管的 NapCat 目录已存在且内容不完整。请备份其中的配置并移走该目录后重试。');
}

async function archiveResponse(start: string, signal: AbortSignal): Promise<Response | null> {
  let url = new URL(start);
  for (let hop = 0; hop < 5; hop++) {
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      ![
        'github.com',
        'api.github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
      ].includes(url.hostname)
    ) {
      throw new Error('归档下载地址不受信任。');
    }
    let response: Response;
    try {
      response = await fetch(url, {
        signal,
        redirect: 'manual',
        headers: { Accept: 'application/octet-stream' },
      });
    } catch {
      signal.throwIfAborted();
      return null;
    }
    if (response.status === 200 && response.body) {
      if (
        response.headers.has('content-length') &&
        Number(response.headers.get('content-length')) !== NAPCAT_PACKAGE.size
      ) {
        await response.body.cancel();
        throw new Error('下载内容大小与已记录的 NapCat 原包不符。');
      }
      return response;
    }
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return null;
    url = new URL(location, url);
  }
  throw new Error('归档下载重定向过多。');
}

async function download(signal: AbortSignal) {
  const response =
    (await archiveResponse(NAPCAT_PACKAGE.downloadUrl, signal)) ??
    (await archiveResponse(mirrorAsset, signal));
  if (!response?.body)
    throw new Error('无法连接 NapCat 归档站。请稍后重试，或导入本机同版本 ZIP。');
  return response.body;
}

async function verifiedBytes(options: NapCatPackageOptions, signal: AbortSignal): Promise<Buffer> {
  const archive = options.archive;
  if (
    archive !== undefined &&
    (!isAbsolute(archive) ||
      archive.includes('\0') ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(archive)))
  )
    throw new Error('请选择本机 NapCat ZIP 文件。');
  if (archive !== undefined && !(await exists(archive))?.isFile())
    throw new Error('请选择本机的普通 ZIP 文件。');
  const file = archive === undefined ? null : await open(archive, 'r');
  try {
    if (file) {
      const info = await file.stat();
      if (!info.isFile() || info.size !== NAPCAT_PACKAGE.size)
        throw new Error('请选择 NapCat v4.18.42 原版 NapCat.Shell.zip，文件大小不匹配。');
    }
    const chunks = file
      ? file.createReadStream({ autoClose: false, signal })
      : await download(signal);
    // Allocate a single bounded buffer so the exact bytes we hash are the bytes we later unpack.
    const bytes = Buffer.allocUnsafe(NAPCAT_PACKAGE.size);
    const hash = createHash('sha256');
    let received = 0;
    let lastReported = 0;
    options.onProgress?.(0, bytes.length);
    for await (const chunk of chunks) {
      signal.throwIfAborted();
      if (received + chunk.length > bytes.length) throw new Error('NapCat ZIP 超过已知大小。');
      bytes.set(chunk, received);
      received += chunk.length;
      hash.update(chunk);
      if (received === bytes.length || Date.now() - lastReported >= 200) {
        options.onProgress?.(received, bytes.length);
        lastReported = Date.now();
      }
    }
    if (received !== bytes.length || hash.digest('hex') !== NAPCAT_PACKAGE.sha256)
      throw new Error('NapCat ZIP 的 SHA-256 校验失败。请重新下载原版文件。');
    return bytes;
  } finally {
    await file?.close();
  }
}

async function extract(bytes: Buffer, stage: string, signal: AbortSignal) {
  const zip = await unzipper.Open.buffer(bytes);
  for (const entry of zip.files) {
    signal.throwIfAborted();
    const name = entry.type === 'Directory' ? entry.path.replace(/\/$/, '') : entry.path;
    const parts = name.split('/');
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (
      (mode !== 0 && mode !== 0o040000 && mode !== 0o100000) ||
      entry.externalFileAttributes & 0x400 ||
      parts.some(
        (part) =>
          !part ||
          /[<>:"\\|?*\x00-\x1f]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
      )
    ) {
      throw new Error('NapCat ZIP 中存在不安全的文件路径。');
    }
    const path = join(stage, ...parts);
    if (entry.type === 'Directory') await mkdir(path, { recursive: true });
    else {
      await mkdir(dirname(path), { recursive: true });
      await pipeline(entry.stream(), createWriteStream(path, { flags: 'wx' }), { signal });
    }
  }
  if (
    !(await exists(join(stage, 'launcher.bat')))?.isFile() ||
    !(await exists(join(stage, 'napcat.mjs')))?.isFile()
  )
    throw new Error('NapCat ZIP 缺少必要的 Windows 启动文件。');
}

/** Returns the complete managed install. No upstream program is launched here. */
export async function installNapCatPackage(
  userData: string,
  options: NapCatPackageOptions = {},
): Promise<string> {
  if (!isAbsolute(userData)) throw new Error('NapCat 需要本机应用数据目录。');
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15 * 60_000)])
    : AbortSignal.timeout(15 * 60_000);
  signal.throwIfAborted();
  await mkdir(userData, { recursive: true });
  const base = join(await realpath(userData), 'napcat-packages');
  await mkdir(base, { recursive: true });
  if (!(await lstat(base)).isDirectory()) throw new Error('无法使用重定向的 NapCat 托管目录。');
  await cleanAbandonedStages(base);
  const destination = join(base, NAPCAT_PACKAGE.version);
  if (await installed(destination)) return destination;
  if (installs.has(destination)) throw new Error('NapCat 安装正在进行。');
  installs.add(destination);
  let stage: string | undefined;
  try {
    const bytes = await verifiedBytes(options, signal);
    signal.throwIfAborted();
    stage = await mkdtemp(join(base, '.install-' + process.pid + '-'));
    await writeFile(join(stage, marker), NAPCAT_PACKAGE.sha256 + '\n', { flag: 'wx' });
    await extract(bytes, stage, signal);
    const config = join(stage, 'config', 'webui.json');
    if (!(await exists(config))) {
      const webui = {
        host: '127.0.0.1',
        port: await availablePort(),
        token: randomBytes(24).toString('hex'),
        disableWebUI: false,
      };
      await writeFile(config, JSON.stringify(webui, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    signal.throwIfAborted();
    if (await installed(destination)) return destination;
    try {
      await rename(stage, destination);
      stage = undefined;
    } catch (error) {
      if (!(await installed(destination))) throw error;
    }
    return destination;
  } finally {
    try {
      if (stage) await rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } finally {
      installs.delete(destination);
    }
  }
}
