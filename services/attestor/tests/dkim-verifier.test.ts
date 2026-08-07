/**
 * DKIM-direct verifier (D-007).
 *
 * Every case runs against a synthetic message signed with a key generated
 * here — hermetic, adversarial on demand. The last block re-runs the happy
 * path against the real provider-signed fixture when this machine has one.
 *
 * The replay-surface cases matter most: the nullifier is derived from the
 * Message-ID, so anything that would let a caller vary the Message-ID of one
 * signed email must be rejected, or one email becomes many claims.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { dkimSign, dnsRecordForPublicKey } from '../../../packages/shared/dkim-sign.js';
import { canonicalClaimHash, deriveSubjectBinding } from '../../../packages/shared/claim.js';
import { toHex } from '../../../packages/shared/hashes.js';
import { secretKeyFromPassphrase, verify } from '../../../packages/shared/schnorr.js';

import { attest } from '../src/attest.js';
import { parseAllowlist, type BlueprintPolicy } from '../src/allowlist.js';
import { ATTESTOR_ERROR, AttestorError } from '../src/errors.js';
import { DkimProofVerifier, findMarkerLine } from '../src/dkim-verifier.js';
import type { ProofSubmission } from '../src/verifier.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const DNS_RECORD = dnsRecordForPublicKey(publicKey);

const ISSUER = 'demo-airline.example';
const SLUG = 'test/FlightCancelledDkim@v1';
const CAMPAIGN = 'dkim-test-campaign';
const MARKER_PATTERN = '^Your flight [A-Z0-9-]{2,12} has been cancelled\\.?$';

const MESSAGE =
  'From: Demo Airline <notifications@demo-airline.example>\r\n' +
  'To: passenger@example.com\r\n' +
  'Subject: Your flight MP401 has been cancelled\r\n' +
  'Date: Fri, 07 Aug 2026 12:00:00 +0000\r\n' +
  'Message-ID: <synthetic-0001@demo-airline.example>\r\n' +
  '\r\n' +
  'Hello Ana Demo,\r\n' +
  'Your flight MP401 has been cancelled.\r\n' +
  'Booking reference: MP-8F2A19\r\n';

function policy(overrides: Partial<BlueprintPolicy> = {}): BlueprintPolicy {
  return {
    key: 'test-dkim',
    status: 'pinned',
    slug: SLUG,
    claimType: 'FLIGHT_CANCELLED',
    issuerDomain: ISSUER,
    campaigns: [CAMPAIGN],
    requiredOutputs: ['cancellationMarker', 'uniqueClaimId'],
    markerOutput: 'cancellationMarker',
    uniqueIdOutput: 'uniqueClaimId',
    markerPattern: MARKER_PATTERN,
    dkim: { dnsRecord: DNS_RECORD },
    ...overrides,
  };
}

function sign(raw = MESSAGE, overrides = {}) {
  return dkimSign(raw, { domain: ISSUER, selector: 'test', privateKey, ...overrides });
}

/** A message body carried as a quoted-printable text part. */
function qpMessage(body: string): string {
  return (
    'From: Demo Airline <notifications@demo-airline.example>\r\n' +
    'To: passenger@example.com\r\n' +
    'Subject: Flight update\r\n' +
    'Date: Fri, 07 Aug 2026 12:00:00 +0000\r\n' +
    'Message-ID: <qp-0001@demo-airline.example>\r\n' +
    'Content-Type: text/plain; charset="UTF-8"\r\n' +
    'Content-Transfer-Encoding: quoted-printable\r\n' +
    '\r\n' +
    body
  );
}

function submission(proofData: string): ProofSubmission {
  return { blueprintSlug: SLUG, publicOutputs: 'dkim-direct/v1', proofData };
}

const verifier = new DkimProofVerifier();

async function expectCode(promise: Promise<unknown>, code: string): Promise<AttestorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AttestorError);
    expect((error as AttestorError).code).toBe(code);
    return error as AttestorError;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('a validly signed message', () => {
  it('yields the signed domain, marker line and Message-ID', async () => {
    const evidence = await verifier.verify(submission(sign()), policy());
    expect(evidence.issuerDomain).toBe(ISSUER);
    expect(evidence.claimMarker).toBe('Your flight MP401 has been cancelled.');
    expect(evidence.uniqueClaimId).toBe('<synthetic-0001@demo-airline.example>');
  });

  it('finds a marker split across a quoted-printable soft break', async () => {
    const raw = qpMessage('Your flight MP401 has been can=\r\ncelled.\r\n');
    const evidence = await verifier.verify(submission(sign(raw)), policy());
    expect(evidence.claimMarker).toBe('Your flight MP401 has been cancelled.');
  });
});

// ─── Marker forgery: the anchored pattern must survive encoding ──────────────

describe('§41.8 the marker must be a line the message states, not one the encoding creates', () => {
  it('rejects a negated sentence broken by a quoted-printable soft break', async () => {
    // A soft break is invisible to a reader: the message says "It is not true
    // that Your flight MP401 has been cancelled." Searching the *encoded*
    // bytes would split at the `=` and leave the claim alone on a line,
    // satisfying ^…$ — the exact negation the anchor exists to reject.
    const raw = qpMessage(
      'Please disregard the earlier notice. It is not true that =\r\n' +
        'Your flight MP401 has been cancelled.\r\n' +
        'Your booking is unchanged.\r\n',
    );
    await expectCode(
      verifier.verify(submission(sign(raw)), policy()),
      ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
    );
  });

  it('rejects a literal =0A in a part that is not quoted-printable', async () => {
    // Decoding unconditionally would turn one line into two and manufacture
    // the marker. Decoding must follow Content-Transfer-Encoding.
    const raw = MESSAGE.replace(
      'Your flight MP401 has been cancelled.\r\n',
      'You wrote: =0AYour flight MP401 has been cancelled.=0A -- end of quote\r\n',
    );
    await expectCode(
      verifier.verify(submission(sign(raw)), policy()),
      ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
    );
  });

  it('does not read a marker out of an HTML part', async () => {
    // An HTML part renders to text through a transformation this project does
    // not implement; matching against its source would match something no
    // reader ever saw.
    const raw =
      'From: Demo Airline <notifications@demo-airline.example>\r\n' +
      'To: passenger@example.com\r\n' +
      'Subject: Flight update\r\n' +
      'Date: Fri, 07 Aug 2026 12:00:00 +0000\r\n' +
      'Message-ID: <html-only@demo-airline.example>\r\n' +
      'Content-Type: multipart/alternative; boundary="B"\r\n' +
      '\r\n' +
      '--B\r\n' +
      'Content-Type: text/html; charset="UTF-8"\r\n' +
      '\r\n' +
      '<div>Your flight MP401 has been cancelled.</div>\r\n' +
      '--B--\r\n';
    await expectCode(
      verifier.verify(submission(sign(raw)), policy()),
      ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
    );
  });

  it('reads the marker from the plain-text part of a multipart message', async () => {
    const raw =
      'From: Demo Airline <notifications@demo-airline.example>\r\n' +
      'To: passenger@example.com\r\n' +
      'Subject: Flight update\r\n' +
      'Date: Fri, 07 Aug 2026 12:00:00 +0000\r\n' +
      'Message-ID: <multipart-0001@demo-airline.example>\r\n' +
      'Content-Type: multipart/alternative; boundary="B"\r\n' +
      '\r\n' +
      '--B\r\n' +
      'Content-Type: text/plain; charset="UTF-8"\r\n' +
      '\r\n' +
      'Your flight MP401 has been cancelled.\r\n' +
      '--B\r\n' +
      'Content-Type: text/html; charset="UTF-8"\r\n' +
      '\r\n' +
      '<div>Your flight MP401 has been cancelled.</div>\r\n' +
      '--B--\r\n';
    const evidence = await verifier.verify(submission(sign(raw)), policy());
    expect(evidence.claimMarker).toBe('Your flight MP401 has been cancelled.');
  });
});

// ─── Tampering ───────────────────────────────────────────────────────────────

describe('tampered evidence', () => {
  it('rejects a body edit', async () => {
    const tampered = sign().replace('MP-8F2A19', 'MP-999999');
    const error = await expectCode(
      verifier.verify(submission(tampered), policy()),
      ATTESTOR_ERROR.PROOF_INVALID,
    );
    expect(error.detail).toMatch(/body hash/);
  });

  it('rejects a signed-header edit', async () => {
    const tampered = sign().replace('Subject: Your flight MP401', 'Subject: Your flight MP999');
    const error = await expectCode(
      verifier.verify(submission(tampered), policy()),
      ATTESTOR_ERROR.PROOF_INVALID,
    );
    expect(error.detail).toMatch(/signature mismatch/);
  });

  it('rejects an unparseable message', async () => {
    await expectCode(
      verifier.verify(submission('no header separator here'), policy()),
      ATTESTOR_ERROR.PROOF_INVALID,
    );
  });
});

// ─── The Message-ID replay surface ───────────────────────────────────────────

describe('Message-ID handling', () => {
  it('rejects a prepended unsigned Message-ID even when the signature still verifies', async () => {
    // h= covers message-id once, consumed bottom-up — so a second instance at
    // the top leaves the signed block untouched and the signature valid. The
    // instance count is the only thing standing between one signed email and
    // unlimited nullifiers.
    const forged = `Message-ID: <attacker-fresh-id@evil.example>\r\n${sign()}`;
    const error = await expectCode(
      verifier.verify(submission(forged), policy()),
      ATTESTOR_ERROR.PROOF_INVALID,
    );
    expect(error.detail).toMatch(/Message-ID instances/);
  });

  it('oversigning (Gmail style) breaks the signature instead', async () => {
    const oversigned = sign(MESSAGE, {
      signedHeaders: ['from', 'to', 'subject', 'date', 'message-id', 'message-id'],
    });
    expect((await verifier.verify(submission(oversigned), policy())).uniqueClaimId).toBe(
      '<synthetic-0001@demo-airline.example>',
    );

    const forged = `Message-ID: <attacker-fresh-id@evil.example>\r\n${oversigned}`;
    // Both instances get consumed into the signed block now, so the
    // signature itself fails before the count is even consulted.
    await expectCode(verifier.verify(submission(forged), policy()), ATTESTOR_ERROR.PROOF_INVALID);
  });

  it('requires the signature to cover Message-ID', async () => {
    const unsignedId = sign(MESSAGE, { signedHeaders: ['from', 'to', 'subject', 'date'] });
    await expectCode(
      verifier.verify(submission(unsignedId), policy()),
      ATTESTOR_ERROR.PUBLIC_OUTPUT_MISSING,
    );
  });

  it('requires a Message-ID to exist', async () => {
    const withoutId = sign(MESSAGE.replace(/Message-ID:[^\r]*\r\n/, ''));
    await expectCode(
      verifier.verify(submission(withoutId), policy()),
      ATTESTOR_ERROR.PUBLIC_OUTPUT_MISSING,
    );
  });

  it('takes the bottom-most instance, the one §5.4.2 consumes first', async () => {
    // Two instances, both covered by h= — legal, and the only shape where
    // first and last differ while everything still verifies. The bottom-most
    // is the one the origin server wrote; taking the top one would let a
    // relay that prepends its own id change the nullifier.
    const twoIds = MESSAGE.replace(
      'Message-ID: <synthetic-0001@demo-airline.example>\r\n',
      'Message-ID: <relay-added-on-top@relay.example>\r\n' +
        'Message-ID: <origin-bottom-most@demo-airline.example>\r\n',
    );
    const signed = sign(twoIds, {
      signedHeaders: ['from', 'to', 'subject', 'date', 'message-id', 'message-id'],
    });
    const evidence = await verifier.verify(submission(signed), policy());
    expect(evidence.uniqueClaimId).toBe('<origin-bottom-most@demo-airline.example>');
  });
});

// ─── Multiple signatures from one domain ─────────────────────────────────────

describe('several signatures from the issuer domain', () => {
  it('accepts when a later signature verifies (RFC 6376 §6.1)', async () => {
    // A junk signature prepended by a relay — or by anyone who can touch the
    // file — must not be able to deny an otherwise valid message.
    const junk =
      'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=demo-airline.example; ' +
      's=test; h=from:to; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA\r\n';
    const evidence = await verifier.verify(submission(junk + sign()), policy());
    expect(evidence.uniqueClaimId).toBe('<synthetic-0001@demo-airline.example>');
  });

  it('still rejects when none of them verifies', async () => {
    const junk =
      'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=demo-airline.example; ' +
      's=test; h=from:to; bh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=; b=AAAA\r\n';
    const tampered = sign().replace('MP-8F2A19', 'MP-999999');
    await expectCode(
      verifier.verify(submission(junk + tampered), policy()),
      ATTESTOR_ERROR.PROOF_INVALID,
    );
  });

  it('honours a pinned selector', async () => {
    const wrongSelector = sign(MESSAGE, { selector: 'rotated' });
    await expectCode(
      verifier.verify(submission(wrongSelector), policy({ dkim: { dnsRecord: DNS_RECORD, selector: 'test' } })),
      ATTESTOR_ERROR.SENDER_NOT_ALLOWED,
    );
    // And the matching one still passes.
    const evidence = await verifier.verify(
      submission(sign()),
      policy({ dkim: { dnsRecord: DNS_RECORD, selector: 'test' } }),
    );
    expect(evidence.issuerDomain).toBe(ISSUER);
  });
});

// ─── Policy gates ────────────────────────────────────────────────────────────

describe('policy gates', () => {
  it('rejects a message with no signature from the expected issuer', async () => {
    const otherDomain = sign(MESSAGE, { domain: 'unrelated.example' });
    await expectCode(
      verifier.verify(submission(otherDomain), policy()),
      ATTESTOR_ERROR.SENDER_NOT_ALLOWED,
    );
  });

  it('rejects an expired signature', async () => {
    const expired = sign(MESSAGE, { expiry: 1_700_000_000 }); // long past
    const error = await expectCode(
      verifier.verify(submission(expired), policy()),
      ATTESTOR_ERROR.PROOF_INVALID,
    );
    expect(error.detail).toMatch(/expired/);
  });

  it('rejects a body with no line stating the claim', async () => {
    const noMarker = sign(MESSAGE.replace('Your flight MP401 has been cancelled.\r\n', ''));
    await expectCode(
      verifier.verify(submission(noMarker), policy()),
      ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
    );
  });

  it('§41.8: a negated sentence does not satisfy the anchored pattern', async () => {
    const negated = sign(
      MESSAGE.replace(
        'Your flight MP401 has been cancelled.',
        'Your flight MP401 has NOT been cancelled.',
      ),
    );
    await expectCode(
      verifier.verify(submission(negated), policy()),
      ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
    );
  });

  it('refuses a pending blueprint', async () => {
    await expectCode(
      verifier.verify(submission(sign()), policy({ status: 'pending' })),
      ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
    );
  });

  it('refuses a blueprint with no pinned key', async () => {
    await expectCode(
      verifier.verify(submission(sign()), policy({ dkim: undefined })),
      ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
    );
  });

  it('respects l=: a marker past the signed length does not count', async () => {
    // Sign only the first body line; the marker sits beyond it, unsigned.
    const headerLength = 'Hello Ana Demo,\r\n'.length;
    const partial = sign(MESSAGE, { bodyLength: headerLength });
    await expectCode(
      verifier.verify(submission(partial), policy()),
      ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
    );
  });
});

// ─── Through attest(): the full policy pipeline ──────────────────────────────

describe('attest() over a DKIM-direct blueprint', () => {
  const allowlist = parseAllowlist({
    blueprints: [
      {
        key: 'test-dkim',
        status: 'pinned',
        slug: SLUG,
        claimType: 'FLIGHT_CANCELLED',
        issuerDomain: ISSUER,
        campaigns: [CAMPAIGN],
        requiredOutputs: ['cancellationMarker', 'uniqueClaimId'],
        markerOutput: 'cancellationMarker',
        uniqueIdOutput: 'uniqueClaimId',
        markerPattern: MARKER_PATTERN,
        dkim: { dnsRecord: DNS_RECORD },
      },
    ],
  });
  const secretKey = secretKeyFromPassphrase('dkim-test-attestor');
  const subjectBinding = deriveSubjectBinding(new Uint8Array(32).fill(7), new Uint8Array(32).fill(1));

  const attestEml = (raw: string) =>
    attest(
      {
        blueprintSlug: SLUG,
        campaign: CAMPAIGN,
        subjectBindingHash: subjectBinding,
        publicOutputs: 'dkim-direct/v1',
        proofData: raw,
      },
      { verifier, allowlist, secretKey, attestorKeyId: 'test-dkim-v1' },
    );

  it('signs a claim the Schnorr verifier accepts', async () => {
    const signed = await attestEml(sign());
    expect(signed.claim.claimType).toBe(1n);
    expect(
      verify(signed.attestorPublicKey, canonicalClaimHash(signed.claim), signed.signature),
    ).toBe(true);
  });

  it('derives the same nullifier for the same email — replay collides on chain', async () => {
    const raw = sign();
    const [first, second] = [await attestEml(raw), await attestEml(raw)];
    expect(toHex(first.claim.claimNullifier)).toBe(toHex(second.claim.claimNullifier));
  });

  it('derives different nullifiers for different emails', async () => {
    const other = sign(
      MESSAGE.replace('<synthetic-0001@demo-airline.example>', '<synthetic-0002@demo-airline.example>'),
    );
    const [first, second] = [await attestEml(sign()), await attestEml(other)];
    expect(toHex(first.claim.claimNullifier)).not.toBe(toHex(second.claim.claimNullifier));
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

describe('helpers', () => {
  // Transfer-encoding decoding itself is covered in packages/shared/mime.test.ts.

  it('findMarkerLine trims folding whitespace before matching', () => {
    expect(findMarkerLine(['  Your flight MP1 has been cancelled.  \r\n'], MARKER_PATTERN)).toBe(
      'Your flight MP1 has been cancelled.',
    );
    expect(findMarkerLine(['nothing relevant\r\n'], MARKER_PATTERN)).toBeUndefined();
    expect(findMarkerLine([], MARKER_PATTERN)).toBeUndefined();
  });

  it('findMarkerLine searches every reading it is given', () => {
    expect(findMarkerLine(['no', 'Your flight MP1 has been cancelled.'], MARKER_PATTERN)).toBe(
      'Your flight MP1 has been cancelled.',
    );
  });
});

// ─── The real provider-signed fixture, when present ──────────────────────────

const REAL_EMAIL = 'fixtures/private-emails/flight-edu.eml';
const BLUEPRINTS = 'config/blueprints.json';

describe.skipIf(!existsSync(REAL_EMAIL))('the real signed email', () => {
  it('verifies against the pinned production entry', async () => {
    const entry = (
      JSON.parse(readFileSync(BLUEPRINTS, 'utf8')) as {
        blueprints: Array<BlueprintPolicy & { dkim?: { dnsRecord: string } }>;
      }
    ).blueprints.find((b) => b.key === 'flight-cancel-edu-dkim-v1');
    expect(entry?.dkim).toBeTruthy();

    const evidence = await verifier.verify(
      { blueprintSlug: entry!.slug, publicOutputs: 'dkim-direct/v1', proofData: readFileSync(REAL_EMAIL, 'utf8') },
      entry as BlueprintPolicy,
    );
    expect(evidence.issuerDomain).toBe('udesa.edu.ar');
    expect(evidence.claimMarker).toMatch(/^Your flight [A-Z0-9-]+ has been cancelled\.?$/);
    expect(evidence.uniqueClaimId.length).toBeGreaterThan(10);
  });
});
