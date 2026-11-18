import {
  importPersonaJson,
  MAX_PERSONA_CARDS,
  MAX_PERSONA_TEXT,
  personaLibrary,
  personaText,
} from '../shared/persona.js';
import type { AppConfig, PersonaCard, ChatDSApi } from '../shared/types.js';

export function personaEditor(api: ChatDSApi, notify: (message: string, error?: boolean) => void) {
  const panel = document.getElementById('page-persona')!;
  const form = panel.querySelector<HTMLFormElement>('#persona-form')!;
  const list = panel.querySelector<HTMLSelectElement>('#persona-list')!;
  const file = panel.querySelector<HTMLInputElement>('#persona-file')!;
  const name = panel.querySelector<HTMLInputElement>('#persona-name')!;
  const description = panel.querySelector<HTMLTextAreaElement>('#persona')!;
  const style = panel.querySelector<HTMLTextAreaElement>('#persona-style')!;
  const examples = panel.querySelector<HTMLTextAreaElement>('#persona-examples')!;
  const save = panel.querySelector<HTMLButtonElement>('#save-persona')!;
  const revert = panel.querySelector<HTMLButtonElement>('#revert-persona')!;
  const remove = panel.querySelector<HTMLButtonElement>('#delete-persona')!;
  let library: ReturnType<typeof personaLibrary>,
    draft: PersonaCard,
    revision = 0;
  let savedSignature = '';

  function read(): PersonaCard {
    return {
      id: draft.id,
      name: name.value,
      description: description.value,
      personality: style.value,
      examples: examples.value,
    };
  }
  function dirty() {
    return JSON.stringify(read()) !== JSON.stringify(draft);
  }
  function isDraft() {
    return !library.cards.some((card) => card.id === draft.id);
  }
  function update() {
    const card = read();
    const prompt = personaText(card);
    const active = library.active === card.id;
    const changed = dirty();
    const newCard = isDraft();
    const valid =
      card.name.trim() &&
      (card.description.trim() || card.personality.trim() || card.examples.trim()) &&
      prompt.length <= MAX_PERSONA_TEXT;
    panel.querySelector('#persona-preview')!.textContent = prompt;
    panel.querySelector('#persona-status')!.textContent =
      prompt.length > MAX_PERSONA_TEXT
        ? '资料超过 20000 字符，请精简后保存。'
        : !valid
          ? '请填写角色名字，以及至少一项角色资料。'
          : changed || newCard
            ? '草稿 · 保存后用于桌面和 QQ 的后续回复'
            : active
              ? '桌面和 QQ 正在使用'
              : '使用后从下一次模型请求生效';
    save.textContent = active ? '保存修改' : newCard || changed ? '保存并使用' : '使用这张卡';
    save.disabled = !valid || (active && !changed);
    remove.hidden = active || newCard;
    revert.hidden = !(changed || newCard);
    revert.textContent = newCard ? '取消新建' : '撤销编辑';
  }
  function edit(card: PersonaCard) {
    draft = card;
    const choices = library.cards.map(
      (c) => new Option(c.name + (c.id === library.active ? ' · 使用中' : ''), c.id),
    );
    if (isDraft()) choices.push(new Option((card.name || '新角色卡') + ' · 草稿', card.id));
    list.replaceChildren(...choices);
    list.value = draft.id;
    name.value = card.name;
    description.value = card.description;
    style.value = card.personality;
    examples.value = card.examples;
    update();
  }
  function current() {
    return library.cards.find((card) => card.id === library.active)!;
  }
  function canLeave() {
    return (
      !(dirty() || (isDraft() && !!draft.name)) || window.confirm('放弃这张角色卡未保存的修改？')
    );
  }
  function canAdd() {
    if (library.cards.length < MAX_PERSONA_CARDS) return true;
    notify('最多保存 ' + MAX_PERSONA_CARDS + ' 张角色卡，请先删除闲置的卡。', true);
    return false;
  }
  function render(config: AppConfig) {
    if (config.revision <= revision) return;
    revision = config.revision;
    const next = personaLibrary(config);
    const signature = JSON.stringify(next);
    if (signature === savedSignature) return;
    savedSignature = signature;
    library = next;
    edit(current());
  }
  async function persist(next: typeof library) {
    panel.inert = true;
    try {
      const snapshot = await api.configure({ config: { personaLibrary: next } });
      render(snapshot.config);
      edit(current());
      notify('当前角色：' + current().name);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    } finally {
      panel.inert = false;
    }
  }
  list.onchange = () => {
    if (!canLeave()) {
      list.value = draft.id;
      return;
    }
    const selected = library.cards.find((card) => card.id === list.value);
    if (selected) edit(selected);
  };
  panel.querySelector<HTMLButtonElement>('#new-persona')!.onclick = () => {
    if (!canAdd() || !canLeave()) return;
    edit({ id: crypto.randomUUID(), name: '', description: '', personality: '', examples: '' });
    name.focus();
  };
  panel.querySelector<HTMLButtonElement>('#import-persona')!.onclick = () => {
    if (canAdd()) file.click();
  };
  file.onchange = async () => {
    const chosen = file.files?.[0];
    file.value = '';
    if (!chosen) return;
    try {
      if (chosen.size > 2 * 1024 * 1024) throw new Error('请选择小于 2 MiB 的 JSON 角色卡。');
      const card = importPersonaJson(await chosen.text(), crypto.randomUUID());
      if (canLeave()) {
        edit(card);
        notify('已读取角色资料。确认内容后点「保存并使用」。');
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    }
  };
  form.oninput = update;
  form.onsubmit = (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const card = read();
    const cards = isDraft()
      ? [...library.cards, card]
      : library.cards.map((c) => (c.id === card.id ? card : c));
    void persist({ active: card.id, cards });
  };
  revert.onclick = () => {
    if (canLeave()) edit(isDraft() ? current() : draft);
  };
  remove.onclick = () => {
    if (draft.id === library.active || !window.confirm('删除角色卡「' + draft.name + '」？'))
      return;
    void persist({
      active: library.active,
      cards: library.cards.filter((card) => card.id !== draft.id),
    });
  };
  return render;
}
