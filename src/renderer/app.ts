import type {
  AppSnapshot,
  ChatMessage,
  MemoryFact,
  SkillInfo,
  ConversationSettings,
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
  connections: '连接与近况',
  memory: '记得的小事',
  persona: '小鱼的性格',
  tools: '工具与技能',
  settings: '设置',
};
const navLabels: Record<string, string> = {
  chat: '聊天',
  connections: '连接',
  memory: '记忆',
  persona: '人设',
  tools: '工具',
  settings: '设置',
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
  formsLoaded = false,
  personaLoaded = false;
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
  page = next;
  for (const key of Object.keys(titles)) $('#page-' + key).classList.toggle('hidden', key !== page);
  $('#page-title').textContent = titles[page]!;
  document
    .querySelectorAll<HTMLButtonElement>('[data-page]')
    .forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  render();
  if (page === 'memory') void loadMemories();
  if (page === 'tools') void loadSkills();
}
for (const [key, label] of Object.entries(navLabels)) {
  const b = el('button');
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
function chooseRoom(key: string) {
  roomId = key;
  historyVersion = '';
  navigate('chat');
}
function roomSettings(): ConversationSettings {
  return state?.config.conversations[roomId] ?? { mode: 'companion', ambient: false, muted: false };
}
function render() {
  if (!state) return;
  const s = state;
  $('#test-badge').classList.toggle('hidden', !s.testMode);
  $('#model-badge').textContent =
    s.keyConfigured || !s.config.model.keyRequired ? s.config.model.model : '先连接模型';
  $('#pause').textContent = s.config.enabled ? '暂停回复' : '恢复回复';
  $('#side-status').textContent = s.config.enabled ? '● 本机运行' : '○ 回复已暂停';
  $('#qq-status').textContent = statuses[s.connection] ?? s.connection;
  $('#qq-status').className = s.connection === 'online' ? 'badge online' : 'badge';
  $('#room-count').textContent = String(s.rooms.length);
  $('#local-room').classList.toggle('active', roomId === 'desktop:owner');
  const rooms = $('#rooms');
  rooms.replaceChildren();
  for (const row of s.rooms.filter((r) => r.id !== 'desktop:owner').slice(0, 100)) {
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
  if (!personaLoaded) {
    field('#persona').value = s.config.persona;
    personaLoaded = true;
    $('#persona-count').textContent = s.config.persona.length + ' 字符';
  }
  $('#key-status').textContent = !s.vaultAvailable
    ? '本机凭据加密不可用，请查看故障说明。'
    : s.keyConfigured
      ? '已为当前模型地址保存密钥；输入框不会回读密钥。'
      : '当前模型地址尚未保存密钥。';
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
  if (page === 'tools') renderTools();
}
function fillForms(s: AppSnapshot) {
  const m = s.config.model,
    q = s.config.onebot;
  select('#provider').value = m.provider;
  field('#model-id').value = m.model;
  field('#base-url').value = m.baseUrl;
  field('#context-window').value = String(m.contextWindow);
  field('#output-tokens').value = String(m.maxOutputTokens);
  select('#thinking').value = m.thinking;
  field('#key-required').checked = m.keyRequired;
  field('#qq-url').value = q.url;
  field('#bot-qq').value = q.botQQ;
  field('#owner-qq').value = q.ownerQQ;
  field('#qq-users').value = q.users.join(', ');
  field('#qq-groups').value = q.groups.join(', ');
  field('#qq-enabled').checked = q.enabled;
  field('#auto-memory').checked = s.config.memory.automatic;
  field('#startup').checked = s.loginStartup;
}
function renderApprovals() {
  const holder = $('#approvals');
  holder.replaceChildren();
  for (const a of state!.approvals) {
    const card = el('article', 'approval');
    card.append(
      el('h3', '', a.summary),
      el('small', 'muted', '仅确认下面这一次操作；更改权限或停止任务会取消确认。'),
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
  $('#chat-phase').textContent =
    room?.error ?? (waiting ? '等待你的确认' : phases[room?.phase ?? 'idle']!);
  select('#mode').value = settings.mode;
  field('#ambient').checked = settings.ambient;
  field('#muted').checked = settings.muted;
  $('#group-options').classList.toggle('hidden', !room?.isGroup);
  field('#message').disabled = !local;
  field('#send').disabled = !local || !s.config.enabled;
  field('#message').placeholder = local ? '跟小鱼说句话…' : '在 QQ 中发消息，这里同步显示记录';
  $('#chat-hint').textContent = local
    ? 'Enter 发送，Shift + Enter 换行'
    : '这里不会代你发 QQ 消息，请在 QQ 中交流。';
  $('#stop').toggleAttribute('disabled', !room || room.phase === 'idle');
  const signature = roomId + ':' + (room?.updatedAt ?? 0);
  if (signature !== historyVersion) {
    historyVersion = signature;
    void loadHistory(roomId);
  }
  $('#draft').classList.toggle('hidden', !room || room.phase === 'idle' || !!room.error);
  $('#draft').textContent = room?.draft || phases[room?.phase ?? 'idle']!;
}
async function loadHistory(key: string) {
  const request = ++requestVersion;
  try {
    const messages = await api.history(key);
    if (request !== requestVersion || key !== roomId) return;
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
    if (nearBottom || request === 1) box.scrollTop = box.scrollHeight;
  } catch (error) {
    toast(String(error), true);
  }
}
function messageNode(message: ChatMessage) {
  const row = el('div', 'message ' + message.role),
    body = el('div', 'message-body');
  body.append(
    el('div', 'message-name', message.role === 'assistant' ? '小鱼' : message.name),
    el('div', 'bubble', message.text),
  );
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
function renderTools() {
  const host = $('#tools');
  host.replaceChildren();
  for (const [key, enabled] of Object.entries(state!.config.tools)) {
    const tool = key as ToolId,
      row = el('div', 'tool-row'),
      copy = el('div');
    copy.append(el('p', '', toolLabels[tool]), el('code', '', key));
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = enabled;
    input.setAttribute('aria-label', toolLabels[tool]);
    input.onchange = () =>
      act(() =>
        api.configure({ config: { tools: { ...state!.config.tools, [tool]: input.checked } } }),
      );
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
    const button = el('button', '', '查看并处理');
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
  if (!text) return;
  input.value = '';
  void act(() => api.chat(text));
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
$('#persona').oninput = () =>
  ($('#persona-count').textContent = field('#persona').value.length + ' 字符');
$('#save-persona').onclick = () =>
  act(() => api.configure({ config: { persona: field('#persona').value } }), '人设已保存');
field('#memory-search').oninput = renderMemories;
select('#memory-scope').onchange = renderMemories;
select('#provider').onchange = () => {
  field('#api-key').value = '';
  if (select('#provider').value === 'deepseek') {
    field('#base-url').value = 'https://api.deepseek.com';
    field('#model-id').value = 'deepseek-flash';
  } else {
    field('#base-url').value = 'http://127.0.0.1:11434/v1';
    field('#model-id').value = '';
    field('#key-required').checked = false;
  }
};
$('#model-form').onsubmit = (event) => {
  event.preventDefault();
  void act(async () => {
    const key = field('#api-key').value.trim();
    await api.configure({
      config: {
        model: {
          protocol: 'openai-completions',
          provider: select('#provider').value as 'deepseek' | 'openai-compatible',
          baseUrl: field('#base-url').value.trim(),
          model: field('#model-id').value.trim(),
          contextWindow: Number(field('#context-window').value),
          maxOutputTokens: Number(field('#output-tokens').value),
          thinking: select('#thinking').value as 'off' | 'low' | 'high',
          keyRequired: field('#key-required').checked,
        },
      },
      ...(key ? { apiKey: key } : {}),
    });
    field('#api-key').value = '';
    formsLoaded = false;
  }, '模型配置已保存');
};
$('#model-test').onclick = () =>
  act(async () => {
    const button = $('#model-test') as HTMLButtonElement;
    button.disabled = true;
    try {
      const result = await api.modelTest();
      if (!result.ok) throw new Error(result.detail);
      toast('模型连接成功：' + result.detail);
    } finally {
      button.disabled = false;
    }
  });
function qqList(value: string) {
  const values = value.split(/[,，;；\s]+/).filter(Boolean);
  if (values.some((v) => !/^\d{5,12}$/.test(v))) throw new Error('QQ／群号需为 5 至 12 位数字');
  return [...new Set(values)];
}
$('#onebot-form').onsubmit = (event) => {
  event.preventDefault();
  void act(async () => {
    const token = field('#qq-token').value.trim();
    await api.configure({
      config: {
        onebot: {
          enabled: field('#qq-enabled').checked,
          url: field('#qq-url').value.trim(),
          botQQ: field('#bot-qq').value.trim(),
          ownerQQ: field('#owner-qq').value.trim(),
          users: qqList(field('#qq-users').value),
          groups: qqList(field('#qq-groups').value),
        },
      },
      ...(token ? { onebotToken: token } : {}),
    });
    field('#qq-token').value = '';
    formsLoaded = false;
  }, 'QQ 连接信息已保存');
};
$('#connect').onclick = () => act(() => api.connect());
$('#disconnect').onclick = () => act(() => api.disconnect());
$('#sandbox-check').onclick = () =>
  act(async () => {
    const result = await api.sandboxCheck();
    toast(
      result.available ? '隔离执行环境已准备好' : (result.reason ?? '不可用'),
      !result.available,
    );
  });
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
  navigate(state && !state.keyConfigured && state.config.model.keyRequired ? 'settings' : 'chat');
})();
