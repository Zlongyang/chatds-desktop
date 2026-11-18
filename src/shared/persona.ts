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

export function personaLibrary(config: Pick<AppConfig, 'persona' | 'personaLibrary'>) {
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

export function activePersonaName(config: AppConfig): string {
  const library = config.personaLibrary;
  return library?.cards.find((card) => card.id === library.active)?.name ?? '小鱼';
}

export function personaText(card: PersonaCard) {
  if (card.name === '小鱼') {
    if (!card.personality && !card.examples) return card.description.trim();
    const original = [card.description, card.personality, '示例：', card.examples].join('\n');
    if (original === DEFAULT_PERSONA) return DEFAULT_PERSONA;
  }
  return [
    card.name.trim() && '名字：' + card.name.trim(),
    card.description.trim(),
    card.personality.trim() && '说话方式：\n' + card.personality.trim(),
    card.examples.trim() && '对话示例：\n' + card.examples.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
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
  const writing = (key: string) =>
    read(key).replace(/\{\{(char|user)\}\}/gi, (_token: string, who: string) =>
      who.toLowerCase() === 'char' ? name : '对方',
    );
  const result = {
    id,
    name,
    description: [writing('description'), writing('scenario')].filter(Boolean).join('\n\n'),
    personality: writing('personality'),
    examples: [writing('first_mes'), writing('mes_example')].filter(Boolean).join('\n\n'),
  };
  if (!(result.description || result.personality || result.examples))
    throw new Error('角色卡缺少角色介绍、性格或对话示例。');
  return result;
}
