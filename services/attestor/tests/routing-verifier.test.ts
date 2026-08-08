/**
 * Routing between the two real verifiers.
 *
 * Small enough to look self-evident, which is exactly why it needs tests:
 * inverting the ternary sends every DKIM-direct submission to a ZK Email
 * verifier that will never accept it, and — worse — sends the raw email to
 * the service whose entire purpose is never to see one.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseAllowlist, type BlueprintPolicy } from '../src/allowlist.js';
import { RoutingProofVerifier } from '../src/routing-verifier.js';
import type { ProofSubmission, ProofVerifier, VerifiedEvidence } from '../src/verifier.js';

const EVIDENCE: VerifiedEvidence = {
  issuerDomain: 'example.test',
  claimMarker: 'marker',
  uniqueClaimId: 'id',
};

class Spy implements ProofVerifier {
  calls = 0;
  constructor(
    readonly name: string,
    readonly isCryptographic = true,
  ) {}
  async verify(_s: ProofSubmission, _p: BlueprintPolicy): Promise<VerifiedEvidence> {
    this.calls += 1;
    return { ...EVIDENCE, claimMarker: this.name };
  }
}

const BASE = {
  key: 'k',
  status: 'pinned' as const,
  claimType: 'FLIGHT_CANCELLED' as const,
  issuerDomain: 'example.test',
  campaigns: ['c'],
  proves: 'claim-in-body' as const,
  requiredOutputs: ['cancellationMarker', 'uniqueClaimId'],
  markerOutput: 'cancellationMarker',
  uniqueIdOutput: 'uniqueClaimId',
  markerPattern: '^marker$',
};

const withDkim: BlueprintPolicy = {
  ...BASE,
  slug: 'a/WithDkim@v1',
  dkim: { dnsRecord: 'v=DKIM1; k=rsa; p=AAAA' },
};
const withoutDkim: BlueprintPolicy = { ...BASE, slug: 'a/WithoutDkim@v1' };

const submission: ProofSubmission = {
  blueprintSlug: 'a/WithDkim@v1',
  publicOutputs: 'x',
  proofData: 'y',
};

function routing() {
  const dkim = new Spy('dkim');
  const zk = new Spy('zk-email');
  return { dkim, zk, verifier: new RoutingProofVerifier(dkim, zk) };
}

describe('RoutingProofVerifier', () => {
  it('sends a blueprint with a pinned DKIM key to the DKIM verifier', async () => {
    const { dkim, zk, verifier } = routing();
    const evidence = await verifier.verify(submission, withDkim);
    expect(evidence.claimMarker).toBe('dkim');
    expect([dkim.calls, zk.calls]).toEqual([1, 0]);
  });

  it('sends a blueprint without one to the ZK Email verifier', async () => {
    const { dkim, zk, verifier } = routing();
    const evidence = await verifier.verify(submission, withoutDkim);
    expect(evidence.claimMarker).toBe('zk-email');
    expect([dkim.calls, zk.calls]).toEqual([0, 1]);
  });

  it('never routes to a non-cryptographic verifier without saying so', () => {
    // The startup guard in server.ts trusts isCryptographic to refuse a fake
    // verifier. Hardcoding it true would disarm that guard, so it must be
    // derived from what is actually behind the router.
    const honest = new RoutingProofVerifier(new Spy('dkim'), new Spy('zk'));
    expect(honest.isCryptographic).toBe(true);

    const fake = new RoutingProofVerifier(new Spy('fixture', false), new Spy('zk'));
    expect(fake.isCryptographic).toBe(false);
  });

  it('names both routes so /health cannot hide one', () => {
    const { verifier } = routing();
    expect(verifier.name).toContain('dkim');
    expect(verifier.name).toContain('zk-email');
  });
});

describe('the shipped allowlist', () => {
  const file = JSON.parse(readFileSync('config/blueprints.json', 'utf8'));

  it('parses', () => {
    expect(() => parseAllowlist(file)).not.toThrow();
  });

  it('has at least one pinned blueprint, so demo:reset has something to pick', () => {
    const pinned = file.blueprints.filter((b: { status: string }) => b.status === 'pinned');
    expect(pinned.length).toBeGreaterThan(0);
  });

  it('pins a selector alongside every pinned DKIM key', () => {
    // Without the selector, a signature from the same domain under a rotated
    // key is checked against the wrong key and reported as tampering.
    for (const entry of file.blueprints) {
      if (entry.dkim) expect(entry.dkim.selector, `${entry.key} pins no selector`).toBeTruthy();
    }
  });
});
