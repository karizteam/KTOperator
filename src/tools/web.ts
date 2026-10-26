import dns from 'node:dns/promises';
import net from 'node:net';
import { ToolExecutionError } from '../errors/errors.js';
import { isPrivateHostname, isPrivateIp } from '../providers/ssrf.js';
import type { Tool, ToolResult } from './types.js';

/**
 * Web tools — read-only network access for the agent.
 *
 * Design rules (they mirror the rest of the security engine):
 *   - every URL, including every redirect hop, is validated before it is
 *     requested: http(s) only, no credentials, standard ports only, and never
 *     a loopback/private/link-local address (SSRF);
 *   - bounded: timeout, redirect count, bytes read, and the text handed to the
 *     model is capped well below the registry's output limit;
 *   - no shell, no cookies, no credentials, one honest user agent;
 *   - the response body is plain data: it is redacted and injection-screened
 *     by the registry like any other tool output.
 */

const USER_AGENT = 'KTOperator/0.3';
const ACCEPT_HEADER = 'text/html,application/xhtml+xml,application/json,application/xml,text/plain;q=0.9,*/*;q=0.5';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 1_000_000;
const SEARCH_ENDPOINT = 'https://www.bing.com/search?format=rss&q=';

/** DNS lookup signature so tests can resolve without touching the network. */
export type HostLookup = (hostname: string) => Promise<string[]>;
/** Injectable fetch so tests can replay responses without a network. */
export type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  /** Tool name used in error messages. */
  tool?: string;
  lookup?: HostLookup;
  fetchImpl?: FetchImpl;
  /** Caller cancellation (agent abort). */
  signal?: AbortSignal;
  /** Hard cap on the bytes read from the body. */
  maxBytes?: number;
  /** Return an error message to refuse a content type before reading the body. */
  accept?: (contentType: string) => string | null;
}

export interface FetchedDocument {
  /** Final URL after redirects. */
  url: string;
  status: number;
  /** Lower-cased media type without parameters, e.g. "text/html". */
  contentType: string;
  bytes: number;
  text: string;
  truncated: boolean;
}

async function resolveHost(hostname: string): Promise<string[]> {
  const clean = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(clean)) return [clean];
  const records = await dns.lookup(clean, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

/**
 * Validate a URL the agent is allowed to request. Throws an actionable
 * ToolExecutionError for anything that is not a public http(s) endpoint.
 */
export async function validateWebUrl(tool: string, rawUrl: string, lookup: HostLookup = resolveHost): Promise<URL> {
  const trimmed = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ToolExecutionError(tool, `"${trimmed}" is not a valid URL.`, { hint: 'Use an absolute URL such as https://example.com/docs.' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolExecutionError(tool, `Refusing ${url.protocol} URLs — only http and https are supported.`, {
      hint: 'Fetch a web page, not a local file or an executable.',
    });
  }
  if (url.username !== '' || url.password !== '') {
    throw new ToolExecutionError(tool, 'URLs with embedded credentials are not allowed.');
  }
  // Privacy first: the security-relevant reason must win over cosmetic ones.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHostname(host) || isPrivateIp(host)) {
    throw new ToolExecutionError(tool, `Refusing ${url.hostname}: private and loopback addresses are not reachable.`, {
      hint: 'Web tools only reach public hosts; run local services through the approved command tools instead.',
    });
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new ToolExecutionError(tool, `Could not resolve ${url.hostname}.`, { hint: 'Check the hostname and your network connection.' });
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a))) {
    throw new ToolExecutionError(tool, `Refusing ${url.hostname}: it resolves to a private address.`, {
      hint: 'Web tools only reach public hosts.',
    });
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443) {
    throw new ToolExecutionError(tool, `Refusing non-standard port ${port}.`, { hint: 'Only the standard web ports 80 and 443 are reachable.' });
  }
  return url;
}

/**
 * GET a URL with validation on every hop and a hard byte cap. The returned
 * text is the raw decoded body — HTML conversion happens in the caller so
 * XML/JSON stay intact.
 */
export async function fetchText(rawUrl: string, options: FetchOptions = {}): Promise<FetchedDocument> {
  const tool = options.tool ?? 'web_fetch';
  const lookup = options.lookup ?? resolveHost;
  const doFetch: FetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

  let current = await validateWebUrl(tool, rawUrl, lookup);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await doFetch(current, {
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: ACCEPT_HEADER,
          'accept-language': 'en-US,en;q=0.8',
        },
      });
    } catch (err) {
      const failure = err as { name?: string; message?: string };
      const detail =
        failure.name === 'TimeoutError' || failure.name === 'AbortError'
          ? `timed out after ${FETCH_TIMEOUT_MS} ms`
          : `request failed (${failure.message ?? 'network error'})`;
      throw new ToolExecutionError(tool, `Could not fetch ${current.toString()}: ${detail}.`, {
        hint: 'Check the URL and the network connection, then try again.',
      });
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      try {
        await res.body?.cancel();
      } catch {
        /* already consumed */
      }
      if (!location) {
        throw new ToolExecutionError(tool, `${current.toString()} answered HTTP ${res.status} without a Location header.`, {
          hint: 'The server sent a broken redirect; open the URL directly instead.',
        });
      }
      // Re-validate every hop: a public host must not redirect into a private one.
      current = await validateWebUrl(tool, new URL(location, current).toString(), lookup);
      continue;
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() || 'application/octet-stream';
    const refused = options.accept?.(contentType);
    if (refused) {
      try {
        await res.body?.cancel();
      } catch {
        /* already consumed */
      }
      throw new ToolExecutionError(tool, refused);
    }

    const { text, bytes, truncated } = await readBody(res, maxBytes);
    return { url: current.toString(), status: res.status, contentType, bytes, text, truncated };
  }

  throw new ToolExecutionError(tool, `Too many redirects (more than ${MAX_REDIRECTS}) while fetching ${rawUrl}.`, {
    hint: 'Fetch the final URL directly.',
  });
}

async function readBody(res: Response, limit: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: '', bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    const remaining = limit - bytes;
    if (value.byteLength >= remaining) {
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      bytes = limit;
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* connection gone */
      }
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  return { text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)), bytes, truncated };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', times: '×',
  middot: '·', bull: '•', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', deg: '°', plusmn: '±',
};

/** Decode HTML entities (named + decimal/hex numeric) exactly once. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,30});/g, (whole, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1] === 'x' || entity[1] === 'X' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? whole;
  });
}

/**
 * Convert an HTML document to readable plain text: scripts, styles and tags
 * are dropped, block boundaries become newlines, list items get a bullet and
 * entities are decoded. Safe for model input (no markup survives).
 */
export function htmlToText(html: string): string {
  let text = html.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|svg|template|iframe|object|embed)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<\s*(br|hr)\s*\/?\s*>/gi, '\n');
  text = text.replace(/<\s*\/\s*(p|div|section|article|header|footer|nav|main|aside|ul|ol|li|table|thead|tbody|tr|h[1-6]|blockquote|pre|figure|figcaption|dl|dt|dd|form)\s*>/gi, '\n');
  text = text.replace(/<\s*li[^>]*>/gi, ' • ');
  text = text.replace(/<\s*(td|th)[^>]*>/gi, ' | ');
  // Inline markup disappears entirely ("Hello <b>world</b>." must stay
  // "Hello world."), anything else becomes a separating space.
  text = text.replace(/<\/?\s*(b|i|u|s|em|strong|span|a|code|kbd|var|abbr|cite|q|small|sub|sup|font|mark|ins|del|time|data|bdi|bdo|img|picture|source)\b[^>]*>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function cleanRssText(raw: string): string {
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Decode first, then strip: escaped markup ("&lt;b&gt;") must not survive
  // as text, and a literal "a < b" has no closing bracket so it stays intact.
  const withoutTags = decodeEntities(withoutCdata).replace(/<[^>]+>/g, ' ');
  return withoutTags.replace(/\s+/g, ' ').trim();
}

/** Parse a Bing RSS search response into plain results (exported for tests). */
export function parseSearchRss(xml: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = match[1]!;
    const grab = (tag: string): string => (body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) ?? [])[1] ?? '';
    const url = cleanRssText(grab('link'));
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({ title: cleanRssText(grab('title')), url, snippet: cleanRssText(grab('description')).slice(0, 300) });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Model-facing tools                                                  */
/* ------------------------------------------------------------------ */

const TEXTUAL_TYPES = new Set(['text/html', 'application/xhtml+xml', 'application/json', 'text/plain', 'text/markdown', 'text/xml', 'application/xml']);

function contentTypeError(contentType: string): string | null {
  if (TEXTUAL_TYPES.has(contentType) || contentType.endsWith('+json') || contentType.endsWith('+xml') || contentType.startsWith('text/')) return null;
  return `Refusing to return ${contentType} — web_fetch only serves HTML, XML, JSON and plain text.`;
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a public http(s) URL and return its readable text. HTML is converted to plain text, JSON is pretty-printed. Private/loopback hosts, credentials and non-standard ports are refused; output is capped.',
  requiresWorkspace: false,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL to fetch.', minLength: 4, maxLength: 2048 },
    },
  },
  async run(input, ctx): Promise<ToolResult> {
    const raw = String(input['url'] ?? '');
    // Stay comfortably under the registry cap so the structured payload is kept.
    const cap = Math.max(4_000, Math.floor(ctx.config.limits.maxOutputBytes * 0.7));
    const doc = await fetchText(raw, {
      tool: 'web_fetch',
      signal: ctx.signal,
      maxBytes: Math.max(cap * 4, 262_144),
      accept: contentTypeError,
    });

    let text = doc.text;
    if (doc.contentType === 'text/html' || doc.contentType === 'application/xhtml+xml') {
      text = htmlToText(doc.text);
    } else if (doc.contentType === 'application/json' || doc.contentType.endsWith('+json')) {
      try {
        text = JSON.stringify(JSON.parse(doc.text), null, 1);
      } catch {
        /* keep the raw body */
      }
    }
    let truncated = doc.truncated;
    if (text.length > cap) {
      text = text.slice(0, cap);
      truncated = true;
    }

    if (doc.status >= 400) {
      return {
        ok: false,
        summary: `HTTP ${doc.status} from ${doc.url}`,
        error: `HTTP ${doc.status} for ${doc.url}${truncated ? ' (body truncated)' : ''}. The page may have moved, be behind a login, or block automated access.`,
      };
    }

    return {
      ok: true,
      summary: `Fetched ${doc.url} — ${doc.status}, ${doc.contentType}, ${doc.bytes} bytes${truncated ? ', truncated' : ''}.`,
      data: { url: doc.url, status: doc.status, contentType: doc.contentType, truncated, text },
    };
  },
};

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the public web and return titles, URLs and snippets. Read-only: only the query leaves the machine. Use web_fetch to read a result page in full.',
  requiresWorkspace: false,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search query.', minLength: 1, maxLength: 300 },
      maxResults: { type: 'integer', description: 'How many results to return (default 8).', minimum: 1, maximum: 10 },
    },
  },
  async run(input, ctx): Promise<ToolResult> {
    const query = String(input['query'] ?? '').trim();
    if (query === '') {
      return { ok: false, summary: 'Empty search query', error: 'web_search needs a non-empty query.' };
    }
    const requested = Number(input['maxResults'] ?? 8);
    const max = Number.isFinite(requested) ? Math.min(10, Math.max(1, Math.trunc(requested))) : 8;

    const doc = await fetchText(`${SEARCH_ENDPOINT}${encodeURIComponent(query)}`, {
      tool: 'web_search',
      signal: ctx.signal,
      maxBytes: 512_000,
      accept: (ct) => (ct.includes('xml') || ct.startsWith('text/') ? null : `Search provider returned an unexpected content type: ${ct}.`),
    });
    if (doc.status !== 200) {
      throw new ToolExecutionError('web_search', `Search provider returned HTTP ${doc.status}.`, { hint: 'Retry in a moment or rephrase the query.' });
    }

    const results = parseSearchRss(doc.text).slice(0, max);
    if (results.length === 0) {
      return { ok: true, summary: `No web results for "${query}".`, data: { query, results: [] } };
    }
    return { ok: true, summary: `${results.length} web result(s) for "${query}".`, data: { query, results } };
  },
};
