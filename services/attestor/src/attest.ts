/**
 * The attestation itself: turn a verified proof into a signed claim.
 *
 * Pure and dependency-injected, so the whole policy surface is testable
 * without a server, a network or a real proof.
 *
 * Ordering here is deliberate. Cheap policy checks run before anything
 * expensive, and nothing is signed until every check has passed — there is no
 * path that produces a partial or default-filled claim (§19.6).
 */
import {
  canonicalClaimHash,
  campaignIdHash,
  blueprintIdHash,
  deriveNullifier,
  issuerDomainHash,
  proofDigest,
  uniqueClaimIdHash,
  type ClaimAttestationV1,
} from '../../../packages/shared/claim.js';
import { isAcademicDomain } from '../../../packages/shared/academic.js';
import { CLAIM_TYPE, CLAIM_VERSION } from '../../../packages/shared/constants.js';
import { publicKeyFromSecret, sign, type SchnorrSignature } from '../../../packages/shared/schnorr.js';
import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

import type { BlueprintAllowlist } from './allowlist.js';
import { ATTESTOR_ERROR, AttestorError } from './errors.js';
import type { ProofVerifier } from './verifier.js';

export interface AttestRequest {
  readonly blueprintSlug: string;
  readonly campaign: string;
  /** 32 bytes committing to the redeeming subject. */
  readonly subjectBindingHash: Uint8Array;
  readonly publicOutputs: string;
  readonly proofData: string;
}

export interface AttestDeps {
  readonly verifier: ProofVerifier;
  readonly allowlist: BlueprintAllowlist;
  readonly secretKey: bigint;
  readonly attestorKeyId: string;
}

export interface SignedClaim {
  readonly claim: ClaimAttestationV1;
  readonly signature: SchnorrSignature;
  readonly attestorPublicKey: JubjubPoint;
  readonly attestorKeyId: string;
  /** Present only for verifiers that produce a keyed, opaque account handle. */
  readonly opaqueIdentityHandle?: string;
  readonly opaqueIdentityKeyId?: string;
}

export async function attest(request: AttestRequest, deps: AttestDeps): Promise<SignedClaim> {
  if (request.subjectBindingHash.length !== 32) {
    throw new AttestorError(ATTESTOR_ERROR.INVALID_SUBJECT_BINDING);
  }

  // 1. Is this blueprint one we sign for at all?
  const policy = deps.allowlist.require(request.blueprintSlug);

  // 2. Is this campaign in scope for it? Checked before verification so an
  //    unknown campaign cannot be used to make us do expensive work.
  if (!policy.campaigns.includes(request.campaign)) {
    throw new AttestorError(ATTESTOR_ERROR.CAMPAIGN_NOT_ALLOWED);
  }

  // 3. Cryptographic verification. Never trust the client's word for this.
  const evidence = await deps.verifier.verify(
    {
      blueprintSlug: request.blueprintSlug,
      publicOutputs: request.publicOutputs,
      proofData: request.proofData,
    },
    policy,
  );

  // 4. The signature proves *a* domain signed *a* message. Confirm it is the
  //    domain this blueprint is pinned to.
  //    A campaign pinned to `*` serves every institution, so there is nothing
  //    to compare against — but "every institution" is not "every domain", or
  //    a gmail.com mailbox earns a student tier. The suffix rules stand in for
  //    the registry that does not exist.
  if (policy.issuerDomain === '*') {
    if (!isAcademicDomain(evidence.issuerDomain)) {
      throw new AttestorError(ATTESTOR_ERROR.SENDER_NOT_ALLOWED);
    }
  } else if (
    evidence.issuerDomain.trim().toLowerCase() !== policy.issuerDomain.trim().toLowerCase()
  ) {
    throw new AttestorError(ATTESTOR_ERROR.SENDER_NOT_ALLOWED);
  }

  // 5. And that the extracted text actually states the claim. The pattern is
  //    anchored (enforced at load) so "has not been cancelled" cannot pass.
  //
  //    A domain-membership blueprint has no pattern and needs none: its
  //    verifier already checked the challenge code against a secret, which is
  //    a stronger test than any regex, and the marker it returns is that code.
  if (policy.markerPattern !== undefined && !new RegExp(policy.markerPattern).test(evidence.claimMarker)) {
    throw new AttestorError(ATTESTOR_ERROR.CLAIM_NOT_SATISFIED);
  }

  // 6. Without a stable identifier there is no honest replay protection, so
  //    refuse rather than invent one (§12.5).
  if (evidence.uniqueClaimId.trim().length === 0) {
    throw new AttestorError(ATTESTOR_ERROR.PUBLIC_OUTPUT_MISSING);
  }

  const campaignId = campaignIdHash(request.campaign);
  const pinnedBlueprintHash = blueprintIdHash(policy.slug);

  let claimNullifier: Uint8Array;
  try {
    claimNullifier = deriveNullifier(
      pinnedBlueprintHash,
      uniqueClaimIdHash(evidence.uniqueClaimId),
      campaignId,
    );
  } catch {
    throw new AttestorError(ATTESTOR_ERROR.NULLIFIER_DERIVATION_FAILED);
  }

  const claim: ClaimAttestationV1 = {
    version: CLAIM_VERSION,
    claimType: CLAIM_TYPE[policy.claimType],
    blueprintIdHash: pinnedBlueprintHash,
    // A `*` campaign signs the domain it actually saw, not the wildcard: the
    // contract's zero hash accepts any value here, so recording the real one
    // costs nothing and keeps the claim self-describing. A pinned campaign
    // signs the pin, which the check above proved the evidence matches.
    issuerDomainHash: issuerDomainHash(
      policy.issuerDomain === '*' ? evidence.issuerDomain.trim().toLowerCase() : policy.issuerDomain,
    ),
    campaignId,
    subjectBindingHash: request.subjectBindingHash,
    claimNullifier,
    proofDigest: proofDigest(request.proofData, request.publicOutputs),
  };

  let signature: SchnorrSignature;
  try {
    signature = sign(deps.secretKey, canonicalClaimHash(claim));
  } catch {
    throw new AttestorError(ATTESTOR_ERROR.SIGNING_UNAVAILABLE);
  }

  return {
    claim,
    signature,
    attestorPublicKey: publicKeyFromSecret(deps.secretKey),
    attestorKeyId: deps.attestorKeyId,
    ...(evidence.opaqueIdentityHandle !== undefined
      ? { opaqueIdentityHandle: evidence.opaqueIdentityHandle }
      : {}),
    ...(evidence.opaqueIdentityKeyId !== undefined
      ? { opaqueIdentityKeyId: evidence.opaqueIdentityKeyId }
      : {}),
  };
}
