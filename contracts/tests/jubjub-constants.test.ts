/**
 * Re-derives the Jubjub subgroup order from the runtime on every run.
 *
 * The contract hard-codes this order as two limbs to range-check signature
 * scalars. If the constant were wrong in the "too large" direction, an
 * out-of-range scalar would reach `ecMulGenerator` and fault the runtime
 * instead of being rejected as a bad signature. These tests make that
 * impossible to introduce silently.
 */
import { describe, expect, it } from 'vitest';
import { ecAdd, ecMulGenerator, MAX_FIELD } from '@midnight-ntwrk/compact-runtime';

import {
  JUBJUB_ORDER,
  JUBJUB_ORDER_HI,
  JUBJUB_ORDER_LO,
  SCALAR_LIMB_SHIFT,
} from '../../packages/shared/constants.js';

const IDENTITY = { x: 0n, y: 1n };

describe('Jubjub subgroup order', () => {
  it('is the order of the generator: (l-1)·G + G == identity', () => {
    const g = ecMulGenerator(1n);
    const gLastValid = ecMulGenerator(JUBJUB_ORDER - 1n);
    expect(ecAdd(gLastValid, g)).toEqual(IDENTITY);
  });

  it('is exactly the scalar bound the runtime enforces', () => {
    // l-1 is accepted...
    expect(() => ecMulGenerator(JUBJUB_ORDER - 1n)).not.toThrow();
    // ...and l is not, which pins the constant from both sides.
    expect(() => ecMulGenerator(JUBJUB_ORDER)).toThrow();
  });

  it('is smaller than the field modulus, so a Field can hold any scalar', () => {
    expect(JUBJUB_ORDER).toBeLessThan(MAX_FIELD + 1n);
  });

  it('splits into the limbs the contract compares against', () => {
    expect((JUBJUB_ORDER_HI << SCALAR_LIMB_SHIFT) + JUBJUB_ORDER_LO).toBe(JUBJUB_ORDER);
    // The contract declares these as Uint<124> and Uint<128>.
    expect(JUBJUB_ORDER_HI).toBeLessThan(1n << 124n);
    expect(JUBJUB_ORDER_LO).toBeLessThan(1n << 128n);
  });

  it('leaves the 224-bit challenge safely below the bound', () => {
    // The contract derives challenges from 28 hash bytes. That is what makes
    // the derivation total rather than occasionally fatal.
    expect(1n << 224n).toBeLessThan(JUBJUB_ORDER);
  });
});
