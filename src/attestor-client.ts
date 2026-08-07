/**
 * Client for the attestor's POST /attest.
 *
 * Converts the wire format back into the exact shapes the compiled contract
 * takes, so the caller never hand-rolls that conversion — getting a limb or a
 * byte order wrong here surfaces on chain as "invalid attestor signature",
 * which looks like a key problem and is not.
 */
import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

import type { ClaimAttestationV1 } from '../packages/shared/claim.js';
import { bytes32FromHex } from '../packages/shared/hashes.js';
import type { SchnorrSignature } from '../packages/shared/schnorr.js';

export interface AttestorHealth {
  status: string;
  version: string;
  blueprints: string[];
  verifier: string;
  /** False when the attestor is running on canned evidence (§50.4). */
  cryptographicVerification: boolean;
  attestorKeyId: string;
  attestorPublicKey: { x: string; y: string };
}

export interface AttestationResult {
  claim: ClaimAttestationV1;
  signature: SchnorrSignature;
  attestorPublicKey: JubjubPoint;
  attestorKeyId: string;
}

export class AttestorRejection extends Error {
  constructor(
    readonly code: string,
    readonly detail: string | undefined,
    readonly status: number,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'AttestorRejection';
  }
}

export async function fetchHealth(baseUrl: string, timeoutMs = 10_000): Promise<AttestorHealth> {
  const response = await fetch(new URL('/health', baseUrl), {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`attestor /health returned ${response.status}`);
  return (await response.json()) as AttestorHealth;
}

export interface AttestationRequest {
  blueprintId: string;
  campaignId: string;
  /** 0x-prefixed 32 bytes. */
  subjectBinding: string;
  publicOutputs: string;
  proofData: string;
}

export async function requestAttestation(
  baseUrl: string,
  request: AttestationRequest,
  timeoutMs = 30_000,
): Promise<AttestationResult> {
  const response = await fetch(new URL('/attest', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = (await response.json()) as Record<string, any>;
  if (!response.ok) {
    throw new AttestorRejection(
      typeof body.error === 'string' ? body.error : 'UNKNOWN',
      typeof body.detail === 'string' ? body.detail : undefined,
      response.status,
    );
  }

  return {
    claim: {
      version: BigInt(body.claim.version),
      claimType: BigInt(body.claim.claimType),
      blueprintIdHash: bytes32FromHex(body.claim.blueprintIdHash, 'blueprintIdHash'),
      issuerDomainHash: bytes32FromHex(body.claim.issuerDomainHash, 'issuerDomainHash'),
      campaignId: bytes32FromHex(body.claim.campaignId, 'campaignId'),
      subjectBindingHash: bytes32FromHex(body.claim.subjectBindingHash, 'subjectBindingHash'),
      claimNullifier: bytes32FromHex(body.claim.claimNullifier, 'claimNullifier'),
      proofDigest: bytes32FromHex(body.claim.proofDigest, 'proofDigest'),
    },
    signature: {
      announcement: {
        x: BigInt(body.signature.announcementX),
        y: BigInt(body.signature.announcementY),
      },
      responseHi: BigInt(body.signature.responseHi),
      responseLo: BigInt(body.signature.responseLo),
    },
    attestorPublicKey: {
      x: BigInt(body.attestorPublicKey.x),
      y: BigInt(body.attestorPublicKey.y),
    },
    attestorKeyId: body.attestorKeyId,
  };
}
