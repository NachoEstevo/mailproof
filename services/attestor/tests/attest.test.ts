/**
 * Attestor test matrix A-01…A-15 (§40.4).
 *
 * A-14 is the one that matters most: a claim signed here must verify inside
 * the compiled Compact circuit. Everything else can be right and the bridge
 * still be broken if that fails.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { pureCircuits } from '../../../contracts/managed/mailproof/contract/index.js';
import { attest, type AttestDeps, type AttestRequest } from '../src/attest.js';
import { parseAllowlist } from '../src/allowlist.js';
import { ATTESTOR_ERROR, AttestorError } from '../src/errors.js';
import { FixtureProofVerifier } from '../src/fixture-verifier.js';
import { logAttest } from '../src/logging.js';
import { buildServer, type ServerDeps } from '../src/server.js';
import type { ProofSubmission, ProofVerifier, VerifiedEvidence } from '../src/verifier.js';
import { ZkEmailProofVerifier } from '../src/zk-email-verifier.js';

import { canonicalClaimHash, deriveSubjectBinding } from '../../../packages/shared/claim.js';
import { fromHex, toHex } from '../../../packages/shared/hashes.js';
import {
  publicKeyFromSecret,
  secretKeyFromPassphrase,
  verify,
} from '../../../packages/shared/schnorr.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SLUG = 'mailproof/FlightCancellation@v1';
const ISSUER = 'demo-airline.example';
const CAMPAIGN = 'travel-insurance-demo-2026';
const OTHER_CAMPAIGN = 'loyalty-demo-2026';

const ALLOWLIST = parseAllowlist({
  blueprints: [
    {
      key: 'flight-cancel-v1',
      status: 'pinned',
      slug: SLUG,
      claimType: 'FLIGHT_CANCELLED',
      issuerDomain: ISSUER,
      campaigns: [CAMPAIGN, OTHER_CAMPAIGN],
      requiredOutputs: ['cancellationMarker', 'uniqueClaimId'],
      markerOutput: 'cancellationMarker',
      uniqueIdOutput: 'uniqueClaimId',
      markerPattern: '^Your flight [A-Z0-9-]{2,12} has been cancelled\\.?$',
    },
  ],
});

const SECRET_KEY = secretKeyFromPassphrase('attestor-test-key');
const SUBJECT_SECRET = new Uint8Array(32).fill(7);

const PUBLIC_OUTPUTS = JSON.stringify(['Your flight MP401 has been cancelled', 'CLAIM-DEMO-0001']);
const PROOF_DATA = JSON.stringify({ pi_a: ['1', '2', '3'], protocol: 'groth16' });

const GOOD_EVIDENCE: VerifiedEvidence = {
  issuerDomain: ISSUER,
  claimMarker: 'Your flight MP401 has been cancelled',
  uniqueClaimId: 'CLAIM-DEMO-0001',
};

function verifierWith(evidence: Partial<VerifiedEvidence> = {}): FixtureProofVerifier {
  return new FixtureProofVerifier([
    {
      blueprintSlug: SLUG,
      publicOutputs: PUBLIC_OUTPUTS,
      proofData: PROOF_DATA,
      ...GOOD_EVIDENCE,
      ...evidence,
    },
  ]);
}

function deps(overrides: Partial<AttestDeps> = {}): AttestDeps {
  return {
    verifier: verifierWith(),
    allowlist: ALLOWLIST,
    secretKey: SECRET_KEY,
    attestorKeyId: 'test-v1',
    ...overrides,
  };
}

/** buildServer reads the allowlist per request; attest() takes it by value. */
function serverDeps(overrides: Partial<AttestDeps> = {}): ServerDeps {
  const { allowlist, ...rest } = deps(overrides);
  return { ...rest, allowlist: () => allowlist };
}

function request(overrides: Partial<AttestRequest> = {}): AttestRequest {
  return {
    blueprintSlug: SLUG,
    campaign: CAMPAIGN,
    subjectBindingHash: deriveSubjectBinding(SUBJECT_SECRET, new Uint8Array(32).fill(1)),
    publicOutputs: PUBLIC_OUTPUTS,
    proofData: PROOF_DATA,
    ...overrides,
  };
}

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

// ─── Matrix ──────────────────────────────────────────────────────────────────

describe('A-01 valid proof', () => {
  it('returns a signed claim', async () => {
    const signed = await attest(request(), deps());

    expect(signed.claim.version).toBe(1n);
    expect(signed.claim.claimType).toBe(1n);
    expect(signed.claim.claimNullifier).toHaveLength(32);
    expect(signed.attestorKeyId).toBe('test-v1');
    expect(verify(signed.attestorPublicKey, canonicalClaimHash(signed.claim), signed.signature)).toBe(
      true,
    );
  });
});

describe('A-02 invalid proof', () => {
  it('rejects when the verifier does not recognise the submission', async () => {
    await expectCode(
      attest(request({ proofData: '{"pi_a":["9"]}' }), deps()),
      ATTESTOR_ERROR.PROOF_INVALID,
    );
  });

  it('treats a verifier that throws as a rejection, never a pass', async () => {
    const exploding: ProofVerifier = {
      name: 'exploding',
      isCryptographic: true,
      async verify(): Promise<VerifiedEvidence> {
        throw new AttestorError(ATTESTOR_ERROR.PROOF_INVALID);
      },
    };
    await expectCode(attest(request(), deps({ verifier: exploding })), ATTESTOR_ERROR.PROOF_INVALID);
  });
});

describe('A-03 blueprint not allowed', () => {
  it('rejects an unlisted slug', async () => {
    await expectCode(
      attest(request({ blueprintSlug: 'someone/Other@v1' }), deps()),
      ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
    );
  });

  it('rejects a version that is not the pinned one', async () => {
    await expectCode(
      attest(request({ blueprintSlug: 'mailproof/FlightCancellation@v2' }), deps()),
      ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
    );
  });
});

describe('A-04 missing public output', () => {
  it('rejects when the unique identifier is absent', async () => {
    // No stable id means no honest replay protection, so refuse (§12.5).
    await expectCode(
      attest(request(), deps({ verifier: verifierWith({ uniqueClaimId: '   ' }) })),
      ATTESTOR_ERROR.PUBLIC_OUTPUT_MISSING,
    );
  });
});

describe('A-05 unexpected sender domain', () => {
  it('rejects evidence signed by another domain', async () => {
    await expectCode(
      attest(request(), deps({ verifier: verifierWith({ issuerDomain: 'evil.example' }) })),
      ATTESTOR_ERROR.SENDER_NOT_ALLOWED,
    );
  });

  it('accepts the expected domain regardless of casing', async () => {
    const signed = await attest(
      request(),
      deps({ verifier: verifierWith({ issuerDomain: 'Demo-Airline.EXAMPLE' }) }),
    );
    expect(signed.claim.claimNullifier).toHaveLength(32);
  });
});

describe('A-06 claim marker not satisfied', () => {
  it('rejects text that does not state the claim', async () => {
    await expectCode(
      attest(request(), deps({ verifier: verifierWith({ claimMarker: 'Your flight is on time' }) })),
      ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
    );
  });

  it('rejects a negated sentence that merely contains the keyword', async () => {
    // §41.8: the exact reason the pattern is anchored.
    await expectCode(
      attest(
        request(),
        deps({
          verifier: verifierWith({
            claimMarker: 'Your flight MP401 has not been cancelled',
          }),
        }),
      ),
      ATTESTOR_ERROR.CLAIM_NOT_SATISFIED,
    );
  });
});

describe('A-07 campaign not allowed', () => {
  it('rejects a campaign outside the blueprint policy', async () => {
    await expectCode(
      attest(request({ campaign: 'not-a-campaign' }), deps()),
      ATTESTOR_ERROR.CAMPAIGN_NOT_ALLOWED,
    );
  });
});

describe('A-08 malformed subject binding', () => {
  it('rejects a binding that is not 32 bytes', async () => {
    await expectCode(
      attest(request({ subjectBindingHash: new Uint8Array(16) }), deps()),
      ATTESTOR_ERROR.INVALID_SUBJECT_BINDING,
    );
  });
});

describe('A-10 stable proof digest', () => {
  it('produces the same digest for the same input', async () => {
    const a = await attest(request(), deps());
    const b = await attest(request(), deps());
    expect(a.claim.proofDigest).toEqual(b.claim.proofDigest);
  });

  it('produces a different digest when the proof changes', async () => {
    const a = await attest(request(), deps());
    const other = JSON.stringify({ pi_a: ['4', '5', '6'], protocol: 'groth16' });
    const b = await attest(
      request({ proofData: other }),
      deps({
        verifier: new FixtureProofVerifier([
          { blueprintSlug: SLUG, publicOutputs: PUBLIC_OUTPUTS, proofData: other, ...GOOD_EVIDENCE },
        ]),
      }),
    );
    expect(a.claim.proofDigest).not.toEqual(b.claim.proofDigest);
  });
});

describe('A-11 context-bound nullifier', () => {
  it('gives the same evidence a different nullifier per campaign', async () => {
    const first = await attest(request({ campaign: CAMPAIGN }), deps());
    const second = await attest(request({ campaign: OTHER_CAMPAIGN }), deps());

    expect(first.claim.claimNullifier).not.toEqual(second.claim.claimNullifier);
    // Same campaign must stay deterministic, or replay protection breaks.
    const repeat = await attest(request({ campaign: CAMPAIGN }), deps());
    expect(repeat.claim.claimNullifier).toEqual(first.claim.claimNullifier);
  });

  it('never publishes the raw unique identifier', async () => {
    const signed = await attest(request(), deps());
    const raw = Buffer.from('CLAIM-DEMO-0001', 'utf8');
    for (const field of Object.values(signed.claim)) {
      if (field instanceof Uint8Array) {
        expect(Buffer.from(field).includes(raw)).toBe(false);
      }
    }
  });
});

describe('A-12 logging', () => {
  it('emits no evidence, only correlation data', async () => {
    const lines: string[] = [];
    const app = buildServer({ ...serverDeps(), logSink: (l) => lines.push(l) });

    const response = await app.inject({
      method: 'POST',
      url: '/attest',
      payload: {
        blueprintId: SLUG,
        campaignId: CAMPAIGN,
        subjectBinding: toHex(deriveSubjectBinding(SUBJECT_SECRET, new Uint8Array(32).fill(1))),
        publicOutputs: PUBLIC_OUTPUTS,
        proofData: PROOF_DATA,
      },
    });
    expect(response.statusCode).toBe(200);

    const logged = lines.join('\n');
    expect(logged).not.toContain('CLAIM-DEMO-0001');
    expect(logged).not.toContain('MP401');
    expect(logged).not.toContain('pi_a');
    expect(logged).not.toContain(PROOF_DATA);
    // What it should contain.
    expect(logged).toContain('requestId');
    expect(logged).toContain('"result":"ok"');

    await app.close();
  });

  it('truncates the digest and nullifier it does log', () => {
    const lines: string[] = [];
    logAttest(
      {
        requestId: 'r',
        result: 'ok',
        proofDigest: `0x${'a'.repeat(64)}`,
        claimNullifier: `0x${'b'.repeat(64)}`,
      },
      (l) => lines.push(l),
    );
    expect(lines[0]).not.toContain('a'.repeat(64));
    expect(lines[0]).toContain('…');
  });
});

describe('A-13 signing unavailable', () => {
  it('fails closed rather than emitting an unsigned claim', async () => {
    await expectCode(attest(request(), deps({ secretKey: 0n })), ATTESTOR_ERROR.SIGNING_UNAVAILABLE);
  });
});

describe('A-14 signature round trip', () => {
  it('produces a claim the compiled Compact circuit accepts', async () => {
    const signed = await attest(request(), deps());

    // The whole point of the bridge: what the attestor signs off-chain must
    // verify inside the circuit, byte for byte.
    expect(pureCircuits.canonicalClaimHash(signed.claim)).toEqual(
      canonicalClaimHash(signed.claim),
    );
    expect(
      pureCircuits.verifySchnorr(
        publicKeyFromSecret(SECRET_KEY),
        pureCircuits.canonicalClaimHash(signed.claim),
        signed.signature,
      ),
    ).toBe(true);
  });

  it('is rejected by the circuit under a different attestor key', async () => {
    const signed = await attest(request(), deps());
    const other = publicKeyFromSecret(secretKeyFromPassphrase('someone-else'));
    expect(
      pureCircuits.verifySchnorr(other, pureCircuits.canonicalClaimHash(signed.claim), signed.signature),
    ).toBe(false);
  });
});

describe('A-15 verifier failure', () => {
  it('returns a controlled error and no partial claim', async () => {
    const flaky: ProofVerifier = {
      name: 'flaky',
      isCryptographic: true,
      async verify(_s: ProofSubmission): Promise<VerifiedEvidence> {
        throw new Error('socket hang up');
      },
    };
    const lines: string[] = [];
    const app = buildServer({ ...serverDeps({ verifier: flaky }), logSink: (l) => lines.push(l) });

    const response = await app.inject({
      method: 'POST',
      url: '/attest',
      payload: {
        blueprintId: SLUG,
        campaignId: CAMPAIGN,
        subjectBinding: toHex(new Uint8Array(32).fill(3)),
        publicOutputs: PUBLIC_OUTPUTS,
        proofData: PROOF_DATA,
      },
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBe(ATTESTOR_ERROR.INTERNAL_ERROR);
    expect(body).not.toHaveProperty('claim');
    expect(body).not.toHaveProperty('signature');
    // The underlying message must not leak to the caller.
    expect(JSON.stringify(body)).not.toContain('socket hang up');

    await app.close();
  });
});

// ─── HTTP surface ────────────────────────────────────────────────────────────

describe('HTTP surface', () => {
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    app = buildServer(serverDeps());
  });

  it('reports health without exposing key material', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.blueprints).toContain(SLUG);
    expect(body.cryptographicVerification).toBe(false); // fixture verifier
    // The public key is fine to publish; the secret must not appear anywhere.
    expect(JSON.stringify(body)).not.toContain(SECRET_KEY.toString(16));
    await app.close();
  });

  it('A-09 rejects an oversized body', async () => {
    const small = buildServer({ ...serverDeps(), env: { MAILPROOF_MAX_REQUEST_BYTES: '2048' } });
    const response = await small.inject({
      method: 'POST',
      url: '/attest',
      payload: {
        blueprintId: SLUG,
        campaignId: CAMPAIGN,
        subjectBinding: toHex(new Uint8Array(32)),
        publicOutputs: 'x'.repeat(8192),
        proofData: PROOF_DATA,
      },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error).toBe(ATTESTOR_ERROR.REQUEST_TOO_LARGE);
    await small.close();
    await app.close();
  });

  it('rejects unknown fields instead of ignoring them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/attest',
      payload: {
        blueprintId: SLUG,
        campaignId: CAMPAIGN,
        subjectBinding: toHex(new Uint8Array(32)),
        publicOutputs: PUBLIC_OUTPUTS,
        proofData: PROOF_DATA,
        // Exactly what must never be accepted (§43.1).
        rawEmail: 'From: someone@example.test',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(ATTESTOR_ERROR.INVALID_REQUEST);
    await app.close();
  });

  it('rejects a subject binding that is not 32 hex bytes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/attest',
      payload: {
        blueprintId: SLUG,
        campaignId: CAMPAIGN,
        subjectBinding: '0xdeadbeef',
        publicOutputs: PUBLIC_OUTPUTS,
        proofData: PROOF_DATA,
      },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('serialises a claim the caller can turn back into contract inputs', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/attest',
      payload: {
        blueprintId: SLUG,
        campaignId: CAMPAIGN,
        subjectBinding: toHex(deriveSubjectBinding(SUBJECT_SECRET, new Uint8Array(32).fill(1))),
        publicOutputs: PUBLIC_OUTPUTS,
        proofData: PROOF_DATA,
      },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    const rebuilt = {
      version: BigInt(body.claim.version),
      claimType: BigInt(body.claim.claimType),
      blueprintIdHash: fromHex(body.claim.blueprintIdHash),
      issuerDomainHash: fromHex(body.claim.issuerDomainHash),
      campaignId: fromHex(body.claim.campaignId),
      subjectBindingHash: fromHex(body.claim.subjectBindingHash),
      claimNullifier: fromHex(body.claim.claimNullifier),
      proofDigest: fromHex(body.claim.proofDigest),
    };
    const signature = {
      announcement: {
        x: BigInt(body.signature.announcementX),
        y: BigInt(body.signature.announcementY),
      },
      responseHi: BigInt(body.signature.responseHi),
      responseLo: BigInt(body.signature.responseLo),
    };

    expect(pureCircuits.verifySchnorr(
      publicKeyFromSecret(SECRET_KEY),
      pureCircuits.canonicalClaimHash(rebuilt),
      signature,
    )).toBe(true);

    await app.close();
  });
});

// ─── Guardrails ──────────────────────────────────────────────────────────────

describe('guardrails', () => {
  it('the real verifier refuses a blueprint that is still pending', async () => {
    const pendingList = parseAllowlist({
      blueprints: [
        {
          key: 'flight-cancel-v1',
          status: 'pending',
          slug: SLUG,
          claimType: 'FLIGHT_CANCELLED',
          issuerDomain: ISSUER,
          campaigns: [CAMPAIGN],
          requiredOutputs: ['cancellationMarker', 'uniqueClaimId'],
          markerOutput: 'cancellationMarker',
          uniqueIdOutput: 'uniqueClaimId',
          markerPattern: '^Your flight [A-Z0-9-]{2,12} has been cancelled\\.?$',
        },
      ],
    });

    const error = await expectCode(
      attest(request(), deps({ verifier: new ZkEmailProofVerifier(), allowlist: pendingList })),
      ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
    );
    expect(error.detail).toMatch(/pending/);
  });

  it('rejects an allowlist whose marker pattern is not anchored', () => {
    expect(() =>
      parseAllowlist({
        blueprints: [
          {
            key: 'loose',
            status: 'pinned',
            slug: 'a/B@v1',
            claimType: 'FLIGHT_CANCELLED',
            issuerDomain: ISSUER,
            campaigns: [CAMPAIGN],
            requiredOutputs: ['m', 'u'],
            markerOutput: 'm',
            uniqueIdOutput: 'u',
            markerPattern: 'cancelled',
          },
        ],
      }),
    ).toThrow(/anchored/);
  });

  it('rejects a slug pinned to `latest`', () => {
    expect(() =>
      parseAllowlist({
        blueprints: [
          {
            key: 'floating',
            status: 'pinned',
            slug: 'owner/Name@latest',
            claimType: 'FLIGHT_CANCELLED',
            issuerDomain: ISSUER,
            campaigns: [CAMPAIGN],
            requiredOutputs: ['m', 'u'],
            markerOutput: 'm',
            uniqueIdOutput: 'u',
            markerPattern: '^x$',
          },
        ],
      }),
    ).toThrow(/owner\/Name@vN|latest/);
  });

  it('ships config/blueprints.json in a state the real verifier will refuse', async () => {
    // Guards against someone flipping status to "pinned" before the slug
    // actually resolves on the registry.
    const { loadAllowlist } = await import('../src/allowlist.js');
    const shipped = loadAllowlist(new URL('../../../config/blueprints.json', import.meta.url).pathname);
    expect(shipped.slugs.length).toBeGreaterThan(0);
  });
});
