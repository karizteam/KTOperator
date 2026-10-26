/**
 * Credential and secret redaction.
 *
 * Applied to every log line, audit entry, error detail and — critically — to
 * untrusted tool output before it is sent back to a model, so secrets that
 * live in workspace files cannot be exfiltrated through the context window.
 */

interface RedactionRule {
  readonly name: string;
  readonly pattern: RegExp;
}

const RULES: readonly RedactionRule[] = [
  { name: 'openai-key', pattern: /\bsk-(?:proj-|ant-|)?[A-Za-z0-9_-]{16,}\b/g },
  { name: 'openrouter-key', pattern: /\bsk-or-[A-Za-z0-9_-]{12,}\b/g },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g },
  { name: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'aws-access-key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: 'stripe-key', pattern: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9_.=-]{20,}\b/gi },
  { name: 'basic-auth', pattern: /\bBasic\s+[A-Za-z0-9+/=]{12,}\b/gi },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'private-key-block', pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/g },
  { name: 'url-credentials', pattern: /([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi },
  { name: 'generic-secret-field', pattern: /("?)((?:api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key|refresh[_-]?token))("?\s*[:=]\s*"?)([^\s"',}]{8,})/gi },
];

export interface RedactionResult {
  text: string;
  redactedCount: number;
}

export function redactText(input: string): RedactionResult {
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (match, ...groups: unknown[]) => {
      count += 1;
      if (rule.name === 'url-credentials' && typeof groups[0] === 'string') {
        return `${groups[0]}[REDACTED:${rule.name}]@`;
      }
      if (rule.name === 'generic-secret-field') {
        const [q1, keyName, sep] = groups as [string, string, string];
        return `${q1 ?? ''}${keyName ?? ''}${sep ?? ': '}[REDACTED:${rule.name}]`;
      }
      return `[REDACTED:${rule.name}]`;
    });
  }
  return { text, redactedCount: count };
}

/** Deep-redact secrets in structured data (used for config display/logging). */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value).text as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/key|secret|token|password|credential/i.test(k) && typeof v === 'string' && v.length > 0) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactValue(v);
      }
    }
    return out as T;
  }
  return value;
}

/** One-line safe preview of an arbitrary value for logs (redacted, capped). */
export function safePreview(value: unknown, maxLength = 200): string {
  let raw: string;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  const { text } = redactText(raw);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
