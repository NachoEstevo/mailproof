/**
 * Minimal RFC 5322 / RFC 6376 reader for inspecting `.eml` fixtures.
 *
 * Deliberately not a mail library. General parsers normalise headers —
 * refolding, reordering, decoding — and every one of those transformations
 * changes what DKIM signed. Here the raw bytes are preserved so the report
 * describes the message as the verifier will see it.
 *
 * This inspects; it does not verify. In-circuit DKIM verification is ZK
 * Email's job (§8, option C: do not reimplement it).
 */

export interface EmlHeader {
  /** Lower-cased field name, for lookup. */
  readonly name: string;
  /** Field name exactly as it appears. */
  readonly rawName: string;
  /** Field value, unfolded (continuation lines joined), not decoded. */
  readonly value: string;
  /** The complete field including folding, as it appears in the message. */
  readonly raw: string;
}

export type LineEnding = 'CRLF' | 'LF' | 'mixed';

export interface ParsedEml {
  readonly headers: readonly EmlHeader[];
  readonly body: string;
  readonly lineEnding: LineEnding;
  readonly headerBlockBytes: number;
  readonly bodyBytes: number;
}

function detectLineEnding(raw: string): LineEnding {
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const allLf = (raw.match(/\n/g) ?? []).length;
  const bareLf = allLf - crlf;
  if (crlf > 0 && bareLf > 0) return 'mixed';
  return crlf > 0 ? 'CRLF' : 'LF';
}

/**
 * Split a message into headers and body.
 *
 * A well-formed message separates them with a blank line. We accept either
 * line ending because files that have travelled through a text editor often
 * arrive with LF — worth reporting, since it usually breaks the body hash.
 */
export function parseEml(raw: string): ParsedEml {
  const lineEnding = detectLineEnding(raw);

  let separatorIndex = raw.indexOf('\r\n\r\n');
  let separatorLength = 4;
  const lfIndex = raw.indexOf('\n\n');
  if (separatorIndex === -1 || (lfIndex !== -1 && lfIndex < separatorIndex)) {
    separatorIndex = lfIndex;
    separatorLength = 2;
  }
  if (separatorIndex === -1) {
    throw new Error('parseEml: no blank line separating headers from body');
  }

  const headerBlock = raw.slice(0, separatorIndex);
  const body = raw.slice(separatorIndex + separatorLength);

  return {
    headers: parseHeaderBlock(headerBlock),
    body,
    lineEnding,
    headerBlockBytes: Buffer.byteLength(headerBlock, 'utf8'),
    bodyBytes: Buffer.byteLength(body, 'utf8'),
  };
}

function parseHeaderBlock(block: string): EmlHeader[] {
  const lines = block.split(/\r\n|\n/);
  const headers: EmlHeader[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const raw = current.join('\r\n');
    const colon = raw.indexOf(':');
    if (colon > 0) {
      const rawName = raw.slice(0, colon);
      // Unfolding per RFC 5322: continuation lines are joined and their
      // leading whitespace collapsed to a single space.
      const value = current
        .map((line, i) => (i === 0 ? line.slice(colon + 1) : line))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      headers.push({ name: rawName.toLowerCase().trim(), rawName, value, raw });
    }
    current = [];
  };

  for (const line of lines) {
    if (/^[ \t]/.test(line) && current.length > 0) {
      current.push(line);
    } else {
      flush();
      current = [line];
    }
  }
  flush();

  return headers;
}

export function getHeaders(eml: ParsedEml, name: string): EmlHeader[] {
  const wanted = name.toLowerCase();
  return eml.headers.filter((h) => h.name === wanted);
}

export function getHeader(eml: ParsedEml, name: string): EmlHeader | undefined {
  return getHeaders(eml, name)[0];
}

export interface DkimSignature {
  /** The header this was parsed from, verbatim — the signature covers it. */
  readonly header: EmlHeader;
  /** Raw tag values, keyed by tag name. */
  readonly tags: ReadonlyMap<string, string>;
  /** `v=` — must be 1. */
  readonly version: string | undefined;
  /** `a=` — signing algorithm, e.g. `rsa-sha256`. */
  readonly algorithm: string | undefined;
  /** `d=` — the signing domain. This, not `From`, is what DKIM authenticates. */
  readonly domain: string | undefined;
  /** `s=` — selector, which picks the DNS key record. */
  readonly selector: string | undefined;
  /** `h=` — the headers covered by the signature, in order. */
  readonly signedHeaders: readonly string[];
  /** `c=` — header/body canonicalisation, e.g. `relaxed/relaxed`. */
  readonly canonicalization: string;
  /** `bh=` — body hash. */
  readonly bodyHash: string | undefined;
  /** `b=` — the signature itself. */
  readonly signature: string | undefined;
  /** `l=` — signed body length, if the signer limited it. */
  readonly bodyLength: number | undefined;
  /** `t=` / `x=` — signature timestamp and expiry, if present. */
  readonly timestamp: number | undefined;
  readonly expiry: number | undefined;
}

/**
 * Parse the DKIM-Signature tag list.
 *
 * Tags are `name=value` separated by semicolons; values may be folded across
 * lines, and for base64 tags the folding whitespace is not part of the value.
 */
export function parseDkimSignature(header: EmlHeader): DkimSignature {
  const tags = new Map<string, string>();
  for (const part of header.value.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    // Whitespace inside base64 is folding artefact, never data.
    const value = part.slice(eq + 1).replace(/\s+/g, '').trim();
    if (key) tags.set(key, value);
  }

  const canonicalization = tags.get('c') || 'simple/simple';
  const headerList = tags.get('h');
  const bodyLength = tags.get('l');
  const timestamp = tags.get('t');
  const expiry = tags.get('x');

  return {
    header,
    tags,
    version: tags.get('v'),
    algorithm: tags.get('a'),
    domain: tags.get('d'),
    selector: tags.get('s'),
    signedHeaders: headerList ? headerList.split(':').map((h) => h.trim().toLowerCase()) : [],
    // `c=relaxed` means relaxed/simple: an omitted body algorithm is `simple`.
    canonicalization: canonicalization.includes('/')
      ? canonicalization
      : `${canonicalization}/simple`,
    bodyHash: tags.get('bh'),
    signature: tags.get('b'),
    bodyLength: bodyLength ? Number(bodyLength) : undefined,
    timestamp: timestamp ? Number(timestamp) : undefined,
    expiry: expiry ? Number(expiry) : undefined,
  };
}

export function parseDkimSignatures(eml: ParsedEml): DkimSignature[] {
  return getHeaders(eml, 'dkim-signature').map(parseDkimSignature);
}

/**
 * Pick the signature for an expected domain.
 *
 * A message can carry several DKIM signatures — the sender's, the mailing
 * list's, the relay's. Taking the first one is a real trap (§20.8): it may
 * belong to a forwarder rather than to the party whose claim we care about.
 * So callers must say which domain they mean.
 */
export function selectSignatureForDomain(
  signatures: readonly DkimSignature[],
  domain: string,
): DkimSignature | undefined {
  const wanted = domain.trim().toLowerCase();
  return signatures.find((s) => s.domain?.trim().toLowerCase() === wanted);
}

/** The DNS name holding the public key for a signature. */
export function dkimDnsRecordName(signature: DkimSignature): string | undefined {
  if (!signature.domain || !signature.selector) return undefined;
  return `${signature.selector}._domainkey.${signature.domain}`;
}
