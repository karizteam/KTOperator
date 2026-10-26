import { ProviderError } from '../errors/errors.js';

/**
 * Minimal Server-Sent-Events parser for provider streaming endpoints.
 * Yields the `data:` payload of each event (already de-chunked).
 */
export async function* parseSse(res: Response, maxBytes = 8 * 1024 * 1024): AsyncGenerator<string> {
  if (!res.body) throw new ProviderError('provider', 'Streaming response has no body.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ProviderError('provider', 'Streaming response exceeded the safety limit.');
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE events are separated by a blank line.
      while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length > 0) yield dataLines.join('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}
