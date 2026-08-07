/**
 * Configuration and attestor-key loading.
 *
 * The long-passphrase case is a regression test: the first version capped
 * seed material at 32 bytes, which made the deploy script crash on its own
 * built-in devnet seed.
 */
import { describe, expect, it } from 'vitest';

import {
  DEVNET_DEMO_SEED,
  loadAttestorPublicKey,
  loadAttestorSecretKey,
  loadConfig,
} from './mailproof.js';
import { JUBJUB_ORDER } from '../packages/shared/constants.js';
import { canonicalClaimHash } from '../packages/shared/claim.js';
import { sign, verify } from '../packages/shared/schnorr.js';

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('loadConfig', () => {
  it('falls back to the demo deployment when nothing is set', () => {
    const config = loadConfig(EMPTY_ENV);
    expect(config.campaign).toBe('travel-insurance-demo-2026');
    expect(config.claimType).toBe(1n);
    expect(config.campaignId).toHaveLength(32);
    expect(config.blueprintIdHash).toHaveLength(32);
    expect(config.issuerDomainHash).toHaveLength(32);
  });

  it('derives different campaign ids for different campaigns', () => {
    const a = loadConfig({ MAILPROOF_CAMPAIGN_ID: 'campaign-a' });
    const b = loadConfig({ MAILPROOF_CAMPAIGN_ID: 'campaign-b' });
    expect(a.campaignId).not.toEqual(b.campaignId);
  });

  it('normalises the issuer domain, so casing cannot fork the deployment', () => {
    const lower = loadConfig({ MAILPROOF_ISSUER_DOMAIN: 'demo-airline.example' });
    const upper = loadConfig({ MAILPROOF_ISSUER_DOMAIN: '  Demo-Airline.EXAMPLE ' });
    expect(lower.issuerDomainHash).toEqual(upper.issuerDomainHash);
  });

  it('rejects an unknown claim type instead of defaulting', () => {
    expect(() => loadConfig({ MAILPROOF_CLAIM_TYPE: 'NOT_A_CLAIM' })).toThrow(/unknown value/);
  });
});

describe('attestor key loading', () => {
  it('fails closed when no key is configured off the devnet', () => {
    expect(() => loadAttestorSecretKey({ allowDevnetDemoKey: false, env: EMPTY_ENV })).toThrow(
      /No attestor key configured/,
    );
  });

  it('uses the published demo key on the devnet, and says so', () => {
    const { secretKey, isDemoKey } = loadAttestorSecretKey({
      allowDevnetDemoKey: true,
      env: EMPTY_ENV,
    });
    expect(isDemoKey).toBe(true);
    expect(secretKey).toBeGreaterThan(0n);
    expect(secretKey).toBeLessThan(JUBJUB_ORDER);
  });

  it('accepts a passphrase longer than 32 bytes', () => {
    // Regression: the devnet seed itself is 36 bytes and used to throw.
    expect(DEVNET_DEMO_SEED.length).toBeGreaterThan(32);
    const long = 'a'.repeat(200);
    const { secretKey } = loadAttestorSecretKey({
      allowDevnetDemoKey: false,
      env: { MAILPROOF_ATTESTOR_SEED: long },
    });
    expect(secretKey).toBeGreaterThan(0n);
    expect(secretKey).toBeLessThan(JUBJUB_ORDER);
  });

  it('accepts a 32-byte hex key', () => {
    const { secretKey, isDemoKey } = loadAttestorSecretKey({
      allowDevnetDemoKey: false,
      env: { MAILPROOF_ATTESTOR_PRIVATE_KEY: `0x${'ab'.repeat(32)}` },
    });
    expect(isDemoKey).toBe(false);
    expect(secretKey).toBeLessThan(JUBJUB_ORDER);
  });

  it('rejects a hex key of the wrong length', () => {
    expect(() =>
      loadAttestorSecretKey({
        allowDevnetDemoKey: false,
        env: { MAILPROOF_ATTESTOR_PRIVATE_KEY: '0xdeadbeef' },
      }),
    ).toThrow(/expected 32 bytes/);
  });

  it('is deterministic, so redeploying does not orphan a signing key', () => {
    const first = loadAttestorSecretKey({
      allowDevnetDemoKey: false,
      env: { MAILPROOF_ATTESTOR_SEED: 'stable-seed' },
    });
    const second = loadAttestorSecretKey({
      allowDevnetDemoKey: false,
      env: { MAILPROOF_ATTESTOR_SEED: 'stable-seed' },
    });
    expect(first.secretKey).toBe(second.secretKey);
  });

  it('yields different keys for different seeds', () => {
    const a = loadAttestorSecretKey({
      allowDevnetDemoKey: false,
      env: { MAILPROOF_ATTESTOR_SEED: 'seed-a' },
    });
    const b = loadAttestorSecretKey({
      allowDevnetDemoKey: false,
      env: { MAILPROOF_ATTESTOR_SEED: 'seed-b' },
    });
    expect(a.secretKey).not.toBe(b.secretKey);
  });

  it('produces a public key that verifies its own signatures', () => {
    const env = { MAILPROOF_ATTESTOR_SEED: 'round-trip-seed' };
    const { secretKey } = loadAttestorSecretKey({ allowDevnetDemoKey: false, env });
    const { publicKey } = loadAttestorPublicKey({ allowDevnetDemoKey: false, env });

    const config = loadConfig(EMPTY_ENV);
    const message = canonicalClaimHash({
      version: 1n,
      claimType: config.claimType,
      blueprintIdHash: config.blueprintIdHash,
      issuerDomainHash: config.issuerDomainHash,
      campaignId: config.campaignId,
      subjectBindingHash: config.campaignId,
      claimNullifier: config.blueprintIdHash,
      proofDigest: config.issuerDomainHash,
    });

    expect(verify(publicKey, message, sign(secretKey, message))).toBe(true);
  });
});
