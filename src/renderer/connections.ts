import type { AppSnapshot, NapCatLoginStatus } from '../shared/types.js';
import { setNapcatPairing } from './napcat-settings.js';

const api = window.chatds;
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => get<HTMLInputElement>(id);
const show = (id: string, visible: boolean) => get(id).classList.toggle('hidden', !visible);
let latest: AppSnapshot | undefined;
let session: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let pending = false;
let switching = false;
let attemptedDirectory: string | undefined;
let formVersion = '',
  listVersion = '';

function showError(error?: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  get('qq-error').textContent = message.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    '',
  );
  show('qq-error', !!message);
}
function configuredOneBot(s: AppSnapshot) {
  return !!(s.config.onebot.botQQ && s.onebotTokenConfigured);
}
export function hasQQChannel(s: AppSnapshot) {
  return (
    s.connection === 'online' && !!s.config.onebot.botQQ && s.account === s.config.onebot.botQQ
  );
}
function renderEntry() {
  if (!latest) return;
  const online = hasQQChannel(latest);
  const configured = configuredOneBot(latest);
  const canScan = !!latest.napcatInstallation?.available;
  const canConfigure = canScan || configured;
  setNapcatPairing(!!session);
  show('qq-status', canConfigure || !!session);
  show('napcat-choose', canScan);
  show('napcat-login-hint', canScan);
  show('qq-management', online);
  get('qq-layout').classList.toggle('optional-only', !online);
  get('qq-section-title').textContent = canConfigure || session ? 'QQ 登录与接入' : '其他接入方式';
  get('napcat-login-hint').textContent = '打开手机 QQ 扫码确认。登录状态仍有效时会自动连接。';
  show('napcat-entry', !session && (!configured || !online || switching));
  show('napcat-flow', !!session);
  show('qq-linked', configured && !session);
  show('qq-reconnect', !online && !['connecting', 'reconnecting'].includes(latest.connection));
  show('disconnect', latest.connection !== 'offline');
  show('qq-switch', canScan && configured && !session);
  get('qq-account').textContent =
    '机器人 QQ ' +
    (latest.account || latest.config.onebot.botQQ) +
    (latest.config.onebot.ownerQQ ? ' · 主号 ' + latest.config.onebot.ownerQQ : '');
  show('qq-continue', online);
  get('qq-continue').textContent =
    latest.keyConfigured || !latest.config.model.keyRequired ? '进入聊天' : '下一步：配置聊天模型';
  show('qq-desktop-only', !configured && !latest.napcatInstallation && !latest.napcatSetup?.busy);
}
export function renderConnections(s: AppSnapshot, visible = false) {
  const changed = latest?.napcatInstallation?.directory !== s.napcatInstallation?.directory;
  latest = s;
  if (changed && session) leaveConnections();
  const q = s.config.onebot;
  const next = JSON.stringify([q.url, q.botQQ, q.ownerQQ, q.enabled]);
  if (next !== formVersion) {
    field('qq-url').value = q.url;
    field('bot-qq').value = q.botQQ;
    field('owner-qq').value = q.ownerQQ;
    field('qq-owner-manage').value = q.ownerQQ;
    field('qq-enabled').checked = q.enabled;
    formVersion = next;
  }
  const lists = JSON.stringify([q.users, q.groups, q.friendChats]);
  if (lists !== listVersion) {
    field('qq-users').value = q.users.join(', ');
    field('qq-groups').value = q.groups.join(', ');
    field('qq-friend-chats').checked = !!q.friendChats;
    listVersion = lists;
  }
  renderEntry();
  if (!s.napcatInstallation) attemptedDirectory = undefined;
  if (
    visible &&
    !s.napcatSetup?.busy &&
    s.napcatInstallation?.available &&
    (!q.botQQ || q.enabled) &&
    !hasQQChannel(s) &&
    !session &&
    !pending &&
    s.napcatInstallation.directory !== attemptedDirectory
  ) {
    attemptedDirectory = s.napcatInstallation.directory;
    void begin();
  }
}
export function leaveConnections() {
  const previous = session;
  clearTimeout(timer);
  session = undefined;
  pending = false;
  switching = false;
  show('napcat-qr', false);
  get('napcat-qr').removeAttribute('src');
  field('napcat-link').value = '';
  if (previous) void api.napcatCancel(previous).catch(() => {});
  renderEntry();
}
async function display(id: string, status: NapCatLoginStatus) {
  clearTimeout(timer);
  const messages = {
    waiting: status.qr ? '用机器人账号的手机 QQ 扫描下方二维码。' : '正在等 NapCat 生成二维码…',
    scanned: '已扫码，请在手机 QQ 上确认登录。',
    initializing: 'QQ 已登录，正在等待 NapCat 准备消息接口…',
    ready: '已登录机器人 QQ ' + (status.botQQ ?? '') + '。',
    expired: '二维码已失效，点击刷新后重新扫码。',
  };
  get('napcat-state').textContent = status.detail || messages[status.phase];
  const image = get<HTMLImageElement>('napcat-qr');
  const qr =
    status.phase === 'waiting' && status.qr?.startsWith('data:image/png;base64,')
      ? status.qr
      : undefined;
  if (qr) {
    if (image.getAttribute('src') !== qr) image.src = qr;
  } else image.removeAttribute('src');
  show('napcat-qr', !!qr);
  show('napcat-renew', status.phase === 'waiting' || status.phase === 'expired');
  show('napcat-retry', false);
  if (status.phase === 'ready') {
    get('napcat-state').textContent = '手机已确认，正在核对账号并连接 QQ…';
    await api.napcatBind(id, switching);
    if (session === id) {
      leaveConnections();
      renderConnections(await api.state());
    }
    return;
  }
  if (status.phase !== 'expired') {
    timer = setTimeout(() => void poll(id), 2000);
  }
}
async function poll(id: string, renew = false) {
  if (id !== session || pending) return;
  clearTimeout(timer);
  pending = true;
  showError();
  try {
    const result = await api.napcatPoll(id, renew);
    if (session === id) await display(id, result);
  } catch (e) {
    if (session === id) {
      get('napcat-state').textContent = '暂时无法读取登录状态。';
      get('napcat-qr').removeAttribute('src');
      show('napcat-qr', false);
      show('napcat-renew', false);
      show('napcat-retry', true);
      showError(e);
    }
  } finally {
    if (session === id) pending = false;
  }
}
async function begin(link?: string) {
  if (session) return;
  const id = crypto.randomUUID();
  session = id;
  pending = true;
  showError();
  get('napcat-state').textContent =
    link || latest?.napcatInstallation
      ? '正在连接本机 NapCat…'
      : '请选择这次登录使用的 NapCat 目录。';
  for (const item of ['napcat-renew', 'napcat-retry', 'napcat-qr']) show(item, false);
  renderEntry();
  try {
    const status = await api.napcatBegin(id, link);
    if (session !== id) return;
    if (status) await display(id, status);
    else leaveConnections();
  } catch (e) {
    if (session === id) {
      leaveConnections();
      showError(e);
    }
  } finally {
    if (session === id) pending = false;
  }
}
get('napcat-choose').onclick = () => void begin();
get('napcat-link-form').onsubmit = (event) => {
  event.preventDefault();
  const link = field('napcat-link').value.trim();
  field('napcat-link').value = '';
  void begin(link);
};
get('napcat-renew').onclick = () => {
  if (session) void poll(session, true);
};
get('napcat-retry').onclick = () => {
  if (session) void poll(session);
};
get('napcat-cancel').onclick = () => {
  leaveConnections();
  showError();
};
get('qq-switch').onclick = () => {
  switching = true;
  void begin();
};
