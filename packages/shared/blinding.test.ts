/**
 * Keyed identity hashing.
 *
 * The first test is the reason the module exists: it runs the dictionary
 * attack against an unkeyed hash and shows it succeeding, then shows the same
 * attack finding nothing against the keyed one.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { blindIdentity, blindingKeyId, BlindingError } from './blinding.js';
import { toHex } from './hashes.js';
import { uniqueClaimIdHash } from './claim.js';

const KEY = new Uint8Array(randomBytes(32));
const OTHER_KEY = new Uint8Array(randomBytes(32));

describe('why this exists', () => {
  it('an unkeyed hash of a mailbox is recoverable from the public set', () => {
    // A ledger entry is H(address). Addresses are guessable, so an observer
    // hashes candidates until one matches and learns exactly who claimed.
    const victim = 'anademo@gmail.com';
    const published = toHex(uniqueClaimIdHash(victim));

    const wordlist = ['ana@gmail.com', 'anademo@gmail.com', 'demo@gmail.com'];
    const recovered = wordlist.find((guess) => toHex(uniqueClaimIdHash(guess)) === published);

    expect(recovered).toBe(victim);
  });

  it('the same attack finds nothing once the hash is keyed', () => {
    const victim = 'anademo@gmail.com';
    const published = toHex(blindIdentity(victim, KEY));

    const wordlist = ['ana@gmail.com', 'anademo@gmail.com', 'demo@gmail.com'];
    const recovered = wordlist.find((guess) => toHex(blindIdentity(guess, OTHER_KEY)) === published);

    expect(recovered).toBeUndefined();
  });
});

describe('blindIdentity', () => {
  it('collides with itself, which is what detects a repeat', () => {
    expect(toHex(blindIdentity('ana@udesa.edu.ar', KEY))).toBe(
      toHex(blindIdentity('ana@udesa.edu.ar', KEY)),
    );
  });

  it('separates two identities under one key', () => {
    expect(toHex(blindIdentity('ana@udesa.edu.ar', KEY))).not.toBe(
      toHex(blindIdentity('bruno@udesa.edu.ar', KEY)),
    );
  });

  it('separates one identity under two keys', () => {
    // Which is also the hazard: rotating the key renames everyone and hands
    // out a second benefit. blindingKeyId exists to make that visible.
    expect(toHex(blindIdentity('ana@udesa.edu.ar', KEY))).not.toBe(
      toHex(blindIdentity('ana@udesa.edu.ar', OTHER_KEY)),
    );
  });

  it('returns 32 bytes, like every other quantity in a claim', () => {
    expect(blindIdentity('ana@udesa.edu.ar', KEY)).toHaveLength(32);
  });

  it('refuses a key too short to be one', () => {
    expect(() => blindIdentity('ana@udesa.edu.ar', new Uint8Array(16))).toThrow(BlindingError);
    expect(() => blindIdentity('ana@udesa.edu.ar', new Uint8Array(31))).toThrow(/at least 32/);
  });

  it('refuses an empty identity rather than blinding nothing', () => {
    expect(() => blindIdentity('', KEY)).toThrow(/empty identity/);
  });
});

describe('blindingKeyId', () => {
  it('labels a key without revealing it', () => {
    const id = blindingKeyId(KEY);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).not.toContain(toHex(KEY).slice(2, 10));
  });

  it('is stable for a key and distinct across keys', () => {
    expect(blindingKeyId(KEY)).toBe(blindingKeyId(KEY));
    expect(blindingKeyId(KEY)).not.toBe(blindingKeyId(OTHER_KEY));
  });

  it('cannot be computed from a key that would be rejected anyway', () => {
    expect(() => blindingKeyId(new Uint8Array(8))).toThrow(BlindingError);
  });
});
