import type { AppSnapshot } from '../shared/types.js';

const api = window.chatds;
const node = (id: string) => document.getElementById(id)!;
const button = (id: string) => node(id) as HTMLButtonElement;
type Installation = AppSnapshot['napcatInstallation'];
let installation: Installation = null;
let busy = false;
let pairing = false;
let check: { online: boolean; detail: string } | undefined;
let note = '';
let failed = false;

function paint() {
  const configured = !!installation;
  node('napcat-directory').textContent = installation?.directory || '尚未选择';
  const badge = node('napcat-environment-state');
  badge.textContent = !configured
    ? '未选择目录'
    : !installation?.available
      ? '目录不可用'
      : check
        ? check.online
          ? 'WebUI 已就绪'
          : 'WebUI 未就绪'
        : '已保存目录';
  badge.classList.toggle('online', !!installation?.available && !!check?.online);
  button('napcat-installation').textContent = configured ? '更换目录' : '选择安装目录';
  button('napcat-installation').classList.toggle('primary', !configured);
  button('napcat-installation').disabled = busy || pairing;
  button('napcat-launch').classList.toggle('hidden', !installation?.canLaunch || !!check?.online);
  button('napcat-launch').disabled = busy || pairing;
  button('napcat-check').classList.toggle('hidden', !configured);
  button('napcat-check').disabled = busy;
  button('napcat-forget').classList.toggle('hidden', !configured);
  button('napcat-forget').disabled = busy || pairing;
  button('napcat-guide').disabled = busy;
  node('napcat-environment-note').textContent =
    note ||
    check?.detail ||
    (!installation
      ? '选择你安装 NapCat 的文件夹。还没安装时，可以先打开安装指南。'
      : !installation.available
        ? '已保存的目录不可用。请更换目录或取消关联。'
        : installation.canLaunch
          ? '可从这里启动 NapCat，然后在下方登录 QQ。'
          : '请使用原安装方式启动 NapCat，然后检查 WebUI。');
  node('napcat-environment-note').classList.toggle('error', failed);
}
function setInstallation(next: Installation) {
  if (installation?.directory !== next?.directory || installation?.available !== next?.available) {
    check = undefined;
    note = '';
    failed = false;
  }
  installation = next;
}
async function run(message: string, action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  failed = false;
  note = message;
  paint();
  try {
    await action();
  } catch (error) {
    note = (error instanceof Error ? error.message : String(error)).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      '',
    );
    failed = true;
  } finally {
    busy = false;
    paint();
  }
}
async function inspect() {
  const path = installation?.directory;
  if (!path) return;
  const result = await api.napcatCheck();
  if (installation?.directory === path) {
    check = result;
    note = result.detail;
  }
}
export function renderNapcatSettings(next: Installation) {
  setInstallation(next);
  paint();
}
export function setNapcatPairing(active: boolean) {
  pairing = active;
  paint();
}
button('napcat-installation').onclick = () =>
  void run('请选择 NapCat 安装目录。', async () => {
    const selected = await api.napcatChooseInstallation();
    note = '';
    if (!selected) return;
    setInstallation(selected);
  });
button('napcat-launch').onclick = () =>
  void run('正在启动 NapCat…', async () => {
    await api.napcatLaunch();
    check = undefined;
    note = '已发出启动请求。等 NapCat 启动完成后，点击「检查 WebUI」。';
  });
button('napcat-check').onclick = () => void run('正在检查本机 WebUI…', inspect);
button('napcat-forget').onclick = () =>
  void run('正在取消目录关联…', async () => {
    await api.napcatForgetInstallation();
    setInstallation(null);
  });
button('napcat-guide').onclick = () => void run('', () => api.napcatGuide());
