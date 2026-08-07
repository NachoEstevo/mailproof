/**
 * Route each submission to the verifier its blueprint declares.
 *
 * An allowlist entry with a pinned DKIM key (`dkim.dnsRecord`) verifies the
 * email's own RSA signature directly; every other entry goes to ZK Email.
 * The choice is a property of the *blueprint*, not of the deployment — so one
 * attestor can serve a DKIM-direct claim today and a ZK Email claim the day
 * its blueprint is pinned, without a restart or a config mode.
 */
import type { BlueprintPolicy } from './allowlist.js';
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
  ) {
    this.name = `${dkim.name} | ${zkEmail.name}`;
    this.isCryptographic = dkim.isCryptographic && zkEmail.isCryptographic;
  }

  async verify(submission: ProofSubmission, policy: BlueprintPolicy): Promise<VerifiedEvidence> {
    return policy.dkim
      ? this.dkim.verify(submission, policy)
      : this.zkEmail.verify(submission, policy);
  }
}
