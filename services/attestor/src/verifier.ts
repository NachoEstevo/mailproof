/**
 * The proof-verification seam.
 *
 * The attestor's job splits cleanly in two: *is this proof cryptographically
 * valid* and *does the fact it proves satisfy our policy*. Only the first half
 * depends on ZK Email, so it lives behind this interface. Policy, nullifier
 * derivation, claim canonicalisation and signing are identical no matter what
 * produced the proof.
 *
 * That matters practically: the pinned blueprint does not exist yet, and this
 * lets everything downstream of it be built and tested now.
 */
import type { BlueprintPolicy } from './allowlist.js';

export interface ProofSubmission {
  /** Pinned blueprint slug, e.g. `owner/FlightCancellation@v1`. */
  readonly blueprintSlug: string;
  /** Public outputs, serialised — the shape `verifyProofData` expects. */
  readonly publicOutputs: string;
  /** Proof data, serialised. */
  readonly proofData: string;
}

/**
 * What a verified proof tells us. Deliberately narrow: the attestor needs
 * exactly these three facts and nothing else about the email.
 */
export interface VerifiedEvidence {
  /** The DKIM `d=` domain the blueprint pins — never the From header. */
  readonly issuerDomain: string;
  /** Text the blueprint extracted to evidence the claim. */
  readonly claimMarker: string;
  /**
   * A stable identifier for this specific evidence, used to derive the
   * nullifier. Stays inside the attestor: only its hash, folded with the
   * campaign, ever becomes public.
   */
  readonly uniqueClaimId: string;
  /**
   * Optional, integrator-scoped identity for account continuity.
   *
   * This is deliberately separate from `uniqueClaimId`: the latter feeds the
   * public claim nullifier, while this value may be returned to the relying
   * application. Keeping the two domains separate prevents the relying
   * application's account identifier from being a direct copy of on-chain
   * material. Verifiers must leave this absent unless the value is already a
   * keyed, opaque identifier.
   */
  readonly opaqueIdentityHandle?: string;
  /** Public generation label for the key that produced the opaque handle. */
  readonly opaqueIdentityKeyId?: string;
}

export interface ProofVerifier {
  /** Reported by /health so it is obvious which verifier is live. */
  readonly name: string;
  /** True only for verifiers that check real cryptography. */
  readonly isCryptographic: boolean;
  /**
   * Verify and extract. Must throw `AttestorError(PROOF_INVALID)` when the
   * proof does not check out, and must never return partial evidence:
   * `unknown` behaves as `deny` (§40.4).
   */
  verify(submission: ProofSubmission, policy: BlueprintPolicy): Promise<VerifiedEvidence>;
}
