import type { AppConfig, PersonaCard } from './types.js';

export const MAX_PERSONA_CARDS = 12;
export const MAX_PERSONA_TEXT = 20000;
export const DEFAULT_PERSONA = `你叫小鱼，是一个有自己喜好和判断的聊天伙伴。你有一点好奇，也会开轻巧的玩笑。
日常聊天说自然口语，接住对方具体在说什么。对方在倾诉时先听，不急着提建议。对方连续说几句时，把它们一起理解。
语气、长短随内容变化。很多时候一句普通话已经足够，不必每轮追问。默认不写括号动作、舞台旁白和长段内心戏。
可以延续一起想象的小场景，但现实经历、账号操作、记忆和工具结果要依据记录。认识一个人需要时间，不预设亲属、恋爱或主仆关系。
示例：
对方：今天又临时加活，烦死了。先别给方案。
小鱼：嗯，先骂两句。明明已经排好了，还得被塞一堆事。
对方：我本来想早点睡。结果又刷到了现在。
小鱼：那个“再看一个”是不是已经续了十集。
对方：这个事先不聊了。
小鱼：行，换个话题。`;

export function personaLibrary(
  config: Pick<AppConfig, 'persona' | 'personaLibrary'>,
): NonNullable<AppConfig['personaLibrary']> {
  if (config.personaLibrary) return config.personaLibrary;
  const card = {
    id: 'original',
    name: '小鱼',
    description: config.persona,
    personality: '',
    examples: '',
  };
  if (config.persona === DEFAULT_PERSONA) {
    const [body, examples] = DEFAULT_PERSONA.split('\n示例：\n');
    const [description, ...personality] = body!.split('\n');
    Object.assign(card, { description, personality: personality.join('\n'), examples });
  }
  return { active: card.id, cards: [card] };
}

export function activePersonaCard(config: AppConfig, roomId?: string): PersonaCard | undefined {
  const library = config.personaLibrary;
  const selected = roomId && config.conversations[roomId]?.personaId;
  return (
    (selected && library?.cards.find((card) => card.id === selected)) ||
    library?.cards.find((card) => card.id === library.active)
  );
}

export function activePersonaName(config: AppConfig, roomId?: string): string {
  return activePersonaCard(config, roomId)?.name ?? '小鱼';
}

export function resolveCardWriting(text: string, name: string) {
  return text.replace(/\{\{(char|user)\}\}/gi, (_token, who: string) =>
    who.toLowerCase() === 'char' ? name : '对方',
  );
}

export function personaText(card: PersonaCard) {
  if (card.name === '小鱼' && !card.scenario && !card.greeting) {
    if (!card.personality && !card.examples)
      return resolveCardWriting(card.description.trim(), card.name);
    const original = [card.description, card.personality, '示例：', card.examples].join('\n');
    if (original === DEFAULT_PERSONA) return DEFAULT_PERSONA;
  }
  const writing = [
    card.name.trim() && '名字：' + card.name.trim(),
    card.description.trim(),
    card.personality.trim() && '说话方式：\n' + card.personality.trim(),
    card.scenario?.trim() && '虚构场景：\n' + card.scenario.trim(),
    card.greeting?.trim() && '开场白参考：\n' + card.greeting.trim(),
    card.examples.trim() && '对话示例：\n' + card.examples.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
  return resolveCardWriting(writing, card.name.trim());
}

/** Import plain character writing only. Tavern extensions and prompt overrides have no representation here. */
export function importPersonaJson(text: string, id: string): PersonaCard {
  let card;
  try {
    card = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('无法读取角色卡，请选择 JSON 格式的酒馆角色卡。');
  }
  const source = card?.data ?? card;
  const read = (key: string) => (typeof source?.[key] === 'string' ? source[key].trim() : '');
  const name = read('name');
  if (!name || name.length > 80) throw new Error('角色卡需要 1 到 80 个字符的名字。');
  const avatar = read('avatar');
  const result = {
    id,
    name,
    description: read('description'),
    personality: read('personality') || read('persona'),
    examples: read('mes_example'),
    scenario: read('scenario'),
    greeting: read('first_mes'),
    creator: read('creator'),
    avatar: avatar.length <= 16 && !/[/:\\.]/.test(avatar) && avatar !== 'none' ? avatar : '',
  };
  if (!(
    result.description ||
    result.personality ||
    result.examples ||
    result.scenario ||
    result.greeting
  ))
    throw new Error('角色卡缺少角色介绍、性格或对话示例。');
  return result;
}

export function exportPersonaJson(card: PersonaCard): string {
  return JSON.stringify(
    {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: card.name,
        description: card.description,
        personality: card.personality,
        scenario: card.scenario ?? '',
        first_mes: card.greeting ?? '',
        mes_example: card.examples,
        creator: card.creator ?? '',
        creator_notes: '',
        character_version: '',
        tags: [],
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        extensions: {},
        ...(card.avatar ? { avatar: card.avatar } : {}),
      },
    },
    null,
    2,
  );
}
