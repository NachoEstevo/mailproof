/**
 * Deployment configuration, resolved from the environment.
 *
 * Everything the contract is pinned to at construction time lives here so
 * that the deploy script, the CLI and the attestor cannot disagree about
 * which campaign, blueprint or issuer they are talking about.
 */
import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

import {
  blueprintIdHash,
  campaignIdHash,
  issuerDomainHash,
} from '../packages/shared/claim.js';
import { CLAIM_TYPE, type ClaimTypeName } from '../packages/shared/constants.js';
import { fromHex } from '../packages/shared/hashes.js';
import {
  publicKeyFromSecret,
  secretKeyFromPassphrase,
  secretKeyFromSeed,
} from '../packages/shared/schnorr.js';

export interface MailProofConfig {
  readonly campaign: string;
  readonly blueprintSlug: string;
  readonly issuerDomain: string;
  readonly claimTypeName: ClaimTypeName;
  readonly claimType: bigint;
  readonly campaignId: Uint8Array;
  readonly blueprintIdHash: Uint8Array;
  readonly issuerDomainHash: Uint8Array;
  readonly attestorKeyId: string;
  readonly attestorUrl: string;
}

const DEFAULTS = {
  campaign: 'travel-insurance-demo-2026',
  blueprintSlug: 'mailproof/FlightCancellation@v1',
  issuerDomain: 'demo-airline.example',
  claimType: 'FLIGHT_CANCELLED' as ClaimTypeName,
  attestorKeyId: 'demo-v1',
  attestorUrl: 'http://127.0.0.1:8787',
};

/**
 * Well-known seed used only when MAILPROOF_ATTESTOR_SEED is absent on the
 * local devnet. Publishing it is the point: nobody should ever mistake a
 * devnet attestor for a real one. Any other network refuses to start without
 * a real seed.
 */
export const DEVNET_DEMO_SEED = 'mailproof-local-devnet-demo-attestor';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MailProofConfig {
  const campaign = env.MAILPROOF_CAMPAIGN_ID?.trim() || DEFAULTS.campaign;
  const blueprintSlug = env.MAILPROOF_BLUEPRINT_ID?.trim() || DEFAULTS.blueprintSlug;
  const issuerDomain = env.MAILPROOF_ISSUER_DOMAIN?.trim() || DEFAULTS.issuerDomain;
  const claimTypeName = (env.MAILPROOF_CLAIM_TYPE?.trim() || DEFAULTS.claimType) as ClaimTypeName;

  const claimType = CLAIM_TYPE[claimTypeName];
  if (claimType === undefined) {
    throw new Error(
      `MAILPROOF_CLAIM_TYPE: unknown value "${claimTypeName}". ` +
        `Supported: ${Object.keys(CLAIM_TYPE).join(', ')}.`,
    );
  }

  return {
    campaign,
    blueprintSlug,
    issuerDomain,
    claimTypeName,
    claimType,
    campaignId: campaignIdHash(campaign),
    blueprintIdHash: blueprintIdHash(blueprintSlug),
    issuerDomainHash: issuerDomainHash(issuerDomain),
    attestorKeyId: env.MAILPROOF_ATTESTOR_KEY_ID?.trim() || DEFAULTS.attestorKeyId,
    attestorUrl: env.MAILPROOF_ATTESTOR_URL?.trim() || DEFAULTS.attestorUrl,
  };
}

export interface AttestorKeyOptions {
  /** Allow the published devnet seed. Only ever true for `undeployed`. */
  allowDevnetDemoKey: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * The attestor's signing key.
 *
 * Accepts `MAILPROOF_ATTESTOR_PRIVATE_KEY` (32 bytes of hex) or
 * `MAILPROOF_ATTESTOR_SEED` (a passphrase of any length). Both are treated as
 * *key material* and run through the same derivation — neither is used as a
 * literal curve scalar, because 32 random bytes land outside the curve order
 * about 94% of the time.
 *
 * Fails closed on every network except the local devnet, where the published
 * demo seed is used and announced.
 */
export function loadAttestorSecretKey(options: AttestorKeyOptions): {
  secretKey: bigint;
  isDemoKey: boolean;
} {
  const env = options.env ?? process.env;

  const rawKey = env.MAILPROOF_ATTESTOR_PRIVATE_KEY?.trim();
  if (rawKey) {
    const bytes = fromHex(rawKey);
    if (bytes.length !== 32) {
      throw new Error(
        `MAILPROOF_ATTESTOR_PRIVATE_KEY: expected 32 bytes of hex, got ${bytes.length}`,
      );
    }
    return { secretKey: secretKeyFromSeed(bytes), isDemoKey: false };
  }

  const seed = env.MAILPROOF_ATTESTOR_SEED?.trim();
  if (seed) {
    return { secretKey: secretKeyFromPassphrase(seed), isDemoKey: false };
  }

  if (!options.allowDevnetDemoKey) {
    throw new Error(
      'No attestor key configured. Set MAILPROOF_ATTESTOR_SEED or ' +
        'MAILPROOF_ATTESTOR_PRIVATE_KEY. The published devnet demo key is only ' +
        'allowed on the undeployed network.',
    );
  }

  return { secretKey: secretKeyFromPassphrase(DEVNET_DEMO_SEED), isDemoKey: true };
}

export function loadAttestorPublicKey(options: AttestorKeyOptions): {
  publicKey: JubjubPoint;
  isDemoKey: boolean;
} {
  const { secretKey, isDemoKey } = loadAttestorSecretKey(options);
  return { publicKey: publicKeyFromSecret(secretKey), isDemoKey };
}

/** Read the attestor URL, requiring it explicitly outside local development. */
export function requireAttestorUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MAILPROOF_ATTESTOR_URL?.trim() || required(env, 'MAILPROOF_ATTESTOR_URL');
}
