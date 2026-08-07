/**
 * The canonical MailProof claim and every value derived from it.
 *
 * `canonicalClaimHash` and `deriveSubjectBinding` are re-implementations of
 * the identically named circuits in contracts/mailproof.compact. They exist
 * separately (rather than calling the compiled circuit) so that the two
 * implementations can be cross-checked — a single shared implementation would
 * agree with itself no matter how wrong it was. See §44.3.
 */
import {
  CLAIM_VERSION,
  DOMAIN_BLUEPRINT,
  DOMAIN_CAMPAIGN,
  DOMAIN_CLAIM,
  DOMAIN_ISSUER,
  DOMAIN_NULLIFIER,
  DOMAIN_PROOF_DIGEST,
  DOMAIN_SUBJECT,
} from './constants.js';
import { fieldToBytes32, hashBytes32Vector, hashString, pad32 } from './hashes.js';

/** Mirrors the Compact struct field-for-field, in the same order. */
export interface ClaimAttestationV1 {
  version: bigint;
  claimType: bigint;
  blueprintIdHash: Uint8Array;
  issuerDomainHash: Uint8Array;
  campaignId: Uint8Array;
  subjectBindingHash: Uint8Array;
  claimNullifier: Uint8Array;
  proofDigest: Uint8Array;
}

function assertBytes32(value: Uint8Array, field: string): Uint8Array {
  if (value.length !== 32) {
    throw new Error(`claim.${field}: expected 32 bytes, got ${value.length}`);
  }
  return value;
}

function assertUint8(value: bigint, field: string): bigint {
  if (value < 0n || value > 255n) {
    throw new Error(`claim.${field}: expected a Uint<8>, got ${value}`);
  }
  return value;
}

/**
 * The exact vector the contract hashes. Fixed length, fixed order, no JSON —
 * so property ordering can never change what gets signed.
 */
export function canonicalClaimFields(claim: ClaimAttestationV1): Uint8Array[] {
  return [
    pad32(DOMAIN_CLAIM),
    fieldToBytes32(assertUint8(claim.version, 'version')),
    fieldToBytes32(assertUint8(claim.claimType, 'claimType')),
    assertBytes32(claim.blueprintIdHash, 'blueprintIdHash'),
    assertBytes32(claim.issuerDomainHash, 'issuerDomainHash'),
    assertBytes32(claim.campaignId, 'campaignId'),
    assertBytes32(claim.subjectBindingHash, 'subjectBindingHash'),
    assertBytes32(claim.claimNullifier, 'claimNullifier'),
    assertBytes32(claim.proofDigest, 'proofDigest'),
  ];
}

/** The message the attestor signs. */
export function canonicalClaimHash(claim: ClaimAttestationV1): Uint8Array {
  return hashBytes32Vector(canonicalClaimFields(claim));
}

/**
 * Campaign-scoped commitment to the subject's secret (§73).
 *
 * The same secret produces a different binding per campaign, so two
 * applications cannot link a user by comparing subject bindings.
 */
export function deriveSubjectBinding(secret: Uint8Array, campaignId: Uint8Array): Uint8Array {
  return hashBytes32Vector([
    pad32(DOMAIN_SUBJECT),
    assertBytes32(secret, 'subjectSecret'),
    assertBytes32(campaignId, 'campaignId'),
  ]);
}

/**
 * One-time identifier for a claim (§72).
 *
 * Deterministic for a given (blueprint, evidence, campaign) so the same email
 * cannot be redeemed twice; campaign-scoped so the same email used in another
 * application yields an unlinkable value. Takes the *hash* of the unique
 * email identifier — the raw booking reference never reaches this layer.
 */
export function deriveNullifier(
  blueprintIdHash: Uint8Array,
  uniqueClaimIdHash: Uint8Array,
  campaignId: Uint8Array,
): Uint8Array {
  return hashBytes32Vector([
    pad32(DOMAIN_NULLIFIER),
    assertBytes32(blueprintIdHash, 'blueprintIdHash'),
    assertBytes32(uniqueClaimIdHash, 'uniqueClaimIdHash'),
    assertBytes32(campaignId, 'campaignId'),
  ]);
}

/** Hash of a pinned blueprint slug, e.g. `owner/FlightCancellation@v1`. */
export function blueprintIdHash(slug: string): Uint8Array {
  return hashString(DOMAIN_BLUEPRINT, slug);
}

/** Hash of the DKIM `d=` domain the blueprint pins. Never the `From` header. */
export function issuerDomainHash(domain: string): Uint8Array {
  return hashString(DOMAIN_ISSUER, domain.trim().toLowerCase());
}

/** Hash of a campaign name, e.g. `travel-insurance-demo-2026`. */
export function campaignIdHash(campaign: string): Uint8Array {
  return hashString(DOMAIN_CAMPAIGN, campaign);
}

/** Hash of the unique email identifier, before nullifier derivation. */
export function uniqueClaimIdHash(uniqueClaimId: string): Uint8Array {
  return hashString(DOMAIN_NULLIFIER, uniqueClaimId);
}

/**
 * Audit digest binding the claim to the exact proof it came from (§32.9).
 *
 * Auditing only — it is not the replay key, because a proof system may
 * randomise proof bytes across regenerations of the same statement.
 */
export function proofDigest(canonicalProof: string, canonicalPublicOutputs: string): Uint8Array {
  return hashBytes32Vector([
    pad32(DOMAIN_PROOF_DIGEST),
    hashString(DOMAIN_PROOF_DIGEST, canonicalProof),
    hashString(DOMAIN_PROOF_DIGEST, canonicalPublicOutputs),
  ]);
}

/** Structural validation before anything is signed or submitted. */
export function assertValidClaim(claim: ClaimAttestationV1): ClaimAttestationV1 {
  if (claim.version !== CLAIM_VERSION) {
    throw new Error(`claim.version: expected ${CLAIM_VERSION}, got ${claim.version}`);
  }
  canonicalClaimFields(claim);
  return claim;
}
