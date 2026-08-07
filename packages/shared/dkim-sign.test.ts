/**
 * Sign→verify round trips over the synthetic signer.
 *
 * These pin the signer/verifier pair to each other; the real Google-signed
 * fixture in dkim.test.ts pins the pair to the outside world.
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { dkimSign, dnsRecordForPublicKey } from './dkim-sign.js';
import { verifyDkim } from './dkim.js';
import { parseDkimSignatures, parseEml } from './eml.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const DNS_RECORD = dnsRecordForPublicKey(publicKey);

const MESSAGE =
  'From: Demo Airline <notifications@demo-airline.example>\r\n' +
  'To: passenger@example.com\r\n' +
  'Subject: Your flight MP401 has been cancelled\r\n' +
  'Date: Fri, 07 Aug 2026 12:00:00 +0000\r\n' +
  'Message-ID: <synthetic-0001@demo-airline.example>\r\n' +
  '\r\n' +
  'Hello Ana Demo,\r\n' +
  'Your flight MP401 has been cancelled.\r\n' +
  'Booking reference: MP-8F2A19\r\n';

function signDefault(raw = MESSAGE, overrides = {}) {
  return dkimSign(raw, {
    domain: 'demo-airline.example',
    selector: 'test',
    privateKey,
    ...overrides,
  });
}

function verifyRaw(raw: string) {
  const [signature] = parseDkimSignatures(parseEml(raw));
  return verifyDkim(raw, signature!, { dnsRecord: DNS_RECORD });
}

describe('dkimSign round trip', () => {
  it('produces a signature verifyDkim accepts (relaxed/relaxed)', () => {
    const result = verifyRaw(signDefault());
    expect(result.bodyHashMatches).toBe(true);
    expect(result.signatureMatches).toBe(true);
    expect(result.valid).toBe(true);
  });

  it('produces a signature verifyDkim accepts (simple/simple)', () => {
    const result = verifyRaw(signDefault(MESSAGE, { canonicalization: 'simple/simple' }));
    expect(result.valid).toBe(true);
  });

  it('fails the body hash when the body is tampered after signing', () => {
    const tampered = signDefault().replace('MP-8F2A19', 'MP-000000');
    const result = verifyRaw(tampered);
    expect(result.bodyHashMatches).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('fails the signature when a signed header is tampered after signing', () => {
    const tampered = signDefault().replace(
      'Subject: Your flight MP401',
      'Subject: Your flight MP999',
    );
    const result = verifyRaw(tampered);
    expect(result.bodyHashMatches).toBe(true);
    expect(result.signatureMatches).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('carries t= and x= through to the parsed signature', () => {
    const raw = signDefault(MESSAGE, { timestamp: 1_700_000_000, expiry: 1_700_000_600 });
    const [signature] = parseDkimSignatures(parseEml(raw));
    expect(signature!.timestamp).toBe(1_700_000_000);
    expect(signature!.expiry).toBe(1_700_000_600);
    expect(
      verifyDkim(raw, signature!, { dnsRecord: DNS_RECORD, now: new Date(1_700_000_500_000) })
        .valid,
    ).toBe(true);
    expect(
      verifyDkim(raw, signature!, { dnsRecord: DNS_RECORD, now: new Date(1_700_000_700_000) })
        .expired,
    ).toBe(true);
  });

  it('rejects a signature from a different key', () => {
    const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const result = verifyRaw(signDefault(MESSAGE, { privateKey: otherKey }));
    expect(result.bodyHashMatches).toBe(true);
    expect(result.signatureMatches).toBe(false);
  });
});
