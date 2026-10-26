import { ProviderError } from '../errors/errors.js';
import { redactText } from '../security/redaction.js';

/**
 * Hardened JSON-over-HTTP helper shared by all provider adapters:
 * timeouts, external cancellation, bounded retries with backoff, manual
 * redirect handling (SSRF defense), and normalized error taxonomy.
 */

export interface HttpJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Return the raw Response instead of parsed JSON (streaming). */
  raw?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY = 2000;

export async function httpJson(url: string, options: HttpJsonOptions = {}): Promise<unknown> {
  const res = await httpRequest(url, options);
  try {
    return await res.json();
  } catch {
    throw new ProviderError('provider', `Provider returned non-JSON response (HTTP ${res.status}).`, { status: res.status });
  }
}

export async function httpRequest(url: string, options: HttpJsonOptions = {}): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? 3;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: options.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.body === undefined ? {} : {}),
          ...(options.headers ?? {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'manual', // never follow redirects silently (SSRF)
        signal: combined,
      });
    } catch (err: unknown) {
      if (options.signal?.aborted) throw new ProviderError('aborted', 'Request cancelled by user.', { cause: err });
      if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') {
        if (attempt <= maxRetries) {
          await sleep(backoffMs(attempt), options.signal);
          continue;
        }
        throw new ProviderError('timeout', `Provider request timed out after ${timeoutMs} ms.`, { cause: err });
      }
      if (attempt <= maxRetries) {
        await sleep(backoffMs(attempt), options.signal);
        continue;
      }
      throw new ProviderError('network', `Network error talking to provider: ${(err as Error).message}`, { cause: err });
    }

    if (res.status >= 300 && res.status < 400) {
      // A redirect on an API call is suspicious; refuse instead of following.
      throw new ProviderError('provider', `Provider attempted an unexpected redirect (HTTP ${res.status}). Refusing to follow it.`, {
        status: res.status,
      });
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      if (attempt <= maxRetries) {
        await sleep(retryAfterMs ?? backoffMs(attempt), options.signal);
        continue;
      }
      throw new ProviderError('rate_limit', 'Provider rate limit reached; retries exhausted.', {
        status: 429,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    if (res.status >= 500) {
      if (attempt <= maxRetries) {
        await sleep(backoffMs(attempt), options.signal);
        continue;
      }
      throw new ProviderError('provider', `Provider error (HTTP ${res.status}): ${await safeBody(res)}`, { status: res.status });
    }
    if (res.status >= 400) {
      const body = await safeBody(res);
      throw classifyClientError(res.status, body);
    }
    return res;
  }
}

export function classifyClientError(status: number, body: string): ProviderError {
  const lower = body.toLowerCase();
  switch (status) {
    case 400:
      if (lower.includes('model') && (lower.includes('not found') || lower.includes('does not exist') || lower.includes('invalid'))) {
        return new ProviderError('invalid_model', `Model not available: ${body}`, { status });
      }
      return new ProviderError('invalid_request', `Provider rejected the request (HTTP 400): ${body}`, { status });
    case 401:
    case 403:
      return new ProviderError('auth', `Authentication failed (HTTP ${status}). Check the API key for this provider profile.`, {
        status,
        hint: 'Run `operator provider test` or re-enter the key via /provider add in the console.',
      });
    case 402:
      return new ProviderError('insufficient_credits', `Provider reports insufficient credits or payment required: ${body}`, { status });
    case 404:
      return new ProviderError('invalid_model', `Endpoint or model not found (HTTP 404): ${body}`, { status });
    default:
      return new ProviderError('provider', `Provider error (HTTP ${status}): ${body}`, { status });
  }
}

async function safeBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return redactText(text.slice(0, MAX_ERROR_BODY)).text;
  } catch {
    return '(unreadable error body)';
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return undefined;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100), 8000);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ProviderError('aborted', 'Request cancelled by user.'));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
