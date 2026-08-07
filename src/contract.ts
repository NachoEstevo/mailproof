/**
 * MailProof-specific wiring shared by deploy, CLI and the e2e check:
 * the compiled contract binding, the witness implementation, and the private
 * state those witnesses read from.
 *
 * The provider setup stays in each script, matching how the scaffold is laid
 * out.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';

import { loadAttestorPublicKey, loadConfig, type MailProofConfig } from '../config/mailproof.js';
import type { NetworkId } from './network.js';

/** Must match at deploy and at reconnect, or the private state is not found. */
export const PRIVATE_STATE_ID = 'mailproofPrivateState';

export const PRIVATE_STATE_STORE = 'mailproof-state';

/**
 * The subject's secret. Never leaves this machine: the contract only ever
 * sees `H(domain, secret, campaignId)`, and only to compare it.
 */
export interface MailProofPrivateState {
  readonly subjectSecret: Uint8Array;
}

export function newPrivateState(): MailProofPrivateState {
  return { subjectSecret: new Uint8Array(randomBytes(32)) };
}

export const witnesses = {
  subjectSecret: (
    context: WitnessContext<unknown, MailProofPrivateState>,
  ): [MailProofPrivateState, Uint8Array] => [
    context.privateState,
    context.privateState.subjectSecret,
  ],
};

const here = path.dirname(fileURLToPath(import.meta.url));

export const zkConfigPath = path.resolve(here, '..', 'contracts', 'managed', 'mailproof');

/**
 * Load the compiled contract, failing with an actionable message rather than
 * a module-resolution error when it has not been compiled yet.
 */
export async function loadContractModule() {
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) {
    console.error('\n❌ Contract not compiled. Run: npm run compile\n');
    process.exit(1);
  }
  return import(pathToFileURL(contractPath).href);
}

export async function loadCompiledContract() {
  const module = await loadContractModule();
  const compiled = CompiledContract.make('mailproof', module.Contract).pipe(
    CompiledContract.withWitnesses(witnesses as never),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );
  return { module, compiled };
}

/**
 * Constructor arguments, in the order the contract declares them.
 *
 * These are what the deployment is permanently pinned to: change any of them
 * and you need a new contract, not a new transaction.
 */
export function constructorArgs(config: MailProofConfig, network: NetworkId) {
  const { publicKey, isDemoKey } = loadAttestorPublicKey({
    allowDevnetDemoKey: network === 'undeployed',
  });

  if (isDemoKey) {
    console.log(
      '\n  ⚠ Using the published local-devnet demo attestor key.\n' +
        '    Anyone can sign claims this contract accepts. Set\n' +
        '    MAILPROOF_ATTESTOR_SEED before deploying anywhere else.\n',
    );
  }

  return [
    publicKey,
    config.campaignId,
    config.blueprintIdHash,
    config.issuerDomainHash,
    config.claimType,
  ] as const;
}

export function describeConfig(config: MailProofConfig): string {
  return [
    `  Campaign:   ${config.campaign}`,
    `  Blueprint:  ${config.blueprintSlug}`,
    `  Issuer:     ${config.issuerDomain}`,
    `  Claim type: ${config.claimTypeName} (${config.claimType})`,
  ].join('\n');
}

export { loadConfig };
