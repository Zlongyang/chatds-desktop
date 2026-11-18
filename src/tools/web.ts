import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { checkAbort } from '../shared/util.js';
export function publicAddress(address: string): boolean {
  try {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}
export async function resolvePublic(host: string): Promise<{ address: string; family: number }> {
  const clean = host.replace(/^\[|\]$/g, '');
  const results = isIP(clean)
    ? [{ address: clean, family: isIP(clean) }]
    : await lookup(clean, { all: true, verbatim: true });
  if (!results.length || results.some((a) => !publicAddress(a.address)))
    throw new Error('网页工具不能访问本机、内网或保留地址');
  return results[0]!;
}
export async function webRead(
  input: string,
  signal: AbortSignal,
  redirects = 0,
): Promise<{ url: string; text: string }> {
  checkAbort(signal);
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    input.length > 2048
  )
    throw new Error('网页工具只允许公开 HTTPS 地址');
  const resolved = await resolvePublic(url.hostname);
  checkAbort(signal);
  const response = await new Promise<{
    status: number;
    location?: string;
    type: string;
    encoding: string;
    body: Buffer;
  }>((resolve, reject) => {
    const request = https.get(
      url,
      {
        signal,
        timeout: 15000,
        headers: {
          'User-Agent': 'ChatDS/0.1 (+public-page-reader)',
          Accept: 'text/html,text/plain,application/json',
          'Accept-Encoding': 'identity',
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [resolved]);
          else callback(null, resolved.address, resolved.family);
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 512 * 1024) {
            res.destroy(new Error('网页响应超过 512 KiB'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: res.headers.location,
            type: String(res.headers['content-type'] ?? ''),
            encoding: String(res.headers['content-encoding'] ?? 'identity'),
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('网页读取超时')));
  });
  if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
    if (redirects >= 3) throw new Error('网页跳转过多');
    return webRead(new URL(response.location, url).href, signal, redirects + 1);
  }
  if (response.status < 200 || response.status >= 300)
    throw new Error('网页返回 HTTP ' + response.status);
  if (response.encoding !== 'identity') throw new Error('网页未提供未压缩的可读响应');
  const mediaType = response.type.split(';', 1)[0]!.trim().toLowerCase();
  if (!['text/plain', 'text/html', 'application/json', 'application/xhtml+xml'].includes(mediaType))
    throw new Error('此响应不是可阅读的网页或文字');
  const body = response.body.toString('utf8');
  const links = new Set<string>();
  const content =
    mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
      ? body
          .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
          .replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_anchor, attrs: string, label: string) => {
            const href = /\shref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(attrs);
            const target =
              href && URL.parse((href[1] ?? href[2] ?? href[3]!).replaceAll('&amp;', '&'), url);
            if (
              !target ||
              target.origin !== url.origin ||
              target.username ||
              target.password ||
              !label.replace(/<[^>]+>/g, '').trim()
            )
              return label;
            target.hash = '';
            if (
              target.href === url.href ||
              target.href.length > 400 ||
              links.has(target.href) ||
              links.size >= 48
            )
              return label;
            links.add(target.href);
            return label + ' (' + target.href + ') ';
          })
          .replace(/<[^>]+>/g, ' ')
          .replace(
            /&(?:nbsp|amp|lt|gt|quot);/g,
            (m) =>
              ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' })[m] ?? m,
          )
          .replace(/\s+/g, ' ')
          .trim()
      : body;
  const text = content.slice(0, 24000);
  if (!text.trim()) throw new Error('网页没有可读正文');
  return { url: url.href, text };
}
