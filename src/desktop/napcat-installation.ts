import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { rmSync } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { release, uptime } from 'node:os';
import { basename, dirname, isAbsolute, join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { atomicJson, readJson } from '../shared/util.js';
import { webUIFiles } from './napcat-location.js';

type Launcher =
  | 'napcat.bat'
  | 'launcher.bat'
  | 'launcher-win10.bat'
  | 'launcher-user.bat'
  | 'launcher-win10-user.bat';
type Status =
  'unconfigured' | 'ready' | 'starting' | 'port-in-use' | 'missing-qq' | 'manual' | 'invalid';
export interface NapCatInstallationState {
  directory: string | null;
  launcher: Launcher | null;
  canStart: boolean;
  hasWebUIConfig: boolean;
  starting: boolean;
  status: Status;
  guidance: string;
}

interface SavedInstallation {
  directory: string;
  launchedAt: number;
  launcherPid?: number;
}
const cooldown = 45_000;

async function file(directory: string, name = ''): Promise<boolean> {
  return (await lstat(join(directory, name)).catch(() => undefined))?.isFile() === true;
}

async function webUIFile(directory: string): Promise<string | undefined> {
  const paths = webUIFiles(directory);
  const present = await Promise.all(paths.map((path) => file(path)));
  return paths.find((_, index) => present[index]);
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

async function startConsole(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<number | void> {
  const child = spawn(command, args, options);
  return new Promise<number | void>((resolve, reject) => {
    child.once('error', () =>
      reject(new Error('无法打开 NapCat 启动窗口，请从安装目录手动启动。')),
    );
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

const runFile = promisify(execFile);
async function windowsQuery(script: string): Promise<string> {
  const env = launcherEnvironment();
  const executable = win32.join(
    env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const result = await runFile(
    executable,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' + script,
    ],
    {
      windowsHide: true,
      timeout: 4000,
      maxBuffer: 128 * 1024,
      env,
    },
  );
  return result.stdout.trim();
}
async function registeredQQ(): Promise<boolean> {
  // Match the uninstall entry used by the upstream non-elevated Windows launchers.
  const env = launcherEnvironment();
  const registry = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ';
  try {
    const { stdout } = await runFile(registry, ['query', key, '/v', 'UninstallString', '/reg:32'], {
      env,
      windowsHide: true,
      timeout: 4000,
      maxBuffer: 64 * 1024,
      encoding: 'buffer',
    });
    const output = stdout.toString('utf8');
    const value = /^\s*UninstallString\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im.exec(output)?.[1]?.trim();
    if (value && !value.includes('\uFFFD') && (await qqNextToUninstaller(value))) return true;
    // reg.exe may encode non-ASCII installation paths in the Windows OEM code page.
  } catch (error) {
    if ((error as { code?: number | string }).code === 1) return false;
  }
  const uninstall = await windowsQuery(
    "$ErrorActionPreference = 'Stop'; $key = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ'; " +
      'if (Test-Path -LiteralPath $key) {(Get-ItemProperty -LiteralPath $key).UninstallString}',
  );
  return qqNextToUninstaller(uninstall);
}
async function qqNextToUninstaller(uninstall: string): Promise<boolean> {
  const path =
    /^"([^"]+\.exe)"(?:\s|$)/i.exec(uninstall)?.[1] ?? /^(.+?\.exe)(?:\s|$)/i.exec(uninstall)?.[1];
  return !!path && win32.isAbsolute(path) && file(win32.dirname(path), 'QQ.exe');
}
function recordedLauncherAlive(saved: SavedInstallation): boolean {
  if (!saved.launcherPid || saved.launchedAt <= Date.now() - uptime() * 1000) return false;
  try {
    process.kill(saved.launcherPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
async function installationProcess(directory: string, saved: SavedInstallation): Promise<boolean> {
  // Only image paths are used. Neither process arguments nor account data are requested.
  const pid = saved.launcherPid;
  // Pair the pid with its creation time: Windows can reuse a pid after cmd exits.
  const owned =
    Number.isSafeInteger(pid) && Number.isSafeInteger(saved.launchedAt)
      ? '$p = Get-Process -Id ' +
        pid +
        " -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'cmd' -and [Math]::Abs(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() - " +
        saved.launchedAt +
        ") -lt 10000) { 'OWNED_LAUNCHER' }; "
      : '';
  const paths = await windowsQuery(
    owned +
      'Get-Process -Name NapCatWinBootMain,QQ,node -ErrorAction SilentlyContinue | ForEach-Object { if ($_.Path) { $_.Path } }; exit 0',
  );
  const candidates = [
    'NapCatWinBootMain.exe',
    'QQ.exe',
    'node.exe',
    'napcat/NapCatWinBootMain.exe',
    ...(basename(directory).toLowerCase() === 'napcat' ? ['../QQ.exe'] : []),
  ].map((name) => win32.join(directory, name).toLowerCase());
  return paths
    .split(/\r?\n/)
    .some((path) => path === 'OWNED_LAUNCHER' || candidates.includes(path.toLowerCase()));
}
interface LaunchHost {
  platform: NodeJS.Platform;
  build?: number;
  startConsole?: typeof startConsole;
  registeredQQ?: typeof registeredQQ;
  running?: typeof installationProcess;
  portInUse?: typeof portInUse;
}

async function portInUse(path: string | undefined): Promise<boolean> {
  let port = 6099;
  let host = '127.0.0.1';
  if (path) {
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
    socket.once('error', (error: NodeJS.ErrnoException) => {
      // Only a refused connection proves that the endpoint is free.
      finish(error.code !== 'ECONNREFUSED');
    });
    socket.setTimeout(800, () => finish(true));
  });
}

function withStatus(
  state: NapCatInstallationState,
  status: Status,
  guidance: string,
): NapCatInstallationState {
  return {
    ...state,
    status,
    guidance,
    canStart: status === 'ready',
    starting: status === 'starting',
  };
}
async function safeBatch(directory: string, name: Launcher): Promise<boolean> {
  if (name === 'launcher.bat' || name === 'launcher-win10.bat') return false;
  const handle = await open(join(directory, name), 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) return false;
    const script = await handle.readFile('utf8');
    // Some repackaged batches with a user-launcher name still request UAC or run the installer.
    return (
      !!script.trim() &&
      !script.includes('\0') &&
      !/\brun\s*as\b|\bNapCatInstaller(?:\.exe)?\b|requireAdministrator/i.test(script)
    );
  } finally {
    await handle.close();
  }
}

export class NapCatInstallation {
  private readonly path: string;
  private saved?: SavedInstallation;
  private pending?: Promise<NapCatInstallationState>;
  private selection = 0;

  constructor(
    directory: string,
    private readonly host: LaunchHost = { platform: process.platform, startConsole },
  ) {
    this.path = join(directory, 'napcat-installation.json');
    try {
      const saved = readJson<Partial<SavedInstallation> | null>(this.path, null);
      if (validDirectory(saved?.directory))
        this.saved = {
          directory: saved.directory,
          launchedAt: Number(saved.launchedAt) || 0,
          ...(Number.isSafeInteger(saved.launcherPid) && Number(saved.launcherPid) > 0
            ? { launcherPid: saved.launcherPid }
            : {}),
        };
    } catch {
      /* A stale setting can be replaced from the directory picker. */
    }
  }

  private async inspect(directory: string | null): Promise<NapCatInstallationState> {
    const state: NapCatInstallationState = {
      directory,
      launcher: null,
      canStart: false,
      hasWebUIConfig: false,
      starting: false,
      status: 'unconfigured',
      guidance: '选择已解压的 NapCat 安装目录或 config 目录。',
    };
    if (!directory) return state;
    if (!(await lstat(directory).catch(() => undefined))?.isDirectory())
      return withStatus(state, 'invalid', '安装目录已移动或无法读取，请重新选择。');
    const win10 = (this.host.build ?? Number(release().split('.')[2])) < 22000;
    const names: Launcher[] = win10
      ? [
          'napcat.bat',
          'launcher-win10-user.bat',
          'launcher-user.bat',
          'launcher-win10.bat',
          'launcher.bat',
        ]
      : [
          'napcat.bat',
          'launcher-user.bat',
          'launcher-win10-user.bat',
          'launcher.bat',
          'launcher-win10.bat',
        ];
    const [found, config, installer] = await Promise.all([
      Promise.all(names.map((name) => file(directory, name))),
      webUIFile(directory),
      file(directory, 'NapCatInstaller.exe'),
    ]);
    state.launcher = names.find((_, i) => found[i]) ?? null;
    state.hasWebUIConfig = !!config;
    try {
      if ((config || state.launcher) && (await (this.host.portInUse ?? portInUse)(config)))
        return withStatus(
          state,
          'port-in-use',
          'WebUI 端口已在使用，请检查连接以确认是否为所选 NapCat。',
        );
      const elapsed = Date.now() - (this.saved?.launchedAt || 0);
      if (this.saved?.directory === directory && elapsed >= 0 && elapsed < cooldown)
        return withStatus(state, 'starting', '已请求启动 NapCat，正在等待 WebUI。');
      if (!state.launcher || this.host.platform !== 'win32')
        return withStatus(
          state,
          'manual',
          installer
            ? '请先运行 NapCatInstaller.exe 完成安装，再选择生成的 NapCat.XXXX.Shell 目录。'
            : '请从安装目录手动启动 NapCat，再检查 WebUI 连接。',
        );
      if (!(await safeBatch(directory, state.launcher)))
        return withStatus(
          state,
          'manual',
          '当前安装包的启动器需要手动运行。请从该目录启动 NapCat，或使用包含免提权启动器的官方包。',
        );
      if (state.launcher === 'napcat.bat') {
        const [qq, node, wrapper, entry] = await Promise.all(
          ['QQ.exe', 'node.exe', 'wrapper.node', 'index.js'].map((name) => file(directory, name)),
        );
        const packagedQQ =
          qq ||
          (basename(directory).toLowerCase() === 'napcat' &&
            (await file(dirname(directory), 'QQ.exe')));
        if (!packagedQQ && !(node && wrapper && entry))
          return withStatus(
            state,
            'missing-qq',
            '此安装包缺少配套 QQ 运行文件。请使用已安装的一键包目录，或重新完整解压官方 Windows.Node 包。',
          );
      } else {
        if (!(await (this.host.registeredQQ ?? registeredQQ)()))
          return withStatus(
            state,
            'missing-qq',
            '免提权 Shell 启动器未找到已安装的 Windows QQ。请安装或修复 QQ NT 后重试；也可以选择已完成安装的 NapCat 一键包目录。',
          );
        const components = await Promise.all(
          ['napcat.mjs', 'NapCatWinBootMain.exe', 'NapCatWinBootHook.dll'].map((name) =>
            file(directory, name),
          ),
        );
        if (components.includes(false))
          return withStatus(
            state,
            'invalid',
            'Shell 运行文件不完整，请重新完整解压官方 NapCat.Shell.zip 并选择解压目录。',
          );
      }
      const saved = this.saved?.directory === directory ? this.saved : { directory, launchedAt: 0 };
      // Process enumeration is supplementary on restricted Windows installations.
      // A live recorded launcher, the grace period, and the two WebUI socket checks
      // still protect startup when PowerShell is unavailable or its probe times out.
      const running = await (this.host.running ?? installationProcess)(directory, saved).catch(() =>
        recordedLauncherAlive(saved),
      );
      if (running)
        return withStatus(
          state,
          'starting',
          '此安装目录已存在启动中的 NapCat 进程。请等待 WebUI 或检查启动窗口。',
        );
      return withStatus(state, 'ready', '可以启动所选目录中的 NapCat。');
    } catch (error) {
      const reason =
        error instanceof Error && /WebUI/.test(error.message)
          ? error.message
          : '无法检查 NapCat 的启动环境，请从安装目录手动启动或重新选择目录。';
      return withStatus(state, 'invalid', reason);
    }
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
    if (this.pending) throw new Error('正在检查启动环境，请稍候。');
    const selection = ++this.selection;
    if (!validDirectory(pickedDirectory)) throw new Error('请选择本机安装目录。');
    const picked = await realpath(pickedDirectory).catch(() => '');
    if (!validDirectory(picked) || !(await lstat(picked)).isDirectory())
      throw new Error('无法读取所选目录。');
    let directory = basename(picked).toLowerCase() === 'config' ? dirname(picked) : picked;
    if (
      basename(directory).toLowerCase() === 'napcat' &&
      (await file(dirname(directory), 'napcat.bat'))
    )
      directory = dirname(directory);
    if (
      !(await file(directory, 'napcat.bat')) &&
      (await file(directory, 'QQ.exe')) &&
      (await file(directory, 'napcat/napcat.bat'))
    )
      directory = join(directory, 'napcat');
    let info = await this.inspect(directory);
    if (!info.launcher && !info.hasWebUIConfig && !(await file(directory, 'napcat.mjs'))) {
      // Only examine named immediate package directories inside the user's selection.
      const children: string[] = [];
      let scanned = 0;
      for await (const entry of await opendir(directory)) {
        if (++scanned > 100) break;
        if (
          entry.isDirectory() &&
          /^NapCat\.(?:[\w.-]{1,64}\.)?Shell(?:\.Windows\.Node)?$/i.test(entry.name)
        )
          children.push(join(directory, entry.name));
      }
      if (children.length > 1)
        throw new Error('找到多个 NapCat Shell 目录，请直接选择要使用的那个。');
      if (children.length === 1) {
        const nested = await this.inspect(children[0]!);
        if (nested.launcher || nested.hasWebUIConfig) {
          directory = children[0]!;
          info = nested;
        }
      }
      if (!info.launcher && !info.hasWebUIConfig && !(await file(directory, 'NapCatInstaller.exe')))
        throw new Error(
          '未找到 NapCat。请选择解压后的安装目录、已安装的 Shell 目录或 config 目录。',
        );
    }
    if (this.pending || selection !== this.selection) throw new Error('所选目录已变更。');
    if (directory !== this.saved?.directory) {
      const next = { directory, launchedAt: 0 };
      atomicJson(this.path, next);
      this.saved = next;
    }
    return info;
  }

  ensureStarted(): Promise<NapCatInstallationState> {
    return this.pending ?? this.launch(true);
  }

  start(): Promise<NapCatInstallationState> {
    if (this.pending) return Promise.reject(new Error('启动请求正在处理。'));
    return this.launch(false);
  }

  private launch(automatic: boolean): Promise<NapCatInstallationState> {
    const task = this.prepareAndStart(automatic);
    this.pending = task.finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async prepareAndStart(automatic: boolean): Promise<NapCatInstallationState> {
    const saved = this.saved;
    const info = await this.inspect(saved?.directory ?? null);
    const blocked = (state: NapCatInstallationState) => {
      if (automatic) return state;
      throw new Error(state.guidance);
    };
    if (!info.canStart || !saved || !info.launcher) return blocked(info);
    if (saved !== this.saved) return blocked(await this.state());
    if (
      saved !== this.saved ||
      (await realpath(saved.directory).catch(() => '')) !== saved.directory ||
      !(await file(saved.directory, info.launcher)) ||
      !(await safeBatch(saved.directory, info.launcher))
    )
      return blocked(withStatus(info, 'invalid', '安装目录或启动器已变更，请重新选择。'));
    // An external launcher can bring up its listener during the process/QQ preflight.
    let occupied;
    try {
      occupied = await (this.host.portInUse ?? portInUse)(await webUIFile(saved.directory));
    } catch {
      return blocked(withStatus(info, 'invalid', 'WebUI 配置已变更，请检查配置后重试。'));
    }
    if (occupied)
      return blocked(
        withStatus(info, 'port-in-use', 'WebUI 端口已在使用，请检查连接以确认是否为所选 NapCat。'),
      );
    if (saved !== this.saved) return blocked(await this.state());
    const next: SavedInstallation = { directory: saved.directory, launchedAt: Date.now() };
    atomicJson(this.path, next);
    this.saved = next;
    let pid: number | void;
    try {
      // No user-controlled path is interpolated into a command; only a fixed launcher name is passed to cmd.
      const env = launcherEnvironment();
      pid = await (this.host.startConsole ?? startConsole)(
        env.ComSpec!,
        ['/d', '/v:off', '/c', '.\\' + info.launcher],
        {
          cwd: saved.directory,
          env,
          detached: true,
          stdio: 'ignore',
          windowsHide: automatic,
          windowsVerbatimArguments: true,
        },
      );
    } catch {
      if (this.saved === next) {
        atomicJson(this.path, saved);
        this.saved = saved;
      }
      return blocked(withStatus(info, 'invalid', '无法打开 NapCat 启动器，请从安装目录手动启动。'));
    }
    if (this.saved !== next) return this.state();
    if (pid) {
      next.launcherPid = pid;
      // The cooldown is already durable. A secondary metadata write failing must not undo it.
      try {
        atomicJson(this.path, next);
      } catch {
        /* Process-path detection remains available. */
      }
    }
    return withStatus(info, 'starting', '已请求启动 NapCat，正在等待 WebUI。');
  }
}
