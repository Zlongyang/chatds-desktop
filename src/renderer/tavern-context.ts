import type {
  AppConfig,
  AppSnapshot,
  ChatDSApi,
  ConversationRow,
  ConversationSettings,
} from '../shared/types.js';
import type { TavernContextLibrary } from '../shared/tavern-context.js';

type Kind = keyof TavernContextLibrary;
const empty: TavernContextLibrary = { userPersonas: [], worldEntries: [] };

export function tavernContextEditor(
  api: ChatDSApi,
  notify: (message: string, error?: boolean) => void,
) {
  const panel = document.getElementById('tavern-context')!;
  const field = <T extends HTMLElement>(id: string) => panel.querySelector<T>('#tavern-' + id)!;
  const room = field<HTMLSelectElement>('room'),
    user = field<HTMLSelectElement>('user');
  const kind = field<HTMLSelectElement>('kind'),
    entry = field<HTMLSelectElement>('entry');
  const name = field<HTMLInputElement>('name'),
    text = field<HTMLTextAreaElement>('text');
  const form = field<HTMLFormElement>('form'),
    remove = field<HTMLButtonElement>('delete');
  let config: AppConfig,
    rooms: readonly ConversationRow[] = [],
    currentChat = '',
    signature = '';
  let editing = '',
    originalName = '',
    originalText = '',
    previousKind: Kind = 'userPersonas',
    busy = false;
  const library = () => config.tavernContext ?? empty;
  const currentKind = () => kind.value as Kind;
  const changed = () => name.value !== originalName || text.value !== originalText;
  const canDiscard = () => !changed() || window.confirm('放弃这条资料未保存的修改？');
  function loadEntry(id: string) {
    const item = library()[currentKind()].find((row) => row.id === id);
    editing = entry.value = item?.id ?? '';
    name.value = originalName = item?.name ?? '';
    text.value = originalText = item?.text ?? '';
    remove.disabled = !item;
    text.placeholder =
      currentKind() === 'userPersonas'
        ? '例如，我叫阿舟，喜欢被称作舟舟。'
        : '例如，故事里的旧书店只在下雨天开门。';
  }
  function libraryOptions() {
    const rows = library()[currentKind()];
    entry.replaceChildren(
      new Option('新建条目', ''),
      ...rows.map((row) => new Option(row.name, row.id)),
    );
    entry.value = editing;
    if (!changed() || (editing && !rows.some((row) => row.id === editing))) loadEntry(editing);
  }
  function sessionOptions() {
    const id = room.value;
    const isOwner =
      id === 'desktop:owner' ||
      (!!config.onebot.ownerQQ && id === 'onebot:private:' + config.onebot.ownerQQ);
    field('owner-field').classList.toggle('hidden', !isOwner);
    field('owner-note').classList.toggle('hidden', isOwner);
    const settings = config.conversations[id];
    user.replaceChildren(
      new Option('不使用', ''),
      ...library().userPersonas.map((row) => new Option(row.name, row.id)),
    );
    user.value = isOwner ? (settings?.userPersonaId ?? '') : '';
    const world = field('world');
    world.replaceChildren();
    const selected = settings?.worldEntryIds ?? [];
    for (const item of library().worldEntries) {
      const label = document.createElement('label'),
        box = document.createElement('input');
      label.className = 'check';
      box.type = 'checkbox';
      box.checked = selected.includes(item.id);
      box.onchange = () =>
        void saveSelection({
          worldEntryIds: box.checked
            ? [...selected, item.id]
            : selected.filter((key) => key !== item.id),
        });
      label.append(box, document.createTextNode(item.name));
      world.append(label);
    }
    const total = library().worldEntries.reduce(
      (sum, row) => sum + (selected.includes(row.id) ? row.text.length : 0),
      0,
    );
    if (!library().worldEntries.length || total > 4000) {
      const note = document.createElement('small');
      note.className = 'muted';
      note.textContent =
        total > 4000
          ? '已选内容超过 4000 字，模型将按选择顺序读取前 4000 字。'
          : '暂无世界条目，可在下方资料库中添加。';
      world.append(note);
    }
  }
  function render(next: AppConfig, roomId: string, knownRooms: readonly ConversationRow[] = rooms) {
    if (config && next.revision < config.revision) return;
    config = next;
    rooms = knownRooms;
    const labels = new Map([['desktop:owner', '桌面聊天']]);
    if (config.onebot.enabled) {
      for (const id of [...Object.keys(config.conversations), roomId]) {
        const match = /^onebot:(group|private):(\d{5,12})$/.exec(id);
        if (match) labels.set(id, (match[1] === 'group' ? '群 ' : 'QQ 私聊 ') + match[2]);
      }
      for (const row of rooms) if (row.id !== 'desktop:owner') labels.set(row.id, row.name);
    }
    const nextSignature = JSON.stringify([config.revision, roomId, [...labels]]);
    if (nextSignature === signature) return;
    const target =
      currentChat === roomId && labels.has(room.value)
        ? room.value
        : labels.has(roomId)
          ? roomId
          : 'desktop:owner';
    signature = nextSignature;
    currentChat = roomId;
    room.replaceChildren(...[...labels].map(([id, title]) => new Option(title, id)));
    room.value = target;
    sessionOptions();
    libraryOptions();
  }
  async function commit(operation: () => Promise<AppSnapshot>, message: string, then?: () => void) {
    if (busy) return;
    busy = true;
    panel.inert = true;
    try {
      const snapshot = await operation();
      render(snapshot.config, currentChat, snapshot.rooms);
      then?.();
      notify(message);
    } catch (error) {
      sessionOptions();
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      panel.inert = false;
      busy = false;
    }
  }
  async function saveSelection(change: Partial<ConversationSettings>) {
    const id = room.value,
      label = room.selectedOptions[0]?.textContent;
    await commit(
      async () => {
        await api.conversation(id, change);
        return api.state();
      },
      '已更新「' + label + '」的会话资料',
    );
  }
  room.onchange = sessionOptions;
  user.onchange = () => void saveSelection({ userPersonaId: user.value || null });
  kind.onchange = () => {
    if (!canDiscard()) {
      kind.value = previousKind;
      return;
    }
    previousKind = currentKind();
    loadEntry('');
    libraryOptions();
  };
  entry.onchange = () => {
    if (!canDiscard()) {
      entry.value = editing;
      return;
    }
    loadEntry(entry.value);
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const rows = library()[currentKind()];
    const value = {
      id: editing || crypto.randomUUID(),
      name: name.value.trim(),
      text: text.value.trim(),
    };
    if (!value.name || !value.text) {
      notify('请填写名称和内容。', true);
      return;
    }
    if (!editing && rows.length >= 40) {
      notify('每类资料最多可保存 40 条。', true);
      return;
    }
    const next = {
      ...library(),
      [currentKind()]: editing
        ? rows.map((row) => (row.id === editing ? value : row))
        : [...rows, value],
    };
    void commit(
      () => api.configure({ config: { tavernContext: next } }),
      '资料已保存',
      () => {
        libraryOptions();
        loadEntry(value.id);
      },
    );
  };
  remove.onclick = () => {
    if (!editing || !window.confirm('删除「' + originalName + '」并从使用它的会话中移除？')) return;
    const next = {
      ...library(),
      [currentKind()]: library()[currentKind()].filter((item) => item.id !== editing),
    };
    void commit(
      () => api.configure({ config: { tavernContext: next } }),
      '资料已删除',
      () => {
        loadEntry('');
        libraryOptions();
      },
    );
  };
  return { render };
}
