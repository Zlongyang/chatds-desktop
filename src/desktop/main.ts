import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
  utilityProcess,
} from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, stat, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ConfigStore } from './config-store.js';
import { Vault } from './vault.js';
import { ModelHost, keyReference } from './model.js';
import { TestModelHost } from './test-model.js';
import { NapCatSession } from './napcat.js';
import { NapCatInstallation } from './napcat-installation.js';
import { installNapCatPackage } from './napcat-package.js';
import { takeInstallerChoice } from './installer-choice.js';
import { setTimeout as delay } from 'node:timers/promises';
import { locationFromFolder, locationFromLink } from './napcat-location.js';
import { ModelVerification, probeModel } from './model-verification.js';
import { RpcPeer } from '../shared/rpc.js';
import { boundText, id } from '../shared/util.js';
import { FriendRequests } from './friend-requests.js';
import {
  conversationSchema,
  errorText,
  modelSchema,
  validateConversationId,
} from '../shared/config.js';
import type {
  Activity,
  AppSnapshot,
  MessageEnvelope,
  RuntimeEvent,
  SettingsChange,
  ToolId,
} from '../shared/types.js';
import { OneBot } from '../connectors/onebot.js';
import { conversationsToStop } from '../runtime/policy.js';
import { SkillRegistry } from '../tools/skills.js';
import { DockerSandbox } from '../tools/docker.js';
import { ToolBroker } from '../tools/broker.js';

const here = dirname(fileURLToPath(import.meta.url));
const requestedData = process.env.CHATDS_TEST_DATA;
const isTest =
  process.env.CHATDS_TEST_MODE === '1' &&
  !!requestedData &&
  relative(resolve(tmpdir()), resolve(requestedData)).startsWith('chatds-test-') &&
  !relative(resolve(tmpdir()), resolve(requestedData)).includes('..');
if (process.env.CHATDS_TEST_MODE === '1' && !isTest)
  throw new Error('测试模式必须使用操作系统临时目录中的 chatds-test-* 目录');
app.setPath('userData', isTest ? resolve(requestedData!) : join(app.getPath('appData'), 'ChatDS'));
if (!app.requestSingleInstanceLock()) app.quit();
else
  void app
    .whenReady()
    .then(start)
    .catch((error) => {
      if (isTest && process.env.CHATDS_SMOKE_REPORT) {
        console.error('ChatDS smoke check:', errorText(error));
        app.exit(1);
        return;
      }
      dialog.showErrorBox('ChatDS 启动失败', errorText(error));
      app.quit();
    });

async function start(): Promise<void> {
  const directory = app.getPath('userData');
  mkdirSync(directory, { recursive: true });
  const config = new ConfigStore(directory);
  if (isTest) {
    config.value.memory.automatic = false;
    config.value.model.keyRequired = false;
    config.value.onebot.enabled = false;
    config.value.model.model = 'fixture';
  }
  const vault = new Vault(directory, safeStorage);
  const verification = new ModelVerification(directory);
  const installation = new NapCatInstallation(directory);
  let napcatInstall = await installation.state();
  const napcatSetup: AppSnapshot['napcatSetup'] = { busy: false, received: 0, total: 0 };
  let installing: AbortController | undefined;
  const installationView = (): AppSnapshot['napcatInstallation'] =>
    napcatInstall.directory
      ? {
          directory: napcatInstall.directory,
          canLaunch: napcatInstall.canStart,
          available: !!napcatInstall.launcher || napcatInstall.hasWebUIConfig,
          guidance: napcatInstall.guidance,
          status: napcatInstall.status,
        }
      : null;
  const onebot = new OneBot(
    () => config.value.onebot,
    () => vault.get('onebot'),
  );
  const skills = new SkillRegistry(join(directory, 'skills'));
  const sandbox = new DockerSandbox(() => config.value.sandbox, directory);
  const sourceCache = new Map<string, MessageEnvelope>();
  let readOnly: DatabaseSync | undefined;
  const lookup = (key: string): MessageEnvelope | undefined => {
    const cached = sourceCache.get(key);
    if (cached) return cached;
    try {
      readOnly ??= new DatabaseSync(join(directory, 'chatds.sqlite'), { readOnly: true });
      const row = readOnly
        .prepare('SELECT envelope FROM messages WHERE id=? AND excluded=0')
        .get(key) as { envelope: string } | undefined;
      return row ? JSON.parse(row.envelope) : undefined;
    } catch {
      return undefined;
    }
  };
  const broker = new ToolBroker(directory, () => config.value, skills, sandbox, lookup, onebot);
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i.test(key),
    ),
  ) as Record<string, string>;
  const child = utilityProcess.fork(join(here, '../runtime/worker.js'), [], {
    env: cleanEnvironment,
    serviceName: 'ChatDS Runtime',
    stdio: 'pipe',
  });
  const peer = new RpcPeer((packet) => child.postMessage(packet));
  child.on('message', (message) => peer.receive(message));
  let quitting = false,
    finished = false;
  let win: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let stateTimer: ReturnType<typeof setTimeout> | undefined;
  let activitySeq = 0;
  const activities: Activity[] = [];
  let logTail = Promise.resolve(),
    queuedLogs = 0;
  const log = (text: string, room?: string) => {
    const safe = errorText(text);
    const entry: Activity = {
      id: String(++activitySeq),
      timestamp: Date.now(),
      text: safe,
      type: 'activity',
      conversationId: room,
    };
    activities.push(entry);
    if (activities.length > 200) activities.shift();
    // Small bounded operational log; never records prompts, credentials or complete tool payloads.
    if (queuedLogs < 100) {
      queuedLogs++;
      logTail = logTail
        .then(async () => {
          const file = join(directory, 'activity.log');
          if (((await stat(file).catch(() => undefined))?.size ?? 0) > 1024 * 1024) {
            await rm(file + '.1', { force: true });
            await rename(file, file + '.1');
          }
          await appendFile(file, JSON.stringify(entry) + '\n');
        })
        .catch(() => {})
        .finally(() => {
          queuedLogs--;
        });
    }
  };
  const notify = (event?: RuntimeEvent) => {
    if (win && !win.isDestroyed() && event) win.webContents.send('chatds:event', event);
    if (!stateTimer) {
      stateTimer = setTimeout(() => {
        stateTimer = undefined;
        if (win && !win.isDestroyed())
          win.webContents.send('chatds:event', {
            seq: ++activitySeq,
            timestamp: Date.now(),
            type: 'change',
            data: null,
          });
      }, 150);
      stateTimer.unref();
    }
  };
  const model = isTest ? new TestModelHost() : new ModelHost(() => config.value.model, vault);
  const checkReady = () => {
    if (quitting) throw new Error('应用正在退出');
  };
  peer.handle('run.register', (p) => broker.register(p.runId, p.sourceIds, p.conversationId));
  peer.handle('run.capabilities', (p) => broker.snapshot(p.runId));
  peer.handle('run.finish', (p) => {
    broker.finish(p.runId);
    return true;
  });
  peer.handle('model.stream', async (p, signal) => {
    broker.context(p.runId);
    if (typeof p.streamId !== 'string' || JSON.stringify(p.context).length > 500000)
      throw new Error('模型请求无效');
    const runSignal = broker.signal(p.runId);
    return model.stream(
      { context: p.context, budget: p.budget, thinking: p.thinking },
      (event) => peer.notify('model.event', { streamId: p.streamId, event }),
      AbortSignal.any([signal, runSignal]),
    );
  });
  peer.handle('tool.execute', (p, signal) =>
    broker.execute(p.runId, p.tool as ToolId, p.args, signal),
  );
  const delivered = new Map<string, string>();
  peer.handle('reply.send', async (p, signal) => {
    const context = broker.context(p.runId);
    if (!config.value.enabled) throw new Error('回复已暂停');
    if (typeof p.outboxId !== 'string' || typeof p.text !== 'string' || p.text.length > 6000)
      throw new Error('回复参数无效');
    if (delivered.has(p.outboxId)) return delivered.get(p.outboxId)!;
    const result = await onebot.send(
      context.conversationId,
      p.text,
      AbortSignal.any([signal, broker.signal(p.runId)]),
    );
    delivered.set(p.outboxId, result);
    while (delivered.size > 1000) delivered.delete(delivered.keys().next().value!);
    return result;
  });
  peer.on('runtime.event', (event: RuntimeEvent) => {
    if (event.type === 'activity')
      log(String((event.data as { text: string })?.text ?? ''), event.conversationId);
    if (event.type !== 'change') notify(event);
    else notify();
  });
  broker.on('change', () => notify());
  broker.on('approval', (view) =>
    notify({
      seq: ++activitySeq,
      timestamp: Date.now(),
      type: 'phase',
      conversationId: view.conversationId,
      runId: view.runId,
      data: { phase: 'approval' },
    }),
  );
  await peer.call('initialize', { directory, config: config.value, testMode: isTest });
  const accept = async (message: MessageEnvelope) => {
    sourceCache.set(message.id, message);
    while (sourceCache.size > 10000) sourceCache.delete(sourceCache.keys().next().value!);
    return peer.call('ingest', message);
  };
  onebot.on('status', () => notify());
  onebot.on(
    'message',
    (raw) =>
      void (async () => {
        const message = await onebot.normalize(raw);
        if (!message) return;
        if (message.actorId === 'owner' && /^\/(?:停止|stop)(?:\s|$)/i.test(message.text)) {
          broker.cancel();
          await peer.call('stop', {});
          return;
        }
        if (message.actorId === 'owner' && /^\/(?:状态|status)\s*$/i.test(message.text)) {
          await onebot.send(
            message.conversationId,
            `ChatDS：${config.value.enabled ? '运行中' : '已暂停回复'}；${config.value.conversations[message.conversationId]?.mode === 'assistant' ? '受控助理' : '纯陪伴'}。权限请在桌面查看与修改。`,
          );
          return;
        }
        await accept(message);
      })().catch((e) => log(errorText(e))),
  );
  const friends = new FriendRequests(join(directory, 'friend-requests.json'), () =>
    onebot.status === 'online' && onebot.account === config.value.onebot.botQQ
      ? onebot.account
      : undefined,
  );
  onebot.on('request', (raw) => {
    if (raw.request_type !== 'friend') return;
    friends.receive(
      String(raw.self_id),
      String(raw.user_id),
      String(raw.flag ?? ''),
      String(raw.comment ?? ''),
    );
    notify();
  });
  const snapshot = async (): Promise<AppSnapshot> => {
    const runtime = await peer.call<{
      rooms: AppSnapshot['rooms'];
      memoryCount: number;
      usage: AppSnapshot['usage'];
    }>('state', {});
    return {
      config: structuredClone(config.value),
      keyConfigured: !!vault.get(keyReference(config.value.model)),
      modelVerified: verification.verified(config.value.model),
      napcatInstallation: installationView(),
      napcatSetup: { ...napcatSetup },
      onebotTokenConfigured: !!vault.get('onebot'),
      vaultAvailable: vault.available,
      connection: onebot.status,
      account: onebot.account,
      rooms: runtime.rooms,
      memoryCount: runtime.memoryCount,
      usage: runtime.usage,
      approvals: broker.pendingApprovals,
      activities: activities.slice(-100),
      sandbox: { ...sandbox.state },
      testMode: isTest,
      friendRequests: friends.list(),
      loginStartup: app.getLoginItemSettings().openAtLogin,
    };
  };
  async function confirmOwner(previous: string, owner: string) {
    if (previous && previous !== owner) {
      const answer = await dialog.showMessageBox(win!, {
        type: 'question',
        message: '更换主号 QQ？',
        detail: '新的主号会与桌面使用同一份个人记忆和工作区。请确认这个账号属于你本人。',
        buttons: ['取消', '确认更换'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response !== 1) throw new Error('已取消更换主号');
    }
  }
  const applySettings = async (change: SettingsChange, confirmedOwner?: string) => {
    const before = structuredClone(config.value),
      next = change.config ? config.preview(change.config) : config.value;
    if (next.onebot.ownerQQ !== before.onebot.ownerQQ && confirmedOwner !== before.onebot.ownerQQ) {
      await confirmOwner(before.onebot.ownerQQ, next.onebot.ownerQQ);
      if (config.value.revision !== before.revision) throw new Error('设置已更新，请重新保存。');
    }
    if (before.onebot.url !== next.onebot.url && !change.onebotToken?.trim() && vault.get('onebot'))
      throw new Error('连接地址已更换，请输入新地址的 Access Token。');
    const secrets: Record<string, string | undefined> = {};
    if (change.apiKey?.trim() || change.clearApiKey)
      secrets[keyReference(next.model)] = change.clearApiKey ? undefined : change.apiKey!.trim();
    if (change.onebotToken?.trim() || change.clearOnebotToken)
      secrets.onebot = change.clearOnebotToken ? undefined : change.onebotToken!.trim();
    for (const [reference, value] of Object.entries(secrets)) {
      if (value === vault.get(reference)) delete secrets[reference];
    }
    const configChanged = !isDeepStrictEqual(before, { ...next, revision: before.revision });
    if (!configChanged && Object.keys(secrets).length === 0) return;
    if (!isDeepStrictEqual(before.model, next.model) || keyReference(next.model) in secrets)
      verification.invalidate();
    if (Object.keys(secrets).length) vault.setMany(secrets);
    if (configChanged) config.commit(next);
    const affected = conversationsToStop(before, next);
    if (affected === 'all' || Object.keys(secrets).length) broker.permissionsChanged();
    else for (const room of affected) broker.cancel(room);
    await peer.call('configure', config.value);
    if (
      (['enabled', 'url', 'botQQ', 'ownerQQ'] as const).some(
        (k) => before.onebot[k] !== next.onebot[k],
      ) ||
      Object.hasOwn(secrets, 'onebot')
    ) {
      onebot.stop();
      if (config.value.onebot.enabled && !isTest) onebot.start();
    }
    notify();
  };
  let pairing:
    | { id: string; client?: NapCatSession; botQQ?: string; busy: boolean; expiry?: NodeJS.Timeout }
    | undefined;
  function closePairing() {
    clearTimeout(pairing?.expiry);
    pairing?.client?.close();
    pairing = undefined;
  }
  function activePairing(key: unknown) {
    if (!pairing?.client || pairing.id !== key) throw new Error('本次扫码已结束，请重新开始。');
    return { slot: pairing, client: pairing.client };
  }
  let sandboxProbe: Promise<typeof sandbox.state> | undefined;
  function checkSandbox() {
    sandboxProbe ??= sandbox
      .check()
      .then(async (result) => {
        if (result.available) await sandbox.reap();
        return result;
      })
      .finally(() => {
        sandboxProbe = undefined;
        notify();
      });
    return sandboxProbe;
  }
  if (config.value.tools.sandbox_exec) void checkSandbox();
  async function installPackage(archive?: string) {
    if (installing) throw new Error('NapCat 安装正在进行。');
    const controller = new AbortController();
    installing = controller;
    Object.assign(napcatSetup, { busy: true, received: 0, total: 0, error: undefined });
    notify();
    try {
      const folder = await installNapCatPackage(directory, {
        archive,
        signal: controller.signal,
        onProgress(received, total) {
          Object.assign(napcatSetup, { received, total });
          notify();
        },
      });
      controller.signal.throwIfAborted();
      napcatInstall = await installation.select(folder);
      closePairing();
      napcatInstall = await installation.ensureStarted();
      return installationView();
    } catch (error) {
      napcatSetup.error = controller.signal.aborted ? '已取消安装。' : errorText(error);
      throw new Error(napcatSetup.error);
    } finally {
      installing = undefined;
      napcatSetup.busy = false;
      notify();
    }
  }
  const handlers: Record<string, (...args: any[]) => unknown | Promise<unknown>> = {
    state: () => snapshot(),
    configure: async (input: unknown) => {
      const change = z
        .object({
          config: z.record(z.string(), z.unknown()).optional(),
          apiKey: z.string().max(1000).optional(),
          clearApiKey: z.boolean().optional(),
          onebotToken: z.string().max(1000).optional(),
          clearOnebotToken: z.boolean().optional(),
        })
        .strict()
        .parse(input) as SettingsChange;
      await applySettings(change);
      return snapshot();
    },
    napcatGuide: () =>
      shell.openExternal(
        'https://github.com/NapNeko/NapCatQQ/blob/9335843246e3b7a17944861f3ac8731a259732c2/LICENSE',
      ),
    openQQDownload: () => shell.openExternal('https://im.qq.com/pcqq/index.shtml'),
    napcatCancelInstall: () => installing?.abort(),
    napcatInstallPackage: async (source: unknown) => {
      z.enum(['download', 'archive']).parse(source);
      if (source === 'download') return installPackage();
      const chosen = await dialog.showOpenDialog(win!, {
        title: '选择 NapCat.Shell.zip',
        properties: ['openFile'],
        filters: [{ name: 'NapCat Shell', extensions: ['zip'] }],
      });
      if (chosen.canceled) return null;
      return installPackage(chosen.filePaths[0]);
    },
    napcatChooseInstallation: async () => {
      if (installing) throw new Error('请先等待 NapCat 安装结束。');
      const chosen = await dialog.showOpenDialog(win!, {
        title: '选择本机 NapCat 安装目录',
        properties: ['openDirectory'],
        ...(napcatInstall.directory ? { defaultPath: napcatInstall.directory } : {}),
      });
      if (chosen.canceled) return null;
      napcatInstall = await installation.select(chosen.filePaths[0]!);
      napcatSetup.error = undefined;
      closePairing();
      napcatInstall = await installation.ensureStarted();
      notify();
      return installationView();
    },
    napcatForgetInstallation: async () => {
      if (installing) throw new Error('请先取消正在进行的安装。');
      napcatInstall = await installation.clear();
      napcatSetup.error = undefined;
      closePairing();
      notify();
    },
    napcatLaunch: async () => {
      napcatInstall = await installation.start();
      notify();
    },
    napcatCheck: async () => {
      napcatInstall = await installation.state();
      notify();
      if (!napcatInstall.directory) return { online: false, detail: '请先选择 NapCat 安装目录。' };
      let client: NapCatSession | undefined;
      try {
        const location = await locationFromFolder(napcatInstall.directory);
        client = new NapCatSession(location.origin, location.token);
        await client.checkWebUI();
        return { online: true, detail: 'WebUI 已连接。可以继续登录 QQ。' };
      } catch (error) {
        return { online: false, detail: errorText(error) };
      } finally {
        client?.close();
      }
    },
    napcatBegin: async (key: unknown, link?: unknown) => {
      const sessionId = z.string().uuid().parse(key);
      closePairing();
      const slot: NonNullable<typeof pairing> = { id: sessionId, busy: true };
      pairing = slot;
      try {
        let location;
        if (link === undefined) {
          let folder = napcatInstall.directory;
          if (!folder) {
            const picked = await dialog.showOpenDialog(win!, {
              title: '选择已启动的 NapCat 目录',
              properties: ['openDirectory'],
            });
            if (picked.canceled) {
              if (pairing === slot) closePairing();
              return null;
            }
            folder = picked.filePaths[0]!;
          }
          napcatInstall = await installation.ensureStarted();
          notify();
          const deadline =
            Date.now() +
            (napcatInstall.status === 'starting' || napcatInstall.status === 'port-in-use'
              ? 60000
              : 0);
          for (;;) {
            if (pairing !== slot || quitting) throw new Error('本次扫码已取消。');
            try {
              location = await locationFromFolder(folder);
              slot.client = new NapCatSession(location.origin, location.token);
              await slot.client.checkWebUI();
              break;
            } catch (error) {
              slot.client?.close();
              slot.client = undefined;
              if (Date.now() >= deadline || !/无法连接本机|没有 webui\.json/.test(errorText(error)))
                throw new Error(
                  napcatInstall.status === 'missing-qq' ? napcatInstall.guidance : errorText(error),
                );
              await delay(850);
            }
          }
        } else location = locationFromLink(link);
        if (pairing !== slot) throw new Error('本次扫码已取消。');
        slot.client ??= new NapCatSession(location.origin, location.token);
        slot.expiry = setTimeout(closePairing, 10 * 60 * 1000);
        slot.expiry.unref();
        const status = await slot.client.status();
        slot.botQQ = status.botQQ;
        return status;
      } catch (error) {
        if (pairing === slot) closePairing();
        throw error;
      } finally {
        slot.busy = false;
      }
    },
    napcatPoll: async (key: unknown, renew = false) => {
      const { slot, client } = activePairing(key);
      if (slot.busy) throw new Error('正在读取登录状态，请稍候。');
      slot.busy = true;
      try {
        const status = await (renew === true ? client.refresh() : client.status());
        slot.botQQ = status.botQQ;
        return status;
      } finally {
        slot.busy = false;
      }
    },
    napcatCancel: (key: unknown) => {
      if (pairing?.id === key) closePairing();
    },
    napcatBind: async (key: unknown, replaceAccount = false) => {
      const { slot, client } = activePairing(key);
      if (slot.busy) throw new Error('正在处理扫码登录，请稍候。');
      if (!slot.botQQ) throw new Error('请先完成扫码登录。');
      const previousBot = config.value.onebot.botQQ;
      const switching = !!previousBot && previousBot !== slot.botQQ;
      if (switching && replaceAccount !== true)
        throw new Error('登录的是另一个 QQ。请核对手机账号，或点击「更换登录账号」。');
      if (!vault.available) throw new Error('无法加密保存连接令牌，请检查本机凭据库。');
      slot.busy = true;
      try {
        const before = JSON.stringify(config.value.onebot),
          previousOwner = config.value.onebot.ownerQQ;
        const check = () => {
          if (pairing !== slot || before !== JSON.stringify(config.value.onebot))
            throw new Error('连接设置已变化，请重新扫码。');
        };
        if (switching) {
          const answer = await dialog.showMessageBox(win!, {
            type: 'question',
            message: '更换小鱼登录的 QQ？',
            detail: '新账号会重新设置主号和聊天名单。',
            buttons: ['取消', '更换账号'],
            defaultId: 0,
            cancelId: 0,
          });
          if (answer.response !== 1) throw new Error('已取消更换 QQ。');
        }
        check();
        const connection = await client.provision(slot.botQQ);
        check();
        if (connection.botQQ !== slot.botQQ)
          throw new Error('NapCat 登录账号已更换，请重新扫码确认。');
        await applySettings(
          {
            config: {
              onebot: {
                ...config.value.onebot,
                enabled: true,
                url: connection.url,
                botQQ: connection.botQQ,
                ...(switching ? { ownerQQ: '', users: [], groups: [] } : {}),
                friendChats: !previousBot || switching ? true : config.value.onebot.friendChats,
              },
            },
            onebotToken: connection.token,
          },
          previousOwner,
        );
        onebot.start();
        if (pairing === slot) closePairing();
      } finally {
        slot.busy = false;
      }
    },
    chat: async (input: unknown) => {
      if (!config.value.enabled) throw new Error('请先恢复回复');
      const text = boundText(input);
      await accept({
        id: id(),
        conversationId: 'desktop:owner',
        channel: 'desktop',
        actorId: 'owner',
        displayName: '你',
        text,
        timestamp: Date.now(),
        isGroup: false,
        trigger: 'direct',
        mention: false,
      });
    },
    history: (room: unknown, before?: unknown, limit?: unknown) =>
      peer.call('history', {
        id: validateConversationId(z.string().parse(room)),
        before: before === undefined ? undefined : z.number().int().positive().parse(before),
        limit: limit === undefined ? undefined : z.number().int().min(1).max(101).parse(limit),
      }),
    conversation: async (room: unknown, patch: unknown) => {
      const key = validateConversationId(z.string().parse(room));
      const value = conversationSchema.partial().parse(patch);
      await applySettings({
        config: {
          conversations: {
            ...config.value.conversations,
            [key]: {
              mode: 'companion',
              ambient: false,
              muted: false,
              ...config.value.conversations[key],
              ...value,
            },
          },
        },
      });
    },
    stop: async (room?: unknown) => {
      const key = room === undefined ? undefined : validateConversationId(z.string().parse(room));
      broker.cancel(key);
      await peer.call('stop', { conversationId: key });
      notify();
    },
    memories: (scope?: unknown) =>
      peer.call('memories', {
        scope: scope === undefined ? undefined : z.string().max(200).parse(scope),
      }),
    forget: async (key: unknown) => {
      broker.cancel();
      await peer.call('forget', { id: z.string().uuid().parse(key) });
      notify();
    },
    approve: (key: unknown, allow: unknown) => {
      broker.answer(z.string().uuid().parse(key), z.boolean().parse(allow));
      notify();
    },
    modelTest: () =>
      verification.run(config.value.model, () => probeModel(model)).finally(() => notify()),
    testAndSaveModel: async (profile: unknown, rawKey?: unknown) => {
      const draft = modelSchema.parse(profile);
      const key = z.string().max(1000).optional().parse(rawKey)?.trim();
      const reference = keyReference(draft);
      const storedKey = vault.get(reference);
      const credential = key || storedKey;
      if (draft.keyRequired && !credential) throw new Error('请输入这个模型接口的 API Key。');
      if (key && !vault.available) throw new Error('本机凭据加密不可用，无法保存 API Key。');
      const active = config.value.model;
      const activeKey = vault.get(keyReference(active));
      if (
        isDeepStrictEqual(active, draft) &&
        storedKey === credential &&
        verification.verified(draft)
      )
        return snapshot();
      const candidate = isTest
        ? new TestModelHost(draft.model)
        : new ModelHost(() => draft, { get: () => credential });
      const outcome = await probeModel(candidate);
      if (!outcome.ok) throw new Error(outcome.detail);
      if (
        !isDeepStrictEqual(active, config.value.model) ||
        activeKey !== vault.get(keyReference(active)) ||
        storedKey !== vault.get(reference)
      )
        throw new Error('测试期间模型配置已更改，请重新测试。');
      await applySettings({ config: { model: draft }, ...(key ? { apiKey: key } : {}) });
      if (!isDeepStrictEqual(draft, config.value.model) || credential !== vault.get(reference))
        throw new Error('模型配置已更改，请重新测试。');
      verification.saveSuccess(draft);
      notify();
      return snapshot();
    },
    connect: () => {
      onebot.start();
      notify();
    },
    disconnect: () => {
      onebot.stop();
      notify();
    },
    sandboxCheck: checkSandbox,
    skills: () => skills.list(),
    chooseSkill: async () => {
      const chosen = await dialog.showOpenDialog(win!, {
        title: '选择包含 SKILL.md 的技能目录',
        properties: ['openDirectory'],
      });
      if (!chosen.canceled) {
        await skills.importDirectory(chosen.filePaths[0]!);
        config.update({});
        broker.permissionsChanged();
        await peer.call('configure', config.value);
        notify();
      }
    },
    removeSkill: async (key: unknown) => {
      await skills.remove(
        z
          .string()
          .regex(/^[a-f0-9]{24}$/)
          .parse(key),
      );
      config.update({});
      broker.permissionsChanged();
      await peer.call('configure', config.value);
      notify();
    },
    chooseImport: async () => {
      const chosen = await dialog.showOpenDialog(win!, {
        title: '选择旧版 fish.json / state.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (chosen.canceled) return null;
      const file = chosen.filePaths[0]!;
      const preview = await peer.call<{
        hash: string;
        messages: number;
        memories: number;
        archived: number;
      }>('previewImport', { file });
      const confirm = await dialog.showMessageBox(win!, {
        type: 'question',
        title: '导入旧数据',
        message: `将导入 ${preview.messages} 条历史消息和 ${preview.memories} 条可确认的私聊记忆。`,
        detail: `${preview.archived} 项归属不明或敏感内容不转为个人事实。人设、配置、凭据不会自动导入。数据库会先备份，原文件保持原样。`,
        buttons: ['取消', '导入'],
        defaultId: 0,
        cancelId: 0,
      });
      if (confirm.response !== 1) return null;
      broker.cancel();
      const result = await peer.call('import', { file, hash: preview.hash });
      notify();
      return result;
    },
    openData: () => shell.openPath(directory),
    loginStartup: (enabled: unknown) => {
      app.setLoginItemSettings({ openAtLogin: z.boolean().parse(enabled) });
      return app.getLoginItemSettings().openAtLogin;
    },
    approveFriend: async (key: unknown) => {
      try {
        await friends.review(
          z.string().uuid().parse(key),
          async (friend) => {
            if (friend.uncertain) {
              const answer = await dialog.showMessageBox(win!, {
                type: 'question',
                message: `${friend.qq} 的好友申请处理结果待核实`,
                detail: '在 QQ 中查看申请结果后，可以移除本机提醒。',
                buttons: ['取消', '已核实，移除提醒'],
                defaultId: 0,
                cancelId: 0,
              });
              return answer.response === 1 ? 'dismiss' : 'cancel';
            }
            const answer = await dialog.showMessageBox(win!, {
              type: 'question',
              message: `处理 ${friend.qq} 发给 ${friend.account} 的好友申请`,
              detail: [friend.comment, '聊天权限由「谁可以和小鱼聊天」的名单控制。']
                .filter(Boolean)
                .join('\n\n'),
              buttons: ['取消', '通过', '拒绝申请'],
              defaultId: 0,
              cancelId: 0,
            });
            return answer.response === 1 ? 'accept' : answer.response === 2 ? 'decline' : 'cancel';
          },
          (flag, approve) => onebot.call('set_friend_add_request', { flag, approve }),
        );
      } finally {
        notify();
      }
    },
  };
  for (const [method, handler] of Object.entries(handlers))
    ipcMain.handle('chatds:' + method, (event, ...args) => {
      checkReady();
      if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame)
        throw new Error('无效界面来源');
      return handler(...args);
    });
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 850,
    minHeight: 620,
    title: 'ChatDS',
    backgroundColor: '#f5f4f0',
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  await win.loadFile(join(here, '../renderer/index.html'), {
    hash: process.argv.includes('--napcat-settings') ? 'napcat' : '',
  });
  win.show();
  const icon = nativeImage.createFromPath(join(here, '../assets/icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('ChatDS');
  const show = () => {
    win?.show();
    win?.focus();
  };
  tray.on('double-click', show);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 ChatDS', click: show },
      {
        label: '停止当前任务',
        click: () => {
          broker.cancel();
          void peer.call('stop', {});
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]),
  );
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });
  app.on('second-instance', show);
  child.on('exit', (code) => {
    peer.close();
    readOnly?.close();
    readOnly = undefined;
    if (!quitting) {
      log('运行时退出：' + code);
      dialog.showErrorBox('ChatDS 运行时已停止', '请重新打开应用；聊天数据保留在本机。');
      app.quit();
    }
  });
  child.stderr?.on('data', (bytes) => {
    const text = String(bytes);
    if (!text.includes('ExperimentalWarning')) log(text.slice(0, 400));
  });
  app.on('before-quit', (event) => {
    if (finished) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    installing?.abort();
    closePairing();
    clearTimeout(stateTimer);
    broker.cancel();
    onebot.stop();
    void (async () => {
      await Promise.race([
        peer.call('close', {}, undefined, 6000).catch(() => {}),
        new Promise((r) => setTimeout(r, 6500)),
      ]);
      await sandbox.close();
      peer.close();
      readOnly?.close();
      readOnly = undefined;
      child.kill();
      tray?.destroy();
      finished = true;
      app.quit();
    })();
  });
  if (!isTest) {
    void (async () => {
      const choice = await takeInstallerChoice(directory);
      if (choice?.action === 'directory') {
        napcatInstall = await installation.select(choice.directory);
      } else if (
        choice?.action === 'download' &&
        !napcatInstall.directory &&
        !config.value.onebot.botQQ
      ) {
        await installPackage();
        return;
      }
      if (napcatInstall.directory && (!config.value.onebot.botQQ || config.value.onebot.enabled))
        napcatInstall = await installation.ensureStarted();
      notify();
    })().catch((error) => {
      napcatSetup.error = errorText(error);
      notify();
    });
  }
  if (config.value.onebot.enabled && !isTest) {
    try {
      onebot.start();
    } catch (e) {
      log(errorText(e));
    }
  }
  if (isTest && process.env.CHATDS_SMOKE_REPORT) {
    const reportPath = process.env.CHATDS_SMOKE_REPORT;
    const report = await win.webContents.executeJavaScript(
      `(async()=>{const api=window.chatds;const wait=async count=>{const end=Date.now()+10000;while(Date.now()<end){const h=await api.history('desktop:owner');if(h.filter(m=>m.role==='assistant').length>=count)return;await new Promise(r=>setTimeout(r,50));}throw new Error('Smoke chat timed out');};await api.chat('记住：我喜欢蓝色饭团');await wait(1);await api.chat('你记得我喜欢什么吗');await wait(2);const s=await api.state();return {title:document.title,hasNode:typeof require!=='undefined',hasApi:!!api,testMode:s.testMode,rooms:s.rooms,memoryCount:s.memoryCount,history:await api.history('desktop:owner'),nav:[...document.querySelectorAll('[data-page]')].map(e=>e.getAttribute('data-page')),pages:[]};})()`,
    );
    for (const page of ['chat', 'connections', 'memory', 'persona', 'tools', 'settings']) {
      await win.webContents.executeJavaScript(
        `document.querySelector('[data-page="${page}"]').click()`,
      );
      await new Promise((r) => setTimeout(r, 200));
      report.pages.push(
        await win.webContents.executeJavaScript(
          `({id:'${page}',visible:!document.getElementById('page-${page}').classList.contains('hidden'),title:document.getElementById('page-title').textContent})`,
        ),
      );
      await win.webContents
        .capturePage()
        .then((image) => writeFileSync(reportPath + '.' + page + '.png', image.toPNG()));
    }
    await win.webContents.executeJavaScript(`(${testToolSwitches.toString()})()`);
    const fixturePort = Number(process.env.CHATDS_SMOKE_QQ_PORT);
    if (Number.isInteger(fixturePort) && fixturePort > 0 && fixturePort < 65536) {
      const previousPicker = dialog.showOpenDialog;
      try {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [join(directory, 'napcat-fixture')],
        });
        report.qqOnline = await win.webContents.executeJavaScript(
          `(${testQQPairing.toString()})()`,
        );
      } finally {
        dialog.showOpenDialog = previousPicker;
      }
    }
    report.modelStatus = await win.webContents.executeJavaScript(
      `(${testModelStatus.toString()})()`,
    );
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    app.quit();
  }
}

async function testToolSwitches() {
  document.querySelector<HTMLButtonElement>('[data-page="tools"]')!.click();
  const toggle = (id: string) =>
    [...document.querySelectorAll('#tools code')]
      .find((c) => c.textContent === id)!
      .parentElement!.parentElement!.querySelector('input')!;
  if (!toggle('sandbox_exec').disabled) throw new Error('未检查隔离环境时不应允许开启脚本执行');
  toggle('read_file').click();
  toggle('write_file').click();
  const deadline = Date.now() + 5000;
  for (;;) {
    const { config } = await window.chatds.state();
    if (config.tools.read_file && config.tools.write_file) break;
    if (Date.now() > deadline) throw new Error('连续切换的两个工具权限没有同时保存');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function testModelStatus() {
  const api = window.chatds;
  const input = (id: string) => document.getElementById(id) as HTMLInputElement;
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!ready()) {
      if (Date.now() > deadline) throw new Error('模型配置页面未进入预期状态');
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  };
  const { config } = await api.state();
  const model = { ...config.model, keyRequired: true };
  const saved = await api.configure({ config: { model }, apiKey: 'local-smoke-fixture' });
  document.querySelector<HTMLButtonElement>('[data-page="settings"]')!.click();
  document.getElementById('model-retest')!.click();
  const end = Date.now() + 5000;
  while (!document.getElementById('model-status')!.textContent!.includes('验证通过')) {
    if (Date.now() > end) throw new Error('模型测试状态未显示');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  document.getElementById('model-edit')!.click();
  const blocked =
    (document.getElementById('model-save') as HTMLButtonElement).disabled &&
    (document.getElementById('model-test') as HTMLButtonElement).disabled &&
    document.getElementById('model-key-label')!.classList.contains('hidden');
  input('model-id').value = 'fixture-unavailable';
  input('model-id').dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('model-replace-key')!.click();
  input('api-key').value = 'unverified-fixture-key';
  input('api-key').dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('model-test')!.click();
  await until(() =>
    document.getElementById('model-result')!.textContent!.includes('测试模型暂不可用'),
  );
  const preserved = await api.state();
  if (
    !preserved.modelVerified ||
    preserved.config.model.model !== model.model ||
    input('model-id').value !== 'fixture-unavailable'
  )
    throw new Error('候选模型测试失败后丢失了原配置或草稿');
  document.getElementById('model-cancel')!.click();
  const duplicate = await api.configure({ config: { model }, apiKey: 'local-smoke-fixture' });
  const changed = await api.configure({ apiKey: 'local-smoke-replacement' });
  const available = { ...model, model: 'fixture-available' };
  const verified = await api.testAndSaveModel(available);
  return (
    saved.keyConfigured &&
    !saved.modelVerified &&
    blocked &&
    duplicate.modelVerified &&
    duplicate.config.revision === saved.config.revision &&
    !changed.modelVerified &&
    verified.modelVerified &&
    verified.config.model.model === available.model
  );
}

// Serialized into the isolated smoke renderer, just like a user operating these controls.
async function testQQPairing() {
  const find = (id: string) => document.getElementById(id)!;
  const wait = async (matches: () => boolean) => {
    const end = Date.now() + 8000;
    while (!matches()) {
      if (Date.now() > end) throw new Error('QQ 登录界面未进入预期状态');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const visible = (id: string) => find(id).getClientRects().length > 0;
  const nav = (page: string) =>
    document.querySelector<HTMLButtonElement>('[data-page="' + page + '"]')!;
  const hasPublish = () =>
    Array.from(find('tools').querySelectorAll('code')).some(
      (label) => label.textContent === 'qzone_publish',
    );
  nav('tools').click();
  if (hasPublish()) throw new Error('未配置时工具页显示了发布说说');
  nav('chat').click();
  if (nav('connections').getClientRects().length || visible('room-connect'))
    throw new Error('未配置时显示了 QQ 入口');
  nav('settings').click();
  find('setup-qq').click();
  if (visible('napcat-choose') || visible('qq-management') || !visible('napcat-installation'))
    throw new Error('未配置时没有显示独立的 NapCat 安装设置');
  find('napcat-installation').click();
  if (visible('qq-management') || nav('connections').getClientRects().length)
    throw new Error('只有安装目录时显示了 QQ 业务入口');
  await wait(
    () =>
      !find('napcat-qr').classList.contains('hidden') &&
      (find('napcat-qr') as HTMLImageElement).naturalWidth > 0,
  );
  await wait(() => find('napcat-state').textContent!.includes('在手机 QQ 上确认'));
  await wait(() => find('qq-status').textContent === 'QQ 在线');
  const state = await window.chatds.state();
  if (!visible('qq-management') || !nav('connections').getClientRects().length)
    throw new Error('OneBot 账号核验通过后仍缺少 QQ 入口');
  nav('tools').click();
  if (!hasPublish()) throw new Error('账号核验通过后工具页缺少发布说说');
  nav('connections').click();
  await window.chatds.napcatForgetInstallation();
  await wait(() => visible('qq-management') && !visible('qq-switch') && !visible('napcat-forget'));
  find('disconnect').click();
  nav('tools').click();
  await wait(() => !hasPublish() && !nav('connections').getClientRects().length);
  nav('chat').click();
  if (visible('room-connect')) throw new Error('OneBot 断开后仍显示 QQ 入口');
  nav('settings').click();
  if (find('setup-qq').textContent !== '管理 OneBot 连接')
    throw new Error('单独配置 OneBot 后仍被引导配置 NapCat');
  find('setup-qq').click();
  if (visible('napcat-choose') || !visible('qq-reconnect'))
    throw new Error('仅配置 OneBot 时显示了错误的登录入口');
  return (
    state.account === '10001' && state.config.onebot.ownerQQ === '' && state.onebotTokenConfigured
  );
}
