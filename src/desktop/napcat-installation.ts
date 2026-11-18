import { spawn, type SpawnOptions } from 'node:child_process';
import { rmSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { release } from 'node:os';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import { atomicJson, readJson } from '../shared/util.js';

type Launcher = 'napcat.bat' | 'launcher.bat' | 'launcher-win10.bat';
export interface NapCatInstallationState {
  directory: string | null;
  launcher: Launcher | null;
  canStart: boolean;
  hasWebUIConfig: boolean;
  starting: boolean;
  guidance: string;
}

interface SavedInstallation {
  directory: string;
  launchedAt: number;
}
const cooldown = 45_000;

async function file(directory: string, name: string): Promise<boolean> {
  return (await lstat(join(directory, name)).catch(() => undefined))?.isFile() === true;
}

function validDirectory(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    isAbsolute(path) &&
    !path.includes('\0') &&
    (process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(path))
  );
}

// Only the Windows environment needed by QQ and the official launcher is inherited.
function launcherEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    'SystemRoot',
    'SystemDrive',
    'windir',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'USERNAME',
    'APPDATA',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'CommonProgramFiles',
    'CommonProgramFiles(x86)',
    'ALLUSERSPROFILE',
    'PUBLIC',
    'HOMEDRIVE',
    'HOMEPATH',
    'COMPUTERNAME',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  const windows = environment.SystemRoot || 'C:\\Windows';
  const system = win32.join(windows, 'System32');
  environment.ComSpec = win32.join(system, 'cmd.exe');
  const path = [
    system,
    windows,
    win32.join(system, 'Wbem'),
    win32.join(system, 'WindowsPowerShell', 'v1.0'),
  ];
  if (environment.LOCALAPPDATA)
    path.push(win32.join(environment.LOCALAPPDATA, 'Microsoft', 'WindowsApps'));
  environment.Path = path.join(';');
  environment.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  return environment;
}

async function startConsole(command: string, args: string[], options: SpawnOptions): Promise<void> {
  const child = spawn(command, args, options);
  await new Promise<void>((resolve, reject) => {
    child.once('error', () =>
      reject(new Error('无法打开 NapCat 启动窗口，请从安装目录手动启动。')),
    );
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('NapCat 启动命令失败，请从安装目录手动启动。')),
    );
  });
}

async function portInUse(directory: string, hasConfig: boolean): Promise<boolean> {
  let port = 6099;
  let host = '127.0.0.1';
  if (hasConfig) {
    const path = (await file(directory, 'config/webui.json'))
      ? join(directory, 'config', 'webui.json')
      : join(directory, 'webui.json');
    const config = await open(path, 'r');
    try {
      const stat = await config.stat();
      if (!stat.isFile() || stat.size > 128 * 1024) throw new Error();
      const value = JSON.parse((await config.readFile('utf8')).replace(/^\uFEFF/, ''));
      if (value.disableWebUI) throw new Error('disabled');
      port = value.port ?? port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
      if (['::', '::1', '[::1]'].includes(value.host)) host = '::1';
      else if (value.host && !['127.0.0.1', 'localhost', '0.0.0.0'].includes(value.host))
        throw new Error();
    } catch (error) {
      if (error instanceof Error && error.message === 'disabled')
        throw new Error('所选 NapCat 已关闭 WebUI，请先在 NapCat 配置中启用。');
      throw new Error('无法读取 NapCat WebUI 端口，请检查配置或从安装目录手动启动。');
    } finally {
      await config.close();
    }
  }
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(800, () => finish(true));
  });
}

export class NapCatInstallation {
  private readonly path: string;
  private saved?: SavedInstallation;
  private launching = false;
  private selection = 0;

  constructor(
    directory: string,
    private readonly host = { platform: process.platform, startConsole },
  ) {
    this.path = join(directory, 'napcat-installation.json');
    try {
      const saved = readJson<Partial<SavedInstallation> | null>(this.path, null);
      if (validDirectory(saved?.directory))
        this.saved = { directory: saved.directory, launchedAt: Number(saved.launchedAt) || 0 };
    } catch {
      /* A stale settings file can be replaced by selecting a directory again. */
    }
  }

  private async inspect(directory: string | null): Promise<NapCatInstallationState> {
    const state: NapCatInstallationState = {
      directory,
      launcher: null,
      canStart: false,
      hasWebUIConfig: false,
      starting: false,
      guidance: '选择已解压的 NapCat 安装目录或 config 目录。',
    };
    if (!directory) return state;
    if (!(await lstat(directory).catch(() => undefined))?.isDirectory()) {
      state.guidance = '安装目录已移动或无法读取，请重新选择。';
      return state;
    }
    const build = Number(release().split('.')[2]);
    const names: Launcher[] =
      this.host.platform === 'win32' && build < 22000
        ? ['napcat.bat', 'launcher-win10.bat', 'launcher.bat']
        : ['napcat.bat', 'launcher.bat', 'launcher-win10.bat'];
    const [found, rootConfig, directConfig, installer] = await Promise.all([
      Promise.all(names.map((name) => file(directory, name))),
      file(directory, 'config/webui.json'),
      file(directory, 'webui.json'),
      file(directory, 'NapCatInstaller.exe'),
    ]);
    state.hasWebUIConfig = rootConfig || directConfig;
    state.launcher = names.find((_, index) => found[index]) ?? null;
    const elapsed = Date.now() - (this.saved?.launchedAt || 0);
    state.starting =
      this.saved?.directory === directory &&
      (this.launching || (elapsed >= 0 && elapsed < cooldown));
    state.canStart = this.host.platform === 'win32' && !!state.launcher && !state.starting;
    if (state.starting) state.guidance = '启动窗口已请求打开。请完成 NapCat 的提示，再检查连接。';
    else if (state.canStart) state.guidance = '可在这里启动 NapCat。已经运行时可直接检查连接。';
    else if (installer)
      state.guidance =
        '请先运行 NapCatInstaller.exe 完成安装，再选择生成的 NapCat.XXXX.Shell 目录。';
    else state.guidance = '请在外部启动 NapCat，再检查连接或使用 WebUI 登录链接。';
    return state;
  }

  state(): Promise<NapCatInstallationState> {
    return this.inspect(this.saved?.directory ?? null);
  }

  clear(): Promise<NapCatInstallationState> {
    this.selection++;
    rmSync(this.path + '.bak', { force: true });
    rmSync(this.path, { force: true });
    this.saved = undefined;
    return this.state();
  }

  async select(pickedDirectory: string): Promise<NapCatInstallationState> {
    if (this.launching) throw new Error('正在打开启动窗口，请稍候。');
    const selection = ++this.selection;
    if (!validDirectory(pickedDirectory)) throw new Error('请选择本机安装目录。');
    const picked = await realpath(pickedDirectory).catch(() => '');
    if (!validDirectory(picked) || !(await lstat(picked)).isDirectory())
      throw new Error('无法读取所选目录。');
    const configPicked = basename(picked).toLowerCase() === 'config';
    const directory = configPicked ? dirname(picked) : picked;
    const info = await this.inspect(directory);
    if (
      !configPicked &&
      !info.launcher &&
      !info.hasWebUIConfig &&
      !(await file(directory, 'napcat.mjs')) &&
      !(await file(directory, 'NapCatInstaller.exe'))
    )
      throw new Error('未找到 NapCat。请选择解压后的安装目录、已安装的 Shell 目录或 config 目录。');
    if (this.launching) throw new Error('正在打开启动窗口，请稍候。');
    if (selection !== this.selection) throw new Error('所选目录已变更。');
    if (directory !== this.saved?.directory) {
      const next = { directory, launchedAt: 0 };
      atomicJson(this.path, next);
      this.saved = next;
    }
    return info;
  }

  async start(): Promise<NapCatInstallationState> {
    if (this.launching) throw new Error('启动请求正在处理。');
    const saved = this.saved;
    if (!saved) throw new Error('请先选择 NapCat 安装目录。');
    const elapsed = Date.now() - saved.launchedAt;
    if (elapsed >= 0 && elapsed < cooldown) throw new Error('启动窗口已请求打开，请先检查连接。');
    this.launching = true;
    try {
      const info = await this.inspect(saved.directory);
      if (this.host.platform !== 'win32' || !info.launcher)
        throw new Error('请从安装目录手动启动 NapCat。');
      if (await portInUse(saved.directory, info.hasWebUIConfig))
        throw new Error('WebUI 端口已在使用，请先检查连接。');
      // Resolve again on each explicit start in case the selected directory was moved or replaced.
      if (
        (await realpath(saved.directory)) !== saved.directory ||
        !(await file(saved.directory, info.launcher))
      )
        throw new Error('安装目录或启动器已变更，请重新选择。');
      if (saved !== this.saved) throw new Error('所选目录已变更。');
      const next = { ...saved, launchedAt: Date.now() };
      atomicJson(this.path, next);
      this.saved = next;
      try {
        // START opens the external interactive console. User paths are passed only as cwd.
        const env = launcherEnvironment();
        await this.host.startConsole(
          env.ComSpec!,
          ['/d', '/v:off', '/c', 'start', '""', 'cmd', '/d', '/v:off', '/c', '.\\' + info.launcher],
          {
            cwd: next.directory,
            env,
            stdio: 'ignore',
            windowsHide: true,
            windowsVerbatimArguments: true,
          },
        );
      } catch (error) {
        if (this.saved === next) {
          atomicJson(this.path, saved);
          this.saved = saved;
        }
        throw error;
      }
    } finally {
      this.launching = false;
    }
    return this.state();
  }
}
