/**
 * Challenge codes.
 *
 * What matters is the three attacks the code exists to stop: replaying an old
 * message, replaying a message minted for another site, and forging a code
 * without the secret.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ChallengeError,
  findChallengeCode,
  issueChallenge,
  normaliseCode,
  verifyChallenge,
} from './challenge.js';

const SECRET = new Uint8Array(randomBytes(32));
const OTHER_SECRET = new Uint8Array(randomBytes(32));
const NOW = new Date('2026-08-08T12:00:00Z');
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const issue = (over: Partial<Parameters<typeof issueChallenge>[0]> = {}) =>
  issueChallenge({ secret: SECRET, audience: 'lain', now: NOW, ...over });

const verify = (code: string, over: Partial<Parameters<typeof verifyChallenge>[0]> = {}) =>
  verifyChallenge({ secret: SECRET, audience: 'lain', code, now: NOW, ...over });

describe('the three attacks it stops', () => {
  it('an expired code is refused, so an old message is not evidence', () => {
    const { code, expiresAt } = issue({ ttlMs: 60_000 });
    expect(() => verify(code, { now: new Date(expiresAt.getTime() + 1000) })).toThrow(
      /expired/,
    );
  });

  it('a code minted for another site does not authenticate here', () => {
    // Which is what stops a proof made for one integrator being replayed at
    // the next one.
    const { code } = issue({ audience: 'otro-sitio' });
    expect(() => verify(code)).toThrow(ChallengeError);
    expect(() => verify(code)).toThrow(/does not authenticate/);
  });

  it('a code cannot be forged without the secret', () => {
    const { code } = issueChallenge({ secret: OTHER_SECRET, audience: 'lain', now: NOW });
    expect(() => verify(code)).toThrow(/does not authenticate/);
  });
});

describe('issueChallenge', () => {
  it('produces something a person can read off a screen and retype', () => {
    const { code } = issue();
    expect(code).toMatch(/^MP-[0-9A-HJKMNP-TV-Z-]+$/);
    // Crockford's alphabet, so the characters people confuse are absent.
    expect(code.slice(3)).not.toMatch(/[ILOU]/);
  });

  it('carries its own expiry, so verifying needs no stored state', () => {
    const { code, expiresAt } = issue({ ttlMs: 15 * 60 * 1000 });
    expect(expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(verify(code).expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('mints a fresh code for every attempt, including within one minute', () => {
    const first = issue();
    const second = issue();
    expect(first.expiresAt).toEqual(second.expiresAt);
    expect(first.code).not.toBe(second.code);
    expect(() => verify(first.code)).not.toThrow();
    expect(() => verify(second.code)).not.toThrow();
  });

  it('refuses a secret too short to be one', () => {
    expect(() => issue({ secret: new Uint8Array(16) })).toThrow(/at least 32 bytes/);
  });

  it('refuses a non-positive lifetime rather than minting a dead code', () => {
    expect(() => issue({ ttlMs: 0 })).toThrow(ChallengeError);
  });
});

describe('normaliseCode', () => {
  it('accepts the shapes a mail client and a person will produce', () => {
    const { code } = issue();
    const mangled = [
      code.toLowerCase(),
      code.replace(/-/g, ''),
      code.replace(/-/g, ' '),
      `  ${code}\r\n`,
      code.split('').join('​'), // zero-width joiners from a paste
    ];
    for (const variant of mangled) {
      expect(() => verify(variant)).not.toThrow();
    }
  });

  it('folds the characters Crockford leaves out onto what they look like', () => {
    expect(normaliseCode('il')).toBe('11');
    expect(normaliseCode('o')).toBe('0');
    expect(normaliseCode('u')).toBe('V');
  });
});

describe('verifyChallenge', () => {
  it('rejects text that is not a code at all', () => {
    expect(() => verify('')).toThrow(/empty/);
    expect(() => verify('---')).toThrow(/empty/);
    expect(() => verify('MP-ZZ')).toThrow(/not a MailProof code/);
  });

  it('rejects a code with a flipped character', () => {
    const { code } = issue();
    const flipped =
      code.slice(0, 3) + (code[3] === 'Z' ? 'Y' : 'Z') + code.slice(4);
    expect(() => verify(flipped)).toThrow(ChallengeError);
  });

  it('rejects a non-zero Base32 padding bit', () => {
    const { code } = issue();
    const finalIndex = CROCKFORD_ALPHABET.indexOf(code.at(-1)!);
    expect(finalIndex).toBeGreaterThanOrEqual(0);
    expect(finalIndex % 2).toBe(0);

    const nonCanonical = code.slice(0, -1) + CROCKFORD_ALPHABET[finalIndex + 1];
    expect(() => verify(nonCanonical)).toThrow(/not a MailProof code/);
  });

  it('accepts right up to the expiry and not past it', () => {
    const { code, expiresAt } = issue();
    expect(() => verify(code, { now: expiresAt })).not.toThrow();
    expect(() => verify(code, { now: new Date(expiresAt.getTime() + 1) })).toThrow(/expired/);
  });
});

describe('findChallengeCode', () => {
  it('picks the code out of a message someone wrote', () => {
    const { code } = issue();
    expect(findChallengeCode(`Hola,\r\n\r\nverificando: ${code}\r\n\r\ngracias`)).toBe(code);
  });

  it('does not mistake prose for a code', () => {
    expect(findChallengeCode('nothing here')).toBeNull();
    expect(findChallengeCode('MP-4')).toBeNull();
  });

  it('what it finds still has to verify', () => {
    // Finding is not accepting: an attacker can write MP-ANYTHING they like.
    const found = findChallengeCode('code: MP-AAAA-BBBB-CCCC');
    expect(found).toBe('MP-AAAA-BBBB-CCCC');
    expect(() => verify(found!)).toThrow(ChallengeError);
  });
});
