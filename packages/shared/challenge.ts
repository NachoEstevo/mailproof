/**
 * The code a person types into the email they send themselves.
 *
 * Without one, any signed message from the right domain is evidence: a
 * fourteen-year-old archive, an autoresponder, a mailing-list confirmation, a
 * calendar invite. All of those can be provoked by an outsider, and none of
 * them says the claimant is here, now, asking for this.
 *
 * The code fixes three things at once. It proves the message was written for
 * this verification rather than found; it binds the message to one site, so a
 * proof minted for one integrator cannot be replayed at another; and it puts
 * an expiry on evidence that otherwise never goes stale.
 *
 * It carries its own expiry and its own authentication tag, so verifying it
 * needs no stored state — an SDK that demanded a table would be a much harder
 * thing to adopt. Integrators who want single-use on top can still record the
 * code; this layer deliberately does not decide that for them.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Crockford's alphabet: no I, L, O or U. People retype these codes by hand
 * off a screen, and `0`/`O` and `1`/`I` are where that goes wrong.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Marks a code as ours, so prose containing base32 is not mistaken for one. */
const PREFIX = 'MP';

/** Minutes since the epoch fit in 4 bytes until the year 10000. */
const EXPIRY_BYTES = 4;
/** 48 bits of tag. Forging one requires 2^47 tries against a live endpoint. */
const TAG_BYTES = 6;
const CODE_BYTES = EXPIRY_BYTES + TAG_BYTES;

const MIN_SECRET_BYTES = 32;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export class ChallengeError extends Error {
  constructor(
    message: string,
    readonly code: 'MALFORMED' | 'EXPIRED' | 'WRONG_AUDIENCE' | 'BAD_SECRET',
  ) {
    super(message);
    this.name = 'ChallengeError';
  }
}

export interface IssueOptions {
  /** Per-integrator secret. Never leaves their server. */
  readonly secret: Uint8Array;
  /** Who this code is for — a site, a tenant, a campaign. Bound into the tag. */
  readonly audience: string;
  readonly now?: Date;
  readonly ttlMs?: number;
}

export interface Challenge {
  /** What the person types, e.g. `MP-4KQ7-9XW2-3TFA`. */
  readonly code: string;
  readonly expiresAt: Date;
}

function assertSecret(secret: Uint8Array): void {
  if (secret.length < MIN_SECRET_BYTES) {
    throw new ChallengeError(
      `challenge secret must be at least ${MIN_SECRET_BYTES} bytes, got ${secret.length}`,
      'BAD_SECRET',
    );
  }
}

function tag(secret: Uint8Array, audience: string, expiryMinutes: number): Buffer {
  return createHmac('sha256', secret)
    .update('MAILPROOF:CHALLENGE:V1')
    .update('\0')
    .update(audience, 'utf8')
    .update('\0')
    .update(String(expiryMinutes))
    .digest()
    .subarray(0, TAG_BYTES);
}

function encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function decode(text: string): Uint8Array | null {
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Fold a typed code back to its canonical characters.
 *
 * People and mail clients add hyphens, spaces and line breaks, lowercase it,
 * and substitute the characters Crockford's alphabet leaves out. All of that
 * has to mean the same code, or the flow fails for reasons the user cannot
 * see.
 */
export function normaliseCode(input: string): string {
  const letters = input
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
    .replace(/[^0-9A-Z]/g, '');

  // `M` and `P` are both in the alphabet, so the prefix has to come off
  // explicitly — left in, it decodes as payload and shifts every byte.
  return letters.startsWith(PREFIX) ? letters.slice(PREFIX.length) : letters;
}

/** Group into fours so it can be read aloud and retyped. */
function pretty(body: string): string {
  return `${PREFIX}-${(body.match(/.{1,4}/g) ?? [body]).join('-')}`;
}

export function issueChallenge(options: IssueOptions): Challenge {
  assertSecret(options.secret);
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (ttlMs <= 0) throw new ChallengeError('ttlMs must be positive', 'MALFORMED');

  // Rounded up to the minute the code is valid until — the expiry travels in
  // the code, so there is nothing to look up when it comes back.
  const expiryMinutes = Math.ceil((now.getTime() + ttlMs) / 60_000);

  const bytes = new Uint8Array(CODE_BYTES);
  new DataView(bytes.buffer).setUint32(0, expiryMinutes, false);
  bytes.set(tag(options.secret, options.audience, expiryMinutes), EXPIRY_BYTES);

  return { code: pretty(encode(bytes)), expiresAt: new Date(expiryMinutes * 60_000) };
}

export interface VerifyOptions {
  readonly secret: Uint8Array;
  readonly audience: string;
  readonly code: string;
  readonly now?: Date;
}

/**
 * Check a code, or say precisely why not.
 *
 * The audience is authenticated rather than compared, so a code minted for
 * another site fails as a forgery instead of as a mismatch — there is nothing
 * to compare against, because the audience is not carried in the code.
 */
export function verifyChallenge(options: VerifyOptions): { expiresAt: Date } {
  assertSecret(options.secret);

  const normalised = normaliseCode(options.code);
  if (normalised.length === 0) throw new ChallengeError('empty challenge code', 'MALFORMED');

  const bytes = decode(normalised);
  if (bytes === null || bytes.length < CODE_BYTES) {
    throw new ChallengeError('challenge code is not a MailProof code', 'MALFORMED');
  }

  const expiryMinutes = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, false);
  const expected = tag(options.secret, options.audience, expiryMinutes);
  const actual = Buffer.from(bytes.subarray(EXPIRY_BYTES, CODE_BYTES));

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    // Indistinguishable from a code for another audience, on purpose.
    throw new ChallengeError('challenge code does not authenticate', 'WRONG_AUDIENCE');
  }

  const expiresAt = new Date(expiryMinutes * 60_000);
  if ((options.now ?? new Date()).getTime() > expiresAt.getTime()) {
    throw new ChallengeError(`challenge code expired at ${expiresAt.toISOString()}`, 'EXPIRED');
  }
  return { expiresAt };
}

/**
 * Find a challenge code in text the sender wrote.
 *
 * Searches for the printed form rather than any run of base32, so ordinary
 * prose cannot accidentally look like a code. The caller must only ever pass
 * text that the DKIM signature covers.
 */
export function findChallengeCode(text: string): string | null {
  const match = /MP-[0-9A-Za-z-]{8,}/.exec(text);
  return match ? match[0] : null;
}
