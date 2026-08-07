/**
 * Direct DKIM verification (RFC 6376), the interim cryptographic path.
 *
 * The ZK Email blueprint is still pending on the registry, which leaves a
 * choice: demo on canned evidence (nothing verified) or verify the email's
 * own RSA signature here. This verifier does the latter. It is *real*
 * cryptography — the same signature Gmail checks — with one honest trade-off,
 * recorded as D-007: the attestor sees the email. ZK Email removes exactly
 * that; the seam this class sits behind is where it will slot in.
 *
 * The submission carries the raw `.eml` in `proofData`. The evidence is
 * extracted only from bytes the signature covers:
 *
 *  - the claim marker must be a line of the signed body (respecting `l=`),
 *  - the unique id is the Message-ID header, required to be covered by `h=`,
 *    taken bottom-up the way RFC 6376 §5.4.2 consumes instances — so an
 *    unsigned Message-ID prepended by an attacker can never become the
 *    nullifier source.
 */
import {
  getHeaders,
  parseDkimSignatures,
  parseEml,
  selectSignaturesForDomain,
  type DkimSignature,
  type ParsedEml,
} from '../../../packages/shared/eml.js';
import { signedBody, verifyDkim, type DkimVerificationResult } from '../../../packages/shared/dkim.js';
import { plainTextReadings } from '../../../packages/shared/mime.js';

import type { BlueprintPolicy } from './allowlist.js';
import { ATTESTOR_ERROR, AttestorError } from './errors.js';
import type { ProofSubmission, ProofVerifier, VerifiedEvidence } from './verifier.js';

export class DkimProofVerifier implements ProofVerifier {
  readonly name = 'dkim-direct (RFC 6376, rsa-sha256)';
  readonly isCryptographic = true;

  /** Injectable clock so signature expiry (`x=`) is testable. */
  constructor(private readonly now: () => Date = () => new Date()) {}

  async verify(submission: ProofSubmission, policy: BlueprintPolicy): Promise<VerifiedEvidence> {
    const dkim = policy.dkim;
    if (!dkim) {
      throw new AttestorError(
        ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
        'blueprint has no pinned DKIM key; it cannot be verified directly',
      );
    }
    if (policy.status !== 'pinned') {
      throw new AttestorError(
        ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
        `blueprint ${policy.slug} is marked pending; pin it before accepting evidence`,
      );
    }

    // `proofData` is the raw message. Error details never quote its content.
    let eml: ParsedEml;
    try {
      eml = parseEml(submission.proofData);
    } catch {
      throw new AttestorError(ATTESTOR_ERROR.PROOF_INVALID, 'message could not be parsed');
    }

    // A message can legitimately carry several signatures from one domain —
    // during a key rotation, or after a relay re-signs. RFC 6376 §6.1 says to
    // keep trying until one verifies, so a single bogus prepended signature
    // cannot deny an otherwise valid claim.
    const candidates = selectSignaturesForDomain(parseDkimSignatures(eml), policy.issuerDomain);
    if (candidates.length === 0) {
      throw new AttestorError(
        ATTESTOR_ERROR.SENDER_NOT_ALLOWED,
        'no DKIM signature from the expected issuer domain',
      );
    }
    if (dkim.selector) {
      // The pinned key belongs to one selector. Verifying a signature that
      // names a different one would check it against the wrong key and report
      // a mismatch as tampering.
      const wanted = dkim.selector.trim().toLowerCase();
      const bySelector = candidates.filter((s) => s.selector?.trim().toLowerCase() === wanted);
      if (bySelector.length === 0) {
        throw new AttestorError(
          ATTESTOR_ERROR.SENDER_NOT_ALLOWED,
          `no DKIM signature using the pinned selector "${wanted}"`,
        );
      }
      candidates.length = 0;
      candidates.push(...bySelector);
    }

    let signature: DkimSignature | undefined;
    let result: DkimVerificationResult | undefined;
    let expiredSeen = false;
    for (const candidate of candidates) {
      const attempt = verifyDkim(submission.proofData, candidate, {
        dnsRecord: dkim.dnsRecord,
        now: this.now(),
      });
      if (attempt.expired) {
        // Not a pass, but a distinguishable failure worth reporting if no
        // other candidate verifies.
        expiredSeen = true;
        continue;
      }
      if (attempt.valid) {
        signature = candidate;
        result = attempt;
        break;
      }
      // Keep the first failure's diagnosis for the error message.
      result ??= attempt;
    }

    if (!signature || !result?.valid) {
      if (expiredSeen && !result?.valid) {
        throw new AttestorError(ATTESTOR_ERROR.PROOF_INVALID, 'DKIM signature has expired (x=)');
      }
      throw new AttestorError(
        ATTESTOR_ERROR.PROOF_INVALID,
        result?.bodyHashMatches
          ? 'DKIM signature mismatch — a signed header changed or the key is wrong'
          : 'DKIM body hash mismatch — the message body changed after signing',
      );
    }

    // ── Unique id: the *signed* Message-ID ──────────────────────────────────
    const covered = signature.signedHeaders.filter((h) => h === 'message-id').length;
    if (covered === 0) {
      throw new AttestorError(
        ATTESTOR_ERROR.PUBLIC_OUTPUT_MISSING,
        'the signature does not cover Message-ID, so there is no signed unique id',
      );
    }
    const instances = getHeaders(eml, 'message-id');
    if (instances.length === 0) {
      throw new AttestorError(ATTESTOR_ERROR.PUBLIC_OUTPUT_MISSING, 'message has no Message-ID');
    }
    if (instances.length > covered) {
      // More instances than the signature consumed means at least one is
      // unsigned — and an unsigned id would let one signed email mint
      // arbitrarily many nullifiers.
      throw new AttestorError(
        ATTESTOR_ERROR.PROOF_INVALID,
        'more Message-ID instances than the signature covers',
      );
    }
    // §5.4.2 consumes instances bottom-up, so the bottom-most one is signed
    // first. It is also the one the origin server wrote.
    const uniqueClaimId = instances[instances.length - 1]!.value.trim();
    if (uniqueClaimId.length === 0) {
      throw new AttestorError(ATTESTOR_ERROR.PUBLIC_OUTPUT_MISSING, 'Message-ID is empty');
    }

    // ── Marker: a signed body line stating the claim ────────────────────────
    // Only the signed octets, decoded per each part's transfer encoding, are
    // searched. Matching against encoded bytes would let a quoted-printable
    // soft break fabricate a line boundary and defeat the anchored pattern.
    const claimMarker = findMarkerLine(
      plainTextReadings(eml, signedBody(eml.body, signature.bodyLength)),
      policy.markerPattern,
    );
    if (claimMarker === undefined) {
      throw new AttestorError(
        ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
        'no line of the signed body states the claim',
      );
    }

    return {
      // The domain comes from the verified signature's d= tag — attest()
      // still compares it against the policy, same as every other verifier.
      issuerDomain: result.domain ?? '',
      claimMarker,
      uniqueClaimId,
    };
  }
}

/**
 * Find the first line matching the (anchored) marker pattern.
 *
 * `readings` are already decoded — see mime.ts. Lines are trimmed before
 * matching so folding whitespace cannot hide a marker. Extraction failure
 * denies; it can never accept something the signer did not write.
 */
export function findMarkerLine(
  readings: readonly string[],
  markerPattern: string,
): string | undefined {
  const pattern = new RegExp(markerPattern);
  for (const reading of readings) {
    for (const line of reading.split(/\r\n|\n/)) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && pattern.test(trimmed)) return trimmed;
    }
  }
  return undefined;
}
