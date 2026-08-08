/**
 * The SDK, end to end.
 *
 * Real DKIM keys and real signatures; only the chain is stood in for, so what
 * is exercised here is exactly what an integrator's code path does. The fake
 * ledger is a Set, which is also what the real one is.
 */
import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { dkimSign, dnsRecordForPublicKey } from '../shared/dkim-sign.js';
import { createMailProof, type MailProofConfig } from './mailproof.js';
import { RedemptionError, type RedemptionClient, type RedemptionRequest } from './redemption.js';

const NOW = new Date('2026-08-08T12:00:00Z');
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, dnsRecord: dnsRecordForPublicKey(publicKey) };
}

const UDESA = keys();
const CORP = keys();
const EVIL = keys();

/** A ledger that behaves like the real one: insert-only, collision-detecting. */
function fakeChain(): RedemptionClient & { spent: Set<string>; calls: RedemptionRequest[] } {
  const spent = new Set<string>();
  const calls: RedemptionRequest[] = [];
  return {
    spent,
    calls,
    async redeem(request) {
      calls.push(request);
      const nullifier = toHex(request.identity);
      const already = spent.has(nullifier);
      spent.add(nullifier);
      return {
        outcome: already ? 'already-claimed' : 'redeemed',
        nullifier,
        contractAddress: 'c0ffee',
        campaign: request.campaign,
        ...(already ? {} : { txId: `tx-${spent.size}` }),
      };
    },
  };
}

function build(over: Partial<MailProofConfig<'STUDENT' | 'CORPORATE'>> = {}) {
  const redemption = over.redemption ?? fakeChain();
  const sdk = createMailProof<'STUDENT' | 'CORPORATE'>({
    audience: 'lain',
    challengeSecret: new Uint8Array(32).fill(1),
    blindingKey: new Uint8Array(32).fill(2),
    campaign: 'lain-2026-s1',
    tiers: [
      { id: 'STUDENT', suffixes: ['.edu.ar'] },
      { id: 'CORPORATE', notFreeProvider: true },
    ],
    domainKeys: [
      { domain: 'udesa.edu.ar', dnsRecord: UDESA.dnsRecord },
      { domain: 'mercadolibre.com', dnsRecord: CORP.dnsRecord },
    ],
    redemption,
    ...over,
  });
  return { sdk, redemption: redemption as ReturnType<typeof fakeChain> };
}

/** A message the claimant sent themselves, carrying the code they were given. */
function selfSent(code: string, from: string, signer = UDESA, domain = 'udesa.edu.ar') {
  return dkimSign(
    [
      `From: ${from}`,
      `To: ${from}`,
      'Subject: Verificacion MailProof',
      'Message-ID: <a@udesa.edu.ar>',
      'Date: Sat, 8 Aug 2026 09:00:00 -0300',
      '',
      `Verificando.\r\n\r\n${code}\r\n`,
      '',
    ].join('\r\n'),
    {
      domain,
      selector: 'test',
      privateKey: signer.privateKey,
      timestamp: Math.floor((NOW.getTime() - 60_000) / 1000),
    },
  );
}

// ─── The flow an integrator writes ───────────────────────────────────────────

describe('the whole flow', () => {
  it('mints a code, grants a tier, and never mentions the address', async () => {
    const { sdk } = build();
    const start = sdk.startVerification(NOW);
    expect(start.instructions).toContain(start.code);

    const result = await sdk.verify(selfSent(start.code, 'Ana <ana@udesa.edu.ar>'), NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tier).toBe('STUDENT');
    expect(result.alreadyClaimed).toBe(false);
    expect(result.txId).toBeDefined();
    expect(result.identityHandle).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.identityHandle).not.toBe(result.handle);
    expect(result.identityKeyId).toHaveLength(16);

    // The address must not appear anywhere in what the integrator receives.
    expect(JSON.stringify(result)).not.toContain('ana');
    expect(JSON.stringify(result)).not.toContain('udesa');
  });

  it('says which domain only when asked to', async () => {
    const withDomain = build({ reveal: 'domain' });
    const start = withDomain.sdk.startVerification(NOW);
    const result = await withDomain.sdk.verify(selfSent(start.code, 'ana@udesa.edu.ar'), NOW);
    expect(result.ok && result.domain).toBe('udesa.edu.ar');
  });

  it('grants the corporate tier from a corporate domain', async () => {
    const { sdk } = build();
    const start = sdk.startVerification(NOW);
    const raw = selfSent(start.code, 'ana@mercadolibre.com', CORP, 'mercadolibre.com');
    const result = await sdk.verify(raw, NOW);
    expect(result.ok && result.tier).toBe('CORPORATE');
  });
});

// ─── One per person ──────────────────────────────────────────────────────────

describe('one benefit per mailbox', () => {
  it('the second attempt is a result, not an exception', async () => {
    const { sdk } = build();
    const first = await sdk.verify(
      selfSent(sdk.startVerification(NOW).code, 'ana@udesa.edu.ar'),
      NOW,
    );
    const second = await sdk.verify(
      selfSent(sdk.startVerification(NOW).code, 'ana@udesa.edu.ar'),
      NOW,
    );

    expect(first.ok && first.alreadyClaimed).toBe(false);
    expect(second.ok && second.alreadyClaimed).toBe(true);
    expect(second.ok && second.tier).toBe('STUDENT');
    expect(first.ok && second.ok && first.identityHandle).toBe(
      second.ok ? second.identityHandle : undefined,
    );
  });

  it('four spellings of one mailbox are one person', async () => {
    const { sdk, redemption } = build();
    for (const from of [
      'ana@udesa.edu.ar',
      'Ana@UDESA.edu.ar',
      'ana+lain@udesa.edu.ar',
      '"boss@harvard.edu" <ana@udesa.edu.ar>',
    ]) {
      await sdk.verify(selfSent(sdk.startVerification(NOW).code, from), NOW);
    }
    expect(redemption.spent.size).toBe(1);
  });

  it('two different people are two claims', async () => {
    const { sdk, redemption } = build();
    await sdk.verify(selfSent(sdk.startVerification(NOW).code, 'ana@udesa.edu.ar'), NOW);
    await sdk.verify(selfSent(sdk.startVerification(NOW).code, 'bruno@udesa.edu.ar'), NOW);
    expect(redemption.spent.size).toBe(2);
  });

  it('what reaches the chain is blinded, not the mailbox', async () => {
    const { sdk, redemption } = build();
    await sdk.verify(selfSent(sdk.startVerification(NOW).code, 'ana@udesa.edu.ar'), NOW);
    const sent = toHex(redemption.calls[0]!.identity);
    expect(sent).toHaveLength(64);
    expect(Buffer.from(sent, 'hex').toString('utf8')).not.toContain('ana');
  });
});

// ─── Refusals ────────────────────────────────────────────────────────────────

describe('refusals are values, not throws', () => {
  const reasonOf = async (raw: string, over = {}) => {
    const { sdk } = build(over);
    const result = await sdk.verify(raw, NOW);
    return result.ok ? 'ok' : result.reason;
  };

  it('a domain nobody pinned a key for', async () => {
    const start = build().sdk.startVerification(NOW);
    const raw = selfSent(start.code, 'ana@otra.edu.ar', EVIL, 'otra.edu.ar');
    expect(await reasonOf(raw)).toBe('SIGNATURE_INVALID');
  });

  it('a domain that matches no tier', async () => {
    const { sdk } = build({
      tiers: [{ id: 'STUDENT', domains: ['uba.ar'] }],
    });
    const raw = selfSent(sdk.startVerification(NOW).code, 'ana@udesa.edu.ar');
    const result = await sdk.verify(raw, NOW);
    expect(result.ok ? 'ok' : result.reason).toBe('NO_TIER');
  });

  it('a message with no code', async () => {
    expect(await reasonOf(selfSent('sin-codigo', 'ana@udesa.edu.ar'))).toBe('CHALLENGE_MISSING');
  });

  it('a code from another integrator', async () => {
    const other = build({ audience: 'otro-sitio' });
    const raw = selfSent(other.sdk.startVerification(NOW).code, 'ana@udesa.edu.ar');
    expect(await reasonOf(raw)).toBe('CHALLENGE_INVALID');
  });

  it('a chain that cannot be reached', async () => {
    const broken: RedemptionClient = {
      async redeem() {
        throw new RedemptionError('daemon is down', 'UNREACHABLE');
      },
    };
    const { sdk } = build({ redemption: broken });
    const raw = selfSent(sdk.startVerification(NOW).code, 'ana@udesa.edu.ar');
    const result = await sdk.verify(raw, NOW);
    expect(result.ok ? 'ok' : result.reason).toBe('REDEMPTION_FAILED');
    // And it says so, rather than reporting the person as unqualified.
    expect(result.ok ? '' : result.detail).toMatch(/daemon is down/);
  });
});

// ─── Disclosure ──────────────────────────────────────────────────────────────

describe('trust is stated, not buried', () => {
  it('every success says what read the email and which key blinded it', async () => {
    const { sdk } = build();
    const result = await sdk.verify(
      selfSent(sdk.startVerification(NOW).code, 'ana@udesa.edu.ar'),
      NOW,
    );
    expect(result.ok && result.trust).toEqual({
      emailReadBy: 'attestor',
      cryptographic: true,
      blindingKeyId: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it('lists the domains this configuration can actually verify', () => {
    const { sdk } = build({
      tiers: [{ id: 'STUDENT', domains: ['udesa.edu.ar', 'sin-clave.edu.ar'] }],
    });
    expect(sdk.verifiableDomains()).toEqual(['udesa.edu.ar']);
  });
});
