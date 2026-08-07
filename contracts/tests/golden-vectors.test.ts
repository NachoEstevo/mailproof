/**
 * Cross-checks the TypeScript claim/crypto layer against the compiled circuit.
 *
 * The attestor signs using the TypeScript implementation; the contract
 * verifies using the Compact one. If the two disagree about a single byte of
 * encoding, every signature is rejected on chain — and the failure surfaces as
 * "invalid attestor signature", which looks like a key problem rather than an
 * encoding one. These tests catch that at the source. This is the golden
 * vector requirement in §44.3.
 */
import { describe, expect, it } from 'vitest';

import { pureCircuits } from '../managed/mailproof/contract/index.js';
import {
  canonicalClaimHash,
  deriveSubjectBinding,
} from '../../packages/shared/claim.js';
import { pad32 } from '../../packages/shared/hashes.js';
import { challenge, joinScalar, sign, splitScalar, verify } from '../../packages/shared/schnorr.js';
import {
  ATTESTOR_PUBLIC_KEY,
  ATTESTOR_SECRET_KEY,
  buildClaim,
  CAMPAIGN_ID,
  ROGUE_SECRET_KEY,
  signClaim,
  SUBJECT_SECRET,
} from './fixtures.js';

describe('canonical claim hash', () => {
  it('matches the circuit byte for byte', () => {
    const claim = buildClaim();
    expect(canonicalClaimHash(claim)).toEqual(pureCircuits.canonicalClaimHash(claim));
  });

  it('changes when any single field changes', () => {
    const base = canonicalClaimHash(buildClaim());
    const mutations = [
      { claimType: 2n },
      { blueprintIdHash: pad32('other-blueprint') },
      { issuerDomainHash: pad32('other-issuer') },
      { campaignId: pad32('other-campaign') },
      { subjectBindingHash: pad32('other-subject') },
      { claimNullifier: pad32('other-nullifier') },
      { proofDigest: pad32('other-digest') },
    ];
    for (const mutation of mutations) {
      const mutated = canonicalClaimHash(buildClaim(mutation));
      expect(mutated, `mutating ${Object.keys(mutation)[0]} must change the hash`).not.toEqual(base);
      // And the circuit must agree about the mutated value too.
      expect(mutated).toEqual(pureCircuits.canonicalClaimHash(buildClaim(mutation)));
    }
  });
});

describe('subject binding', () => {
  it('matches the circuit', () => {
    expect(deriveSubjectBinding(SUBJECT_SECRET, CAMPAIGN_ID)).toEqual(
      pureCircuits.deriveSubjectBinding(SUBJECT_SECRET, CAMPAIGN_ID),
    );
  });

  it('is campaign-scoped, so the same secret is unlinkable across campaigns', () => {
    const a = deriveSubjectBinding(SUBJECT_SECRET, CAMPAIGN_ID);
    const b = deriveSubjectBinding(SUBJECT_SECRET, pad32('a-different-campaign'));
    expect(a).not.toEqual(b);
  });
});

describe('Schnorr signatures', () => {
  it('produces signatures the circuit accepts', () => {
    const claim = buildClaim();
    const signature = signClaim(claim);
    expect(
      pureCircuits.verifySchnorr(ATTESTOR_PUBLIC_KEY, canonicalClaimHash(claim), signature),
    ).toBe(true);
  });

  it('agrees with the circuit that a wrong-key signature is invalid', () => {
    const claim = buildClaim();
    const signature = signClaim(claim, ROGUE_SECRET_KEY);
    expect(verify(ATTESTOR_PUBLIC_KEY, canonicalClaimHash(claim), signature)).toBe(false);
    expect(
      pureCircuits.verifySchnorr(ATTESTOR_PUBLIC_KEY, canonicalClaimHash(claim), signature),
    ).toBe(false);
  });

  it('agrees with the circuit that a tampered message is invalid', () => {
    const claim = buildClaim();
    const signature = signClaim(claim);
    const otherMessage = canonicalClaimHash(buildClaim({ claimNullifier: pad32('tampered') }));
    expect(verify(ATTESTOR_PUBLIC_KEY, otherMessage, signature)).toBe(false);
    expect(pureCircuits.verifySchnorr(ATTESTOR_PUBLIC_KEY, otherMessage, signature)).toBe(false);
  });

  it('is deterministic for the same key and message', () => {
    const message = canonicalClaimHash(buildClaim());
    expect(sign(ATTESTOR_SECRET_KEY, message)).toEqual(sign(ATTESTOR_SECRET_KEY, message));
  });

  it('derives different challenges for different messages', () => {
    const claim = buildClaim();
    const signature = signClaim(claim);
    const c1 = challenge(signature.announcement, ATTESTOR_PUBLIC_KEY, canonicalClaimHash(claim));
    const c2 = challenge(signature.announcement, ATTESTOR_PUBLIC_KEY, pad32('another message'));
    expect(c1).not.toBe(c2);
  });

  it('keeps the challenge inside the 224-bit window the contract relies on', () => {
    for (let i = 0; i < 32; i++) {
      const claim = buildClaim({ proofDigest: pad32(`digest-${i}`) });
      const signature = signClaim(claim);
      const c = challenge(signature.announcement, ATTESTOR_PUBLIC_KEY, canonicalClaimHash(claim));
      expect(c).toBeLessThan(1n << 224n);
    }
  });
});

describe('scalar limbs', () => {
  it('round-trip through the 124/128-bit split the contract uses', () => {
    const claim = buildClaim();
    const signature = signClaim(claim);
    const s = joinScalar(signature.responseHi, signature.responseLo);
    expect(splitScalar(s)).toEqual({ hi: signature.responseHi, lo: signature.responseLo });
    expect(signature.responseHi).toBeLessThan(1n << 124n);
    expect(signature.responseLo).toBeLessThan(1n << 128n);
  });

  it('rejects a scalar that does not fit the curve order', () => {
    expect(() => splitScalar(1n << 252n)).toThrow(/out of range/);
  });
});
