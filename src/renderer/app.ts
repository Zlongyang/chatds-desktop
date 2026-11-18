import { renderConnections, leaveConnections, hasQQChannel } from './connections.js';
import { renderNapcatSettings } from './napcat-settings.js';
import { activePersonaName } from '../shared/persona.js';
import { personaEditor } from './persona-editor.js';
import type {
  AppSnapshot,
  ChatMessage,
  MemoryFact,
  SkillInfo,
  ConversationSettings,
  ModelProfile,
  ToolId,
} from '../shared/types.js';
const api = window.chatds;
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error('Missing interface element ' + selector);
  return element as T;
};
const field = (selector: string) => $(selector) as HTMLInputElement;
const select = (selector: string) => $(selector) as HTMLSelectElement;
const el = (tag: string, cls = '', text?: string) => {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const icons: Record<string, string> = {
  chat: 'M21 11a8 8 0 0 1-8 8H6l-4 3V11a9 9 0 0 1 19 0Z',
  connections: 'M8 12h8M7 7H5a5 5 0 0 0 0 10h2M17 7h2a5 5 0 0 1 0 10h-2',
  memory: 'M8 3H5v18h14V3h-3M8 2h8v4H8ZM8 11h8M8 16h5',
  persona: 'M20 12c-2-5-7-7-13-5L2 4v15l5-3c6 2 11 0 13-4ZM16 10h.01',
  tools: 'm14 6 4-4 4 4-4 4M14 6 4 16a3 3 0 0 0 4 4L18 10',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z',
};
const titles: Record<string, string> = {
  chat: '聊聊天',
  connections: 'NapCat 与 QQ',
  memory: '记得的小事',
  persona: '小鱼人设',
  tools: '工具与技能',
  settings: '环境配置',
};
const navLabels: Record<string, string> = {
  chat: '聊天',
  connections: 'QQ 管理',
  memory: '记忆',
  persona: '小鱼人设',
  tools: '工具',
  settings: '环境配置',
};
const phases: Record<string, string> = {
  idle: '空闲',
  queued: '等待处理',
  collecting: '等你说完',
  recalling: '回想相关记忆',
  generating: '正在组织回复',
  tool: '正在使用工具',
  approval: '等待你的确认',
  sending: '正在发送',
  cancelled: '已取消',
  error: '遇到问题',
};
const statuses: Record<string, string> = {
  offline: '未连接',
  connecting: '连接中',
  online: 'QQ 在线',
  reconnecting: '正在重连',
  'wrong-account': '机器人账号不符',
  'authentication-or-protocol-error': '鉴权或协议异常',
};
const toolLabels: Record<ToolId, string> = {
  memory_search: '回想当前范围的记忆',
  memory_remember: '保存明确交代的事实',
  skills_load: '按需读取本地技能',
  read_file: '读取当前工作区文件',
  write_file: '写入工作区 · 逐次确认',
  web_read: '阅读公开网页',
  sandbox_exec: '执行隔离脚本 · 逐次确认',
  qzone_publish: '发布说说 · 确认正文',
};
let state: AppSnapshot | undefined,
  page = 'chat',
  roomId = 'desktop:owner',
  historyVersion = '',
  requestVersion = 0,
  formsLoaded = false;
let editingModel = false,
  replacingModelKey = false,
  modelBusy = false;
const historyPageSize = 100;
let historyCursors: number[] = [];
let olderCursor: number | undefined;
let desktopDraft = '';
const renderPersona = personaEditor(api, toast);
let memoryRows: MemoryFact[] = [],
  refreshTimer: ReturnType<typeof setTimeout> | undefined,
  noticeTimer: ReturnType<typeof setTimeout> | undefined,
  refreshRunning = false,
  refreshAgain = false;
function toast(text: string, error = false) {
  clearTimeout(noticeTimer);
  $('#notice').textContent = text;
  $('#notice').className = error ? 'error' : '';
  noticeTimer = setTimeout(() => ($('#notice').className = 'hidden'), 8000);
}
async function act(fn: () => unknown | Promise<unknown>, success?: string) {
  try {
    await fn();
    if (success) toast(success);
    await refresh();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  }
}
function navigate(next: string) {
  if (!titles[next]) return;
  if (page === 'settings' && next !== page && editingModel && !modelChanged()) {
    editingModel = false;
    replacingModelKey = false;
  }
  if (page === 'connections' && next !== page) leaveConnections();
  if (page !== next) window.scrollTo(0, 0);
  page = next;
  for (const key of Object.keys(titles)) $('#page-' + key).classList.toggle('hidden', key !== page);
  $('#page-title').textContent = titles[page]!;
  document.title = titles[page] + ' · ChatDS';
  render();
  if (page === 'memory') void loadMemories();
  if (page === 'tools') void loadSkills();
}
for (const [key, label] of Object.entries(navLabels)) {
  const b = el('button');
  if (key === 'connections') b.classList.add('hidden');
  b.dataset.page = key;
  b.title = label;
  b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[key]}"/></svg><span>${label}</span>`;
  b.onclick = () => navigate(key);
  $('#nav').append(b);
}
$('#collapse').onclick = () => {
  const collapsed = $('.app').classList.toggle('collapsed');
  $('#collapse').textContent = collapsed ? '›' : '‹';
  localStorage.setItem('chatds-sidebar', collapsed ? 'collapsed' : 'expanded');
};
if (localStorage.getItem('chatds-sidebar') === 'collapsed') $('.app').classList.add('collapsed');
$('#local-room').onclick = () => chooseRoom('desktop:owner');
$('#model-badge').onclick = $('#chat-setup').onclick = () => navigate('settings');
$('#chat-web-settings').onclick = () => {
  navigate('tools');
  document.getElementById('tool-web_read')?.focus();
};
$('#room-connect').onclick = $('#setup-qq').onclick = () => navigate('connections');
$('#setup-persona').onclick = () => navigate('persona');
$('#setup-chat').onclick = () => {
  chooseRoom('desktop:owner');
  field('#message').focus();
};
function modelReady(s: AppSnapshot) {
  return s.keyConfigured || !s.config.model.keyRequired;
}
function chooseRoom(key: string) {
  resetHistory(key);
  navigate('chat');
}
function resetHistory(key: string) {
  const input = $('#message') as HTMLTextAreaElement;
  if (key !== roomId) {
    if (roomId === 'desktop:owner') desktopDraft = input.value;
    input.value = key === 'desktop:owner' ? desktopDraft : '';
  }
  roomId = key;
  historyVersion = '';
  historyCursors = [];
  olderCursor = undefined;
  requestVersion++;
  $('#history-nav').classList.add('hidden');
  $('#messages').replaceChildren();
}
$('#history-older').onclick = () => {
  if (olderCursor === undefined) return;
  void loadHistory(roomId, true, [...historyCursors, olderCursor]);
};
$('#history-newer').onclick = () => {
  void loadHistory(roomId, true, historyCursors.slice(0, -1));
};
$('#history-latest').onclick = () => {
  void loadHistory(roomId, true, []);
};
function roomSettings(): ConversationSettings {
  return state?.config.conversations[roomId] ?? { mode: 'companion', ambient: false, muted: false };
}
function render() {
  if (!state) return;
  const s = state;
  renderConnections(s);
  renderNapcatSettings(s.napcatInstallation);
  const hasQQ = hasQQChannel(s);
  $('[data-page="connections"]').classList.toggle('hidden', !hasQQ);
  const activeNav = page === 'connections' && !hasQQ ? 'settings' : page;
  document.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === activeNav);
    if (b.dataset.page === activeNav) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (!hasQQ && roomId !== 'desktop:owner') {
    resetHistory('desktop:owner');
  }
  $('#room-connect').classList.toggle('hidden', !hasQQ);
  $('#qq-boundary').classList.toggle('hidden', !hasQQ);
  $('#setup-qq').textContent = s.napcatInstallation
    ? 'NapCat 配置'
    : s.config.onebot.botQQ && s.onebotTokenConfigured
      ? '管理 OneBot 连接'
      : '配置 NapCat（可选）';
  $('#test-badge').classList.toggle('hidden', !s.testMode);
  $('#model-badge').textContent = modelReady(s)
    ? s.config.model.model + (s.modelVerified ? ' · 已验证' : ' · 已配置')
    : '配置聊天模型';
  $('#model-badge').classList.toggle('hidden', page === 'settings');
  $('#pause').classList.toggle('hidden', !modelReady(s) && s.config.enabled);
  $('#setup-persona-status').textContent =
    '正在使用「' + activePersonaName(s.config) + '」角色卡。';
  const qqStatus =
    !hasQQ && s.connection === 'online' ? '账号未核对' : (statuses[s.connection] ?? s.connection);
  $('#setup-qq-status').textContent = hasQQ
    ? 'QQ 已连接 · ' + s.config.onebot.botQQ
    : s.config.onebot.botQQ
      ? qqStatus + ' · ' + s.config.onebot.botQQ
      : s.napcatInstallation?.available
        ? '已选择 NapCat 安装目录，可继续登录 QQ。'
        : s.napcatInstallation
          ? '已保存的 NapCat 安装目录不可用，请重新选择。'
          : '尚未关联本机 NapCat 安装目录。';
  $('#pause').textContent = s.config.enabled ? '暂停回复' : '恢复回复';
  $('#side-status').textContent = s.config.enabled ? '● 本机运行' : '○ 回复已暂停';
  $('#qq-status').textContent = qqStatus;
  $('#qq-status').classList.toggle('online', hasQQ);
  const qqRooms = hasQQ ? s.rooms.filter((r) => r.id !== 'desktop:owner') : [];
  $('#room-count').textContent = String(1 + qqRooms.length);
  $('#local-room').classList.toggle('active', roomId === 'desktop:owner');
  const rooms = $('#rooms');
  rooms.replaceChildren();
  for (const row of qqRooms.slice(0, 100)) {
    const b = el('button', 'room' + (row.id === roomId ? ' active' : ''));
    const copy = el('span');
    copy.append(
      el('strong', '', row.name),
      el(
        'small',
        '',
        row.phase === 'idle' ? (row.isGroup ? '群聊' : 'QQ 私聊') : phases[row.phase],
      ),
    );
    b.append(el('span', 'avatar', row.isGroup ? '群' : 'Q'), copy);
    b.onclick = () => chooseRoom(row.id);
    rooms.append(b);
  }
  renderApprovals();
  if (!formsLoaded) {
    fillForms(s);
    formsLoaded = true;
  }
  renderPersona(s.config);
  renderModelSettings();
  $('#qq-token-status').textContent = s.onebotTokenConfigured
    ? '已保存令牌；留空保留。'
    : '尚未保存 Access Token。';
  $('#memory-count').textContent = s.memoryCount + ' 条';
  $('#usage').textContent =
    `今天模型用量：输入 ${s.usage.input.toLocaleString()} / 输出 ${s.usage.output.toLocaleString()} tokens；其中自主判定 ${s.usage.ambient.toLocaleString()}，后台记忆 ${s.usage.background.toLocaleString()}。费用以供应商账单为准。`;
  $('#sandbox-badge').textContent = s.sandbox.available ? '已准备' : '未准备';
  $('#sandbox-detail').textContent = s.sandbox.available
    ? '脚本在断网临时环境中运行；文件不会自动写回工作区。'
    : (s.sandbox.reason ?? '普通聊天不需要 Docker。');
  renderFriends();
  renderActivities();
  if (page === 'chat') renderChat();
  if (page === 'tools') renderTools(s);
}
function fillForms(s: AppSnapshot) {
  fillModel(s.config.model);
  field('#auto-memory').checked = s.config.memory.automatic;
  field('#startup').checked = s.loginStartup;
}
function fillModel(m: ModelProfile) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(m.baseUrl).hostname);
  select('#provider').value = local && m.provider === 'openai-compatible' ? 'local' : m.provider;
  $<HTMLDetailsElement>('#endpoint-options').open =
    m.provider !== 'deepseek' ||
    m.model !== 'deepseek-flash' ||
    m.baseUrl !== 'https://api.deepseek.com';
  field('#model-id').value = m.model;
  field('#base-url').value = m.baseUrl;
  field('#context-window').value = String(m.contextWindow);
  field('#output-tokens').value = String(m.maxOutputTokens);
  select('#thinking').value = m.thinking;
  field('#key-required').checked = m.keyRequired;
  field('#api-key').value = '';
  replacingModelKey = false;
}
function renderApprovals() {
  const holder = $('#approvals');
  const current = new Set(state!.approvals.map((a) => a.id));
  for (const card of holder.querySelectorAll<HTMLElement>('[data-approval-id]')) {
    if (!current.has(card.dataset.approvalId!)) card.remove();
  }
  for (const a of state!.approvals) {
    if (document.getElementById('approval-' + a.id)) continue;
    const card = el('article', 'approval');
    card.id = 'approval-' + a.id;
    card.dataset.approvalId = a.id;
    const source =
      a.conversationId === 'desktop:owner'
        ? '桌面聊天'
        : 'QQ 私聊 ' + a.conversationId.split(':').at(-1);
    const target =
      a.tool === 'qzone_publish' ? ' · 发布到 QQ ' + state!.config.onebot.botQQ + ' 的空间' : '';
    card.append(
      el('h3', '', a.summary),
      el('small', 'muted', '来自' + source + target),
      el('pre', '', a.detail),
    );
    const actions = el('div', 'row');
    for (const [allow, label] of [
      [false, '拒绝'],
      [true, '仅允许这一次'],
    ] as const) {
      const b = el('button', allow ? 'primary' : '', label);
      b.onclick = () => act(() => api.approve(a.id, allow));
      actions.append(b);
    }
    card.append(actions);
    holder.append(card);
  }
}
function renderChat() {
  const s = state!,
    room = s.rooms.find((r) => r.id === roomId),
    local = roomId === 'desktop:owner',
    settings = roomSettings();
  $('#chat-name').textContent = local ? '桌面聊天' : (room?.name ?? 'QQ 会话');
  const waiting = s.approvals.some((a) => a.conversationId === roomId);
  $('#chat-phase').textContent = !s.config.enabled
    ? '所有会话已暂停回复'
    : settings.muted
      ? '此会话只同步消息'
      : (room?.error ?? (waiting ? '等待你的确认' : phases[room?.phase ?? 'idle']!));
  select('#mode').value = settings.mode;
  $('#chat-web-settings').classList.toggle(
    'hidden',
    !local || !modelReady(s) || settings.mode !== 'assistant',
  );
  $('#chat-web-settings').textContent = s.config.tools.web_read
    ? '网页读取已开启'
    : '网页读取已关闭';
  $('#chat-web-settings').title = '管理阅读公开网页权限';
  field('#ambient').disabled = settings.muted;
  field('#ambient').checked = !settings.muted && settings.ambient;
  field('#muted').checked = settings.muted;
  $('#group-options').classList.toggle('hidden', !room?.isGroup);
  const needsSetup = local && !modelReady(s);
  field('#message').disabled = !local || needsSetup;
  field('#send').disabled = !local || needsSetup || !s.config.enabled;
  $('#chat-setup').classList.toggle('hidden', !needsSetup);
  $('#send').classList.toggle('hidden', needsSetup);
  field('#message').placeholder = !local
    ? '在 QQ 中发消息，这里同步显示记录'
    : needsSetup
      ? '连接一个模型后，就可以开始聊天。'
      : '跟' + activePersonaName(state!.config) + '说句话…';
  $('#chat-hint').textContent = !local
    ? '请在 QQ 中回复。'
    : needsSetup
      ? '支持 DeepSeek 和本机模型服务'
      : !s.config.enabled
        ? '点击右上角「恢复回复」继续聊天'
        : 'Enter 发送，Shift + Enter 换行';
  $('#stop').toggleAttribute('disabled', !room || room.phase === 'idle');
  const signature = roomId + ':' + (room?.updatedAt ?? 0);
  if (signature !== historyVersion) {
    const first = !historyVersion;
    historyVersion = signature;
    if (!historyCursors.length) void loadHistory(roomId, first);
  }
  $('#draft').classList.toggle('hidden', !room || room.phase === 'idle' || !!room.error);
  $('#draft').textContent = room?.draft || phases[room?.phase ?? 'idle']!;
}
async function loadHistory(key: string, pageChanged = false, cursors = historyCursors) {
  const request = ++requestVersion;
  const previous = historyCursors;
  historyCursors = cursors;
  const before = historyCursors.at(-1);
  const controls = ['#history-older', '#history-newer', '#history-latest'].map((id) =>
    $<HTMLButtonElement>(id),
  );
  for (const button of controls) button.disabled = true;
  try {
    const result = await api.history(key, before, historyPageSize + 1);
    if (request !== requestVersion || key !== roomId) return;
    const messages = result.slice(-historyPageSize);
    olderCursor = result.length > historyPageSize ? messages[0]?.seq : undefined;
    $('#history-older').classList.toggle('hidden', olderCursor === undefined);
    $('#history-newer').classList.toggle('hidden', historyCursors.length < 2);
    $('#history-latest').classList.toggle('hidden', before === undefined);
    $('#history-nav').classList.toggle('hidden', olderCursor === undefined && before === undefined);
    const box = $('#messages'),
      nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    box.replaceChildren();
    if (!messages.length) {
      const empty = el('div', 'empty');
      const img = document.createElement('img');
      img.src = '../assets/icon.png';
      img.width = 76;
      img.height = 76;
      empty.append(
        img,
        el('h2', '', '今天过得怎么样？'),
        el('p', '', '普通的小事，也可以聊一聊。'),
      );
      box.append(empty);
    } else for (const message of messages) box.append(messageNode(message));
    if (nearBottom || pageChanged) box.scrollTo({ top: box.scrollHeight, behavior: 'instant' });
  } catch (error) {
    if (request !== requestVersion) return;
    historyCursors = previous;
    historyVersion = '';
    toast(String(error), true);
  } finally {
    if (request === requestVersion) for (const button of controls) button.disabled = false;
  }
}
function messageNode(message: ChatMessage) {
  const row = el('div', 'message ' + message.role),
    body = el('div', 'message-body');
  body.append(el('div', 'message-name', message.name), el('div', 'bubble', message.text));
  if (message.role === 'assistant' && message.webReads?.length === 0)
    body.append(el('small', 'web-receipts', '本轮未读取网页'));
  if (message.role === 'assistant' && message.webReads?.length) {
    const receipts = el('ul', 'web-receipts');
    receipts.setAttribute('aria-label', '本次实际网页读取记录');
    for (const receipt of message.webReads) {
      const label = receipt.status === 'read' ? '网页已读取' : '网页读取失败';
      const details = [label, receipt.host, receipt.status === 'failed' && receipt.reason];
      receipts.append(el('li', '', details.filter(Boolean).join(' · ')));
    }
    body.append(receipts);
  }
  if (message.status === 'unknown' || message.status === 'failed')
    body.append(
      el(
        'div',
        'delivery',
        message.status === 'unknown' ? 'QQ 发送结果未知，请核实；没有自动重发。' : '未发送成功。',
      ),
    );
  row.append(
    el('span', 'avatar', message.role === 'assistant' ? '鱼' : message.name.slice(0, 1)),
    body,
  );
  return row;
}
function renderActivities() {
  const events = state!.activities.slice(-15).reverse();
  for (const selector of ['#activity', '#chat-activity']) {
    const host = $(selector);
    host.replaceChildren();
    for (const a of events) {
      if (selector === '#chat-activity' && a.conversationId && a.conversationId !== roomId)
        continue;
      const row = el('div', 'event');
      row.append(
        el(
          'time',
          '',
          new Date(a.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        ),
        document.createTextNode(a.text),
      );
      host.append(row);
    }
    if (!host.childNodes.length) host.append(el('p', 'muted', '还没有新的活动。'));
  }
  $('#activity-status').textContent =
    phases[state!.rooms.find((r) => r.id === roomId)?.phase ?? 'idle']!;
}
function renderTools(snapshot: AppSnapshot) {
  const host = $('#tools');
  host.replaceChildren();
  for (const [key, enabled] of Object.entries(snapshot.config.tools)) {
    if (key === 'qzone_publish' && !hasQQChannel(snapshot)) continue;
    const tool = key as ToolId,
      row = el('div', 'tool-row'),
      copy = el('div');
    copy.append(el('p', '', toolLabels[tool]), el('code', '', key));
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = 'tool-' + tool;
    input.checked = enabled;
    if (tool === 'sandbox_exec' && !snapshot.sandbox.available) {
      input.disabled = !enabled;
      copy.append(
        el(
          'small',
          'muted',
          enabled ? '已授权，等待隔离环境就绪。' : '先检查 Docker 与专用镜像，即可开启。',
        ),
      );
    }
    input.setAttribute('aria-label', toolLabels[tool]);
    input.onchange = () =>
      act(() => api.configure({ config: { tools: { [tool]: input.checked } } }));
    row.append(copy, input);
    host.append(row);
  }
}
function renderFriends() {
  const host = $('#friends');
  host.replaceChildren();
  for (const f of state!.friendRequests) {
    const row = el('div', 'friend');
    row.append(el('strong', '', f.qq), el('p', '', f.comment));
    const button = el('button', '', f.uncertain ? '去 QQ 核实后处理提醒' : '查看并处理');
    button.onclick = () => act(() => api.approveFriend(f.id));
    row.append(button);
    host.append(row);
  }
  if (!host.childNodes.length) host.append(el('p', 'muted', '没有待处理申请。'));
}
async function loadMemories() {
  try {
    memoryRows = await api.memories();
    const current = select('#memory-scope').value;
    const options = select('#memory-scope');
    options.replaceChildren(new Option('所有范围', ''));
    for (const scope of [...new Set(memoryRows.map((m) => m.scope))])
      options.add(new Option(scopeLabel(scope), scope));
    options.value = current;
    renderMemories();
  } catch (e) {
    toast(String(e), true);
  }
}
function scopeLabel(scope: string) {
  return scope === 'person:owner'
    ? '你 · 私密'
    : scope.startsWith('person:')
      ? '私聊 ' + scope.slice(7)
      : '群聊 ' + scope.split(':').at(-1);
}
function renderMemories() {
  const term = field('#memory-search').value.toLowerCase(),
    scope = select('#memory-scope').value,
    host = $('#memories');
  host.replaceChildren();
  for (const m of memoryRows.filter(
    (m) => (!scope || m.scope === scope) && (!term || m.content.toLowerCase().includes(term)),
  )) {
    const row = el('article', 'memory-card'),
      copy = el('div');
    copy.append(
      el('span', 'scope', scopeLabel(m.scope)),
      el('p', '', m.content),
      el(
        'small',
        '',
        `归属 ${m.subject === 'owner' ? '你' : m.subject} · ${new Date(m.updatedAt).toLocaleDateString()} · ${m.sourceIds.length} 条来源`,
      ),
    );
    const remove = el('button', '', '忘记');
    remove.onclick = () => {
      if (
        window.confirm('忘记这条事实？\n相关旧来源与摘要将从模型后续上下文排除；原始聊天记录保留。')
      )
        void act(async () => {
          await api.forget(m.id);
          await loadMemories();
        }, '已忘记这条记忆');
    };
    row.append(copy, remove);
    host.append(row);
  }
  if (!host.childNodes.length) host.append(el('p', 'muted', '这里还没有符合条件的记忆。'));
}
async function loadSkills() {
  try {
    const list = await api.skills(),
      host = $('#skills');
    host.replaceChildren();
    for (const s of list) {
      const card = el('div', 'skill');
      const head = el('div', 'row between');
      head.append(el('strong', '', s.name));
      const remove = el('button', '', '移除');
      remove.onclick = () =>
        act(async () => {
          await api.removeSkill(s.id);
          await loadSkills();
        });
      head.append(remove);
      card.append(
        head,
        el('p', '', s.description),
        el('small', 'muted', `${s.resources.length} 个资源 · 版本 ${s.revision.slice(0, 8)}`),
      );
      host.append(card);
    }
    if (!list.length) host.append(el('p', 'muted', '尚未导入本地技能。'));
  } catch (error) {
    toast(String(error), true);
  }
}
async function refresh() {
  if (refreshRunning) {
    refreshAgain = true;
    return;
  }
  refreshRunning = true;
  try {
    state = await api.state();
    render();
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  } finally {
    refreshRunning = false;
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    }
  }
}
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refresh();
  }, 150);
}
api.onEvent((event) => {
  if (event.type === 'draft' && event.conversationId === roomId) {
    $('#draft').textContent = String((event.data as { text: string }).text ?? '');
    $('#draft').classList.remove('hidden');
  }
  scheduleRefresh();
});
$('#composer').onsubmit = (event) => {
  event.preventDefault();
  const input = field('#message'),
    text = input.value.trim();
  if (!text || field('#send').disabled) return;
  input.value = '';
  void act(async () => {
    try {
      await api.chat(text);
      if (roomId === 'desktop:owner' && historyCursors.length) await loadHistory(roomId, true, []);
    } catch (error) {
      if (roomId !== 'desktop:owner') desktopDraft ||= text;
      else if (!input.value) input.value = text;
      throw error;
    }
  });
};
$('#message').onkeydown = (event) => {
  const e = event as KeyboardEvent;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').dispatchEvent(new Event('submit', { cancelable: true }));
  }
};
$('#stop').onclick = () => act(() => api.stop(roomId));
$('#pause').onclick = () =>
  act(() => api.configure({ config: { enabled: !state!.config.enabled } }));
select('#mode').onchange = () =>
  act(() =>
    api.conversation(roomId, { mode: select('#mode').value as ConversationSettings['mode'] }),
  );
field('#ambient').onchange = () =>
  act(() => api.conversation(roomId, { ambient: field('#ambient').checked }));
field('#muted').onchange = () =>
  act(() => api.conversation(roomId, { muted: field('#muted').checked }));
field('#memory-search').oninput = renderMemories;
select('#memory-scope').onchange = renderMemories;
function formModel(): ModelProfile {
  return {
    protocol: 'openai-completions',
    provider: select('#provider').value === 'deepseek' ? 'deepseek' : 'openai-compatible',
    baseUrl: field('#base-url').value.trim(),
    model: field('#model-id').value.trim(),
    contextWindow: Number(field('#context-window').value),
    maxOutputTokens: Number(field('#output-tokens').value),
    thinking: select('#thinking').value as ModelProfile['thinking'],
    keyRequired: field('#key-required').checked,
  };
}
function sameEndpoint(a: string, b: string) {
  try {
    const identity = (v: string) => {
      const url = new URL(v);
      return url.origin + url.pathname.replace(/\/$/, '');
    };
    return identity(a) === identity(b);
  } catch {
    return false;
  }
}
function modelChanged() {
  if (!state) return false;
  const draft = formModel();
  const saved = state.config.model;
  return (
    !!field('#api-key').value.trim() ||
    (Object.keys(draft) as (keyof ModelProfile)[]).some((k) => draft[k] !== saved[k])
  );
}
function renderModelSettings() {
  if (!state) return;
  const current = state.config.model;
  const ready = modelReady(state);
  const editing = !ready || editingModel;
  $('#model-summary').classList.toggle('hidden', editing);
  $('#model-form').classList.toggle('hidden', !editing);
  $('#model-status').textContent = !ready
    ? '待配置'
    : editingModel
      ? '编辑中'
      : state.modelVerified
        ? '已配置 · 验证通过'
        : '已配置 · 待验证';
  $('#model-status').classList.toggle('online', ready && !editingModel && state.modelVerified);
  $('#current-model').textContent = current.model;
  const url = new URL(current.baseUrl);
  $('#current-endpoint').textContent = url.origin + url.pathname;
  $('#current-key').textContent = state.keyConfigured
    ? '已加密保存在本机'
    : current.keyRequired
      ? '尚未保存'
      : '此接口无需密钥';
  $('#model-retest').textContent = state.modelVerified ? '重新测试连接' : '测试连接';
  field('#model-retest').disabled = modelBusy;
  field('#model-edit').disabled = modelBusy;
  field('#setup-chat').disabled = modelBusy;
  $('#model-cancel').classList.toggle('hidden', !ready);
  $<HTMLFieldSetElement>('#model-fields').disabled = !editing || modelBusy;
  const m = formModel();
  const saved =
    state.keyConfigured &&
    current.provider === m.provider &&
    sameEndpoint(current.baseUrl, m.baseUrl);
  $('#model-key-label').classList.toggle('hidden', saved && !replacingModelKey);
  $('#model-replace-key').classList.toggle('hidden', !saved);
  $('#model-replace-key').textContent = replacingModelKey ? '保留已存密钥' : '更换密钥';
  $('#key-status').textContent = !state.vaultAvailable
    ? '本机凭据加密不可用，无法保存新的 API Key。'
    : saved
      ? '已为此地址保存密钥。'
      : m.keyRequired
        ? '首次使用此地址时请输入 API Key。留空会使用此前为此地址保存的密钥。'
        : '此接口允许免密访问，可留空。';
  field('#api-key').placeholder = saved ? '已保存' : m.keyRequired ? '输入 API Key' : '可选';
  const canSave = editing && !modelBusy && modelChanged();
  field('#model-test').disabled = !canSave;
  field('#model-save').disabled = !canSave;
}
function modelResult(message: string, error = false) {
  $('#model-result').textContent = message;
  $('#model-result').className =
    'model-result' + (message ? '' : ' hidden') + (error ? ' error' : '');
}
$('#model-form').oninput = () => {
  modelResult('');
  renderModelSettings();
};
$('#model-edit').onclick = () => {
  if (!state || modelBusy) return;
  fillModel(state.config.model);
  editingModel = true;
  modelResult('');
  renderModelSettings();
  select('#provider').focus();
};
$('#model-cancel').onclick = () => {
  if (!state || modelBusy) return;
  fillModel(state.config.model);
  editingModel = false;
  modelResult('');
  renderModelSettings();
  $('#model-edit').focus();
};
$('#model-replace-key').onclick = () => {
  field('#api-key').value = '';
  replacingModelKey = !replacingModelKey;
  renderModelSettings();
  if (replacingModelKey) field('#api-key').focus();
};
select('#provider').onchange = () => {
  const provider = select('#provider').value;
  field('#api-key').value = '';
  replacingModelKey = false;
  field('#base-url').value =
    provider === 'deepseek'
      ? 'https://api.deepseek.com'
      : provider === 'local'
        ? 'http://127.0.0.1:11434/v1'
        : '';
  field('#base-url').placeholder = 'https://…/v1';
  field('#model-id').value = provider === 'deepseek' ? 'deepseek-flash' : '';
  field('#model-id').placeholder =
    provider === 'local' ? '本机已安装的模型名称' : '服务商提供的模型 ID';
  field('#key-required').checked = provider !== 'local';
  $<HTMLDetailsElement>('#endpoint-options').open = provider !== 'deepseek';
  renderModelSettings();
};
field('#base-url').oninput = () => {
  field('#api-key').value = '';
  replacingModelKey = false;
};
async function testModelConnection() {
  modelResult('正在测试模型连接…');
  try {
    const result = await api.modelTest();
    if (!result.ok) throw new Error(result.detail || '服务未返回完整回复');
    modelResult('连接成功，可以开始聊天了。');
  } catch (error) {
    modelResult('连接测试失败。' + (error instanceof Error ? error.message : String(error)), true);
  }
  await refresh();
}
$('#model-retest').onclick = async () => {
  if (!state || !modelReady(state) || editingModel || modelBusy) return;
  modelBusy = true;
  renderModelSettings();
  try {
    await testModelConnection();
  } finally {
    modelBusy = false;
    renderModelSettings();
  }
};
$('#model-form').onsubmit = async (event) => {
  event.preventDefault();
  if (!state || modelBusy || (modelReady(state) && !editingModel) || !modelChanged()) return;
  const test = (event as SubmitEvent).submitter?.id !== 'model-save';
  const model = formModel();
  const key = field('#api-key').value.trim();
  if (model.maxOutputTokens >= model.contextWindow / 2) {
    $<HTMLDetailsElement>('#model-advanced').open = true;
    field('#output-tokens').focus();
    modelResult('最大输出需要小于上下文窗口的一半。', true);
    return;
  }
  const current = state.config.model;
  if (
    test &&
    model.keyRequired &&
    !key &&
    !state.keyConfigured &&
    model.provider === current.provider &&
    sameEndpoint(model.baseUrl, current.baseUrl)
  ) {
    field('#api-key').focus();
    modelResult('请输入当前模型服务的 API Key。', true);
    return;
  }
  modelBusy = true;
  renderModelSettings();
  modelResult(test ? '正在测试填写的模型…' : '正在保存…');
  try {
    state = test
      ? await api.testAndSaveModel(model, key || undefined)
      : await api.configure({ config: { model }, ...(key ? { apiKey: key } : {}) });
    fillModel(state.config.model);
    editingModel = false;
    render();
    if (test) {
      modelResult('模型已验证并保存，可以开始聊天了。');
    } else if (state.modelVerified) {
      modelResult('当前配置与已验证的模型一致。');
    } else {
      modelResult(modelReady(state) ? '模型配置已保存。' : '配置已保存。补充 API Key 后即可聊天。');
    }
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      '',
    );
    modelResult((test ? '测试并保存失败。' : '未能保存配置。') + detail, true);
  } finally {
    modelBusy = false;
    renderModelSettings();
  }
};
function qqList(value: string) {
  const values = value.split(/[,，;；\s]+/).filter(Boolean);
  if (values.some((v) => !/^\d{5,12}$/.test(v))) throw new Error('QQ／群号需为 5 至 12 位数字');
  return [...new Set(values)];
}
$('#onebot-form').onsubmit = (event) => {
  event.preventDefault();
  void act(async () => {
    const token = field('#qq-token').value.trim();
    const config = state!.config.onebot;
    const botQQ = field('#bot-qq').value.trim(),
      ownerQQ = field('#owner-qq').value.trim();
    if (!/^\d{5,12}$/.test(botQQ) || !/^\d{5,12}$/.test(ownerQQ) || botQQ === ownerQQ)
      throw new Error('请分别填写机器人和自己的 QQ 号，两者应为不同账号。');
    if (!token && (!state!.onebotTokenConfigured || config.url !== field('#qq-url').value.trim()))
      throw new Error('请填写这个服务的 Access Token。');
    await api.configure({
      config: {
        onebot: {
          ...config,
          enabled: field('#qq-enabled').checked,
          url: field('#qq-url').value.trim(),
          botQQ,
          ownerQQ,
        },
      },
      ...(token ? { onebotToken: token } : {}),
    });
    field('#qq-token').value = '';
    await api.connect();
  }, '已保存，正在核对机器人账号');
};
$('#qq-access').onsubmit = (event) => {
  event.preventDefault();
  void act(
    () =>
      api.configure({
        config: {
          onebot: {
            ...state!.config.onebot,
            users: qqList(field('#qq-users').value),
            groups: qqList(field('#qq-groups').value),
          },
        },
      }),
    '聊天名单已保存',
  );
};
$('#qq-reconnect').onclick = () => act(() => api.connect());
$('#disconnect').onclick = () => act(() => api.disconnect());
$('#sandbox-check').onclick = async () => {
  const button = $<HTMLButtonElement>('#sandbox-check');
  button.disabled = true;
  button.textContent = '正在检查…';
  try {
    await act(async () => {
      const result = await api.sandboxCheck();
      toast(
        result.available ? '隔离执行环境已准备好' : (result.reason ?? '不可用'),
        !result.available,
      );
    });
  } finally {
    button.disabled = false;
    button.textContent = '检查 Docker 与专用镜像';
  }
};
$('#import-skill').onclick = () =>
  act(async () => {
    await api.chooseSkill();
    await loadSkills();
  });
$('#open-data').onclick = () => act(() => api.openData());
$('#import-data').onclick = () =>
  act(async () => {
    const result = await api.chooseImport();
    if (result) toast(`已导入 ${result.messages} 条消息、${result.memories} 条记忆。`);
  });
field('#auto-memory').onchange = () =>
  act(() =>
    api.configure({
      config: { memory: { ...state!.config.memory, automatic: field('#auto-memory').checked } },
    }),
  );
field('#startup').onchange = () => act(() => api.loginStartup(field('#startup').checked));
void (async () => {
  await refresh();
  navigate(
    location.hash === '#napcat' ? 'connections' : state && !modelReady(state) ? 'settings' : 'chat',
  );
})();
