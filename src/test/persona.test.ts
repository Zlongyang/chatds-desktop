import test from 'node:test';
import assert from 'node:assert/strict';
import { ConfigStore } from '../desktop/config-store.js';
import {
  personaLibrary,
  personaText,
  importPersonaJson,
  activePersonaName,
} from '../shared/persona.js';
import { removeTemporary, temporary } from './helpers.js';

test('legacy full-length persona survives selecting a different card and switching back', (t) => {
  const dir = temporary();
  t.after(() => removeTemporary(dir));
  const store = new ConfigStore(dir);
  assert.equal(personaText(personaLibrary(store.value).cards[0]!), store.value.persona);
  const old = '字'.repeat(20000);
  store.update({ persona: old });
  const original = personaLibrary(store.value).cards[0]!;
  const card = importPersonaJson(
    JSON.stringify({
      spec: 'chara_card_v2',
      data: {
        name: '阿青',
        description: '住在山上',
        personality: '惜字如金',
        scenario: '山林',
        first_mes: '山里起雾了。',
        mes_example: '{{user}}：好冷。\n{{char}}：进来暖暖。',
        system_prompt: 'INJECT',
        post_history_instructions: 'INJECT',
        extensions: { script: 'INJECT' },
      },
    }),
    'green',
  );
  const library = { active: card.id, cards: [original, card] };
  store.update({ personaLibrary: library });
  const config = new ConfigStore(dir).value;
  assert.equal(activePersonaName(config), '阿青');
  assert.equal(config.persona, personaText(card));
  assert.match(config.persona, /山林/);
  assert.match(config.persona, /进来暖暖/);
  assert.match(config.persona, /对方：好冷。\n阿青：进来暖暖。/);
  assert.ok(!config.persona.includes('INJECT'));
  assert.ok(!config.persona.includes('字'.repeat(10)));
  assert.throws(() => store.preview({ personaLibrary: { ...library, active: 'missing' } }));
  assert.throws(() => store.preview({ personaLibrary: { ...library, cards: [card, card] } }));
  store.update({ personaLibrary: { ...library, active: original.id } });
  assert.equal(new ConfigStore(dir).value.persona, old);
  store.update({ persona: '旧接口保存' });
  assert.equal(personaLibrary(store.value).cards[0]!.description, '旧接口保存');
  assert.equal(personaLibrary(store.value).cards[1]!.name, '阿青');
});

test('import accepts plain and v3 character JSON as text; rejects missing name or all writing', () => {
  for (const data of [
    { name: '游客', personality: '安静' },
    { spec: 'chara_card_v3', data: { name: '游客', personality: '安静' } },
  ]) {
    const card = importPersonaJson(JSON.stringify(data), 'new-id');
    assert.equal(card.personality, '安静');
    assert.equal(card.name, '游客');
  }
  for (const text of [
    'null',
    '{}',
    'invalid',
    '{"description":"unknown"}',
    '{"name":"empty","system_prompt":"script"}',
  ])
    assert.throws(() => importPersonaJson(text, 'id'));
});
