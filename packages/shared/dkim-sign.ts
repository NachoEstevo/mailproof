/**
 * DKIM signing (RFC 6376), for synthetic test fixtures.
 *
 * The verifier needs adversarial cases — tampered bodies, replayed headers,
 * expired signatures — and those cannot come from a real provider on demand.
 * So tests generate an RSA key, sign with it here, and "publish" the key as
 * an inline DNS record string.
 *
 * Canonicalisation is shared with dkim.ts, which means a sign→verify round
 * trip cannot catch a canonicalisation bug on its own. The anchor for that is
 * the real Google-signed fixture in dkim.test.ts: the same verify code passes
 * against a signature this file had no hand in.
 */
import { createHash, sign as cryptoSign, type KeyObject } from 'node:crypto';

import {
  canonicalizeBodyRelaxed,
  canonicalizeBodySimple,
  canonicalizeHeaderRelaxed,
  canonicalizeHeaderSimple,
  type Canonicalization,
} from './dkim.js';
import { parseEml, type ParsedEml } from './eml.js';

export interface DkimSignOptions {
  readonly domain: string;
  readonly selector: string;
  readonly privateKey: KeyObject;
  /** Header names for `h=`, in order. May repeat a name to oversign it. */
  readonly signedHeaders?: readonly string[];
  readonly canonicalization?: `${Canonicalization}/${Canonicalization}`;
  /** `t=` / `x=`, seconds since epoch. */
  readonly timestamp?: number;
  readonly expiry?: number;
  /** `l=`, if the signature should cover only part of the body. */
  readonly bodyLength?: number;
}

const DEFAULT_SIGNED_HEADERS = ['from', 'to', 'subject', 'date', 'message-id'] as const;

/** The TXT record a verifier would fetch for this key. */
export function dnsRecordForPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return `v=DKIM1; k=rsa; p=${der.toString('base64')}`;
}

/**
 * Sign a raw message and return it with the DKIM-Signature field prepended.
 *
 * Header instances are consumed bottom-up for the signed block, mirroring
 * RFC 6376 §5.4.2 — the same order the verifier reconstructs.
 */
export function dkimSign(raw: string, options: DkimSignOptions): string {
  const eml = parseEml(raw);
  const canonicalization = options.canonicalization ?? 'relaxed/relaxed';
  const [headerMode, bodyMode] = canonicalization.split('/') as [
    Canonicalization,
    Canonicalization,
  ];
  const signedHeaders = options.signedHeaders ?? DEFAULT_SIGNED_HEADERS;

  const body =
    options.bodyLength !== undefined ? eml.body.slice(0, options.bodyLength) : eml.body;
  const canonicalBody =
    bodyMode === 'relaxed' ? canonicalizeBodyRelaxed(body) : canonicalizeBodySimple(body);
  const bodyHash = createHash('sha256').update(canonicalBody, 'utf8').digest('base64');

  const tags = [
    'v=1',
    'a=rsa-sha256',
    `c=${canonicalization}`,
    `d=${options.domain}`,
    `s=${options.selector}`,
    options.timestamp !== undefined ? `t=${options.timestamp}` : null,
    options.expiry !== undefined ? `x=${options.expiry}` : null,
    options.bodyLength !== undefined ? `l=${options.bodyLength}` : null,
    `h=${signedHeaders.join(':')}`,
    `bh=${bodyHash}`,
    'b=',
  ].filter((t): t is string => t !== null);
  const unsignedField = `DKIM-Signature: ${tags.join('; ')}`;

  const signedData =
    buildSignedHeaderBlock(eml, signedHeaders, headerMode) +
    canonicalizeDkimField(unsignedField, headerMode);

  const signature = cryptoSign(
    'sha256',
    Buffer.from(signedData, 'utf8'),
    options.privateKey,
  ).toString('base64');

  return `${unsignedField}${signature}\r\n${raw}`;
}

/** Bottom-up consumption of header instances, per RFC 6376 §5.4.2. */
function buildSignedHeaderBlock(
  eml: ParsedEml,
  signedHeaders: readonly string[],
  mode: Canonicalization,
): string {
  const remaining = new Map<string, Array<{ raw: string; rawName: string; value: string }>>();
  for (const header of eml.headers) {
    const list = remaining.get(header.name) ?? [];
    list.push(header);
    remaining.set(header.name, list);
  }
  for (const list of remaining.values()) list.reverse();

  let block = '';
  for (const name of signedHeaders) {
    const next = remaining.get(name.toLowerCase())?.shift();
    if (!next) continue;
    block +=
      mode === 'relaxed'
        ? canonicalizeHeaderRelaxed(next.rawName, next.value)
        : canonicalizeHeaderSimple(next.raw);
  }
  return block;
}

/** The DKIM field itself: canonicalised, `b=` empty, no trailing CRLF (§3.7). */
function canonicalizeDkimField(field: string, mode: Canonicalization): string {
  const colon = field.indexOf(':');
  const name = field.slice(0, colon);
  const value = field.slice(colon + 1);
  if (mode === 'relaxed') {
    return `${name.toLowerCase().trim()}:${value.replace(/\s+/g, ' ').trim()}`;
  }
  return `${name}:${value}`;
}
