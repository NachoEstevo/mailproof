/**
 * DKIM verification (RFC 6376), off-circuit.
 *
 * This is the §29.6 check: confirm a fixture actually verifies *before*
 * spending time building a blueprint around it. Without it, a mangled
 * download or a stray editor save shows up much later as an unexplained
 * proving failure.
 *
 * This is not the in-circuit verifier and must never be mistaken for one —
 * ZK Email does that, and §8 (option C) is explicit that reimplementing DKIM
 * inside Compact is out of scope. Here we only use Node's crypto to check an
 * RSA signature we already hold the public key for.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

import { parseEml, type DkimSignature, type ParsedEml } from './eml.js';

export type Canonicalization = 'simple' | 'relaxed';

export interface DkimVerificationResult {
  readonly valid: boolean;
  /** Which check failed, when it did. */
  readonly reason?: string;
  readonly bodyHashMatches: boolean;
  readonly signatureMatches: boolean;
  readonly domain: string | undefined;
  readonly selector: string | undefined;
  /** True when the signature carries an `x=` that has passed. */
  readonly expired: boolean;
}

/**
 * Relaxed body canonicalisation (RFC 6376 §3.4.4).
 *
 * Collapse runs of whitespace within a line, strip trailing whitespace, drop
 * trailing empty lines, then end with exactly one CRLF.
 */
export function canonicalizeBodyRelaxed(body: string): string {
  const lines = body.split(/\r\n/).map((line) => line.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`;
}

/** Simple body canonicalisation (§3.4.3): only trailing empty lines go. */
export function canonicalizeBodySimple(body: string): string {
  let out = body.replace(/(\r\n)*$/, '');
  out += '\r\n';
  return out === '\r\n' && body.length === 0 ? '\r\n' : out;
}

/** Relaxed header canonicalisation (§3.4.2). */
export function canonicalizeHeaderRelaxed(rawName: string, value: string): string {
  const name = rawName.toLowerCase().trim();
  // `value` arrives already unfolded by the parser; collapse and trim it.
  const folded = value.replace(/\s+/g, ' ').trim();
  return `${name}:${folded}\r\n`;
}

/** Simple header canonicalisation (§3.4.1): the field, verbatim. */
export function canonicalizeHeaderSimple(raw: string): string {
  return `${raw}\r\n`;
}

/**
 * Assemble the header block the signature covers.
 *
 * `h=` may name the same header more than once — Google routinely oversigns —
 * and RFC 6376 §5.4.2 resolves that by consuming instances from the bottom of
 * the message upward, treating a name with no instances left as absent.
 */
function buildSignedHeaders(
  eml: ParsedEml,
  signature: DkimSignature,
  mode: Canonicalization,
): string {
  const remaining = new Map<string, string[]>();
  for (const header of eml.headers) {
    const list = remaining.get(header.name) ?? [];
    list.push(mode === 'relaxed' ? canonicalizeHeaderRelaxed(header.rawName, header.value) : canonicalizeHeaderSimple(header.raw));
    remaining.set(header.name, list);
  }
  // Bottom-up consumption.
  for (const list of remaining.values()) list.reverse();

  let block = '';
  for (const name of signature.signedHeaders) {
    const next = remaining.get(name)?.shift();
    if (next) block += next;
  }
  return block;
}

/**
 * The DKIM-Signature field itself, with `b=` emptied and no trailing CRLF
 * (§3.7). Its own value is part of what it signs.
 */
function canonicalizeDkimHeader(raw: string, mode: Canonicalization): string {
  const colon = raw.indexOf(':');
  const name = raw.slice(0, colon);
  const value = raw.slice(colon + 1);
  // Strip everything after b= up to the next tag or the end.
  const withoutSignature = value.replace(/(b=)[^;]*/, '$1');

  if (mode === 'relaxed') {
    return `${name.toLowerCase().trim()}:${withoutSignature.replace(/\s+/g, ' ').trim()}`;
  }
  return `${name}:${withoutSignature}`;
}

/** Turn a DNS TXT record (`v=DKIM1; k=rsa; p=…`) into a usable key. */
export function publicKeyFromDnsRecord(record: string): ReturnType<typeof createPublicKey> {
  const joined = record.replace(/"\s*"/g, '').replace(/"/g, '');
  const p = joined
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('p='))
    ?.slice(2)
    .replace(/\s+/g, '');
  if (!p) throw new Error('DKIM record has no p= tag');
  return createPublicKey({
    key: Buffer.from(`-----BEGIN PUBLIC KEY-----\n${p}\n-----END PUBLIC KEY-----\n`),
    format: 'pem',
  });
}

export interface VerifyOptions {
  /** The `p=` public key, as published in DNS. */
  dnsRecord: string;
  /** Defaults to now; injectable so tests are not time-dependent. */
  now?: Date;
}

/**
 * Verify one DKIM signature over a raw message.
 *
 * Both halves are checked and reported separately, because they fail for very
 * different reasons: a body-hash mismatch means the content changed, while a
 * signature mismatch with a good body hash means a header changed or the key
 * is wrong.
 */
export function verifyDkim(
  raw: string,
  signature: DkimSignature,
  options: VerifyOptions,
): DkimVerificationResult {
  const eml = parseEml(raw);
  const [headerMode, bodyMode] = signature.canonicalization.split('/') as [
    Canonicalization,
    Canonicalization,
  ];

  const base = {
    domain: signature.domain,
    selector: signature.selector,
    expired: signature.expiry !== undefined
      ? signature.expiry * 1000 < (options.now ?? new Date()).getTime()
      : false,
  };

  if (signature.algorithm !== 'rsa-sha256') {
    return { ...base, valid: false, bodyHashMatches: false, signatureMatches: false, reason: `unsupported algorithm ${signature.algorithm}` };
  }

  // 1. Body hash. `l=` limits how much of the body is covered.
  const body = signature.bodyLength !== undefined ? eml.body.slice(0, signature.bodyLength) : eml.body;
  const canonicalBody = bodyMode === 'relaxed' ? canonicalizeBodyRelaxed(body) : canonicalizeBodySimple(body);
  const bodyHash = createHash('sha256').update(canonicalBody, 'utf8').digest('base64');
  const bodyHashMatches = bodyHash === signature.bodyHash;

  if (!bodyHashMatches) {
    return { ...base, valid: false, bodyHashMatches: false, signatureMatches: false, reason: 'body hash mismatch — the message body changed after signing' };
  }

  // 2. Signature over the signed headers plus this header with b= emptied.
  //    The header travels with the parsed signature rather than being looked
  //    up again: its unfolded value has collapsed whitespace, so matching it
  //    against the whitespace-stripped b= value never succeeds.
  const signedData =
    buildSignedHeaders(eml, signature, headerMode) +
    canonicalizeDkimHeader(signature.header.raw, headerMode);

  let signatureMatches = false;
  try {
    signatureMatches = cryptoVerify(
      'sha256',
      Buffer.from(signedData, 'utf8'),
      publicKeyFromDnsRecord(options.dnsRecord),
      Buffer.from(signature.signature ?? '', 'base64'),
    );
  } catch (error) {
    return { ...base, valid: false, bodyHashMatches, signatureMatches: false, reason: error instanceof Error ? error.message : 'signature check threw' };
  }

  return {
    ...base,
    valid: bodyHashMatches && signatureMatches,
    bodyHashMatches,
    signatureMatches,
    reason: signatureMatches ? undefined : 'signature mismatch — a signed header changed, or the key is wrong',
  };
}
