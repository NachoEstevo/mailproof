/**
 * The real verifier, backed by @zk-email/sdk 2.0.11.
 *
 * Two things here are non-negotiable and easy to get wrong:
 *
 *  - Verification runs server-side, against the pinned blueprint fetched from
 *    the registry. A boolean from the browser means nothing (§41.15).
 *  - The named field values are read from the *verified* public outputs, never
 *    from a separate client-supplied map. Otherwise a caller could submit a
 *    valid proof of one thing alongside the claimed outputs of another.
 */
import { initZkEmailSdk, type Blueprint } from '@zk-email/sdk';

import { requireClaimInBody, type BlueprintPolicy } from './allowlist.js';
import { ATTESTOR_ERROR, AttestorError } from './errors.js';
import type { ProofSubmission, ProofVerifier, VerifiedEvidence } from './verifier.js';

type Sdk = ReturnType<typeof initZkEmailSdk>;

export class ZkEmailProofVerifier implements ProofVerifier {
  readonly name = 'zk-email@2.0.11';
  readonly isCryptographic = true;

  private readonly sdk: Sdk;
  private readonly blueprints = new Map<string, Promise<Blueprint>>();

  constructor(sdk: Sdk = initZkEmailSdk()) {
    this.sdk = sdk;
  }

  private blueprintFor(slug: string): Promise<Blueprint> {
    let pending = this.blueprints.get(slug);
    if (!pending) {
      pending = this.sdk.getBlueprint(slug);
      // Do not cache a rejection: a transient registry outage would otherwise
      // poison the slug for the lifetime of the process.
      pending.catch(() => this.blueprints.delete(slug));
      this.blueprints.set(slug, pending);
    }
    return pending;
  }

  async verify(submission: ProofSubmission, policy: BlueprintPolicy): Promise<VerifiedEvidence> {
    // Narrowed once, here: these four fields are what a marker-based
    // blueprint is, and they are optional on the type because a
    // domain-membership entry has no use for them.
    const marker = requireClaimInBody(policy);
    if (policy.status !== 'pinned') {
      // The slug has not been compiled on the registry yet. Running anyway
      // would mean "verifying" against a blueprint that does not exist, which
      // is worse than refusing. See config/blueprints.json.
      throw new AttestorError(
        ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
        `blueprint ${policy.slug} is marked pending; pin it before accepting proofs`,
      );
    }

    let blueprint: Blueprint;
    try {
      blueprint = await this.blueprintFor(policy.slug);
    } catch {
      throw new AttestorError(ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED, 'blueprint could not be fetched');
    }

    // The blueprint's own pinned sender domain is the authority, not the
    // allowlist entry — the allowlist says which domain we *expect*, and a
    // mismatch means the registry entry changed under us.
    const pinnedDomain = blueprint.props.senderDomain?.trim().toLowerCase();
    if (!pinnedDomain) {
      throw new AttestorError(ATTESTOR_ERROR.SENDER_NOT_ALLOWED, 'blueprint pins no sender domain');
    }
    if (pinnedDomain !== policy.issuerDomain.trim().toLowerCase()) {
      throw new AttestorError(
        ATTESTOR_ERROR.SENDER_NOT_ALLOWED,
        'blueprint sender domain does not match the allowlist',
      );
    }

    let valid = false;
    try {
      valid = await blueprint.verifyProofData(submission.publicOutputs, submission.proofData);
    } catch {
      // An exception is not a pass. `unknown` behaves as `deny` (§40.4).
      valid = false;
    }
    if (!valid) throw new AttestorError(ATTESTOR_ERROR.PROOF_INVALID);

    const outputs = extractNamedOutputs(blueprint, submission.publicOutputs);
    for (const name of marker.requiredOutputs) {
      if (!outputs.has(name)) {
        throw new AttestorError(ATTESTOR_ERROR.PUBLIC_OUTPUT_MISSING, `missing output "${name}"`);
      }
    }

    return {
      issuerDomain: pinnedDomain,
      claimMarker: outputs.get(marker.markerOutput) ?? '',
      uniqueClaimId: outputs.get(marker.uniqueIdOutput) ?? '',
    };
  }
}

/**
 * Map verified public outputs onto the blueprint's declared field names.
 *
 * The blueprint declares its extracted fields in `decomposedRegexes`, in
 * order, and the circuit emits their values in that same order. The exact
 * index layout is not part of the SDK's published types, which is precisely
 * why `config/blueprints.json` keeps a blueprint at `status: "pending"` until
 * this has been checked against a real proof from that blueprint. Verify the
 * mapping before flipping a blueprint to `pinned`.
 */
export function extractNamedOutputs(
  blueprint: Blueprint,
  serialisedOutputs: string,
): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialisedOutputs);
  } catch {
    throw new AttestorError(ATTESTOR_ERROR.PUBLIC_OUTPUT_MISSING, 'public outputs are not JSON');
  }

  const values = Array.isArray(parsed) ? parsed : null;
  if (!values) {
    throw new AttestorError(
      ATTESTOR_ERROR.PUBLIC_OUTPUT_MISSING,
      'public outputs are not an array; this circuit needs a dedicated extractor',
    );
  }

  const fields = blueprint.props.decomposedRegexes ?? [];
  const named = new Map<string, string>();
  fields.forEach((field, index) => {
    const value = values[index];
    if (typeof value === 'string' && value.length > 0) named.set(field.name, value);
  });
  return named;
}
