import { realpath, mkdir, lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function workspacePath(root: string, input: string): Promise<string> {
  if (!input || input.length > 250 || isAbsolute(input) || /^[a-zA-Z]:|\\|\0|:/.test(input))
    throw new Error('请使用工作区内的相对路径');
  await mkdir(root, { recursive: true });
  const base = await realpath(root),
    target = resolve(base, input);
  const rel = relative(base, target);
  if (
    rel === '..' ||
    rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) ||
    isAbsolute(rel)
  )
    throw new Error('路径越过工作区');
  let current = target;
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('工作区不允许符号链接');
      const real = await realpath(current);
      const r = relative(base, real);
      if (
        r === '..' ||
        r.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) ||
        isAbsolute(r)
      )
        throw new Error('链接越过工作区');
      if (current === target && info.isFile() && info.nlink > 1)
        throw new Error('工作区不允许硬链接');
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = dirname(current);
      if (parent === current) throw new Error('路径无效');
      current = parent;
    }
  }
  return target;
}
export async function readWorkspace(root: string, input: string): Promise<string> {
  const file = await workspacePath(root, input);
  const info = await lstat(file);
  if (!info.isFile() || info.size > 256 * 1024) throw new Error('只能读取 256 KiB 以内的普通文件');
  return (await readFile(file, 'utf8')).slice(0, 30000);
}
export async function writeWorkspace(
  root: string,
  input: string,
  content: string,
  beforeCommit: () => void = () => {},
): Promise<void> {
  if (Buffer.byteLength(content) > 100000) throw new Error('写入内容超过 100 KiB');
  const target = await workspacePath(root, input);
  await mkdir(dirname(target), { recursive: true });
  await workspacePath(root, input);
  const temporary = join(dirname(target), '.chatds-' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
    beforeCommit();
    await workspacePath(root, input);
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
