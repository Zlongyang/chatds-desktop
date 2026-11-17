import { readdir, readFile, lstat, mkdir, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { digest } from '../shared/util.js';
import type { SkillInfo } from '../shared/types.js';
interface Manifest {
  version: 1;
  name: string;
  description: string;
  files: Record<string, string>;
}
function metadata(text: string): { name: string; description: string } {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!header) throw new Error('SKILL.md 缺少 YAML frontmatter');
  const scalar = (key: string) => {
    const lines = header.split(/\r?\n/);
    const i = lines.findIndex((line) => line.startsWith(key + ':'));
    if (i < 0) return '';
    let value = lines[i]!.slice(key.length + 1).trim();
    if (/^[>|][+-]?$/.test(value)) {
      value = lines
        .slice(i + 1)
        .slice(
          0,
          lines.slice(i + 1).findIndex((l) => l && !/^\s/.test(l)) < 0
            ? undefined
            : lines.slice(i + 1).findIndex((l) => l && !/^\s/.test(l)),
        )
        .map((l) => l.trim())
        .join(' ');
    }
    return value.replace(/^(['"])([\s\S]*)\1$/, '$2');
  };
  const name = scalar('name'),
    description = scalar('description');
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
    name.length > 64 ||
    !description ||
    description.length > 1024
  )
    throw new Error('技能 name 或 description 无效');
  return { name, description };
}
export class SkillRegistry {
  constructor(readonly root: string) {}
  private directory(key: string): string {
    if (!/^[a-f0-9]{24}$/.test(key)) throw new Error('技能编号无效');
    return join(this.root, key);
  }
  async importDirectory(source: string): Promise<SkillInfo> {
    const top = await lstat(source);
    if (!top.isDirectory() || top.isSymbolicLink()) throw new Error('请选择普通技能目录');
    const files: Record<string, string> = {};
    const contents = new Map<string, Buffer>();
    let bytes = 0;
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const file = join(dir, entry.name),
          r = relative(source, file).replaceAll('\\', '/');
        const info = await lstat(file);
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))
          throw new Error('技能包不允许符号链接或硬链接');
        if (entry.isDirectory()) {
          if (r.split('/').length > 6) throw new Error('技能目录层级过深');
          await walk(file);
        } else if (entry.isFile()) {
          if (
            Object.keys(files).length >= 128 ||
            info.size > 1024 * 1024 ||
            (bytes += info.size) > 8 * 1024 * 1024
          )
            throw new Error('技能包过大（最多 128 个文件、8 MiB）');
          const content = await readFile(file);
          files[r] = digest(content.toString('base64'));
          contents.set(r, content);
        }
      }
    };
    await walk(source);
    const main = contents.get('SKILL.md');
    if (!main || main.length > 65536) throw new Error('缺少 SKILL.md 或正文过大');
    const info = metadata(main.toString('utf8'));
    const manifest: Manifest = { version: 1, ...info, files };
    const revision = digest(manifest);
    const key = revision.slice(0, 24);
    await mkdir(this.root, { recursive: true });
    const staging = join(this.root, '.import-' + key);
    await mkdir(staging, { recursive: true });
    try {
      for (const [r, content] of contents) {
        const destination = join(staging, r);
        await mkdir(resolve(destination, '..'), { recursive: true });
        await writeFile(destination, content, { flag: 'w', mode: 0o600 });
      }
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
      try {
        await rename(staging, this.directory(key));
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code !== 'EEXIST' &&
          (e as NodeJS.ErrnoException).code !== 'ENOTEMPTY'
        )
          throw e;
      }
      const all = await this.list();
      for (const old of all)
        if (old.name === info.name && old.id !== key) await this.remove(old.id);
      return { id: key, ...info, revision, resources: Object.keys(files) };
    } finally {
      await this.removeStaging(staging);
    }
  }
  private async removeStaging(target: string) {
    const root = resolve(this.root),
      full = resolve(target);
    if (
      !full.startsWith(root + (process.platform === 'win32' ? '\\' : '/')) ||
      !relative(root, full).startsWith('.import-')
    )
      throw new Error('非法临时技能目录');
    await rm(full, { recursive: true, force: true });
  }
  async list(): Promise<SkillInfo[]> {
    await mkdir(this.root, { recursive: true });
    const result: SkillInfo[] = [];
    for (const item of await readdir(this.root, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[a-f0-9]{24}$/.test(item.name)) continue;
      try {
        const directory = this.directory(item.name),
          stat = await lstat(directory);
        if (stat.isSymbolicLink()) continue;
        const manifest = JSON.parse(
          await readFile(join(directory, 'manifest.json'), 'utf8'),
        ) as Manifest;
        if (manifest.version !== 1 || digest(manifest).slice(0, 24) !== item.name) continue;
        const main = await readFile(join(directory, 'SKILL.md'));
        if (digest(main.toString('base64')) !== manifest.files['SKILL.md']) continue;
        result.push({
          id: item.name,
          name: manifest.name,
          description: manifest.description,
          revision: digest(manifest),
          resources: Object.keys(manifest.files),
        });
      } catch {
        /* Invalid or modified packages are not disclosed. */
      }
    }
    return result.slice(0, 30);
  }
  async load(key: string, resource = 'SKILL.md'): Promise<string> {
    const info = (await this.list()).find((s) => s.id === key);
    if (!info || !info.resources.includes(resource))
      throw new Error('技能或资源不可用，请重新导入修改后的技能');
    if (
      isAbsolute(resource) ||
      resource.includes('\\') ||
      resource.split('/').some((p) => p === '..' || p === '')
    )
      throw new Error('技能资源路径无效');
    const root = this.directory(key),
      file = resolve(root, resource);
    if (!file.startsWith(resolve(root) + (process.platform === 'win32' ? '\\' : '/')))
      throw new Error('技能资源越界');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 65536)
      throw new Error('仅支持 64 KiB 以内的普通文字资源');
    let ancestor = root;
    for (const component of resource.split('/')) {
      ancestor = join(ancestor, component);
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('技能资源不允许链接');
    }
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Manifest;
    const content = await readFile(file);
    if (digest(content.toString('base64')) !== manifest.files[resource])
      throw new Error('技能资源已变更，需要重新导入');
    return content.toString('utf8');
  }
  async remove(key: string): Promise<void> {
    const target = this.directory(key);
    const rel = relative(resolve(this.root), resolve(target));
    if (isAbsolute(rel) || rel.startsWith('..') || rel !== key) throw new Error('非法技能目录');
    await rm(target, { recursive: true, force: true });
  }
}
