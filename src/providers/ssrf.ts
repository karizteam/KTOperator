import dns from 'node:dns/promises';
import net from 'node:net';
import { ProviderError } from '../errors/errors.js';

/**
 * SSRF protection for provider base URLs. Rules:
 *  - HTTPS only (HTTP is allowed solely for explicitly trusted local endpoints);
 *  - no userinfo (credentials) in the URL;
 *  - hostname must not resolve to loopback/private/link-local/reserved ranges
 *    unless the profile is explicitly marked `trustedLocal`;
 *  - non-standard ports require trust;
 *  - redirects are handled manually by callers (never followed silently).
 */

export interface UrlPolicy {
  trustedLocal: boolean;
  allowPrivate: boolean;
}

const PRIVATE_V4: [number, number][] = [
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0x7f000000, 0xff000000], // 127.0.0.0/8
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
  [0x00000000, 0xff000000], // 0.0.0.0/8
  [0xe0000000, 0xf0000000], // 224.0.0.0/4 multicast
  [0xf0000000, 0xf0000000], // 240.0.0.0/4 reserved
  [0x64400000, 0xffc00000], // 100.64.0.0/10 CGNAT
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    if (n === null) return true;
    // Bitwise ops are signed in JS; normalize to unsigned before comparing.
    return PRIVATE_V4.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::1' || norm === '::') return true;
    if (norm.startsWith('fe8') || norm.startsWith('fe9') || norm.startsWith('fea') || norm.startsWith('feb')) return true; // link-local fe80::/10
    if (norm.startsWith('fc') || norm.startsWith('fd')) return true; // ULA fc00::/7
    if (norm.startsWith('ff')) return true; // multicast
    if (norm.includes('.')) {
      // IPv4-mapped (::ffff:127.0.0.1)
      const v4 = norm.split(':').pop() ?? '';
      return ipv4ToInt(v4) !== null && isPrivateIp(v4);
    }
    return false;
  }
  return false;
}

export function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local') || h === '[::1]';
}

export async function validateProviderBaseUrl(
  rawUrl: string,
  policy: UrlPolicy,
  lookup: (hostname: string) => Promise<string[]> = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderError('invalid_request', `Invalid provider base URL: ${rawUrl}`);
  }
  if (url.username || url.password) {
    throw new ProviderError('invalid_request', 'Provider base URL must not contain credentials.');
  }
  const trusted = policy.trustedLocal;
  if (url.protocol === 'http:' && !trusted) {
    throw new ProviderError('invalid_request', 'Plain HTTP endpoints require an explicitly trusted local provider profile.', {
      hint: 'Use HTTPS, or set trustedLocal: true for a local inference server you control.',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('invalid_request', `Unsupported URL scheme: ${url.protocol}`);
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!trusted && port !== 443 && port !== 80) {
    throw new ProviderError('invalid_request', `Non-standard port ${port} requires a trusted local provider profile.`);
  }
  if (!(policy.allowPrivate || trusted)) {
    if (isPrivateHostname(url.hostname) || isPrivateIp(url.hostname.replace(/^\[|\]$/g, ''))) {
      throw new ProviderError('invalid_request', 'Provider endpoint resolves to a private address and is not trusted.', {
        hint: 'If this is a local inference server, mark the profile trustedLocal. Otherwise choose a public endpoint.',
      });
    }
    let addresses: string[];
    try {
      addresses = await lookup(url.hostname);
    } catch {
      throw new ProviderError('network', `Could not resolve provider hostname: ${url.hostname}`);
    }
    if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a))) {
      throw new ProviderError('invalid_request', 'Provider endpoint resolves to a private address and is not trusted.', {
        hint: 'Set network.allowPrivateProviderEndpoints only if you understand the risk.',
      });
    }
  }
  return url;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const clean = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(clean)) return [clean];
  const res = await dns.lookup(clean, { all: true, verbatim: true });
  return res.map((r) => r.address);
}
