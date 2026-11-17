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
import { z } from 'zod';
import { ConfigStore } from './config-store.js';
import { Vault } from './vault.js';
import { ModelHost, keyReference } from './model.js';
import { TestModelHost } from './test-model.js';
import { RpcPeer } from '../shared/rpc.js';
import { boundText, id, atomicJson, readJson, checkAbort, stableDay } from '../shared/util.js';
import {
  configSchema,
  conversationSchema,
  errorText,
  validateConversationId,
} from '../shared/config.js';
import type {
  Activity,
  AppSnapshot,
  ChatMessage,
  MessageEnvelope,
  RuntimeEvent,
  SettingsChange,
  ToolId,
} from '../shared/types.js';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { OneBot } from '../connectors/onebot.js';
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
  type Friend = { id: string; qq: string; comment: string; flag: string; handled: boolean };
  const requestsFile = join(directory, 'friend-requests.json');
  const friends = readJson<Friend[]>(requestsFile, []);
  onebot.on('request', (raw) => {
    if (raw.request_type !== 'friend' || String(raw.self_id) !== config.value.onebot.botQQ) return;
    if (friends.some((f) => f.flag === String(raw.flag))) return;
    friends.push({
      id: id(),
      qq: String(raw.user_id),
      comment: String(raw.comment ?? '').slice(0, 500),
      flag: String(raw.flag),
      handled: false,
    });
    if (friends.length > 100) friends.splice(0, friends.length - 100);
    atomicJson(requestsFile, friends);
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
      friendRequests: friends
        .filter((f) => !f.handled)
        .map(({ id, qq, comment }) => ({ id, qq, comment })),
      loginStartup: app.getLoginItemSettings().openAtLogin,
    };
  };
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
      const before = structuredClone(config.value),
        next = change.config ? config.preview(change.config) : config.value;
      if (before.onebot.ownerQQ && next.onebot.ownerQQ !== before.onebot.ownerQQ) {
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
      const secrets: Record<string, string | undefined> = {};
      if (change.apiKey?.trim() || change.clearApiKey)
        secrets[keyReference(next.model)] = change.clearApiKey ? undefined : change.apiKey!.trim();
      if (change.onebotToken?.trim() || change.clearOnebotToken)
        secrets.onebot = change.clearOnebotToken ? undefined : change.onebotToken!.trim();
      if (Object.keys(secrets).length) vault.setMany(secrets);
      if (change.config) config.commit(next);
      broker.permissionsChanged();
      await peer.call('configure', config.value);
      if (
        JSON.stringify(before.onebot) !== JSON.stringify(config.value.onebot) ||
        change.onebotToken !== undefined ||
        change.clearOnebotToken
      ) {
        onebot.stop();
        if (config.value.onebot.enabled && !isTest) onebot.start();
      }
      notify();
      return snapshot();
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
    history: (room: unknown, before?: unknown) =>
      peer.call('history', {
        id: validateConversationId(z.string().parse(room)),
        before: before === undefined ? undefined : z.number().int().positive().parse(before),
      }),
    conversation: async (room: unknown, patch: unknown) => {
      const key = validateConversationId(z.string().parse(room));
      const value = conversationSchema.partial().parse(patch);
      config.update({
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
      });
      broker.cancel(key);
      await peer.call('configure', config.value);
      notify();
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
    modelTest: async () => {
      const result = await model.stream(
        {
          context: {
            messages: [
              { role: 'system', content: '只回答连接成功。', timestamp: Date.now() },
              { role: 'user', content: '请回答连接成功', timestamp: Date.now() },
            ],
          } as unknown as TranscriptContext,
          budget: 64,
          thinking: 'off',
        },
        () => {},
        AbortSignal.timeout(20000),
      );
      return {
        ok: result.stopReason === 'stop',
        detail: result.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('')
          .slice(0, 200),
      };
    },
    connect: () => {
      onebot.start();
      notify();
    },
    disconnect: () => {
      onebot.stop();
      notify();
    },
    sandboxCheck: async () => {
      const value = await sandbox.check();
      if (value.available) await sandbox.reap();
      await peer.call('configure', config.value);
      notify();
      return value;
    },
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
      const friend = friends.find((f) => f.id === key && !f.handled);
      if (!friend) throw new Error('好友申请不存在');
      const confirmation = await dialog.showMessageBox(win!, {
        type: 'question',
        message: `通过 ${friend.qq} 的好友申请？`,
        detail: friend.comment,
        buttons: ['取消', '通过'],
        defaultId: 0,
        cancelId: 0,
      });
      if (confirmation.response !== 1) return;
      await onebot.call('set_friend_add_request', { flag: friend.flag, approve: true });
      friend.handled = true;
      atomicJson(requestsFile, friends);
      notify();
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
  await win.loadFile(join(here, '../renderer/index.html'));
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
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    app.quit();
  }
}
