/**
 * The C-xx contract test matrix from §40.2.
 *
 * Every negative case asserts the exact error string, not just "it threw".
 * A test that only checks `toThrow()` passes when the contract rejects a
 * claim for the wrong reason, which is precisely the bug worth catching in a
 * chain of nine sequential asserts.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { MailProofSimulator } from './simulator.js';
import {
  buildClaim,
  CAMPAIGN_ID,
  deployOptions,
  OTHER_CAMPAIGN_ID,
  OTHER_SUBJECT_SECRET,
  ROGUE_SECRET_KEY,
  signClaim,
  signedClaim,
} from './fixtures.js';
import { deriveSubjectBinding } from '../../packages/shared/claim.js';
import { JUBJUB_ORDER_HI, JUBJUB_ORDER_LO } from '../../packages/shared/constants.js';
import { blueprintIdHash, issuerDomainHash } from '../../packages/shared/claim.js';

let contract: MailProofSimulator;

beforeEach(() => {
  contract = new MailProofSimulator(deployOptions());
});

describe('initial state', () => {
  it('starts with no approved claims and no consumed nullifiers', () => {
    expect(contract.ledger.approvedClaimCount).toBe(0n);
    expect(contract.ledger.usedNullifiers.isEmpty()).toBe(true);
  });

  it('records the deployment parameters', () => {
    expect(contract.ledger.campaignId).toEqual(CAMPAIGN_ID);
    expect(contract.ledger.allowedClaimType).toBe(1n);
  });
});

describe('C-01 valid claim', () => {
  it('is accepted and consumes its nullifier', () => {
    const { claim, signature } = signedClaim();
    contract.redeemClaim(claim, signature);

    expect(contract.ledger.approvedClaimCount).toBe(1n);
    expect(contract.ledger.usedNullifiers.member(claim.claimNullifier)).toBe(true);
  });
});

describe('C-02 tampered claim', () => {
  it('rejects a claim whose bytes changed after signing', () => {
    const claim = buildClaim();
    const signature = signClaim(claim);
    // proofDigest is not otherwise constrained, so this isolates the
    // signature check from every other assert.
    const tampered = { ...claim, proofDigest: buildClaim({}).blueprintIdHash };

    expect(() => contract.redeemClaim(tampered, signature)).toThrow(
      'invalid attestor signature',
    );
    expect(contract.ledger.approvedClaimCount).toBe(0n);
  });
});

describe('C-03 signature from another key', () => {
  it('rejects a claim signed by an unauthorised attestor', () => {
    const claim = buildClaim();
    const signature = signClaim(claim, ROGUE_SECRET_KEY);

    expect(() => contract.redeemClaim(claim, signature)).toThrow('invalid attestor signature');
    expect(contract.ledger.approvedClaimCount).toBe(0n);
  });
});

describe('C-04 wrong campaign', () => {
  it('rejects a correctly signed claim minted for another campaign', () => {
    const { claim, signature } = signedClaim({ campaignId: OTHER_CAMPAIGN_ID });

    expect(() => contract.redeemClaim(claim, signature)).toThrow('wrong campaign');
    expect(contract.ledger.approvedClaimCount).toBe(0n);
  });
});

describe('C-05 wrong blueprint', () => {
  it('rejects a claim from a blueprint this deployment does not allow', () => {
    const { claim, signature } = signedClaim({
      blueprintIdHash: blueprintIdHash('someone/OtherBlueprint@v1'),
    });

    expect(() => contract.redeemClaim(claim, signature)).toThrow('wrong blueprint');
    expect(contract.ledger.approvedClaimCount).toBe(0n);
  });
});

describe('C-06 wrong claim type', () => {
  it('rejects a claim of a type this deployment does not accept', () => {
    const { claim, signature } = signedClaim({ claimType: 2n });

    expect(() => contract.redeemClaim(claim, signature)).toThrow('wrong claim type');
    expect(contract.ledger.approvedClaimCount).toBe(0n);
  });
});

describe('C-07 replay', () => {
  it('rejects the second redemption of the same claim', () => {
    const { claim, signature } = signedClaim();
    contract.redeemClaim(claim, signature);

    expect(() => contract.redeemClaim(claim, signature)).toThrow('claim already used');
  });

  it('leaves the counter at one after a rejected replay', () => {
    const { claim, signature } = signedClaim();
    contract.redeemClaim(claim, signature);
    expect(() => contract.redeemClaim(claim, signature)).toThrow();

    expect(contract.ledger.approvedClaimCount).toBe(1n);
    expect(contract.ledger.usedNullifiers.size()).toBe(1n);
  });
});

describe('C-08 altered nullifier', () => {
  it('rejects a claim whose nullifier no longer matches the signature', () => {
    const claim = buildClaim();
    const signature = signClaim(claim);
    const swapped = { ...claim, claimNullifier: buildClaim({}).proofDigest };

    expect(() => contract.redeemClaim(swapped, signature)).toThrow('invalid attestor signature');
    expect(contract.ledger.usedNullifiers.isEmpty()).toBe(true);
  });
});

describe('C-09 wrong subject binding', () => {
  it('rejects a claim issued to a different subject', () => {
    const { claim, signature } = signedClaim({
      subjectBindingHash: deriveSubjectBinding(OTHER_SUBJECT_SECRET, CAMPAIGN_ID),
    });

    expect(() => contract.redeemClaim(claim, signature)).toThrow('subject binding mismatch');
  });

  it('rejects a stolen but otherwise valid claim redeemed by another user', () => {
    // The thief holds a genuine, correctly signed claim — but not the secret
    // it was bound to. This is the front-running / copied-proof case (§41.11).
    const { claim, signature } = signedClaim();
    contract.withSubjectSecret(OTHER_SUBJECT_SECRET);

    expect(() => contract.redeemClaim(claim, signature)).toThrow('subject binding mismatch');
    expect(contract.ledger.approvedClaimCount).toBe(0n);
  });
});

describe('C-12 state transition', () => {
  it('advances the counter exactly once per distinct claim', () => {
    const first = signedClaim();
    contract.redeemClaim(first.claim, first.signature);
    expect(contract.ledger.approvedClaimCount).toBe(1n);

    const second = signedClaim({ claimNullifier: issuerDomainHash('second-evidence') });
    contract.redeemClaim(second.claim, second.signature);
    expect(contract.ledger.approvedClaimCount).toBe(2n);
    expect(contract.ledger.usedNullifiers.size()).toBe(2n);
  });
});

describe('additional guards', () => {
  it('rejects an unsupported claim version', () => {
    const { claim, signature } = signedClaim({ version: 2n });
    expect(() => contract.redeemClaim(claim, signature)).toThrow('invalid claim encoding');
  });

  it('rejects a claim from an unexpected issuer domain', () => {
    const { claim, signature } = signedClaim({
      issuerDomainHash: issuerDomainHash('not-the-airline.example'),
    });
    expect(() => contract.redeemClaim(claim, signature)).toThrow('wrong issuer');
  });

  it('rejects a signature scalar at or above the curve order', () => {
    // Exactly l: representable in the two limbs, but not a valid scalar. The
    // range check must catch it before it reaches the curve operation, which
    // would fault the runtime rather than reject the claim.
    const claim = buildClaim();
    const signature = signClaim(claim);
    const outOfRange = {
      ...signature,
      responseHi: JUBJUB_ORDER_HI,
      responseLo: JUBJUB_ORDER_LO,
    };

    expect(() => contract.redeemClaim(claim, outOfRange)).toThrow('invalid attestor signature');
  });

  it('does not leak the subject secret into public state', () => {
    const { claim, signature } = signedClaim();
    contract.redeemClaim(claim, signature);

    const published = [...contract.ledger.usedNullifiers];
    expect(published).toHaveLength(1);
    expect(published[0]).toEqual(claim.claimNullifier);
    // The nullifier is a derived value, not the binding and not the secret.
    expect(published[0]).not.toEqual(claim.subjectBindingHash);
  });
});
