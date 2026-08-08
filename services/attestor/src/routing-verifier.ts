/**
 * Route each submission to the verifier its blueprint declares.
 *
 * Two things decide, in this order. `proves: 'domain-membership'` means the
 * sender is proving they control a mailbox, so the self-attestation verifier
 * takes it. Otherwise a pinned DKIM key (`dkim.dnsRecord`) means the email's
 * own RSA signature is checked directly, and everything else goes to ZK Email.
 *
 * The choice is a property of the *blueprint*, not of the deployment — so one
 * attestor serves all three at once, and pinning a blueprint changes what it
 * can do without a restart or a config mode.
 */
import type { BlueprintPolicy } from './allowlist.js';
import { ATTESTOR_ERROR, AttestorError } from './errors.js';
import type { ProofSubmission, ProofVerifier, VerifiedEvidence } from './verifier.js';

export class RoutingProofVerifier implements ProofVerifier {
  readonly name: string;
  /**
   * Derived, never asserted. server.ts refuses to start on a
   * non-cryptographic verifier, and hardcoding `true` here would let a fake
   * verifier smuggled behind the router disarm that guard.
   */
  readonly isCryptographic: boolean;

  constructor(
    private readonly dkim: ProofVerifier,
    private readonly zkEmail: ProofVerifier,
    private readonly selfAttestation?: ProofVerifier,
  ) {
    const all = [dkim, zkEmail, ...(selfAttestation ? [selfAttestation] : [])];
    this.name = all.map((v) => v.name).join(' | ');
    this.isCryptographic = all.every((v) => v.isCryptographic);
  }

  async verify(submission: ProofSubmission, policy: BlueprintPolicy): Promise<VerifiedEvidence> {
    if (policy.proves === 'domain-membership') {
      if (!this.selfAttestation) {
        // Refuse rather than fall through to a verifier that would check
        // something else entirely and report success for it.
        throw new AttestorError(
          ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
          `${policy.slug} proves domain membership, which this attestor is not configured for`,
        );
      }
      return this.selfAttestation.verify(submission, policy);
    }
    return policy.dkim
      ? this.dkim.verify(submission, policy)
      : this.zkEmail.verify(submission, policy);
  }
}
