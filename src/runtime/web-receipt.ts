import type { WebReadReceipt } from '../shared/types.js';

// Catch affirmative first-person browsing claims. Quoted text, questions about
// someone else's connection and ordinary conversation can contain the same words.
export function claimsWebAccess(text: string): boolean {
  const ownWords = text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|`[^`]*`/gu, '');
  const site = /网页|网站|官网|页面|链接|网络/u;
  const failed = /打不开|没打开|网络打?不通|网络连接失败|读取超时|连不上/u;
  const attempted =
    /(?:我(?:刚才|刚刚|刚|已经)?|刚才|刚)(?:试着)?(?:打开了?|访问了?|看了|翻了|读了|查阅了)/u;
  return (ownWords.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? []).some((sentence) => {
    if (/[?？]$|(?:如果|假如|要是|不是)我/u.test(sentence)) return false;
    if (!site.test(sentence)) return false;
    return (
      attempted.test(sentence) || (/我(?:这边|这里|这儿)/u.test(sentence) && failed.test(sentence))
    );
  });
}

export function asksForWebEvidence(text: string): boolean {
  if (
    /(?:不想|无需|不必|不用|不要|别)(?:再)?(?:上网|联网|查官网)|(?:翻译|改写|润色|复述)(?:一下|这句|这段)?[：:]/u.test(
      text,
    )
  )
    return false;
  return /(?:上网|联网)(?:查|搜|核实)|(?:请|帮我|能否|能不能|麻烦你)(?:去)?(?:查|搜|核实).{0,12}(?:官网|官方|网页|网站)|(?:最近|近期|最新).{0,14}(?:公开|发布|公告|新闻).{0,12}(?:什么|哪些|[?？])|(?:有哪些|有什么).{0,12}(?:最新|近期)(?:公告|新闻|更新)/u.test(
    text,
  );
}

// Retain an honest model answer or a request for a source, including its
// conversational tone. A promise to check later has no scheduled action behind it.
export function explainsMissingSource(text: string): boolean {
  const limitation =
    /纯陪伴|网页(?:读取|工具|权限).{0,8}(?:没启用|未开|关闭)|(?:没开|没启用|没有启用).{0,8}(?:网页|联网)|(?:还没|尚未|没法|不能|无法)(?:联网|上网|查证|核实)|(?:给我|发我|提供).{0,12}(?:链接|网址)/u;
  const promises = /(?:等|回头|稍后|以后|一旦).{0,35}(?:通知|告诉|帮你查|帮你看|发给你|跟你说)/u;
  return limitation.test(text) && !promises.test(text);
}

function hostOf(value: unknown): string {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  return url?.protocol === 'https:' && !url.username && !url.password ? url.hostname : '';
}

/** Receipts contain only the site and a bounded, app-generated diagnostic. */
function failureReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.match(/网页返回 (HTTP [1-5]\d\d)\b/);
  if (status) return status[1];
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return '域名解析失败';
  if (/超时|ETIMEDOUT/.test(message)) return '读取超时';
  if (/不能访问本机、内网或保留地址|只允许公开 HTTPS/.test(message)) return '地址受限';
  if (/超过 512 KiB/.test(message)) return '响应超过大小限制';
  if (/没有可读正文|不是可阅读的网页或文字/.test(message)) return '没有可读正文';
  if (/未提供未压缩/.test(message)) return '不支持此响应编码';
  if (/Invalid IP address: undefined/.test(message)) return '网页工具内部错误';
  return undefined;
}

export async function captureWebRead(
  receipts: WebReadReceipt[],
  requestedUrl: string,
  read: () => Promise<unknown>,
): Promise<unknown> {
  try {
    const page = await read();
    const finalHost = page && typeof page === 'object' && 'url' in page ? hostOf(page.url) : '';
    receipts.push({ host: finalHost || hostOf(requestedUrl), status: 'read' });
    return page;
  } catch (error) {
    const reason = failureReason(error);
    receipts.push({ host: hostOf(requestedUrl), status: 'failed', ...(reason ? { reason } : {}) });
    throw error;
  }
}
