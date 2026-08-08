/**
 * Values that must agree exactly with contracts/mailproof.compact.
 *
 * Anything here that drifts from the contract silently invalidates every
 * signature. contracts/tests/golden-vectors.test.ts compares this module
 * against the compiled circuit on every run to make that impossible.
 */

/** Domain separators (§44.1). ASCII, right-padded with zeros to 32 bytes. */
export const DOMAIN_CLAIM = 'MAILPROOF:CLAIM:V1';
export const DOMAIN_SUBJECT = 'MAILPROOF:SUBJECT:V1';
export const DOMAIN_CHALLENGE = 'MAILPROOF:SCHNORR:V1';
export const DOMAIN_NULLIFIER = 'MAILPROOF:NULLIFIER:V1';
export const DOMAIN_BLUEPRINT = 'MAILPROOF:BLUEPRINT:V1';
export const DOMAIN_ISSUER = 'MAILPROOF:ISSUER:V1';
export const DOMAIN_CAMPAIGN = 'MAILPROOF:CAMPAIGN:V1';
export const DOMAIN_PROOF_DIGEST = 'MAILPROOF:PROOF-DIGEST:V1';

/** Key and nonce derivation are signer-local; the contract never sees these. */
export const DOMAIN_ATTESTOR_KEY = 'MAILPROOF:ATTESTOR-KEY:V1';
export const DOMAIN_NONCE_HI = 'MAILPROOF:NONCE-HI:V1';
export const DOMAIN_NONCE_LO = 'MAILPROOF:NONCE-LO:V1';

/**
 * Order of the Jubjub prime-order subgroup.
 *
 * Not copied from a reference: contracts/tests/jubjub-constants.test.ts
 * re-derives it from the runtime on every run ((l-1)·G + G == identity, and l
 * is rejected as a scalar), so a wrong value here fails the suite immediately.
 */
export const JUBJUB_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/** Limb split used by SchnorrSignature, because Compact caps Uint at 248 bits. */
export const SCALAR_LIMB_SHIFT = 128n;
export const JUBJUB_ORDER_HI = JUBJUB_ORDER >> SCALAR_LIMB_SHIFT;
export const JUBJUB_ORDER_LO = JUBJUB_ORDER & ((1n << SCALAR_LIMB_SHIFT) - 1n);

/**
 * Claim types (§11.1).
 *
 * The value is pinned into the contract at deploy time and compared against
 * every claim, so a number here is a wire format: reuse one and two campaigns
 * become mutually replayable. Append, never renumber.
 */
export const CLAIM_TYPE = {
  FLIGHT_CANCELLED: 1n,
  EVENT_REGISTERED: 2n,
  /** Holder controls a mailbox at the pinned domain. Proves nothing else. */
  DOMAIN_MEMBER: 3n,
} as const;

export type ClaimTypeName = keyof typeof CLAIM_TYPE;

/** The only version this codebase emits or accepts. */
export const CLAIM_VERSION = 1n;
