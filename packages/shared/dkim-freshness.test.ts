/**
 * Age bounds on a DKIM signature.
 *
 * This project pins the DNS key so verification does not depend on DNS being
 * up — which also means a rotated or revoked key keeps verifying forever. With
 * no age bound, a 2014 archive is evidence in 2026, an alumnus keeps a benefit
 * for life, and a breach dump is a farm.
 *
 * Signed hermetically with a throwaway key so the clock, not a fixture, is
 * what each case varies.
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { dkimSign, dnsRecordForPublicKey } from './dkim-sign.js';
import { verifyDkim } from './dkim.js';
import { parseDkimSignatures, parseEml } from './eml.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const DNS_RECORD = dnsRecordForPublicKey(publicKey);

const NOW = new Date('2026-08-08T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const MESSAGE = [
  'From: Ana <ana@udesa.edu.ar>',
  'To: Ana <ana@udesa.edu.ar>',
  'Subject: MailProof',
  'Message-ID: <freshness@udesa.edu.ar>',
  'Date: Sat, 8 Aug 2026 09:00:00 -0300',
  '',
  'MP-TEST-CODE',
  '',
].join('\r\n');

/** A signed message whose `t=` sits a given age in the past. */
function signedAt(ageMs: number | 'no-timestamp'): string {
  return dkimSign(MESSAGE, {
    domain: 'udesa.edu.ar',
    selector: 'test',
    privateKey,
    ...(ageMs === 'no-timestamp'
      ? {}
      : { timestamp: Math.floor((NOW.getTime() - ageMs) / 1000) }),
  });
}

const verify = (raw: string, options: Partial<Parameters<typeof verifyDkim>[2]> = {}) => {
  const signature = parseDkimSignatures(parseEml(raw))[0]!;
  return verifyDkim(raw, signature, { dnsRecord: DNS_RECORD, now: NOW, ...options });
};

describe('without an age bound', () => {
  it('a fourteen-year-old signature still verifies, which is the problem', () => {
    const ancient = verify(signedAt(14 * 365 * DAY_MS));
    expect(ancient.valid).toBe(true);
    expect(ancient.stale).toBe(false);
    expect(ancient.ageSeconds).toBeGreaterThan(14 * 365 * 24 * 3600 - 60);
  });
});

describe('with maxAgeMs', () => {
  it('accepts a signature inside the window', () => {
    const fresh = verify(signedAt(5 * 60 * 1000), { maxAgeMs: 30 * 60 * 1000 });
    expect(fresh.valid).toBe(true);
    expect(fresh.stale).toBe(false);
  });

  it('marks one outside the window stale without calling it invalid', () => {
    // The signature is genuine; it is the age we refuse. Conflating the two
    // would report "signature mismatch" for a message nobody tampered with.
    const old = verify(signedAt(2 * DAY_MS), { maxAgeMs: DAY_MS });
    expect(old.valid).toBe(true);
    expect(old.stale).toBe(true);
  });

  it('treats a missing t= as stale, since its age cannot be established', () => {
    const undated = verify(signedAt('no-timestamp'), { maxAgeMs: DAY_MS });
    expect(undated.valid).toBe(true);
    expect(undated.stale).toBe(true);
    expect(undated.ageSeconds).toBeUndefined();
  });

  it('can be told to accept a missing t=, explicitly and never by default', () => {
    const undated = verify(signedAt('no-timestamp'), {
      maxAgeMs: DAY_MS,
      allowMissingTimestamp: true,
    });
    expect(undated.stale).toBe(false);
  });

  it('is exact at the boundary', () => {
    expect(verify(signedAt(DAY_MS), { maxAgeMs: DAY_MS }).stale).toBe(false);
    expect(verify(signedAt(DAY_MS + 1000), { maxAgeMs: DAY_MS }).stale).toBe(true);
  });

  it('does not treat a clock-skewed future signature as stale', () => {
    // Signers ahead of us are common; refusing them would be a false negative
    // with no security value, since a future t= makes evidence younger.
    const future = verify(signedAt(-5 * 60 * 1000), { maxAgeMs: DAY_MS });
    expect(future.stale).toBe(false);
    expect(future.ageSeconds).toBeLessThan(0);
  });
});

describe('stale and expired are different facts', () => {
  it('x= is the sender saying so; maxAgeMs is us deciding', () => {
    const raw = dkimSign(MESSAGE, {
      domain: 'udesa.edu.ar',
      selector: 'test',
      privateKey,
      timestamp: Math.floor((NOW.getTime() - 10 * 60 * 1000) / 1000),
      expiry: Math.floor((NOW.getTime() - 60 * 1000) / 1000),
    });
    const result = verify(raw, { maxAgeMs: DAY_MS });
    expect(result.expired).toBe(true);
    expect(result.stale).toBe(false);
  });
});
