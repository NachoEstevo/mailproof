/**
 * Wire format for POST /attest (§43.1, §43.3).
 *
 * Unknown keys are rejected rather than ignored: a caller sending `rawEmail`
 * should get a loud error, not have it silently dropped.
 */
import { z } from 'zod';

import { toHex } from '../../../packages/shared/hashes.js';
import type { SignedClaim } from './attest.js';

/** Generous, but bounded — proofs are large, and unbounded input is a DoS. */
const MAX_FIELD_BYTES = 2_000_000;

const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'expected 0x followed by 64 hex characters');

export const attestRequestSchema = z.strictObject({
  /** Exact pinned slug, e.g. `owner/FlightCancellation@v1`. */
  blueprintId: z.string().min(1).max(200),
  /** Campaign name, not its hash — the attestor derives the hash itself. */
  campaignId: z.string().min(1).max(200),
  /** Commitment to the redeeming subject. */
  subjectBinding: hex32,
  /** Serialised public outputs, as `verifyProofData` expects. */
  publicOutputs: z.string().min(1).max(MAX_FIELD_BYTES),
  /** Serialised proof data. */
  proofData: z.string().min(1).max(MAX_FIELD_BYTES),
});

export type AttestRequestBody = z.infer<typeof attestRequestSchema>;

/**
 * Response body.
 *
 * Carries no raw evidence: the unique claim identifier is present only as the
 * derived nullifier. For ZK Email claims the email never reaches this service
 * at all; for DKIM-direct claims (D-007) it arrives as `proofData`, is
 * verified, and leaves only as hashes — never in a response or a log.
 */
export function serialiseSignedClaim(signed: SignedClaim) {
  return {
    claim: {
      version: Number(signed.claim.version),
      claimType: Number(signed.claim.claimType),
      blueprintIdHash: toHex(signed.claim.blueprintIdHash),
      issuerDomainHash: toHex(signed.claim.issuerDomainHash),
      campaignId: toHex(signed.claim.campaignId),
      subjectBindingHash: toHex(signed.claim.subjectBindingHash),
      claimNullifier: toHex(signed.claim.claimNullifier),
      proofDigest: toHex(signed.claim.proofDigest),
    },
    signature: {
      announcementX: `0x${signed.signature.announcement.x.toString(16)}`,
      announcementY: `0x${signed.signature.announcement.y.toString(16)}`,
      // The response scalar travels as the two limbs the contract expects.
      responseHi: `0x${signed.signature.responseHi.toString(16)}`,
      responseLo: `0x${signed.signature.responseLo.toString(16)}`,
    },
    attestorPublicKey: {
      x: `0x${signed.attestorPublicKey.x.toString(16)}`,
      y: `0x${signed.attestorPublicKey.y.toString(16)}`,
    },
    attestorKeyId: signed.attestorKeyId,
    ...(signed.opaqueIdentityHandle !== undefined
      ? { opaqueIdentityHandle: signed.opaqueIdentityHandle }
      : {}),
    ...(signed.opaqueIdentityKeyId !== undefined
      ? { opaqueIdentityKeyId: signed.opaqueIdentityKeyId }
      : {}),
  };
}

export type SerialisedSignedClaim = ReturnType<typeof serialiseSignedClaim>;
