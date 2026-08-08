/**
 * The self-attestation verifier, at the seam.
 *
 * The pure verification is already covered in
 * packages/shared/self-attestation.test.ts. What matters here is the mapping
 * onto `VerifiedEvidence` — because that mapping is what turns "one claim per
 * message" into "one claim per person", and getting it wrong would be silent.
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { issueChallenge } from '../../../packages/shared/challenge.js';
import { dkimSign, dnsRecordForPublicKey } from '../../../packages/shared/dkim-sign.js';
import { parseAllowlist, type BlueprintPolicy } from '../src/allowlist.js';
import { ATTESTOR_ERROR, AttestorError } from '../src/errors.js';
import { SelfAttestationProofVerifier } from '../src/self-attestation-verifier.js';

const NOW = new Date('2026-08-08T12:00:00Z');
const CHALLENGE_SECRET = new Uint8Array(32).fill(3);
const BLINDING_KEY = new Uint8Array(32).fill(9);

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const DNS_RECORD = dnsRecordForPublicKey(publicKey);

const CODE = issueChallenge({ secret: CHALLENGE_SECRET, audience: 'lain', now: NOW }).code;

function policy(over: Partial<BlueprintPolicy> = {}): BlueprintPolicy {
  const parsed = parseAllowlist({
    blueprints: [
      {
        key: 'domain',
        status: 'pinned',
        slug: 'mailproof/DomainMembership@v1',
        claimType: 'FLIGHT_CANCELLED',
        issuerDomain: 'udesa.edu.ar',
        campaigns: ['lain-2026-s1'],
        requiredOutputs: ['marker', 'uniqueId'],
        markerOutput: 'marker',
        uniqueIdOutput: 'uniqueId',
        markerPattern: '^MP-[0-9A-Z-]+$',
        dkim: { dnsRecord: DNS_RECORD, selector: 'test' },
      },
    ],
  }).require('mailproof/DomainMembership@v1');
  return { ...parsed, ...over };
}

function selfSent(from = 'Ana <ana@udesa.edu.ar>', body = `Hola\r\n\r\n${CODE}\r\n`) {
  return dkimSign(
    [
      `From: ${from}`,
      `To: ${from}`,
      'Subject: MailProof',
      'Message-ID: <one@udesa.edu.ar>',
      'Date: Sat, 8 Aug 2026 09:00:00 -0300',
      '',
      body,
      '',
    ].join('\r\n'),
    {
      domain: 'udesa.edu.ar',
      selector: 'test',
      privateKey,
      timestamp: Math.floor((NOW.getTime() - 60_000) / 1000),
    },
  );
}

const verifier = () =>
  new SelfAttestationProofVerifier({
    challengeSecret: CHALLENGE_SECRET,
    audience: 'lain',
    blindingKey: BLINDING_KEY,
    maxAgeMs: 24 * 60 * 60 * 1000,
  });

const submit = (eml: string) => ({
  blueprintSlug: 'mailproof/DomainMembership@v1',
  publicOutputs: '',
  proofData: eml,
});

describe('what it reports', () => {
  it('maps the mailbox onto the unique id, blinded', async () => {
    const evidence = await verifier().verify(submit(selfSent()), policy());

    expect(evidence.issuerDomain).toBe('udesa.edu.ar');
    expect(evidence.claimMarker).toBe(CODE);
    // 32 bytes of hex, and nothing recognisable from the address.
    expect(evidence.uniqueClaimId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(evidence.uniqueClaimId).not.toContain('ana');
  });

  it('gives one person one id however they spell their address', async () => {
    const ids = await Promise.all(
      ['ana@udesa.edu.ar', 'Ana@UDESA.edu.ar', '"x" <ana+lain@udesa.edu.ar>'].map(async (from) =>
        (await verifier().verify(submit(selfSent(from)), policy())).uniqueClaimId,
      ),
    );
    expect(new Set(ids).size).toBe(1);
  });

  it('gives two people two ids', async () => {
    const ana = await verifier().verify(submit(selfSent('ana@udesa.edu.ar')), policy());
    const bruno = await verifier().verify(submit(selfSent('bruno@udesa.edu.ar')), policy());
    expect(ana.uniqueClaimId).not.toBe(bruno.uniqueClaimId);
  });

  it('renames everyone when the blinding key changes', async () => {
    // The hazard that `blindingKeyId` exists to make visible: rotate this and
    // every person becomes a new person, with a fresh benefit.
    const other = new SelfAttestationProofVerifier({
      challengeSecret: CHALLENGE_SECRET,
      audience: 'lain',
      blindingKey: new Uint8Array(32).fill(11),
      maxAgeMs: 24 * 60 * 60 * 1000,
    });
    const a = await verifier().verify(submit(selfSent()), policy());
    const b = await other.verify(submit(selfSent()), policy());
    expect(a.uniqueClaimId).not.toBe(b.uniqueClaimId);
    expect(verifier().blindingKeyId).not.toBe(other.blindingKeyId);
  });
});

describe('what it refuses', () => {
  const codeOf = async (eml: string, p = policy()) => {
    try {
      await verifier().verify(submit(eml), p);
    } catch (error) {
      if (error instanceof AttestorError) return error.code;
      throw error;
    }
    return 'accepted';
  };

  it('a message with no challenge code is unsatisfied, not invalid', async () => {
    // The signature is genuine; it is the claim that is not evidenced. Calling
    // that PROOF_INVALID sends the operator looking for tampering.
    expect(await codeOf(selfSent('ana@udesa.edu.ar', 'sin codigo'))).toBe(
      ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
    );
  });

  it('a tampered message is invalid', async () => {
    expect(await codeOf(selfSent().replace('Hola', 'Otro'))).toBe(ATTESTOR_ERROR.PROOF_INVALID);
  });

  it('a blueprint with no pinned key verifies nothing', async () => {
    const { dkim, ...withoutKey } = policy();
    expect(await codeOf(selfSent(), withoutKey as never)).toBe(
      ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
    );
  });

  it('declares itself cryptographic, because it is', () => {
    expect(verifier().isCryptographic).toBe(true);
  });
});
