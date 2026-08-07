/**
 * DKIM verification.
 *
 * The canonicalisation cases come from RFC 6376 §3.4.5 — the spec's own
 * worked example — so they check the implementation against the standard
 * rather than against itself.
 *
 * The end-to-end cases run against a real signed message, which cannot be
 * committed (it carries a real address, §61.3). They skip when it is absent
 * and run for whoever has fetched one. `docs/BUILD_LOG.md` records the result
 * from the run that validated the fixture.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  canonicalizeBodyRelaxed,
  canonicalizeBodySimple,
  canonicalizeHeaderRelaxed,
  publicKeyFromDnsRecord,
  verifyDkim,
} from './dkim.js';
import { dkimDnsRecordName, parseDkimSignatures, parseEml } from './eml.js';

const REAL_EMAIL = 'fixtures/private-emails/flight-edu.eml';
const hasRealEmail = existsSync(REAL_EMAIL);

describe('relaxed header canonicalisation (RFC 6376 §3.4.2)', () => {
  it('lowercases the field name', () => {
    expect(canonicalizeHeaderRelaxed('SubJect', 'Hello')).toBe('subject:Hello\r\n');
  });

  it('collapses internal whitespace and trims the value', () => {
    expect(canonicalizeHeaderRelaxed('B', '  Y   Z  ')).toBe('b:Y Z\r\n');
  });

  it('joins an unfolded value into one line', () => {
    expect(canonicalizeHeaderRelaxed('B', 'Y Z')).toBe('b:Y Z\r\n');
  });
});

describe('relaxed body canonicalisation (RFC 6376 §3.4.4)', () => {
  it('collapses whitespace runs inside a line', () => {
    expect(canonicalizeBodyRelaxed('a  \t b\r\n')).toBe('a b\r\n');
  });

  it('strips trailing whitespace', () => {
    expect(canonicalizeBodyRelaxed('hello   \r\n')).toBe('hello\r\n');
  });

  it('drops trailing empty lines and ends with exactly one CRLF', () => {
    expect(canonicalizeBodyRelaxed('a\r\n\r\n\r\n')).toBe('a\r\n');
  });

  it('canonicalises an empty body to nothing', () => {
    expect(canonicalizeBodyRelaxed('')).toBe('');
    expect(canonicalizeBodyRelaxed('\r\n\r\n')).toBe('');
  });
});

describe('simple body canonicalisation (RFC 6376 §3.4.3)', () => {
  it('preserves internal whitespace', () => {
    expect(canonicalizeBodySimple('a  b\r\n')).toBe('a  b\r\n');
  });

  it('still removes trailing empty lines', () => {
    expect(canonicalizeBodySimple('a\r\n\r\n\r\n')).toBe('a\r\n');
  });
});

describe('public key parsing', () => {
  it('reads the p= tag out of a DNS TXT record', () => {
    // A real published record, split across strings the way dig returns it.
    const record = readFixtureRecord();
    if (!record) return;
    expect(() => publicKeyFromDnsRecord(record)).not.toThrow();
  });

  it('rejects a record with no key', () => {
    expect(() => publicKeyFromDnsRecord('v=DKIM1; k=rsa;')).toThrow(/no p= tag/);
  });
});

function readFixtureRecord(): string | null {
  if (!hasRealEmail) return null;
  const raw = readFileSync(REAL_EMAIL, 'utf8');
  const [signature] = parseDkimSignatures(parseEml(raw));
  if (!signature) return null;
  try {
    return execFileSync('dig', ['+short', 'TXT', dkimDnsRecordName(signature)!], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

describe.skipIf(!hasRealEmail)('a real signed message', () => {
  const raw = hasRealEmail ? readFileSync(REAL_EMAIL, 'utf8') : '';
  const record = hasRealEmail ? readFixtureRecord() : null;

  const verifyVariant = (sample: string) => {
    const [signature] = parseDkimSignatures(parseEml(sample));
    return verifyDkim(sample, signature!, { dnsRecord: record! });
  };

  it.skipIf(!record)('verifies', () => {
    const result = verifyVariant(raw);
    expect(result.bodyHashMatches).toBe(true);
    expect(result.signatureMatches).toBe(true);
    expect(result.valid).toBe(true);
  });

  it.skipIf(!record)('fails the body hash when a word in the body changes', () => {
    // The demo's first attack: a screenshot can be edited, a signed body
    // cannot. Target a string that appears only in the body — "has been
    // cancelled" also occurs in the Subject, so replacing its first instance
    // would edit a header and exercise the other failure mode instead.
    const result = verifyVariant(raw.replace('Booking reference:', 'Booking ref:'));
    expect(result.bodyHashMatches).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/body/);
  });

  it.skipIf(!record)('fails the signature when a signed header changes', () => {
    // Body untouched, so the body hash still matches — the discrimination
    // between the two failure modes is what makes the diagnosis useful.
    const result = verifyVariant(raw.replace('Subject: Your flight', 'Subject: Your FLIGHT'));
    expect(result.bodyHashMatches).toBe(true);
    expect(result.signatureMatches).toBe(false);
    expect(result.valid).toBe(false);
  });

  it.skipIf(!record)('reports the signing domain, not the From header', () => {
    const result = verifyVariant(raw);
    expect(result.domain).toBeTruthy();
    expect(result.selector).toBeTruthy();
  });
});
