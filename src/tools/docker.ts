import http from 'node:http';
import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppConfig } from '../shared/types.js';
import { checkAbort, digest } from '../shared/util.js';
import { packTar, safeArchiveName, unpackTar } from './archive.js';

export class DockerApi {
  private agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  constructor(
    private socketPath = process.platform === 'win32'
      ? '\\\\.\\pipe\\docker_engine'
      : '/var/run/docker.sock',
    private testPort?: number,
  ) {}
  request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    maxBytes = 1024 * 1024,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const data =
        body === undefined
          ? undefined
          : Buffer.isBuffer(body)
            ? body
            : Buffer.from(JSON.stringify(body));
      const request = http.request(
        {
          ...(this.testPort
            ? { host: '127.0.0.1', port: this.testPort }
            : { socketPath: this.socketPath }),
          agent: this.agent,
          method,
          path,
          signal,
          timeout: 65000,
          headers: data
            ? {
                'Content-Type': Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json',
                'Content-Length': data.length,
              }
            : {},
        },
        (response) => {
          const parts: Buffer[] = [];
          let size = 0;
          response.on('data', (b: Buffer) => {
            size += b.length;
            if (size > maxBytes) {
              response.destroy(new Error('Docker 输出超过限制'));
              return;
            }
            parts.push(b);
          });
          response.on('error', reject);
          response.on('end', () => {
            const bytes = Buffer.concat(parts);
            if ((response.statusCode ?? 500) >= 300) {
              reject(
                new Error(
                  'Docker HTTP ' +
                    response.statusCode +
                    ': ' +
                    bytes.toString('utf8').slice(0, 150),
                ),
              );
              return;
            }
            resolve(bytes);
          });
        },
      );
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('Docker 操作超时')));
      request.end(data);
    });
  }
  async json<T = any>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await this.request(method, path, body, signal);
    return result.length ? JSON.parse(result.toString('utf8')) : (undefined as T);
  }
  close(): void {
    this.agent.destroy();
  }
}
export function sandboxSpecification(
  imageId: string,
  language: 'javascript' | 'python',
  code: string,
  owner: string,
  limits: AppConfig['sandbox'],
): Record<string, unknown> {
  return {
    Image: imageId,
    Cmd:
      language === 'python'
        ? ['python3', '-I', '-c', code]
        : ['node', '--disable-proto=throw', '--eval', code],
    User: '10001:10001',
    WorkingDir: '/workspace',
    NetworkDisabled: true,
    AttachStdout: false,
    AttachStderr: false,
    Tty: false,
    Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/tmp', 'LANG=C.UTF-8', 'PYTHONUNBUFFERED=1'],
    Labels: { 'org.chatds.owner': owner, 'org.chatds.job': '1' },
    HostConfig: {
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      NetworkMode: 'none',
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: limits.memoryMb * 1024 * 1024,
      MemorySwap: limits.memoryMb * 1024 * 1024,
      NanoCpus: Math.floor(limits.cpus * 1e9),
      PidsLimit: limits.pids,
      Mounts: [{ Type: 'volume', Target: '/workspace', VolumeOptions: { NoCopy: false } }],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '256k', 'max-file': '1' } },
    },
  };
}
export function decodeDockerLogs(buffer: Buffer): { stdout: string; stderr: string } {
  let offset = 0;
  const out: Buffer[] = [],
    err: Buffer[] = [];
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new Error('Docker 日志帧不完整');
    const stream = buffer[offset],
      size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buffer.length) throw new Error('Docker 日志长度无效');
    (stream === 2 ? err : out).push(buffer.subarray(offset, offset + size));
    offset += size;
  }
  return {
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}
export class DockerSandbox {
  private owned = new Set<string>();
  private runningJobs = 0;
  private imageId?: string;
  state: { available: boolean; reason?: string } = { available: false, reason: '尚未检查 Docker' };
  readonly owner: string;
  constructor(
    private config: () => AppConfig['sandbox'],
    profileDirectory: string,
    private api = new DockerApi(),
  ) {
    this.owner = digest(profileDirectory).slice(0, 24);
  }
  async check(): Promise<{ available: boolean; reason?: string }> {
    try {
      const signal = AbortSignal.timeout(5000);
      const info = await this.api.json('GET', '/info', undefined, signal);
      if (info.OSType !== 'linux') throw new Error('需要 Docker 的 Linux 容器模式');
      const image = await this.api.json(
        'GET',
        '/images/' + encodeURIComponent(this.config().image) + '/json',
        undefined,
        signal,
      );
      if (
        image.Config?.Labels?.['org.chatds.sandbox.version'] !== '1' ||
        !/^sha256:[a-f0-9]{64}$/.test(image.Id)
      )
        throw new Error('请按说明构建 ChatDS 专用沙箱镜像');
      this.imageId = image.Id;
      this.state = { available: true };
    } catch (e) {
      this.imageId = undefined;
      this.state = {
        available: false,
        reason:
          'Docker 或专用镜像不可用：' + (e instanceof Error ? e.message : String(e)).slice(0, 180),
      };
    }
    return { ...this.state };
  }
  async reap(): Promise<void> {
    try {
      if (this.runningJobs) return;
      const rows = await this.api.json<{ Id: string }[]>(
        'GET',
        '/containers/json?all=1&filters=' +
          encodeURIComponent(
            JSON.stringify({ label: ['org.chatds.owner=' + this.owner, 'org.chatds.job=1'] }),
          ),
        undefined,
        AbortSignal.timeout(3000),
      );
      // A create request may already have reached Docker before its ID comes back to this process.
      if (this.runningJobs) return;
      for (const r of rows) {
        this.owned.add(r.Id);
        await this.remove(r.Id);
      }
    } catch {
      /* Rechecked when Docker becomes available; never touches another application's containers. */
    }
  }
  private async snapshot(directory: string): Promise<{ name: string; data: Buffer }[]> {
    const files: { name: string; data: Buffer }[] = [];
    let bytes = 0;
    const walk = async (dir: string) => {
      for (const f of await readdir(dir, { withFileTypes: true })) {
        if (f.name.startsWith('.')) continue;
        const full = join(dir, f.name),
          stat = await lstat(full),
          name = relative(directory, full).replaceAll('\\', '/');
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
          throw new Error('沙箱输入不允许链接');
        if (f.isDirectory()) {
          if (name.split('/').length > 5) throw new Error('工作区目录过深');
          await walk(full);
        } else if (f.isFile()) {
          if (
            !safeArchiveName(name) ||
            files.length >= 100 ||
            (bytes += stat.size) > 8 * 1024 * 1024
          )
            throw new Error('沙箱输入最多 100 个文件、8 MiB');
          files.push({ name, data: await readFile(full) });
        }
      }
    };
    await walk(directory);
    return files;
  }
  async execute(
    directory: string,
    args: { language: 'javascript' | 'python'; code: string; outputs?: string[] },
    signal: AbortSignal,
  ): Promise<unknown> {
    checkAbort(signal);
    if (!this.imageId || !this.state.available)
      throw new Error(this.state.reason ?? 'Docker 不可用');
    if (!['javascript', 'python'].includes(args.language) || args.code.length > 30000)
      throw new Error('沙箱代码或语言无效');
    if ((args.outputs ?? []).some((p) => !safeArchiveName(p)) || (args.outputs?.length ?? 0) > 5)
      throw new Error('导出路径无效');
    const limits = this.config(),
      scope = AbortSignal.any([signal, AbortSignal.timeout(limits.timeoutMs)]);
    let container: string | undefined;
    this.runningJobs++;
    try {
      const inputs = await this.snapshot(directory);
      checkAbort(scope);
      const response = await this.api.json<{ Id: string }>(
        'POST',
        '/containers/create?name=chatds-' + randomUUID(),
        sandboxSpecification(this.imageId, args.language, args.code, this.owner, limits),
        scope,
      );
      container = response.Id;
      if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Docker 返回了无效容器编号');
      this.owned.add(container);
      if (inputs.length)
        await this.api.request(
          'PUT',
          `/containers/${container}/archive?path=/workspace`,
          packTar(inputs),
          scope,
        );
      await this.api.request('POST', `/containers/${container}/start`, undefined, scope);
      const result = await this.api.json<{ StatusCode: number; Error?: { Message: string } }>(
        'POST',
        `/containers/${container}/wait?condition=not-running`,
        undefined,
        scope,
      );
      const logs = decodeDockerLogs(
        await this.api.request(
          'GET',
          `/containers/${container}/logs?stdout=1&stderr=1`,
          undefined,
          scope,
          65536,
        ),
      );
      const outputs: { path: string; text?: string; bytes: number; sha256: string }[] = [];
      for (const file of args.outputs ?? []) {
        const archive = await this.api.request(
          'GET',
          `/containers/${container}/archive?path=${encodeURIComponent('/workspace/' + file)}`,
          undefined,
          scope,
          70000,
        );
        const entries = unpackTar(archive);
        if (entries.length !== 1) throw new Error('只支持导出单个普通文件');
        const data = entries[0]!.data;
        outputs.push({
          path: file,
          text: data.includes(0) ? undefined : data.toString('utf8').slice(0, 30000),
          bytes: data.length,
          sha256: createHash('sha256').update(data).digest('hex'),
        });
      }
      return {
        ...logs,
        exitCode: result.StatusCode,
        outputs,
        note: '沙箱文件为临时副本；写回工作区仍需 write_file 确认。',
      };
    } finally {
      try {
        if (container && this.owned.has(container)) await this.remove(container);
      } finally {
        this.runningJobs--;
      }
    }
  }
  private async remove(container: string): Promise<void> {
    if (!this.owned.has(container)) throw new Error('容器不属于当前应用');
    await this.api
      .request(
        'DELETE',
        `/containers/${container}?force=1&v=1`,
        undefined,
        AbortSignal.timeout(5000),
      )
      .catch((e) => {
        if (!String(e).includes('HTTP 404')) throw new Error('沙箱清理未确认，请重新检查 Docker');
      });
    this.owned.delete(container);
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.owned].map((c) => this.remove(c)));
    this.api.close();
  }
  get stats() {
    return { containers: this.owned.size };
  }
}
