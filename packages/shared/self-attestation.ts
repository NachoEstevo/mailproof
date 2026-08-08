/**
 * Proving control of a mailbox by sending yourself a message.
 *
 * The obvious design — take an email addressed to you and read `To:` — does
 * not work. `To:` is written by whoever sent the message, and DKIM signs what
 * the sender wrote. Anyone able to sign for a domain can therefore mint a
 * claim for any address they invent inside it, and pre-burn a colleague's
 * mailbox at no cost. The demo message in this repo *is* that shape: the
 * claimant is the sender.
 *
 * `From:` is different. A provider will not sign a message claiming to come
 * from a mailbox the sender does not control — that is the entire purpose of
 * DKIM alignment, and it is what DMARC checks. So the sound evidence is a
 * message the claimant sent, signed by their own domain, and the flow is:
 *
 *     "Send yourself an email from your institutional address with code X."
 *
 * Three things then have to hold together, and all three are checked here:
 *
 *  1. The signature verifies, and the signing domain aligns with `From:`.
 *     Otherwise `evil.com` signs `From: ana@udesa.edu.ar` and takes her slot.
 *  2. The message carries a challenge code that authenticates for this site
 *     and has not expired. Otherwise an autoresponder from 2014 is evidence.
 *  3. The `From:` header is covered by the signature, and no unsigned
 *     instance of it was prepended. Otherwise the header the verifier reads
 *     is not the header the domain signed.
 *
 * What comes out is a canonical mailbox. Turning that into something safe to
 * publish is a separate concern — see `blinding.ts`, because a bare hash of a
 * mailbox is recoverable by anyone with a wordlist.
 */
import { verifyChallenge, findChallengeCode, type ChallengeError } from './challenge.js';
import { signedBody, verifyDkim } from './dkim.js';
import { getHeaders, parseDkimSignatures, parseEml, type DkimSignature } from './eml.js';
import { domainAligns, domainOf, soleMailbox, type CanonicaliseOptions } from './mailbox.js';
import { plainTextReadings } from './mime.js';

export type SelfAttestationFailure =
  | 'NO_SIGNATURE'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_EXPIRED'
  | 'SIGNATURE_STALE'
  | 'FROM_NOT_SIGNED'
  | 'FROM_UNPARSEABLE'
  | 'DOMAIN_NOT_ALIGNED'
  | 'DOMAIN_NOT_ALLOWED'
  | 'CHALLENGE_MISSING'
  | 'CHALLENGE_INVALID';

/**
 * How far a candidate got before it failed.
 *
 * A message is checked against every signature it carries and, in the SDK,
 * against every pinned key. Most of those attempts fail at the first hurdle,
 * so keeping the *last* failure reports "no signature" for a message whose
 * only real problem was a missing code — and sends whoever reads the log after
 * a bug that is not there. The furthest attempt is the informative one.
 */
export const SELF_ATTESTATION_PROGRESS: Record<SelfAttestationFailure, number> = {
  NO_SIGNATURE: 0,
  SIGNATURE_INVALID: 1,
  SIGNATURE_EXPIRED: 2,
  SIGNATURE_STALE: 3,
  FROM_NOT_SIGNED: 4,
  FROM_UNPARSEABLE: 5,
  DOMAIN_NOT_ALIGNED: 6,
  DOMAIN_NOT_ALLOWED: 7,
  CHALLENGE_MISSING: 8,
  CHALLENGE_INVALID: 9,
};

/** Whichever of two failures got further. */
export function furthestFailure(
  a: SelfAttestationError | undefined,
  b: SelfAttestationError,
): SelfAttestationError {
  if (a === undefined) return b;
  return SELF_ATTESTATION_PROGRESS[b.failure] > SELF_ATTESTATION_PROGRESS[a.failure] ? b : a;
}

export class SelfAttestationError extends Error {
  constructor(
    readonly failure: SelfAttestationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SelfAttestationError';
  }
}

export interface SelfAttestationOptions {
  /** The pinned `p=` record for the signing domain. */
  readonly dnsRecord: string;
  /** Per-integrator challenge secret. */
  readonly challengeSecret: Uint8Array;
  /** Who the challenge was minted for. */
  readonly audience: string;
  /** How old the signature may be. */
  readonly maxAgeMs: number;
  /** When set, the signing domain must be one of these. */
  readonly allowedDomains?: readonly string[];
  /** Passed through to mailbox canonicalisation. */
  readonly mailbox?: CanonicaliseOptions;
  readonly now?: Date;
}

export interface SelfAttestation {
  /** The canonical mailbox that was proven. Never publish this directly. */
  readonly mailbox: string;
  /** Its domain, which is what a tier is decided from. */
  readonly domain: string;
  /** The signing domain — aligned with, but not necessarily equal to, `domain`. */
  readonly signingDomain: string;
  /** The challenge code found in the signed content. */
  readonly code: string;
  /** Age of the signature in seconds, for logging and for the caller's own limits. */
  readonly ageSeconds: number | undefined;
}

/**
 * The signed `From:` field, with the same rigour the Message-ID path uses.
 *
 * `getHeader` returns the *first* instance, which is the one an attacker
 * prepends. RFC 6376 §5.4.2 consumes instances bottom-up, so the bottom-most
 * is the one the signature actually covered — and if the message carries more
 * instances than `h=` consumed, at least one is unsigned and the whole message
 * is refused rather than guessed at.
 */
function signedFromField(
  eml: ReturnType<typeof parseEml>,
  signature: DkimSignature,
): string {
  const covered = signature.signedHeaders.filter((h) => h === 'from').length;
  if (covered === 0) {
    throw new SelfAttestationError(
      'FROM_NOT_SIGNED',
      'the signature does not cover From, so the sender is not attested',
    );
  }
  const instances = getHeaders(eml, 'from');
  if (instances.length === 0) {
    throw new SelfAttestationError('FROM_NOT_SIGNED', 'message has no From header');
  }
  if (instances.length > covered) {
    throw new SelfAttestationError(
      'FROM_NOT_SIGNED',
      'more From instances than the signature covers, so one is unsigned',
    );
  }
  return instances[instances.length - 1]!.value;
}

/** Everything the signature covers that a person could have typed a code into. */
function signedText(eml: ReturnType<typeof parseEml>, signature: DkimSignature): string {
  const subjectCovered = signature.signedHeaders.filter((h) => h === 'subject').length;
  const subjects = getHeaders(eml, 'subject');
  const subject =
    subjectCovered > 0 && subjects.length > 0 && subjects.length <= subjectCovered
      ? subjects[subjects.length - 1]!.value
      : '';

  // The body is covered by `bh=`, and only the octets `l=` accounts for. Read
  // through the same decoder the marker path uses: a quoted-printable soft
  // break otherwise fabricates line structure that was never signed.
  const body = plainTextReadings(eml, signedBody(eml.body, signature.bodyLength)).join('\n');
  return `${subject}\n${body}`;
}

/**
 * Verify that whoever produced this message controls the mailbox in `From:`.
 *
 * Every candidate signature is tried, because a message may carry several and
 * only one needs to hold — but the *reason* reported is the one from the
 * furthest a candidate got, so a message that fails only on freshness does not
 * come back as "no signature".
 */
export function verifySelfAttestation(
  raw: string,
  options: SelfAttestationOptions,
): SelfAttestation {
  const eml = parseEml(raw);
  const signatures = parseDkimSignatures(eml);
  if (signatures.length === 0) {
    throw new SelfAttestationError('NO_SIGNATURE', 'message carries no DKIM signature');
  }

  let furthest: SelfAttestationError | undefined;
  for (const signature of signatures) {
    try {
      return checkOne(eml, raw, signature, options);
    } catch (error) {
      if (error instanceof SelfAttestationError) furthest = furthestFailure(furthest, error);
      else throw error;
    }
  }
  throw furthest ?? new SelfAttestationError('SIGNATURE_INVALID', 'no signature verified');
}

function checkOne(
  eml: ReturnType<typeof parseEml>,
  raw: string,
  signature: DkimSignature,
  options: SelfAttestationOptions,
): SelfAttestation {
  const result = verifyDkim(raw, signature, {
    dnsRecord: options.dnsRecord,
    now: options.now,
    maxAgeMs: options.maxAgeMs,
  });

  if (!result.valid) {
    throw new SelfAttestationError(
      'SIGNATURE_INVALID',
      result.bodyHashMatches
        ? 'DKIM signature mismatch — a signed header changed or the key is wrong'
        : 'DKIM body hash mismatch — the body changed after signing',
    );
  }
  if (result.expired) {
    throw new SelfAttestationError('SIGNATURE_EXPIRED', 'the signature has passed its x=');
  }
  if (result.stale) {
    throw new SelfAttestationError(
      'SIGNATURE_STALE',
      result.ageSeconds === undefined
        ? 'the signature carries no t=, so its age cannot be established'
        : `the signature is ${Math.round(result.ageSeconds / 3600)}h old`,
    );
  }

  const signingDomain = (result.domain ?? '').toLowerCase();
  if (signingDomain.length === 0) {
    throw new SelfAttestationError('SIGNATURE_INVALID', 'the signature names no domain');
  }

  let mailbox: string;
  try {
    mailbox = soleMailbox(signedFromField(eml, signature), options.mailbox);
  } catch (error) {
    if (error instanceof SelfAttestationError) throw error;
    throw new SelfAttestationError(
      'FROM_UNPARSEABLE',
      error instanceof Error ? error.message : 'From names no single mailbox',
    );
  }

  const domain = domainOf(mailbox);
  if (!domainAligns(signingDomain, domain)) {
    // The one check that makes From: mean anything. Without it a signature
    // from any domain vouches for a mailbox at any other.
    throw new SelfAttestationError(
      'DOMAIN_NOT_ALIGNED',
      `signed by ${signingDomain}, which does not vouch for ${domain}`,
    );
  }

  if (options.allowedDomains && !options.allowedDomains.some((d) => domainAligns(d, domain))) {
    throw new SelfAttestationError('DOMAIN_NOT_ALLOWED', `${domain} is not an accepted domain`);
  }

  const code = findChallengeCode(signedText(eml, signature));
  if (code === null) {
    throw new SelfAttestationError(
      'CHALLENGE_MISSING',
      'no challenge code in the signed subject or body',
    );
  }
  try {
    verifyChallenge({
      secret: options.challengeSecret,
      audience: options.audience,
      code,
      now: options.now,
    });
  } catch (error) {
    throw new SelfAttestationError(
      'CHALLENGE_INVALID',
      (error as ChallengeError).message ?? 'challenge code did not verify',
    );
  }

  return { mailbox, domain, signingDomain, code, ageSeconds: result.ageSeconds };
}
