import {
  MAX_PERSONA_CARDS,
  MAX_PERSONA_TEXT,
  personaLibrary,
  personaText,
} from '../shared/persona.js';
import type { AppConfig, ChatDSApi, PersonaCard } from '../shared/types.js';

export function personaEditor(api: ChatDSApi, notify: (message: string, error?: boolean) => void) {
  const panel = document.getElementById('page-persona')!;
  const find = <T extends HTMLElement = HTMLElement>(selector: string) =>
    panel.querySelector<T>(selector)!;
  const button = (id: string) => find<HTMLButtonElement>(id);
  const fields = {
    name: find<HTMLInputElement>('#persona-name'),
    avatar: find<HTMLInputElement>('#persona-avatar'),
    creator: find<HTMLInputElement>('#persona-creator'),
    description: find<HTMLTextAreaElement>('#persona'),
    personality: find<HTMLTextAreaElement>('#persona-style'),
    scenario: find<HTMLTextAreaElement>('#persona-scenario'),
    greeting: find<HTMLTextAreaElement>('#persona-greeting'),
    examples: find<HTMLTextAreaElement>('#persona-examples'),
  };
  const fieldNames = Object.keys(fields) as (keyof typeof fields)[];
  const form = find<HTMLFormElement>('#persona-form');
  const workspace = find('.persona-workspace');
  const confirm = find<HTMLDialogElement>('#persona-confirm');
  const list = find('#persona-list');
  button('#persona-context-link').onclick = () => {
    const context = find('#tavern-context');
    context.scrollIntoView({ block: 'start' });
    context.querySelector('select')?.focus({ preventScroll: true });
  };
  const apply = button('#apply-persona'),
    save = button('#save-persona');
  const remove = button('#delete-persona'),
    revert = button('#revert-persona');
  const add = button('#new-persona'),
    load = button('#import-persona');
  const exports = { json: button('#export-persona-json'), png: button('#export-persona-png') };
  let library: NonNullable<AppConfig['personaLibrary']>;
  let selected: PersonaCard;
  let revision = 0,
    signature = '';

  function read(): PersonaCard {
    const card = { ...selected };
    for (const key of fieldNames) card[key] = fields[key].value;
    return card;
  }
  function changed() {
    return fieldNames.some((key) => fields[key].value !== (selected[key] || ''));
  }
  function saved(id: string) {
    return library.cards.find((card) => card.id === id);
  }
  function avatar(host: HTMLElement, card: PersonaCard) {
    // Only sanitized, locally stored PNG previews may become an image source.
    if (
      card.portrait &&
      card.portrait.length <= 43700 &&
      /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(card.portrait)
    ) {
      const src = 'data:image/png;base64,' + card.portrait;
      if (host.firstElementChild?.getAttribute('src') === src) return;
      const img = document.createElement('img');
      img.alt = '';
      img.src = src;
      host.replaceChildren(img);
    } else {
      host.textContent =
        card.avatar?.trim() ||
        (card.id === 'original' ? '🐟' : Array.from(card.name.trim())[0]) ||
        '＋';
    }
  }
  function renderList() {
    const choices = saved(selected.id) ? library.cards : [...library.cards, selected];
    find('#persona-count').textContent = library.cards.length + ' 张';
    list.replaceChildren(
      ...choices.map((card) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'persona-choice';
        row.dataset.personaId = card.id;
        row.setAttribute('aria-pressed', String(card.id === selected.id));
        const icon = document.createElement('span');
        icon.className = 'persona-avatar';
        icon.setAttribute('aria-hidden', 'true');
        avatar(icon, card);
        const copy = document.createElement('span');
        copy.className = 'persona-choice-copy';
        const title = document.createElement('strong');
        title.textContent = card.name || '新角色卡';
        const caption = document.createElement('small');
        caption.textContent =
          card.id === library.active
            ? '默认角色'
            : !saved(card.id)
              ? '未保存'
              : card.creator?.trim() || card.description.trim() || '已保存';
        copy.append(title, caption);
        row.append(icon, copy);
        row.onclick = async () => {
          if (card.id !== selected.id && (await canLeave())) {
            edit(card);
            list
              .querySelector<HTMLButtonElement>('[aria-pressed="true"]')
              ?.focus({ preventScroll: true });
          }
        };
        return row;
      }),
    );
    add.disabled = load.disabled = library.cards.length >= MAX_PERSONA_CARDS;
    const hint = add.disabled ? '角色卡已达 ' + MAX_PERSONA_CARDS + ' 张，请先删除一张。' : '';
    add.title = hint;
    load.title = hint || '选择酒馆 JSON 或 PNG 角色卡';
  }
  function update() {
    const card = read();
    const prompt = personaText(card);
    const isNew = !saved(card.id),
      dirty = changed(),
      isDefault = card.id === library.active;
    const hasWriting = [
      card.description,
      card.personality,
      card.examples,
      card.scenario,
      card.greeting,
    ].some((value) => value?.trim());
    const invalid = !card.name.trim()
      ? '请填写角色名字。'
      : !hasWriting
        ? '请至少填写一项角色资料或对话内容。'
        : prompt.length > MAX_PERSONA_TEXT
          ? '角色资料超过 20000 字符，请精简后保存。'
          : '';
    const title = card.name.trim() || '新角色卡';
    find('#persona-title').textContent = title;
    if (isNew) {
      const row = list.querySelector<HTMLElement>('[aria-pressed="true"]')!;
      row.querySelector('strong')!.textContent = title;
      avatar(row.querySelector('.persona-avatar')!, card);
    }
    avatar(find('#persona-avatar-preview'), card);
    find('#persona-role').textContent = isNew ? '草稿' : isDefault ? '默认角色' : '库中角色';
    find('#persona-preview').textContent = prompt || '填写角色资料后可在这里预览。';
    find('#persona-status').textContent =
      invalid || (isNew ? '保存后加入卡库' : dirty ? '有未保存的修改' : '已保存');
    save.disabled = Boolean(invalid) || (!dirty && !isNew);
    for (const exportButton of Object.values(exports)) exportButton.disabled = Boolean(invalid);
    apply.hidden = isDefault;
    apply.disabled = isNew || dirty;
    apply.title = apply.disabled ? '请先保存角色卡。' : '用于跟随默认角色的对话';
    revert.hidden = !isNew && !dirty;
    revert.textContent = isNew ? '取消草稿' : '撤销修改';
    remove.hidden = isNew;
    remove.disabled = isDefault;
    remove.title = isDefault ? '请先将另一张角色卡设为默认。' : '';
  }
  function showTab(active: string) {
    for (const tab of panel.querySelectorAll<HTMLButtonElement>('[data-persona-tab]')) {
      const selectedTab = tab.dataset.personaTab === active;
      tab.setAttribute('aria-pressed', String(selectedTab));
      find('#' + tab.getAttribute('aria-controls')).hidden = !selectedTab;
    }
  }
  function edit(card: PersonaCard, resetTab = true) {
    selected = card;
    for (const key of fieldNames) fields[key].value = card[key] || '';
    if (resetTab) showTab('profile');
    renderList();
    update();
  }
  function ask(question: string, action: string): Promise<boolean> {
    find('#persona-confirm-title').textContent = question;
    button('#persona-confirm-action').textContent = action;
    confirm.returnValue = '';
    return new Promise((resolve) => {
      confirm.addEventListener('close', () => resolve(confirm.returnValue === 'confirm'), {
        once: true,
      });
      confirm.showModal();
    });
  }
  function canLeave() {
    return (
      (!changed() && (Boolean(saved(selected.id)) || !selected.name)) ||
      ask('放弃这张卡未保存的修改？', '放弃修改')
    );
  }
  function render(config: AppConfig) {
    if (revision >= config.revision) return;
    revision = config.revision;
    const next = personaLibrary(config);
    const nextSignature = JSON.stringify(next);
    if (nextSignature === signature) return;
    const editing = selected && (!saved(selected.id) || changed());
    library = next;
    signature = nextSignature;
    if (editing) {
      renderList();
      update();
    } else {
      edit((selected && saved(selected.id)) || saved(library.active)!, !selected);
    }
  }
  async function action(work: () => Promise<void>) {
    if (workspace.inert) return;
    workspace.inert = true;
    try {
      await work();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      workspace.inert = false;
    }
  }
  async function persist(next: typeof library, selectedId: string) {
    const result = await api.configure({ config: { personaLibrary: next } });
    render(result.config);
    edit(saved(selectedId) || saved(library.active)!, false);
  }
  for (const tab of panel.querySelectorAll<HTMLButtonElement>('[data-persona-tab]'))
    tab.onclick = () => showTab(tab.dataset.personaTab!);
  add.onclick = async () => {
    if (!(await canLeave())) return;
    edit({ id: crypto.randomUUID(), name: '', description: '', personality: '', examples: '' });
    fields.name.focus();
  };
  load.onclick = () =>
    void action(async () => {
      const card = await api.importPersonaCard();
      if (card && (await canLeave())) edit(card);
    });
  for (const format of ['json', 'png'] as const)
    exports[format].onclick = () =>
      void action(async () => {
        if (await api.exportPersonaCard(read(), format))
          find('#persona-status').textContent = '已导出 ' + format.toUpperCase() + ' 角色卡。';
      });
  form.oninput = update;
  form.onsubmit = (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const card = read();
    const cards = saved(card.id)
      ? library.cards.map((existing) => (existing.id === card.id ? card : existing))
      : [...library.cards, card];
    void action(() => persist({ active: library.active, cards }, card.id));
  };
  apply.onclick = () =>
    void action(async () => {
      await persist({ ...library, active: selected.id }, selected.id);
    });
  revert.onclick = async () => {
    if (await canLeave()) edit(saved(selected.id) || saved(library.active)!, false);
  };
  remove.onclick = async () => {
    if (
      selected.id === library.active ||
      !(await ask('删除角色卡「' + selected.name + '」？', '删除角色卡'))
    )
      return;
    const cards = library.cards.filter((card) => card.id !== selected.id);
    void action(() => persist({ active: library.active, cards }, library.active));
  };
  return render;
}
