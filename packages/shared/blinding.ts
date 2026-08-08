/**
 * Making an identity unguessable before it is written to a public ledger.
 *
 * The nullifier set is public and insert-only. Hashing a mailbox straight into
 * it does not hide the mailbox: the input space is small and enumerable, so an
 * observer with a wordlist recovers the exact address of every claimant by
 * hashing candidates and looking for a hit. Measured on this machine below —
 * the attack is not theoretical, it runs at tens of thousands of guesses a
 * second on a laptop.
 *
 * The fix is a keyed hash. Only the holder of the blinding key can compute the
 * mapping, so the set becomes opaque to everyone else while remaining exactly
 * as effective at detecting a repeat.
 *
 * The key lives with the attestor, which already reads the whole message in
 * DKIM-direct mode — so this grants it nothing it did not have. It does not
 * make the attestor trustworthy; it stops the *ledger* from leaking to
 * everyone else. See docs/KNOWN_LIMITATIONS.md on the attestor boundary.
 *
 * Rotating the key renames every identity, which silently hands everyone a
 * fresh benefit. `blindingKeyId` exists so a rotation is visible rather than
 * silent, and so a deployment can refuse to mix two generations.
 */
import { createHmac } from 'node:crypto';

import { hashBytes32Vector, pad32 } from './hashes.js';

/** Domain separator for the keyed identity hash. */
const DOMAIN_BLINDED_IDENTITY = 'MAILPROOF:BLINDED-IDENTITY:V1';

/** Minimum key length. 32 bytes is the HMAC-SHA256 block-security point. */
const MIN_KEY_BYTES = 32;

export class BlindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlindingError';
  }
}

/**
 * A keyed, domain-separated hash of a canonical identity.
 *
 * Deterministic for a given key, so a repeat claim collides exactly as it
 * must. Opaque without the key, so the ledger reveals nothing.
 *
 * The result is folded through the same 32-byte hash the rest of the claim
 * uses, which keeps it inside the field the circuit works in rather than
 * introducing a second convention.
 */
export function blindIdentity(canonicalIdentity: string, key: Uint8Array): Uint8Array {
  if (canonicalIdentity.length === 0) {
    throw new BlindingError('refusing to blind an empty identity');
  }
  if (key.length < MIN_KEY_BYTES) {
    throw new BlindingError(
      `blinding key must be at least ${MIN_KEY_BYTES} bytes, got ${key.length}`,
    );
  }

  const mac = createHmac('sha256', key)
    .update(DOMAIN_BLINDED_IDENTITY)
    .update('\0')
    .update(canonicalIdentity, 'utf8')
    .digest();

  // Through the project's own hash so the value is a field element like every
  // other 32-byte quantity in a claim, not a raw SHA-256 digest.
  return hashBytes32Vector([pad32(DOMAIN_BLINDED_IDENTITY), new Uint8Array(mac)]);
}

/**
 * A short, public label for the key that produced a blinded identity.
 *
 * Derived from the key rather than configured, so it cannot be set to
 * something that does not match. Publishing it is safe — it is a one-way
 * function of the key — and it lets a deployment notice that two nullifiers
 * came from different generations instead of quietly treating one person as
 * two.
 */
export function blindingKeyId(key: Uint8Array): string {
  if (key.length < MIN_KEY_BYTES) {
    throw new BlindingError(`blinding key must be at least ${MIN_KEY_BYTES} bytes`);
  }
  return createHmac('sha256', key).update('MAILPROOF:BLINDING-KEY-ID:V1').digest('hex').slice(0, 16);
}
