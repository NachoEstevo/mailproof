/**
 * The MailProof SDK.
 *
 * What an integrator gets is two calls. One mints a code and tells the person
 * what to do with it; the other takes the message back and answers a single
 * question: *does this person qualify, and is it the first time*.
 *
 * What they never get is the address. The SDK reads it, folds it into a keyed
 * hash, and returns a handle — so a grant can be keyed on a person without
 * anyone, including the integrator, being able to say who that person is.
 *
 * The honesty rules this API is built around:
 *
 *  - `alreadyClaimed` is an outcome, not an exception. It is the answer the
 *    caller most often wants, and throwing for it pushes everyone into a
 *    try/catch that treats the normal case as exceptional.
 *  - `tier` is `null` when nothing matched. There is no default tier, because
 *    "unrecognised means generic" is how a domain registered this morning
 *    collects a benefit.
 *  - `trust` is part of the return value rather than a footnote in a README.
 *    Something read the email; the caller is told what, and told plainly that
 *    the integrator was not it.
 */
import { blindIdentity, blindingKeyId } from '../shared/blinding.js';
import { issueChallenge, type Challenge } from '../shared/challenge.js';
import {
  SelfAttestationError,
  verifySelfAttestation,
  type SelfAttestation,
} from '../shared/self-attestation.js';
import { explicitDomains, resolveTier, type TierRule } from '../shared/tiers.js';
import { RedemptionError, type RedemptionClient } from './redemption.js';

export interface DomainKey {
  /** The domain whose mail this key signs. */
  readonly domain: string;
  /** The pinned `p=` DNS record. */
  readonly dnsRecord: string;
}

export interface MailProofConfig<T extends string = string> {
  /**
   * Identifies this integrator. Bound into every challenge code, so a code
   * minted here cannot be redeemed anywhere else.
   */
  readonly audience: string;
  /** Per-integrator secret for challenge codes. At least 32 bytes. */
  readonly challengeSecret: Uint8Array;
  /**
   * Key for blinding identities before they are published.
   *
   * Distinct from `challengeSecret` on purpose: they have different lifetimes.
   * A challenge secret can be rotated freely; rotating this one renames every
   * person and hands everyone a fresh benefit.
   */
  readonly blindingKey: Uint8Array;
  /** Which domains earn which tier. First match wins; no match earns nothing. */
  readonly tiers: readonly TierRule<T>[];
  /** Pinned DKIM keys, per domain. A domain with no key cannot be verified. */
  readonly domainKeys: readonly DomainKey[];
  /** The campaign claims are spent in — the period a benefit is granted for. */
  readonly campaign: string;
  /** Where claims are spent. */
  readonly redemption: RedemptionClient;
  /** How old the signature may be. Defaults to 24 hours. */
  readonly maxSignatureAgeMs?: number;
  /** How long a challenge code lives. Defaults to 15 minutes. */
  readonly challengeTtlMs?: number;
  /** Whether the caller is told which domain matched. Defaults to `tier`. */
  readonly reveal?: 'tier' | 'domain';
}

export interface VerificationStart {
  readonly code: string;
  readonly expiresAt: Date;
  /** Ready to show a person. The code is already in it. */
  readonly instructions: string;
}

export interface TrustDisclosure {
  /** What read the raw message. Never the integrator. */
  readonly emailReadBy: 'attestor';
  /** Whether real cryptography was checked, or a fixture stood in for it. */
  readonly cryptographic: boolean;
  /** Which blinding-key generation produced the handle. */
  readonly blindingKeyId: string;
}

export type VerificationResult<T extends string = string> =
  | {
      readonly ok: true;
      readonly tier: T;
      /** Stable per person per campaign. Safe to store; already blinded. */
      readonly handle: string;
      /** Only when `reveal: 'domain'`. */
      readonly domain?: string;
      readonly alreadyClaimed: boolean;
      readonly nullifier: string;
      readonly contractAddress: string;
      readonly txId?: string;
      readonly trust: TrustDisclosure;
    }
  | {
      readonly ok: false;
      readonly reason: VerificationRefusal;
      readonly detail: string;
    };

export type VerificationRefusal =
  | 'NO_PINNED_KEY'
  | 'NO_TIER'
  | SelfAttestationError['failure']
  | 'REDEMPTION_FAILED';

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface MailProof<T extends string = string> {
  /** Mint a code and the instructions that go with it. */
  startVerification(now?: Date): VerificationStart;
  /** Take the message back and decide. Never throws for an expected refusal. */
  verify(eml: string, now?: Date): Promise<VerificationResult<T>>;
  /** Domains this configuration can actually verify — tiers minus missing keys. */
  verifiableDomains(): string[];
}

export function createMailProof<T extends string>(config: MailProofConfig<T>): MailProof<T> {
  const keysByDomain = new Map(
    config.domainKeys.map((key) => [key.domain.toLowerCase().replace(/\.$/, ''), key.dnsRecord]),
  );
  const keyId = blindingKeyId(config.blindingKey);

  /** The pinned key for a domain, or for the nearest parent that has one. */
  const dnsRecordFor = (domain: string): string | undefined => {
    let candidate = domain.toLowerCase().replace(/\.$/, '');
    for (;;) {
      const record = keysByDomain.get(candidate);
      if (record !== undefined) return record;
      const dot = candidate.indexOf('.');
      if (dot === -1) return undefined;
      candidate = candidate.slice(dot + 1);
    }
  };

  const refuse = (reason: VerificationRefusal, detail: string): VerificationResult<T> => ({
    ok: false,
    reason,
    detail,
  });

  return {
    startVerification(now) {
      const challenge: Challenge = issueChallenge({
        secret: config.challengeSecret,
        audience: config.audience,
        ttlMs: config.challengeTtlMs,
        now,
      });
      return {
        code: challenge.code,
        expiresAt: challenge.expiresAt,
        instructions:
          `Send yourself an email from the address you want to prove, with this ` +
          `code anywhere in the subject or the body:\n\n    ${challenge.code}\n\n` +
          `Then come back and hand us that message. We read the domain and nothing else.`,
      };
    },

    async verify(eml, now) {
      // The signing domain is not known until the signature verifies, so the
      // key has to be found first. Every pinned key is offered in turn, and
      // alignment is what stops the wrong one mattering.
      let attestation: SelfAttestation | undefined;
      let lastFailure: SelfAttestationError | undefined;

      for (const dnsRecord of new Set(keysByDomain.values())) {
        try {
          attestation = verifySelfAttestation(eml, {
            dnsRecord,
            challengeSecret: config.challengeSecret,
            audience: config.audience,
            maxAgeMs: config.maxSignatureAgeMs ?? DEFAULT_MAX_AGE_MS,
            now,
          });
          break;
        } catch (error) {
          if (error instanceof SelfAttestationError) lastFailure = error;
          else throw error;
        }
      }

      if (!attestation) {
        return lastFailure
          ? refuse(lastFailure.failure, lastFailure.message)
          : refuse('NO_PINNED_KEY', 'no DKIM key is pinned for any domain in this configuration');
      }

      // Belt and braces: the message verified against *a* pinned key, and the
      // key that matched must be the one pinned for the domain it claims.
      if (dnsRecordFor(attestation.domain) === undefined) {
        return refuse(
          'NO_PINNED_KEY',
          `${attestation.domain} verified, but no key is pinned for it`,
        );
      }

      const match = resolveTier(attestation.domain, config.tiers);
      if (match === null) {
        return refuse('NO_TIER', `${attestation.domain} matches no tier in this configuration`);
      }

      const identity = blindIdentity(attestation.mailbox, config.blindingKey);

      let receipt;
      try {
        receipt = await config.redemption.redeem({
          identity,
          campaign: config.campaign,
          tier: match.id,
        });
      } catch (error) {
        return refuse(
          'REDEMPTION_FAILED',
          error instanceof RedemptionError ? error.message : 'could not spend the claim',
        );
      }

      return {
        ok: true,
        tier: match.id,
        handle: receipt.nullifier,
        ...(config.reveal === 'domain' ? { domain: attestation.domain } : {}),
        alreadyClaimed: receipt.outcome === 'already-claimed',
        nullifier: receipt.nullifier,
        contractAddress: receipt.contractAddress,
        ...(receipt.txId !== undefined ? { txId: receipt.txId } : {}),
        trust: { emailReadBy: 'attestor', cryptographic: true, blindingKeyId: keyId },
      };
    },

    verifiableDomains() {
      return explicitDomains(config.tiers).filter((d) => dnsRecordFor(d) !== undefined);
    },
  };
}
