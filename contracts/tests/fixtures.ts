/**
 * Deterministic fixtures for the contract test matrix.
 *
 * Everything here is synthetic. No real domain, no real booking reference, no
 * real key. Names follow §75 so a screenshot can never be mistaken for a real
 * user's data.
 */
import {
  blueprintIdHash,
  campaignIdHash,
  canonicalClaimHash,
  deriveNullifier,
  deriveSubjectBinding,
  issuerDomainHash,
  proofDigest,
  uniqueClaimIdHash,
  type ClaimAttestationV1,
} from '../../packages/shared/claim.js';
import { CLAIM_TYPE, CLAIM_VERSION } from '../../packages/shared/constants.js';
import { pad32 } from '../../packages/shared/hashes.js';
import {
  publicKeyFromSecret,
  secretKeyFromSeed,
  sign,
  type SchnorrSignature,
} from '../../packages/shared/schnorr.js';

export const DEMO = {
  blueprintSlug: 'mailproof/FlightCancellation@v1',
  issuerDomain: 'demo-airline.example',
  campaign: 'travel-insurance-demo-2026',
  uniqueClaimId: 'CLAIM-DEMO-0001',
} as const;

export const BLUEPRINT_ID_HASH = blueprintIdHash(DEMO.blueprintSlug);
export const ISSUER_DOMAIN_HASH = issuerDomainHash(DEMO.issuerDomain);
export const CAMPAIGN_ID = campaignIdHash(DEMO.campaign);
export const OTHER_CAMPAIGN_ID = campaignIdHash('other-campaign-2026');

/** Test-only attestor key. Never used outside the suite. */
export const ATTESTOR_SECRET_KEY = secretKeyFromSeed(pad32('mailproof-test-attestor'));
export const ATTESTOR_PUBLIC_KEY = publicKeyFromSecret(ATTESTOR_SECRET_KEY);

/** An unauthorised signer, for the wrong-key cases. */
export const ROGUE_SECRET_KEY = secretKeyFromSeed(pad32('mailproof-test-rogue'));
export const ROGUE_PUBLIC_KEY = publicKeyFromSecret(ROGUE_SECRET_KEY);

export const SUBJECT_SECRET = pad32('mailproof-test-subject-secret');
export const OTHER_SUBJECT_SECRET = pad32('mailproof-test-other-subject');

export const PROOF_DIGEST = proofDigest('{"proof":"synthetic"}', '{"cancellationMarker":true}');

/** A claim that satisfies every check the contract makes. */
export function buildClaim(overrides: Partial<ClaimAttestationV1> = {}): ClaimAttestationV1 {
  const campaignId = overrides.campaignId ?? CAMPAIGN_ID;
  return {
    version: CLAIM_VERSION,
    claimType: CLAIM_TYPE.FLIGHT_CANCELLED,
    blueprintIdHash: BLUEPRINT_ID_HASH,
    issuerDomainHash: ISSUER_DOMAIN_HASH,
    campaignId,
    subjectBindingHash: deriveSubjectBinding(SUBJECT_SECRET, campaignId),
    claimNullifier: deriveNullifier(
      BLUEPRINT_ID_HASH,
      uniqueClaimIdHash(DEMO.uniqueClaimId),
      campaignId,
    ),
    proofDigest: PROOF_DIGEST,
    ...overrides,
  };
}

/** Sign a claim as the authorised attestor unless told otherwise. */
export function signClaim(
  claim: ClaimAttestationV1,
  secretKey: bigint = ATTESTOR_SECRET_KEY,
): SchnorrSignature {
  return sign(secretKey, canonicalClaimHash(claim));
}

/** A claim plus a matching signature — the normal happy path. */
export function signedClaim(overrides: Partial<ClaimAttestationV1> = {}): {
  claim: ClaimAttestationV1;
  signature: SchnorrSignature;
} {
  const claim = buildClaim(overrides);
  return { claim, signature: signClaim(claim) };
}

/** Deploy options wired to the fixtures above. */
export function deployOptions() {
  return {
    attestorPublicKey: ATTESTOR_PUBLIC_KEY,
    campaignId: CAMPAIGN_ID,
    blueprintIdHash: BLUEPRINT_ID_HASH,
    issuerDomainHash: ISSUER_DOMAIN_HASH,
    claimType: CLAIM_TYPE.FLIGHT_CANCELLED,
    subjectSecret: SUBJECT_SECRET,
  };
}
