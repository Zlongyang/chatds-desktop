import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https, { type RequestOptions } from 'node:https';
import { Readable } from 'node:stream';
import test from 'node:test';
import { webRead } from '../tools/web.js';

test('web reader pins the same checked IP for both Node HTTPS lookup callback formats', async (t) => {
  const ip = '1.1.1.1';
  const source = 'https://' + ip + '/news';
  const response = Object.assign(Readable.from([Buffer.from('<p>Article body</p>')]), {
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
  });
  t.mock.method(
    https,
    'get',
    (url: URL, options: RequestOptions, respond: (res: typeof response) => void) => {
      assert.equal(url.href, source);
      const lookup = options.lookup!;
      lookup(url.hostname, { all: true }, (err, addresses) => {
        assert.ifError(err);
        assert.deepEqual(addresses, [{ address: ip, family: 4 }]);
      });
      lookup(url.hostname, { all: false }, (err, address, family) => {
        assert.ifError(err);
        assert.equal(address, ip);
        assert.equal(family, 4);
      });
      respond(response);
      return new EventEmitter();
    },
  );
  assert.deepEqual(await webRead(source, new AbortController().signal), {
    url: source,
    text: 'Article body',
  });
});

test('plain text and JSON preserve literal markup, entities and line breaks', async (t) => {
  for (const [type, body] of [
    ['text/plain; charset=utf-8', 'left <x>\n  &amp; right'],
    ['application/json', '{"label":"<x>","escaped":"&amp;"}'],
  ] as const) {
    const response = Object.assign(Readable.from([Buffer.from(body)]), {
      statusCode: 200,
      headers: { 'content-type': type },
    });
    const stub = t.mock.method(
      https,
      'get',
      (_url: URL, _options: RequestOptions, respond: (res: typeof response) => void) => {
        respond(response);
        return new EventEmitter();
      },
    );
    const page = await webRead('https://1.1.1.1/', new AbortController().signal);
    assert.equal(page.text, body);
    stub.mock.restore();
  }
});

test('HTML article labels keep usable same-site URLs without automatically opening links', async (t) => {
  const html =
    '<a href="/news/first#main">第一条公告</a> <a href="https://elsewhere.test/ad">广告</a>';
  const response = Object.assign(Readable.from([Buffer.from(html)]), {
    statusCode: 200,
    headers: { 'content-type': 'text/html' },
  });
  const request = t.mock.method(
    https,
    'get',
    (_url: URL, _options: RequestOptions, respond: (res: typeof response) => void) => {
      respond(response);
      return new EventEmitter();
    },
  );
  const page = await webRead('https://1.1.1.1/news', new AbortController().signal);
  assert.equal(page.text, '第一条公告 (https://1.1.1.1/news/first) 广告');
  assert.equal(request.mock.callCount(), 1);
});

test('a successful HTTP response containing only scripts and styles has no readable text', async (t) => {
  const response = Object.assign(
    Readable.from([Buffer.from('<script>app()</script><style>p{}</style>')]),
    {
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
    },
  );
  t.mock.method(
    https,
    'get',
    (_url: URL, _options: RequestOptions, respond: (res: typeof response) => void) => {
      respond(response);
      return new EventEmitter();
    },
  );
  await assert.rejects(
    webRead('https://1.1.1.1/', new AbortController().signal),
    /网页没有可读正文/,
  );
});
