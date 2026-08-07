/**
 * Hashing primitives shared by the attestor, the CLI and the tests.
 *
 * Every function here mirrors a circuit in contracts/mailproof.compact and
 * uses the same runtime builtins the circuit compiles down to, so the two
 * cannot disagree about encoding.
 */
import {
  CompactTypeBytes,
  CompactTypeJubjubPoint,
  CompactTypeVector,
  persistentHash,
  upgradeFromTransient,
  type JubjubPoint,
} from '@midnight-ntwrk/compact-runtime';

export const BYTES_32 = new CompactTypeBytes(32);

const vectorTypes = new Map<number, CompactTypeVector<Uint8Array>>();

/** `Vector<n, Bytes<32>>`, cached — the descriptors are immutable. */
export function bytes32Vector(n: number): CompactTypeVector<Uint8Array> {
  let t = vectorTypes.get(n);
  if (!t) {
    t = new CompactTypeVector(n, BYTES_32);
    vectorTypes.set(n, t);
  }
  return t;
}

/**
 * Compact's `pad(32, s)`: the ASCII bytes of `s`, right-padded with zeros.
 * Verified against the generated circuit, not assumed.
 */
export function pad32(s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length > 32) {
    throw new Error(`pad32: "${s}" is ${encoded.length} bytes, max 32`);
  }
  const out = new Uint8Array(32);
  out.set(encoded, 0);
  return out;
}

/** `persistentHash<Vector<n, Bytes<32>>>(parts)`. */
export function hashBytes32Vector(parts: readonly Uint8Array[]): Uint8Array {
  for (const [i, p] of parts.entries()) {
    if (p.length !== 32) {
      throw new Error(`hashBytes32Vector: part ${i} is ${p.length} bytes, expected 32`);
    }
  }
  return persistentHash(bytes32Vector(parts.length), [...parts]);
}

/** `persistentHash<JubjubPoint>(point)` — the canonical 32-byte point encoding. */
export function hashPoint(point: JubjubPoint): Uint8Array {
  return persistentHash(CompactTypeJubjubPoint, point);
}

/**
 * Domain-separated hash of an arbitrary-length string into 32 bytes.
 *
 * Used off-circuit only, to turn identifiers like a blueprint slug or a
 * campaign name into the fixed-width values the contract stores. The string
 * is hashed in 32-byte chunks so inputs longer than 32 bytes still work,
 * unlike `pad32`.
 */
export function hashString(domain: string, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const chunkCount = Math.max(1, Math.ceil(bytes.length / 32));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunk = new Uint8Array(32);
    chunk.set(bytes.subarray(i * 32, i * 32 + 32), 0);
    chunks.push(chunk);
  }
  // Length is bound in so that "ab"+"" and "a"+"b" cannot collide.
  return hashBytes32Vector([pad32(domain), fieldToBytes32(BigInt(bytes.length)), ...chunks]);
}

/** `upgradeFromTransient` — widens a field element to 32 bytes. */
export function fieldToBytes32(value: bigint): Uint8Array {
  return upgradeFromTransient(value);
}

/** Constant-time-ish equality for fixed-width digests. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

export function fromHex(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(body)) {
    throw new Error('fromHex: not an even-length hex string');
  }
  return new Uint8Array(Buffer.from(body, 'hex'));
}

/** Parse a hex string that must decode to exactly 32 bytes. */
export function bytes32FromHex(hex: string, label = 'value'): Uint8Array {
  const bytes = fromHex(hex);
  if (bytes.length !== 32) {
    throw new Error(`${label}: expected 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}
