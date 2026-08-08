/**
 * Verifier for "prove you control a mailbox at this domain".
 *
 * Slots into the same `ProofVerifier` seam as the other two, and the fit is
 * exact rather than convenient:
 *
 *  - `issuerDomain` becomes the domain of the proven mailbox, which `attest`
 *    already compares against the blueprint's pinned domain.
 *  - `uniqueClaimId` becomes the **blinded** mailbox. Everything downstream
 *    hashes it into the nullifier without change, so "one claim per message"
 *    becomes "one claim per person" by substituting what goes in. Blinded
 *    because the nullifier set is public and a bare hash of an address is
 *    recoverable with a wordlist — see `packages/shared/blinding.ts`.
 *  - `claimMarker` becomes the challenge code, which is exactly what it is:
 *    the signed text evidencing the claim.
 *
 * The blinding key lives here rather than with an integrator because this
 * service already reads the whole message. Handing it out would spread the one
 * secret that keeps the ledger opaque; keeping it here spreads nothing.
 */
import { blindIdentity, blindingKeyId } from '../../../packages/shared/blinding.js';
import { toHex } from '../../../packages/shared/hashes.js';
import {
  SelfAttestationError,
  verifySelfAttestation,
} from '../../../packages/shared/self-attestation.js';
import type { BlueprintPolicy } from './allowlist.js';
import { ATTESTOR_ERROR, AttestorError } from './errors.js';
import type { ProofSubmission, ProofVerifier, VerifiedEvidence } from './verifier.js';

/** Which refusals are the submitter's fault, and which are ours. */
const NOT_A_PROOF: ReadonlySet<SelfAttestationError['failure']> = new Set([
  'NO_SIGNATURE',
  'SIGNATURE_INVALID',
  'SIGNATURE_EXPIRED',
  'SIGNATURE_STALE',
  'FROM_NOT_SIGNED',
  'FROM_UNPARSEABLE',
  'DOMAIN_NOT_ALIGNED',
]);

export interface SelfAttestationConfig {
  /** Shared with the integrator that mints the codes. */
  readonly challengeSecret: Uint8Array;
  /** The integrator these codes were minted for. */
  readonly audience: string;
  /** Blinds the mailbox before it can reach a public ledger. */
  readonly blindingKey: Uint8Array;
  /** How old the signature may be. */
  readonly maxAgeMs: number;
}

export class SelfAttestationProofVerifier implements ProofVerifier {
  readonly name = 'self-attestation (DKIM From alignment + challenge)';
  readonly isCryptographic = true;

  constructor(private readonly config: SelfAttestationConfig) {}

  /** Published on /health so a deployment can see which generation is live. */
  get blindingKeyId(): string {
    return blindingKeyId(this.config.blindingKey);
  }

  async verify(
    submission: ProofSubmission,
    policy: BlueprintPolicy,
  ): Promise<VerifiedEvidence> {
    const dnsRecord = policy.dkim?.dnsRecord;
    if (!dnsRecord) {
      throw new AttestorError(
        ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
        `${policy.slug} has no pinned DKIM key, so nothing can be verified against it`,
      );
    }

    let attestation;
    try {
      attestation = verifySelfAttestation(submission.proofData, {
        dnsRecord,
        challengeSecret: this.config.challengeSecret,
        audience: this.config.audience,
        maxAgeMs: this.config.maxAgeMs,
        // The domain is checked against the policy by `attest`, one layer up,
        // the same way it is for every other verifier. Checking it twice, in
        // two places, is how the two come to disagree.
      });
    } catch (error) {
      if (!(error instanceof SelfAttestationError)) throw error;
      throw new AttestorError(
        NOT_A_PROOF.has(error.failure)
          ? ATTESTOR_ERROR.PROOF_INVALID
          : ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
        error.message,
      );
    }

    return {
      issuerDomain: attestation.domain,
      claimMarker: attestation.code,
      // The mailbox itself stops here. Only this leaves the process.
      uniqueClaimId: toHex(blindIdentity(attestation.mailbox, this.config.blindingKey)),
    };
  }
}
