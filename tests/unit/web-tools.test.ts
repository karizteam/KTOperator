import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, fetchText, htmlToText, parseSearchRss, validateWebUrl } from '../../src/tools/web.js';
import { TOOL_BASE_TIER } from '../../src/security/policy.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { makeHarness } from '../helpers.js';

/** Public host for every lookup so no test ever touches DNS. */
const publicLookup = async (): Promise<string[]> => ['93.184.216.34'];

describe('web url validation (SSRF)', () => {
  it('accepts a public https URL', async () => {
    const url = await validateWebUrl('web_fetch', 'https://example.com/docs?x=1', publicLookup);
    assert.equal(url.hostname, 'example.com');
  });

  it('rejects non-http schemes, credentials and odd ports', async () => {
    await assert.rejects(() => validateWebUrl('web_fetch', 'file:///etc/passwd', publicLookup), /http/i);
    await assert.rejects(() => validateWebUrl('web_fetch', 'ftp://example.com/x', publicLookup), /http/i);
    await assert.rejects(() => validateWebUrl('web_fetch', 'https://user:pass@example.com/', publicLookup), /credential/i);
    await assert.rejects(() => validateWebUrl('web_fetch', 'https://example.com:8443/x', publicLookup), /port/i);
  });

  it('rejects loopback and private hosts before any DNS lookup', async () => {
    for (const bad of ['http://localhost/admin', 'http://127.0.0.1:80/', 'http://10.1.2.3/', 'http://169.254.169.24/latest/meta-data/']) {
      await assert.rejects(
        () => validateWebUrl('web_fetch', bad, async () => { throw new Error('lookup must not run'); }),
        /private|loopback/i,
        bad,
      );
    }
  });

  it('rejects a public hostname that resolves to a private address', async () => {
    await assert.rejects(
      () => validateWebUrl('web_fetch', 'https://sneaky.example.com/', async () => ['192.168.1.10']),
      /private/i,
    );
  });

  it('rejects malformed URLs', async () => {
    await assert.rejects(() => validateWebUrl('web_fetch', 'not a url', publicLookup), /URL/i);
  });
});

describe('fetchText (no network)', () => {
  it('reads a body up to the byte cap and reports truncation', async () => {
    const doc = await fetchText('https://example.com/big', {
      lookup: publicLookup,
      fetchImpl: async () => new Response('x'.repeat(5000)),
      maxBytes: 1000,
    });
    assert.equal(doc.status, 200);
    assert.equal(doc.text.length, 1000);
    assert.equal(doc.truncated, true);
    assert.equal(doc.bytes, 1000);
  });

  it('reports no truncation for a small body', async () => {
    const doc = await fetchText('https://example.com/small', {
      lookup: publicLookup,
      fetchImpl: async () => new Response('hello'),
      maxBytes: 1000,
    });
    assert.equal(doc.text, 'hello');
    assert.equal(doc.truncated, false);
    assert.equal(doc.bytes, 5);
  });

  it('refuses a content type before reading the body', async () => {
    await assert.rejects(
      () =>
        fetchText('https://example.com/image.png', {
          lookup: publicLookup,
          fetchImpl: async () => new Response('binary', { headers: { 'content-type': 'image/png' } }),
          accept: (ct) => (ct.startsWith('image/') ? `Refusing ${ct}` : null),
        }),
      /image\/png/,
    );
  });

  it('re-validates every redirect hop (public → private is refused)', async () => {
    await assert.rejects(
      () =>
        fetchText('https://example.com/ok', {
          lookup: publicLookup,
          fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.24/latest/' } }),
        }),
      /private/i,
    );
  });

  it('follows redirects to a public host and returns the final URL', async () => {
    let calls = 0;
    const doc = await fetchText('https://example.com/start', {
      lookup: publicLookup,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response(null, { status: 301, headers: { location: 'https://example.org/final' } })
          : new Response('landed');
      },
    });
    assert.equal(doc.url, 'https://example.org/final');
    assert.equal(doc.text, 'landed');
    assert.equal(calls, 2);
  });

  it('gives up after too many redirects', async () => {
    await assert.rejects(
      () =>
        fetchText('https://example.com/loop', {
          lookup: publicLookup,
          fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/again' } }),
        }),
      /redirect/i,
    );
  });

  it('surfaces network failures as an actionable tool error', async () => {
    await assert.rejects(
      () =>
        fetchText('https://example.com/down', {
          lookup: publicLookup,
          fetchImpl: async () => {
            throw new Error('ECONNRESET');
          },
        }),
      /ECONNRESET/,
    );
  });
});

describe('html → text', () => {
  it('drops scripts, styles and tags but keeps readable text', () => {
    const html = `
      <html><head><style>.a{color:red}</style><script>alert(1)</script></head>
      <body><h1>Title</h1><p>Hello <b>world</b>.</p><ul><li>one</li><li>two</li></ul></body></html>`;
    const text = htmlToText(html);
    assert.ok(text.includes('Title'));
    assert.ok(text.includes('Hello world.'));
    assert.ok(text.includes('• one'));
    assert.ok(!text.includes('alert(1)'));
    assert.ok(!text.includes('color:red'));
    assert.ok(!/<[a-z]+/i.test(text), 'no markup may survive');
  });

  it('decodes named and numeric entities once', () => {
    assert.equal(decodeEntities('a &amp; b &lt;tag&gt; &#65;&#x42; &nbsp;'), 'a & b <tag> AB  ');
    assert.equal(decodeEntities('&amp;lt;'), '&lt;');
    assert.equal(decodeEntities('&#x1F600;'), '\u{1F600}');
    assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;');
  });

  it('collapses runs of blank lines', () => {
    const text = htmlToText('<p>one</p><p>two</p>\n\n\n\n<p>three</p>');
    assert.ok(!/\n{3,}/.test(text));
    assert.ok(text.includes('one') && text.includes('three'));
  });
});

describe('search result parsing', () => {
  const rss = `<?xml version="1.0"?>
    <rss><channel>
      <item><title>First &amp; best</title><link>https://example.com/a</link><description>A &lt;b&gt;result&lt;/b&gt;</description></item>
      <item><title>Local file</title><link>file:///etc/passwd</link><description>should be skipped</description></item>
      <item><title><![CDATA[CDATA title]]></title><link><![CDATA[https://example.com/b]]></link><description><![CDATA[plain <i>text</i>]]></description></item>
    </channel></rss>`;

  it('extracts titles, links and snippets and skips non-http links', () => {
    const results = parseSearchRss(rss);
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], { title: 'First & best', url: 'https://example.com/a', snippet: 'A result' });
    assert.deepEqual(results[1], { title: 'CDATA title', url: 'https://example.com/b', snippet: 'plain text' });
  });

  it('returns an empty list for non-result payloads', () => {
    assert.deepEqual(parseSearchRss('<html><body>nope</body></html>'), []);
  });
});

describe('web tool wiring', () => {
  it('registers both tools as read-only (no approval prompt)', () => {
    const names = ALL_TOOLS.map((t) => t.name);
    assert.ok(names.includes('web_fetch'), 'web_fetch registered');
    assert.ok(names.includes('web_search'), 'web_search registered');
    assert.equal(TOOL_BASE_TIER['web_fetch'], 0);
    assert.equal(TOOL_BASE_TIER['web_search'], 0);
  });

  it('refuses unsafe URLs through the whole registry pipeline', async () => {
    const h = await makeHarness({ approvalMode: { kind: 'auto', maxTier: 3 } });
    try {
      const result = await h.registry.execute('web_fetch', JSON.stringify({ url: 'file:///etc/passwd' }), h.toolContext);
      assert.equal(result.ok, false);
      assert.match(`${result.summary} ${result.error ?? ''}`, /http/i);
      assert.equal(h.registry.names().includes('web_search'), true);
    } finally {
      await h.cleanup();
    }
  });

  it('validates arguments before doing any work', async () => {
    const h = await makeHarness({ approvalMode: { kind: 'auto', maxTier: 3 } });
    try {
      const empty = await h.registry.execute('web_search', JSON.stringify({ query: '' }), h.toolContext);
      assert.equal(empty.ok, false, 'an empty query must be rejected by schema validation');
      const missing = await h.registry.execute('web_fetch', '{}', h.toolContext);
      assert.equal(missing.ok, false, 'url is required');
    } finally {
      await h.cleanup();
    }
  });
});
