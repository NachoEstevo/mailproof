/**
 * MIME body reading (RFC 2045/2046), for claim extraction.
 *
 * Why this exists: a claim marker must be a line the message *states*, and
 * "line" is a property of the decoded text, not of the transfer encoding.
 * Searching the still-encoded body conflates the two, and a quoted-printable
 * soft break (`=CRLF`) is then read as a line boundary that does not exist —
 * which lets "It is not true that =\r\nYour flight X has been cancelled."
 * satisfy an anchored `^…$` pattern. That is exactly the negation case the
 * anchoring in allowlist.ts exists to stop, so decoding is a security
 * requirement here, not a nicety.
 *
 * The rule this module enforces: decode strictly according to each part's
 * declared `Content-Transfer-Encoding`, then read lines from the decoded
 * text only. Nothing is ever matched against encoded bytes.
 */
import { parseEml, type EmlHeader, type ParsedEml } from './eml.js';

export interface TextPart {
  /** Lower-cased media type, parameters stripped. */
  readonly contentType: string;
  /** Lower-cased `Content-Transfer-Encoding`; `7bit` when absent. */
  readonly encoding: string;
  /** The part's text, decoded per `encoding`. */
  readonly text: string;
}

/** Guard against a malformed or hostile part tree costing unbounded work. */
const MAX_DEPTH = 8;

function headerValue(headers: readonly EmlHeader[], name: string): string | undefined {
  return headers.find((h) => h.name === name)?.value;
}

/** `multipart/alternative; boundary="abc"` → `abc`. */
export function boundaryOf(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = /;\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
}

function mediaType(contentType: string | undefined): string {
  // Absent Content-Type defaults to text/plain (RFC 2045 §5.2).
  return (contentType ?? 'text/plain').split(';')[0]!.trim().toLowerCase();
}

/** Just enough RFC 2045 §6.7: soft breaks and `=XX` escapes. */
export function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64(text: string): string {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
}

/**
 * Decode a part body according to its transfer encoding.
 *
 * An unrecognised encoding is left alone rather than guessed at: inventing a
 * decoding could only ever manufacture content the signer did not write.
 */
export function decodeTransferEncoding(body: string, encoding: string): string {
  switch (encoding) {
    case 'quoted-printable':
      return decodeQuotedPrintable(body);
    case 'base64':
      return decodeBase64(body);
    default:
      return body;
  }
}

/**
 * Split a multipart body on its boundary.
 *
 * The preamble (before the first delimiter) and epilogue (after the closing
 * one) are not parts and are discarded — content there is not displayed and
 * must not be able to carry a claim.
 */
function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const segments = body.split(delimiter);
  // segments[0] is the preamble; the segment after the closing `--` is the
  // epilogue and is identified by its leading `--`.
  return segments
    .slice(1)
    .filter((segment) => !segment.startsWith('--'))
    .map((segment) => segment.replace(/^\r?\n/, ''));
}

function collect(headers: readonly EmlHeader[], body: string, depth: number, out: TextPart[]): void {
  if (depth > MAX_DEPTH) return;

  const contentType = headerValue(headers, 'content-type');
  const type = mediaType(contentType);

  if (type.startsWith('multipart/')) {
    const boundary = boundaryOf(contentType);
    if (!boundary) return;
    for (const segment of splitMultipart(body, boundary)) {
      // Each part carries its own headers, including its own encoding.
      let part: ParsedEml;
      try {
        part = parseEml(segment);
      } catch {
        continue; // A part with no header/body separator carries nothing.
      }
      collect(part.headers, part.body, depth + 1, out);
    }
    return;
  }

  if (!type.startsWith('text/')) return;

  const encoding = (headerValue(headers, 'content-transfer-encoding') ?? '7bit')
    .trim()
    .toLowerCase();
  out.push({ contentType: type, encoding, text: decodeTransferEncoding(body, encoding) });
}

/**
 * Every `text/*` part of a message, decoded.
 *
 * @param body Pass the *signed* body when a signature limits it with `l=`;
 * this function does not know about signatures and will happily read whatever
 * it is given.
 */
export function textParts(eml: ParsedEml, body: string = eml.body): TextPart[] {
  const parts: TextPart[] = [];
  collect(eml.headers, body, 0, parts);
  return parts;
}

/**
 * The readings a claim marker may be drawn from.
 *
 * `text/plain` only. An HTML part renders to text through a transformation
 * this project does not implement, and guessing at it would mean matching a
 * marker against something no reader ever saw. A message with no plain-text
 * part yields nothing, and extraction fails closed.
 */
export function plainTextReadings(eml: ParsedEml, body: string = eml.body): string[] {
  const parts = textParts(eml, body).filter((p) => p.contentType === 'text/plain');
  return parts.map((p) => p.text);
}
