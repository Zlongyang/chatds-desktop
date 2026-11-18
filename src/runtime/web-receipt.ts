import type { WebReadReceipt } from '../shared/types.js';

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
