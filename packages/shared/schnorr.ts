/**
 * Schnorr signatures over the proof system's embedded Jubjub curve.
 *
 * This is the off-circuit half of the scheme verified by `verifySchnorr` in
 * contracts/mailproof.compact. Both halves call the same runtime curve and
 * hash builtins, and contracts/tests/golden-vectors.test.ts checks that a
 * signature produced here verifies inside the compiled circuit.
 *
 *   keygen   x <- [1, l),  P = x·G
 *   sign     k <- nonce,   R = k·G,  c = H(dom, R, P, m),  s = k + c·x mod l
 *   verify   s·G == R + c·P
 */
import { randomBytes } from 'node:crypto';
import { ecAdd, ecMul, ecMulGenerator, type JubjubPoint } from '@midnight-ntwrk/compact-runtime';

import {
  DOMAIN_ATTESTOR_KEY,
  DOMAIN_CHALLENGE,
  DOMAIN_NONCE_HI,
  DOMAIN_NONCE_LO,
  JUBJUB_ORDER,
  SCALAR_LIMB_SHIFT,
} from './constants.js';
import { hashBytes, hashBytes32Vector, hashPoint, pad32 } from './hashes.js';

/** Bytes of the challenge digest folded into the scalar (§ see contract). */
const CHALLENGE_BYTES = 28;

export interface SchnorrSignature {
  announcement: JubjubPoint;
  responseHi: bigint;
  responseLo: bigint;
}

export interface SchnorrKeyPair {
  secretKey: bigint;
  publicKey: JubjubPoint;
}

/** Split a scalar into the 124/128-bit limbs the contract struct carries. */
export function splitScalar(s: bigint): { hi: bigint; lo: bigint } {
  if (s < 0n || s >= JUBJUB_ORDER) {
    throw new Error('splitScalar: scalar out of range [0, l)');
  }
  return { hi: s >> SCALAR_LIMB_SHIFT, lo: s & ((1n << SCALAR_LIMB_SHIFT) - 1n) };
}

/** Inverse of {@link splitScalar}. */
export function joinScalar(hi: bigint, lo: bigint): bigint {
  return (hi << SCALAR_LIMB_SHIFT) + lo;
}

/** Big-endian interpretation of `bytes`, reduced mod l. */
function bytesToScalar(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) + BigInt(b);
  return acc % JUBJUB_ORDER;
}

/**
 * Reduce 512 bits into [0, l).
 *
 * A single 256-bit digest reduced mod a 252-bit order is biased by roughly
 * 2^-4, which is enough to recover a signing key from a few hundred
 * signatures by lattice reduction. Folding two digests makes the bias about
 * 2^-260 instead. Ed25519 reduces from 512 bits for the same reason.
 */
function wideReduce(hi: Uint8Array, lo: Uint8Array): bigint {
  let acc = 0n;
  for (const b of hi) acc = (acc << 8n) + BigInt(b);
  for (const b of lo) acc = (acc << 8n) + BigInt(b);
  return acc % JUBJUB_ORDER;
}

/** A secret key uniform in [1, l). */
export function generateSecretKey(): bigint {
  for (;;) {
    const x = wideReduce(randomBytes(32), randomBytes(32));
    if (x !== 0n) return x;
  }
}

/**
 * Deterministically derive a secret key from seed material of any length.
 *
 * Used to load the attestor key from the environment and to make test
 * fixtures reproducible. The seed is compressed to 32 bytes first, so a long
 * passphrase and a raw 32-byte key go through the same path, then
 * wide-reduced so the result is unbiased.
 *
 * Note this treats its input as *seed material*, not as a literal scalar:
 * 32 random bytes exceed the curve order about 94% of the time, so
 * interpreting them directly would reject most keys.
 */
export function secretKeyFromSeed(seed: Uint8Array): bigint {
  const material = hashBytes(DOMAIN_ATTESTOR_KEY, seed);
  const hi = hashBytes32Vector([pad32(DOMAIN_NONCE_HI), material]);
  const lo = hashBytes32Vector([pad32(DOMAIN_NONCE_LO), material]);
  const x = wideReduce(hi, lo);
  return x === 0n ? 1n : x;
}

/** {@link secretKeyFromSeed} over the UTF-8 encoding of a passphrase. */
export function secretKeyFromPassphrase(passphrase: string): bigint {
  return secretKeyFromSeed(new TextEncoder().encode(passphrase));
}

export function publicKeyFromSecret(secretKey: bigint): JubjubPoint {
  if (secretKey <= 0n || secretKey >= JUBJUB_ORDER) {
    throw new Error('publicKeyFromSecret: secret key out of range [1, l)');
  }
  return ecMulGenerator(secretKey);
}

export function generateKeyPair(): SchnorrKeyPair {
  const secretKey = generateSecretKey();
  return { secretKey, publicKey: publicKeyFromSecret(secretKey) };
}

/**
 * Fiat-Shamir challenge, byte-identical to `schnorrChallenge` in the contract:
 * the leading 28 bytes of the digest, big-endian. Truncating to 224 bits keeps
 * the challenge structurally below l — the runtime faults rather than asserts
 * on an out-of-range scalar, so it must not be able to get there.
 */
export function challenge(
  announcement: JubjubPoint,
  publicKey: JubjubPoint,
  messageHash: Uint8Array,
): bigint {
  const digest = hashBytes32Vector([
    pad32(DOMAIN_CHALLENGE),
    hashPoint(announcement),
    hashPoint(publicKey),
    messageHash,
  ]);
  return bytesToScalar(digest.subarray(0, CHALLENGE_BYTES));
}

/**
 * Deterministic nonce, derived from the key and the message (RFC 6979 /
 * EdDSA style). Deterministic so a bad RNG cannot repeat a nonce across two
 * different messages, which would expose the signing key outright.
 */
function deriveNonce(secretKey: bigint, messageHash: Uint8Array): bigint {
  const secretBytes = new Uint8Array(32);
  const hex = secretKey.toString(16).padStart(64, '0');
  secretBytes.set(Buffer.from(hex, 'hex'));

  const hi = hashBytes32Vector([pad32(DOMAIN_NONCE_HI), secretBytes, messageHash]);
  const lo = hashBytes32Vector([pad32(DOMAIN_NONCE_LO), secretBytes, messageHash]);
  const k = wideReduce(hi, lo);
  // k = 0 would publish R = identity and leak s = c·x. Astronomically
  // unlikely, but the check costs nothing and the failure is catastrophic.
  if (k === 0n) throw new Error('deriveNonce: degenerate nonce');
  return k;
}

export function sign(secretKey: bigint, messageHash: Uint8Array): SchnorrSignature {
  if (secretKey <= 0n || secretKey >= JUBJUB_ORDER) {
    throw new Error('sign: secret key out of range [1, l)');
  }
  if (messageHash.length !== 32) {
    throw new Error(`sign: messageHash must be 32 bytes, got ${messageHash.length}`);
  }

  const k = deriveNonce(secretKey, messageHash);
  const announcement = ecMulGenerator(k);
  const publicKey = publicKeyFromSecret(secretKey);
  const c = challenge(announcement, publicKey, messageHash);
  const s = (k + ((c * secretKey) % JUBJUB_ORDER)) % JUBJUB_ORDER;

  const { hi, lo } = splitScalar(s);
  return { announcement, responseHi: hi, responseLo: lo };
}

/**
 * Off-circuit mirror of `verifySchnorr`. The attestor and the CLI use it to
 * catch their own mistakes before spending a proof; it is not a substitute
 * for the on-chain check.
 */
export function verify(
  publicKey: JubjubPoint,
  messageHash: Uint8Array,
  signature: SchnorrSignature,
): boolean {
  const s = joinScalar(signature.responseHi, signature.responseLo);
  if (s >= JUBJUB_ORDER) return false;
  const c = challenge(signature.announcement, publicKey, messageHash);
  const lhs = ecMulGenerator(s);
  const rhs = ecAdd(signature.announcement, ecMul(publicKey, c));
  return lhs.x === rhs.x && lhs.y === rhs.y;
}
