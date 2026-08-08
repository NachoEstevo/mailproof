/**
 * Fetch a signer's public key from DNS, so a campaign can serve institutions
 * nobody enumerated in advance.
 *
 * Pinning a key in the allowlist is stronger: it removes DNS from the trusted
 * set entirely, and a campaign for one institution should keep doing it. But a
 * campaign open to every university cannot pin what it has not met, and every
 * DKIM verifier on the internet already resolves the key this way — RFC 6376
 * §3.6.2 defines the record as living at `<selector>._domainkey.<domain>`.
 * Trusting DNS here is the same trust every mail server makes.
 *
 * The selector and domain come from the signature being verified, which is
 * attacker-controlled, so both are validated as hostname labels before they
 * reach the resolver: a `d=` carrying a newline or a path must not become a
 * query for something else.
 */
import { Resolver } from 'node:dns/promises';

export class DkimDnsError extends Error {
  constructor(
    message: string,
    readonly failure: 'BAD_NAME' | 'NO_RECORD' | 'NOT_A_KEY' | 'LOOKUP_FAILED',
  ) {
    super(message);
    this.name = 'DkimDnsError';
  }
}

/** One label per RFC 1035: letters, digits, hyphens, not leading or trailing. */
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function assertHostname(value: string, what: string): string {
  const trimmed = value.trim().replace(/\.$/, '');
  if (trimmed.length === 0 || trimmed.length > 253) {
    throw new DkimDnsError(`${what} is not a usable hostname`, 'BAD_NAME');
  }
  for (const label of trimmed.split('.')) {
    if (!LABEL.test(label)) {
      throw new DkimDnsError(`${what} has an invalid label: ${label}`, 'BAD_NAME');
    }
  }
  return trimmed.toLowerCase();
}

export interface ResolveOptions {
  /** Injectable for tests, and so a deployment can pin its own resolver. */
  readonly resolveTxt?: (name: string) => Promise<string[][]>;
  readonly timeoutMs?: number;
}

/**
 * Return the DKIM key record for a selector and domain, as the single string
 * `publicKeyFromDnsRecord` expects.
 *
 * A TXT record longer than 255 octets arrives split into chunks; DNS defines
 * the value as their concatenation with no separator, and a key record is
 * always long enough for this to matter.
 */
export async function resolveDkimKey(
  selector: string,
  domain: string,
  options: ResolveOptions = {},
): Promise<string> {
  const name = `${assertHostname(selector, 'selector')}._domainkey.${assertHostname(domain, 'signing domain')}`;

  const resolveTxt =
    options.resolveTxt ??
    (async (host: string) => {
      const resolver = new Resolver({ timeout: options.timeoutMs ?? 5_000, tries: 2 });
      return resolver.resolveTxt(host);
    });

  let chunks: string[][];
  try {
    chunks = await resolveTxt(name);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      throw new DkimDnsError(`no DKIM key published at ${name}`, 'NO_RECORD');
    }
    throw new DkimDnsError(
      `could not resolve ${name}: ${error instanceof Error ? error.message : 'lookup failed'}`,
      'LOOKUP_FAILED',
    );
  }

  const records = chunks.map((parts) => parts.join('')).filter((r) => r.includes('p='));
  if (records.length === 0) {
    throw new DkimDnsError(`no DKIM key published at ${name}`, 'NO_RECORD');
  }
  // More than one is a misconfiguration, not a choice to make on the signer's
  // behalf: verifying against whichever came first would be luck.
  if (records.length > 1) {
    throw new DkimDnsError(`${name} publishes ${records.length} key records`, 'NOT_A_KEY');
  }

  const record = records[0]!;
  if (/(^|;)\s*p=\s*(;|$)/.test(record)) {
    throw new DkimDnsError(`the key at ${name} has been revoked (empty p=)`, 'NOT_A_KEY');
  }
  return record;
}
