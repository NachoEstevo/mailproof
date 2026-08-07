/**
 * End-to-end claim redemption against a real chain (§33).
 *
 * Unlike the contract unit tests, which run circuits in-process, this goes
 * through the whole stack: proof server, transaction balancing, submission,
 * indexer read-back. It is the check that the circuit *proves*, not merely
 * that its logic is right.
 *
 * The ZK Email stage is not wired in yet, so the claim is signed locally by
 * the attestor key rather than derived from an email proof. Every later stage
 * — signature verification, campaign binding, nullifier consumption, replay
 * rejection — is exercised for real.
 *
 *   npx tsx scripts/e2e-claim.ts [--claim-id <id>]
 */
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

import { getDeployment, getOrCreateWallet, resolveNetwork } from '../src/network';
import { createWallet, persistWalletState, type WalletContext } from '../src/wallet';
import {
  loadCompiledContract,
  loadConfig,
  newPrivateState,
  PRIVATE_STATE_ID,
  PRIVATE_STATE_STORE,
  zkConfigPath,
  type MailProofPrivateState,
} from '../src/contract';
import { buildDemoSignedClaim } from '../src/fixture-claim';
import { toHex } from '../packages/shared/hashes';
import { deriveSubjectBinding } from '../packages/shared/claim';
import { AttestorRejection, fetchHealth, requestAttestation } from '../src/attestor-client';
import { readFileSync } from 'node:fs';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

const TOTAL_STEPS = 6;
let step = 0;

function progress(message: string): void {
  step += 1;
  console.log(`[${step}/${TOTAL_STEPS}] ${message}`);
}

function fail(message: string): never {
  console.error(`\n❌ e2e-claim failed: ${message}\n`);
  process.exit(1);
}

function parseClaimId(argv: string[]): string {
  const i = argv.indexOf('--claim-id');
  if (i !== -1) {
    const value = argv[i + 1];
    if (!value) fail('--claim-id requires a value');
    return value;
  }
  // Fresh by default so the script is re-runnable: a fixed id would collide
  // with its own previous run's nullifier and fail at step 3 instead of 6.
  return `CLAIM-E2E-${Date.now().toString(36).toUpperCase()}`;
}

const { network, config: networkConfig } = resolveNetwork();
const mailproofConfig = loadConfig();
const uniqueClaimId = parseClaimId(process.argv);

/**
 * Route the claim through the running attestor instead of signing it here.
 *
 * Explicit rather than an automatic fallback: silently switching signing paths
 * would make it impossible to tell which one a demo actually exercised.
 */
const viaAttestor = process.argv.includes('--via-attestor');

interface DemoEvidence {
  blueprintSlug: string;
  publicOutputs: string;
  proofData: string;
}

function loadDemoEvidence(slug: string): DemoEvidence {
  const file = process.env.MAILPROOF_DEMO_EVIDENCE_FILE?.trim() || 'fixtures/demo-evidence.json';
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { evidence?: DemoEvidence[] };
  const entry = (parsed.evidence ?? []).find((e) => e.blueprintSlug === slug);
  if (!entry) fail(`no demo evidence for ${slug} in ${file}`);
  return entry;
}

async function createProviders(walletCtx: WalletContext) {
  const privateStatePassword =
    process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';

  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        {
          shieldedSecretKeys: walletCtx.shieldedSecretKeys,
          dustSecretKey: walletCtx.dustSecretKey,
        },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: PRIVATE_STATE_STORE,
      accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

async function main(): Promise<void> {
  console.log(`\nMailProof end-to-end claim  (network: ${network})\n`);

  const deployment = getDeployment(network);
  if (!deployment) fail(`no deployment on file for ${network}. Run: npm run setup`);

  const { module: MailProof, compiled: compiledContract } = await loadCompiledContract();

  const walletCtx = await createWallet({
    network,
    networkConfig,
    seed: getOrCreateWallet(network).seed,
  });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);

  const providers = await createProviders(walletCtx);
  const deployed: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress: deployment.address,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: newPrivateState() as any,
  });

  const privateState = (await providers.privateStateProvider.get(
    PRIVATE_STATE_ID,
  )) as MailProofPrivateState | null;
  if (!privateState) fail('no private state found. Run: npm run setup');

  const readLedger = async () => {
    const state = await providers.publicDataProvider.queryContractState(deployment.address);
    if (!state) fail(`contract state not found at ${deployment.address}`);
    return MailProof.ledger(state.data);
  };

  // ── 1 ─────────────────────────────────────────────────────────────────────
  const before = await readLedger();
  progress(
    `Connected to ${deployment.address.slice(0, 12)}…  ` +
      `(approved: ${before.approvedClaimCount})`,
  );

  // ── 2 ─────────────────────────────────────────────────────────────────────
  let claim;
  let signature;

  if (viaAttestor) {
    const health = await fetchHealth(mailproofConfig.attestorUrl).catch((error) =>
      fail(`attestor unreachable at ${mailproofConfig.attestorUrl}: ${error.message}`),
    );
    if (!health.cryptographicVerification) {
      // Say it out loud every run. A demo must never imply a proof was checked
      // when it was not (§50.4).
      console.log('      ⚠ attestor is running the FIXTURE verifier — no proof is being checked');
    }

    const evidence = loadDemoEvidence(mailproofConfig.blueprintSlug);
    const subjectBinding = toHex(
      deriveSubjectBinding(privateState.subjectSecret, mailproofConfig.campaignId),
    );

    try {
      const attestation = await requestAttestation(mailproofConfig.attestorUrl, {
        blueprintId: evidence.blueprintSlug,
        campaignId: mailproofConfig.campaign,
        subjectBinding,
        publicOutputs: evidence.publicOutputs,
        proofData: evidence.proofData,
      });
      claim = attestation.claim;
      signature = attestation.signature;
      progress(`Attestor signed the claim  (verifier: ${health.verifier}, key: ${attestation.attestorKeyId})`);
    } catch (error) {
      if (error instanceof AttestorRejection) fail(`attestor rejected the proof: ${error.message}`);
      throw error;
    }
  } else {
    const built = buildDemoSignedClaim({
      config: mailproofConfig,
      subjectSecret: privateState.subjectSecret,
      network,
      uniqueClaimId,
    });
    claim = built.claim;
    signature = built.signature;
    progress(`Claim built and signed locally  (id: ${uniqueClaimId})`);
  }
  console.log(`      nullifier: ${toHex(claim.claimNullifier).slice(0, 22)}…`);

  if (before.usedNullifiers.member(claim.claimNullifier)) {
    fail(`nullifier for "${uniqueClaimId}" is already consumed — pass a different --claim-id`);
  }

  // ── 3 ─────────────────────────────────────────────────────────────────────
  const startedAt = Date.now();
  const tx = await deployed.callTx.redeemClaim(claim, signature);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  progress(`Transaction proved and submitted in ${elapsed}s  (block ${tx.public.blockHeight})`);

  // ── 4 ─────────────────────────────────────────────────────────────────────
  const after = await readLedger();
  if (after.approvedClaimCount !== before.approvedClaimCount + 1n) {
    fail(
      `counter did not advance exactly once: ` +
        `${before.approvedClaimCount} -> ${after.approvedClaimCount}`,
    );
  }
  if (!after.usedNullifiers.member(claim.claimNullifier)) {
    fail('nullifier was not recorded on chain');
  }
  progress(`Claim approved on chain  (approved: ${after.approvedClaimCount})`);

  // ── 5 ─────────────────────────────────────────────────────────────────────
  let replayRejected = false;
  let replayError = '';
  try {
    await deployed.callTx.redeemClaim(claim, signature);
  } catch (error) {
    replayError = error instanceof Error ? error.message : String(error);
    replayRejected = replayError.includes('claim already used');
  }
  if (!replayRejected) {
    fail(
      replayError
        ? `replay was rejected for the wrong reason: ${replayError.split('\n')[0]}`
        : 'replay SUCCEEDED — the same evidence was redeemed twice',
    );
  }
  progress('Replay rejected: "claim already used"');

  // ── 6 ─────────────────────────────────────────────────────────────────────
  const final = await readLedger();
  if (final.approvedClaimCount !== after.approvedClaimCount) {
    fail(`rejected replay still changed state: ${after.approvedClaimCount} -> ${final.approvedClaimCount}`);
  }
  progress('State unchanged after the rejected replay');

  console.log(`\n✅ e2e-claim passed  (${elapsed}s to prove and submit)\n`);

  await walletCtx.wallet.stop();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
