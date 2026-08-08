/**
 * Deployment configuration, resolved from the environment.
 *
 * Everything the contract is pinned to at construction time lives here so
 * that the deploy script, the CLI and the attestor cannot disagree about
 * which campaign, blueprint or issuer they are talking about.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

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

/**
 * Demo selection chosen by the last `npm run demo:reset`.
 *
 * A campaign is baked into the contract at construction, so a fresh campaign
 * means a fresh set of nullifiers — which is what makes the demo repeatable
 * without hand-editing state mid-pitch (§50.5). The active blueprint and its
 * issuer travel in the same file for the same reason: the contract pins their
 * hashes at deploy time, so the deploy script, the attestor and the web app
 * must all see the same values without being launched from one shell.
 */
export const DEMO_STATE_FILE = '.mailproof-demo.json';

export interface DemoState {
  readonly campaign: string;
  readonly blueprintSlug?: string;
  readonly issuerDomain?: string;
  readonly claimType?: ClaimTypeName;
}

function persistedDemoState(cwd: string): Partial<DemoState> {
  try {
    const raw = readFileSync(path.join(cwd, DEMO_STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const str = (key: string) =>
      typeof parsed[key] === 'string' && parsed[key] ? (parsed[key] as string) : undefined;
    return {
      campaign: str('campaign'),
      blueprintSlug: str('blueprintSlug'),
      issuerDomain: str('issuerDomain'),
      claimType: str('claimType') as ClaimTypeName | undefined,
    };
  } catch {
    return {};
  }
}

export function writeDemoState(state: DemoState, cwd = process.cwd()): void {
  writeFileSync(
    path.join(cwd, DEMO_STATE_FILE),
    `${JSON.stringify({ ...state, createdAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

/** Back-compat shim for callers that only choose the campaign. */
export function writeDemoCampaign(campaign: string, cwd = process.cwd()): void {
  writeDemoState({ campaign }, cwd);
}

/**
 * @param cwd Where to look for the demo-reset file. Injectable so callers —
 * and tests — are not at the mercy of the working directory.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): MailProofConfig {
  // Explicit env wins, then the last demo reset, then the built-in default.
  const demo = persistedDemoState(cwd);
  const campaign = env.MAILPROOF_CAMPAIGN_ID?.trim() || demo.campaign || DEFAULTS.campaign;
  const blueprintSlug =
    env.MAILPROOF_BLUEPRINT_ID?.trim() || demo.blueprintSlug || DEFAULTS.blueprintSlug;
  const issuerDomain =
    env.MAILPROOF_ISSUER_DOMAIN?.trim() || demo.issuerDomain || DEFAULTS.issuerDomain;
  const claimTypeName = (env.MAILPROOF_CLAIM_TYPE?.trim() ||
    demo.claimType ||
    DEFAULTS.claimType) as ClaimTypeName;

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
    // `*` is the wildcard the contract reads as "any institution": it pins the
    // zero hash and delegates the domain to the attestor's allowlist. Written
    // as a domain nobody can own rather than as an empty string, so an unset
    // variable can never be mistaken for a deliberate opening.
    issuerDomainHash:
      issuerDomain === '*' ? new Uint8Array(32) : issuerDomainHash(issuerDomain),
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
