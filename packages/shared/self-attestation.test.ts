/**
 * Proving control of a mailbox.
 *
 * Signed hermetically with throwaway keys, one per domain, so every case can
 * vary exactly one thing. The attacks come first, because they are the reason
 * the module is shaped the way it is.
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { issueChallenge } from './challenge.js';
import { dkimSign, dnsRecordForPublicKey } from './dkim-sign.js';
import { SelfAttestationError, verifySelfAttestation } from './self-attestation.js';

const NOW = new Date('2026-08-08T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET = new Uint8Array(32).fill(7);

function keysFor() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, dnsRecord: dnsRecordForPublicKey(publicKey) };
}

const UDESA = keysFor();
const EVIL = keysFor();

const CODE = issueChallenge({ secret: SECRET, audience: 'lain', now: NOW }).code;

interface MessageOptions {
  from?: string;
  to?: string;
  body?: string;
  subject?: string;
  signedHeaders?: readonly string[];
  ageMs?: number;
  keys?: { privateKey: ReturnType<typeof keysFor>['privateKey']; dnsRecord: string };
  domain?: string;
  extraHeaders?: readonly string[];
}

function message(options: MessageOptions = {}): string {
  const raw = [
    ...(options.extraHeaders ?? []),
    `From: ${options.from ?? 'Ana <ana@udesa.edu.ar>'}`,
    `To: ${options.to ?? 'ana@udesa.edu.ar'}`,
    `Subject: ${options.subject ?? 'MailProof'}`,
    'Message-ID: <one@udesa.edu.ar>',
    'Date: Sat, 8 Aug 2026 09:00:00 -0300',
    '',
    options.body ?? `Verificando mi casilla.\r\n\r\n${CODE}\r\n`,
    '',
  ].join('\r\n');

  return dkimSign(raw, {
    domain: options.domain ?? 'udesa.edu.ar',
    selector: 'test',
    privateKey: (options.keys ?? UDESA).privateKey,
    signedHeaders: options.signedHeaders ?? ['from', 'to', 'subject', 'date', 'message-id'],
    timestamp: Math.floor((NOW.getTime() - (options.ageMs ?? 60_000)) / 1000),
  });
}

const verify = (raw: string, over: Partial<Parameters<typeof verifySelfAttestation>[1]> = {}) =>
  verifySelfAttestation(raw, {
    dnsRecord: UDESA.dnsRecord,
    challengeSecret: SECRET,
    audience: 'lain',
    maxAgeMs: DAY_MS,
    now: NOW,
    ...over,
  });

const failure = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof SelfAttestationError) return error.failure;
    throw error;
  }
  throw new Error('expected a SelfAttestationError, got success');
};

// ─── The attacks ─────────────────────────────────────────────────────────────

describe('the attacks it exists to stop', () => {
  it('a domain cannot vouch for a mailbox at another domain', () => {
    // evil.com holds a valid key and signs From: ana@udesa.edu.ar. Without
    // alignment this mints Ana's slot, permanently, for free.
    const forged = message({ domain: 'evil.com', keys: EVIL });
    expect(failure(() => verify(forged, { dnsRecord: EVIL.dnsRecord }))).toBe(
      'DOMAIN_NOT_ALIGNED',
    );
  });

  it('a message with no challenge code is not evidence', () => {
    // Otherwise any autoresponder or list confirmation from the domain counts.
    expect(failure(() => verify(message({ body: 'sin codigo' })))).toBe('CHALLENGE_MISSING');
  });

  it('a code minted for another site does not carry over', () => {
    const otherSite = issueChallenge({ secret: SECRET, audience: 'otro', now: NOW }).code;
    expect(failure(() => verify(message({ body: otherSite })))).toBe('CHALLENGE_INVALID');
  });

  it('an old message is refused however valid its signature', () => {
    expect(failure(() => verify(message({ ageMs: 8 * DAY_MS })))).toBe('SIGNATURE_STALE');
  });

  it('an unsigned From prepended above the signed one is refused', () => {
    // The signature covered one From; the message now has two, so the one a
    // naive reader takes first is not the one the domain attested.
    const raw = message({ extraHeaders: ['From: Attacker <evil@udesa.edu.ar>'] });
    expect(failure(() => verify(raw))).toBe('FROM_NOT_SIGNED');
  });

  it('a signature that does not cover From at all is refused', () => {
    const raw = message({ signedHeaders: ['to', 'subject', 'date', 'message-id'] });
    expect(failure(() => verify(raw))).toBe('FROM_NOT_SIGNED');
  });

  it('a From naming two mailboxes is refused rather than resolved', () => {
    const raw = message({ from: 'ana@udesa.edu.ar, evil@udesa.edu.ar' });
    expect(failure(() => verify(raw))).toBe('FROM_UNPARSEABLE');
  });

  it('a display name that looks like an address does not become one', () => {
    const raw = message({ from: '"boss@udesa.edu.ar" <ana@udesa.edu.ar>' });
    expect(verify(raw).mailbox).toBe('ana@udesa.edu.ar');
  });

  it('a tampered body loses the signature, not just the code', () => {
    const raw = message().replace('Verificando', 'Manipulado');
    expect(failure(() => verify(raw))).toBe('SIGNATURE_INVALID');
  });
});

// ─── The happy path ──────────────────────────────────────────────────────────

describe('a message the claimant sent themselves', () => {
  it('proves the mailbox, its domain, and which key vouched', () => {
    const attestation = verify(message());
    expect(attestation.mailbox).toBe('ana@udesa.edu.ar');
    expect(attestation.domain).toBe('udesa.edu.ar');
    expect(attestation.signingDomain).toBe('udesa.edu.ar');
    expect(attestation.code).toBe(CODE);
    expect(attestation.ageSeconds).toBeCloseTo(60, 0);
  });

  it('accepts a code in the subject as readily as in the body', () => {
    const attestation = verify(message({ subject: `Verificacion ${CODE}`, body: 'hola' }));
    expect(attestation.code).toBe(CODE);
  });

  it('accepts a subdomain signer, since that is what alignment means', () => {
    const raw = message({ from: 'ana@mail.udesa.edu.ar', to: 'ana@mail.udesa.edu.ar' });
    expect(verify(raw).domain).toBe('mail.udesa.edu.ar');
  });

  it('folds address spellings so one person is one mailbox', () => {
    const tagged = message({ from: 'Ana <Ana+lain@UDESA.edu.ar>' });
    expect(verify(tagged).mailbox).toBe('ana@udesa.edu.ar');
  });

  it('ignores who the message was addressed to', () => {
    // The recipient is whatever the sender typed, so it must not matter.
    expect(verify(message({ to: 'anyone@example.com' })).mailbox).toBe('ana@udesa.edu.ar');
  });
});

// ─── Domain policy ───────────────────────────────────────────────────────────

describe('allowedDomains', () => {
  it('accepts a listed domain and its subdomains', () => {
    expect(verify(message(), { allowedDomains: ['udesa.edu.ar'] }).domain).toBe('udesa.edu.ar');
  });

  it('refuses one that is not listed', () => {
    expect(failure(() => verify(message(), { allowedDomains: ['uba.ar'] }))).toBe(
      'DOMAIN_NOT_ALLOWED',
    );
  });

  it('is not fooled by a domain that merely ends the same way', () => {
    const raw = message({ domain: 'notudesa.edu.ar', from: 'ana@notudesa.edu.ar', keys: EVIL });
    expect(
      failure(() =>
        verify(raw, { dnsRecord: EVIL.dnsRecord, allowedDomains: ['udesa.edu.ar'] }),
      ),
    ).toBe('DOMAIN_NOT_ALLOWED');
  });
});

describe('reporting', () => {
  it('names the furthest failure, not the first', () => {
    // A message that fails only on freshness must not come back as "no
    // signature" — the operator would go looking for the wrong problem.
    expect(failure(() => verify(message({ ageMs: 8 * DAY_MS })))).toBe('SIGNATURE_STALE');
  });

  it('says plainly when there is no signature at all', () => {
    const unsigned = 'From: ana@udesa.edu.ar\r\nSubject: x\r\n\r\nbody\r\n';
    expect(failure(() => verify(unsigned))).toBe('NO_SIGNATURE');
  });
});
