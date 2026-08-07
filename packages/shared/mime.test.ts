/**
 * MIME reading, with the security case first.
 *
 * The quoted-printable soft break is not a stylistic detail: it is the
 * difference between "the message states the claim" and "the message denies
 * the claim, but the encoded bytes happen to line up".
 */
import { describe, expect, it } from 'vitest';

import { parseEml } from './eml.js';
import {
  boundaryOf,
  decodeQuotedPrintable,
  decodeTransferEncoding,
  plainTextReadings,
  textParts,
} from './mime.js';

const MULTIPART =
  'From: a@example.com\r\n' +
  'Content-Type: multipart/alternative; boundary="XYZ"\r\n' +
  '\r\n' +
  'this preamble is not a part\r\n' +
  '--XYZ\r\n' +
  'Content-Type: text/plain; charset="UTF-8"\r\n' +
  '\r\n' +
  'plain body line\r\n' +
  '--XYZ\r\n' +
  'Content-Type: text/html; charset="UTF-8"\r\n' +
  '\r\n' +
  '<div>html body line</div>\r\n' +
  '--XYZ--\r\n' +
  'this epilogue is not a part\r\n';

describe('a quoted-printable soft break is not a line boundary', () => {
  // The attack: the sentence reads "It is not true that Your flight ... has
  // been cancelled." Splitting the *encoded* text turns the soft break into a
  // line boundary and leaves "Your flight ... has been cancelled." alone on a
  // line, satisfying an anchored ^…$ pattern that exists to reject exactly
  // this negation (§41.8).
  const raw =
    'From: a@example.com\r\n' +
    'Content-Type: text/plain\r\n' +
    'Content-Transfer-Encoding: quoted-printable\r\n' +
    '\r\n' +
    'It is not true that =\r\n' +
    'Your flight MP401 has been cancelled.\r\n';

  it('joins the soft-broken sentence into one line', () => {
    const [reading] = plainTextReadings(parseEml(raw));
    expect(reading).toBe('It is not true that Your flight MP401 has been cancelled.\r\n');
    expect(reading!.split(/\r\n|\n/)).not.toContain('Your flight MP401 has been cancelled.');
  });
});

describe('decoding is driven by Content-Transfer-Encoding', () => {
  it('leaves =0A alone when the part is not quoted-printable', () => {
    // Decoding unconditionally would turn this single line into two and
    // manufacture a marker line that the message never states.
    const raw =
      'From: a@example.com\r\n' +
      'Content-Type: text/plain\r\n' +
      '\r\n' +
      'You wrote: =0AYour flight MP401 has been cancelled.=0A -- end\r\n';
    const [reading] = plainTextReadings(parseEml(raw));
    expect(reading).toContain('=0A');
    expect(reading!.split(/\r\n|\n/).map((l) => l.trim())).not.toContain(
      'Your flight MP401 has been cancelled.',
    );
  });

  it('decodes =0A when the part declares quoted-printable', () => {
    const raw =
      'From: a@example.com\r\n' +
      'Content-Type: text/plain\r\n' +
      'Content-Transfer-Encoding: quoted-printable\r\n' +
      '\r\n' +
      'first=0Asecond\r\n';
    expect(plainTextReadings(parseEml(raw))[0]).toBe('first\nsecond\r\n');
  });

  it('decodes base64 parts', () => {
    const raw =
      'From: a@example.com\r\n' +
      'Content-Type: text/plain\r\n' +
      'Content-Transfer-Encoding: base64\r\n' +
      '\r\n' +
      `${Buffer.from('decoded line').toString('base64')}\r\n`;
    expect(plainTextReadings(parseEml(raw))[0]).toContain('decoded line');
  });

  it('leaves an unrecognised encoding untouched rather than guessing', () => {
    expect(decodeTransferEncoding('=41', 'x-unknown')).toBe('=41');
    expect(decodeTransferEncoding('=41', 'quoted-printable')).toBe('A');
  });
});

describe('multipart walking', () => {
  it('reads each part with its own headers', () => {
    const parts = textParts(parseEml(MULTIPART));
    expect(parts.map((p) => p.contentType)).toEqual(['text/plain', 'text/html']);
  });

  it('offers only text/plain as a marker source', () => {
    const readings = plainTextReadings(parseEml(MULTIPART));
    expect(readings).toHaveLength(1);
    expect(readings[0]).toContain('plain body line');
    expect(readings[0]).not.toContain('html body line');
  });

  it('ignores the preamble and the epilogue', () => {
    const joined = plainTextReadings(parseEml(MULTIPART)).join('\n');
    expect(joined).not.toContain('preamble');
    expect(joined).not.toContain('epilogue');
  });

  it('decodes a quoted-printable part inside a multipart message', () => {
    const raw =
      'From: a@example.com\r\n' +
      'Content-Type: multipart/mixed; boundary=B\r\n' +
      '\r\n' +
      '--B\r\n' +
      'Content-Type: text/plain\r\n' +
      'Content-Transfer-Encoding: quoted-printable\r\n' +
      '\r\n' +
      'soft =\r\n' +
      'joined\r\n' +
      '--B--\r\n';
    expect(plainTextReadings(parseEml(raw))[0]).toContain('soft joined');
  });

  it('yields nothing for a multipart message with no plain-text part', () => {
    const raw =
      'From: a@example.com\r\n' +
      'Content-Type: multipart/alternative; boundary=B\r\n' +
      '\r\n' +
      '--B\r\n' +
      'Content-Type: text/html\r\n' +
      '\r\n' +
      '<p>only html</p>\r\n' +
      '--B--\r\n';
    expect(plainTextReadings(parseEml(raw))).toEqual([]);
  });

  it('treats a message with no Content-Type as text/plain', () => {
    const raw = 'From: a@example.com\r\n\r\njust text\r\n';
    expect(plainTextReadings(parseEml(raw))[0]).toBe('just text\r\n');
  });
});

describe('helpers', () => {
  it('boundaryOf reads quoted and bare forms', () => {
    expect(boundaryOf('multipart/mixed; boundary="a b"')).toBe('a b');
    expect(boundaryOf('multipart/mixed; boundary=abc')).toBe('abc');
    expect(boundaryOf('text/plain')).toBeUndefined();
    expect(boundaryOf(undefined)).toBeUndefined();
  });

  it('decodeQuotedPrintable handles soft breaks and escapes', () => {
    expect(decodeQuotedPrintable('can=\r\ncelled')).toBe('cancelled');
    expect(decodeQuotedPrintable('=41=42 ok')).toBe('AB ok');
    expect(decodeQuotedPrintable('plain text')).toBe('plain text');
  });
});
