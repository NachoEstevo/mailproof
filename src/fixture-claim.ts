/**
 * Locally-signed demo claims.
 *
 * This is the §28.5 fixture signer: it exercises the on-chain redemption path
 * before ZK Email is in the picture, by producing a claim the deployed
 * contract will accept.
 *
 * It does NOT verify an email. The claim it produces attests to nothing —
 * it exists to prove that the contract, the proof server and the signature
 * encoding all agree. Once the attestor exists (Gate 6), real claims come
 * from there and this stays a development tool.
 */
import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

import { loadAttestorSecretKey, type MailProofConfig } from '../config/mailproof.js';
import {
  canonicalClaimHash,
  deriveNullifier,
  deriveSubjectBinding,
  proofDigest,
  uniqueClaimIdHash,
  type ClaimAttestationV1,
} from '../packages/shared/claim.js';
import { CLAIM_VERSION } from '../packages/shared/constants.js';
import { publicKeyFromSecret, sign, type SchnorrSignature } from '../packages/shared/schnorr.js';
import type { NetworkId } from './network.js';

export interface DemoSignedClaim {
  claim: ClaimAttestationV1;
  signature: SchnorrSignature;
  attestorPublicKey: JubjubPoint;
}

export interface DemoClaimOptions {
  config: MailProofConfig;
  subjectSecret: Uint8Array;
  network: NetworkId;
  /** Distinguishes claims: the same value yields the same nullifier. */
  uniqueClaimId: string;
}

export function buildDemoSignedClaim(options: DemoClaimOptions): DemoSignedClaim {
  const { config, subjectSecret, network, uniqueClaimId } = options;

  const { secretKey } = loadAttestorSecretKey({
    allowDevnetDemoKey: network === 'undeployed',
  });

  const claim: ClaimAttestationV1 = {
    version: CLAIM_VERSION,
    claimType: config.claimType,
    blueprintIdHash: config.blueprintIdHash,
    issuerDomainHash: config.issuerDomainHash,
    campaignId: config.campaignId,
    subjectBindingHash: deriveSubjectBinding(subjectSecret, config.campaignId),
    claimNullifier: deriveNullifier(
      config.blueprintIdHash,
      uniqueClaimIdHash(uniqueClaimId),
      config.campaignId,
    ),
    proofDigest: proofDigest(
      `demo-fixture:${uniqueClaimId}`,
      `demo-fixture-outputs:${uniqueClaimId}`,
    ),
  };

  return {
    claim,
    signature: sign(secretKey, canonicalClaimHash(claim)),
    attestorPublicKey: publicKeyFromSecret(secretKey),
  };
}
