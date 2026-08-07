/**
 * Demo web app (Gate 8).
 *
 * Deliberately boring in its construction: static HTML/CSS/JS served by a
 * local Fastify process, no bundler, no framework, no browser wallet
 * extension. A demo that must not fail in front of a room should have as few
 * moving parts between the story and the chain as possible, and every part
 * removed here is a part that cannot break on stage.
 *
 * The wallet lives in this process (the devnet genesis wallet), not in the
 * browser. That is a real limitation versus a wallet-connected dApp and is
 * recorded in docs/KNOWN_LIMITATIONS.md — it is not hidden in the UI either.
 *
 * Privacy: the `.eml` is parsed here, on the same machine as the browser. In
 * DKIM-direct mode (D-007) it is also sent to the local attestor, which must
 * read it to verify its RSA signature — the UI discloses exactly that. It
 * never reaches the chain in any mode; the chain records only hashes.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

import { getDeployment, getOrCreateWallet, resolveNetwork } from '../../src/network.js';
import { createWallet, persistWalletState, type WalletContext } from '../../src/wallet.js';
import {
  loadCompiledContract,
  loadConfig,
  newPrivateState,
  PRIVATE_STATE_ID,
  PRIVATE_STATE_STORE,
  zkConfigPath,
  type MailProofPrivateState,
} from '../../src/contract.js';
import { AttestorRejection, fetchHealth, requestAttestation } from '../../src/attestor-client.js';
import { deriveSubjectBinding } from '../../packages/shared/claim.js';
import { verifyDkim } from '../../packages/shared/dkim.js';
import { toHex } from '../../packages/shared/hashes.js';
import {
  dkimDnsRecordName,
  getHeader,
  parseDkimSignatures,
  parseEml,
  selectSignaturesForDomain,
} from '../../packages/shared/eml.js';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');

const { network, config: networkConfig } = resolveNetwork();
const config = loadConfig();

/**
 * The `publicOutputs` label for DKIM-direct submissions. The verifier ignores
 * it, and the nullifier does not derive from it — but it does feed the proof
 * digest recorded in the claim, so a constant keeps that digest stable for
 * the same email across submissions.
 */
const DKIM_DIRECT_OUTPUTS = 'dkim-direct/v1';

/** The demo email is private (§61.3): gitignored, served only on localhost. */
const PRIVATE_DEMO_EML = path.resolve(here, '../../fixtures/private-emails/flight-edu.eml');

interface BlueprintEntry {
  slug: string;
  status: 'pending' | 'pinned';
  dkim?: { dnsRecord: string; selector?: string };
}

/** The active blueprint's allowlist entry — carries the pinned DKIM key. */
function loadActiveBlueprintEntry(): BlueprintEntry | undefined {
  const file = JSON.parse(
    readFileSync(path.resolve(here, '../../config/blueprints.json'), 'utf8'),
  ) as { blueprints: BlueprintEntry[] };
  return file.blueprints.find((b) => b.slug === config.blueprintSlug);
}

/**
 * Whether this deployment can redeem from a dropped `.eml` at all.
 *
 * Only a pinned DKIM-direct blueprint can: the ZK Email path needs a proof
 * the browser cannot yet generate, and forwarding the raw message to that
 * verifier would ship the user's email somewhere it does not belong.
 */
function dkimDirectEntry(): BlueprintEntry | undefined {
  const entry = loadActiveBlueprintEntry();
  return entry?.dkim && entry.status === 'pinned' ? entry : undefined;
}

async function createProviders(walletCtx: WalletContext) {
  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
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
      privateStoragePasswordProvider: () =>
        process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1',
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

async function main(): Promise<void> {
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`\n❌ No deployment for ${network}. Run: npm run setup\n`);
    process.exit(1);
  }

  console.log('Connecting to the chain (this takes a moment)...');
  const { module: MailProof, compiled } = await loadCompiledContract();
  const walletCtx = await createWallet({
    network,
    networkConfig,
    seed: getOrCreateWallet(network).seed,
  });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);

  const providers = await createProviders(walletCtx);
  const deployed: any = await findDeployedContract(providers, {
    compiledContract: compiled as any,
    contractAddress: deployment.address,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: newPrivateState() as any,
  });
  const privateState = (await providers.privateStateProvider.get(
    PRIVATE_STATE_ID,
  )) as MailProofPrivateState | null;
  if (!privateState) {
    console.error('\n❌ No private state. Run: npm run setup\n');
    process.exit(1);
  }

  const readLedger = async () => {
    const state = await providers.publicDataProvider.queryContractState(deployment.address);
    return state ? MailProof.ledger(state.data) : null;
  };

  const app = Fastify({ logger: false, bodyLimit: 10_000_000 });

  const sendFile = (name: string, type: string) => async (_req: any, reply: any) => {
    reply.type(type).send(readFileSync(path.join(PUBLIC_DIR, name), 'utf8'));
  };
  app.get('/', sendFile('index.html', 'text/html; charset=utf-8'));
  app.get('/app.js', sendFile('app.js', 'text/javascript; charset=utf-8'));
  app.get('/styles.css', sendFile('styles.css', 'text/css; charset=utf-8'));

  /** The synthetic sample, so a demo never depends on having a file to hand. */
  app.get('/api/sample-eml', async (_req, reply) => {
    reply
      .type('text/plain; charset=utf-8')
      .send(
        readFileSync(
          path.resolve(here, '../../fixtures/emails/flight-cancelled.sample.eml'),
          'utf8',
        ),
      );
  });

  app.get('/api/state', async () => {
    const ledger = await readLedger();
    const health = await fetchHealth(config.attestorUrl).catch(() => null);
    return {
      network,
      contractAddress: deployment.address,
      campaign: config.campaign,
      claimType: config.claimTypeName,
      blueprint: config.blueprintSlug,
      issuerDomain: config.issuerDomain,
      // Reported honestly, including the case where the configured slug is
      // not in the allowlist at all — silently calling that "zk-email" would
      // describe a mode nothing is actually running in.
      verificationMode: (() => {
        const entry = loadActiveBlueprintEntry();
        if (!entry) return 'unknown';
        if (!entry.dkim) return 'zk-email';
        return entry.status === 'pinned' ? 'dkim-direct' : 'dkim-direct (pending)';
      })(),
      redeemableFromBrowser: Boolean(dkimDirectEntry()),
      demoEmailAvailable: existsSync(PRIVATE_DEMO_EML),
      approvedClaimCount: ledger ? Number(ledger.approvedClaimCount) : 0,
      nullifiersUsed: ledger ? Number(ledger.usedNullifiers.size()) : 0,
      attestor: health
        ? {
            online: true,
            verifier: health.verifier,
            cryptographicVerification: health.cryptographicVerification,
          }
        : { online: false, verifier: null, cryptographicVerification: false },
    };
  });

  /**
   * The real demo email, when this machine has one. It is gitignored evidence
   * (§61.3) and this server binds to 127.0.0.1 only — the file is being shown
   * to its own owner, not published.
   */
  app.get('/api/demo-eml', async (_req, reply) => {
    if (!existsSync(PRIVATE_DEMO_EML)) {
      return reply.status(404).send({ error: 'no local demo email on this machine' });
    }
    return reply.type('text/plain; charset=utf-8').send(readFileSync(PRIVATE_DEMO_EML, 'utf8'));
  });

  /** Structural report on a dropped `.eml`. Values redacted by default. */
  app.post('/api/inspect', async (request, reply) => {
    const raw = typeof request.body === 'string' ? request.body : '';
    try {
      const eml = parseEml(raw);
      const signatures = parseDkimSignatures(eml);
      const expected = selectSignaturesForDomain(signatures, config.issuerDomain).length > 0;
      const shape = (name: string) => {
        const header = getHeader(eml, name);
        if (!header) return null;
        return { present: true, length: header.value.length };
      };
      return {
        ok: true,
        lineEnding: eml.lineEnding,
        bodyBytes: eml.bodyBytes,
        headerFields: eml.headers.length,
        headers: {
          from: shape('from'),
          to: shape('to'),
          subject: shape('subject'),
          messageId: shape('message-id'),
        },
        signatures: signatures.map((s) => ({
          domain: s.domain ?? null,
          selector: s.selector ?? null,
          algorithm: s.algorithm ?? null,
          canonicalization: s.canonicalization,
          dnsRecord: dkimDnsRecordName(s) ?? null,
          signedHeaders: s.signedHeaders,
          bodyLengthLimit: s.bodyLength ?? null,
        })),
        matchesExpectedIssuer: expected,
        expectedIssuer: config.issuerDomain,
      };
    } catch (error) {
      return reply
        .status(400)
        .send({ ok: false, error: error instanceof Error ? error.message : 'could not parse' });
    }
  });

  /**
   * Runs the pipeline over the submitted `.eml`, streaming each stage so the
   * UI is never a bare spinner. POST because the message rides in the body —
   * the client reads the SSE stream off `fetch` rather than EventSource.
   */
  app.post('/api/redeem', async (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const emit = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const raw = typeof request.body === 'string' ? request.body : '';
      if (raw.trim().length === 0) {
        throw new Error('Drop the email first — there is nothing to verify.');
      }

      // Refuse rather than green-tick a stage that verified nothing. On a
      // zk-email blueprint this route cannot work — and forwarding the raw
      // message to that verifier would send the user's email to a service
      // whose whole point is never to see it.
      const entry = dkimDirectEntry();
      if (!entry) {
        const active = loadActiveBlueprintEntry();
        throw new Error(
          !active
            ? `Blueprint ${config.blueprintSlug} is not in the allowlist. Run: npm run demo:reset`
            : `Blueprint ${config.blueprintSlug} needs a ZK Email proof, which this demo cannot ` +
              `generate yet. Switch with: npm run demo:reset -- <a pinned dkim blueprint>`,
        );
      }

      // Local pre-check with the same pinned key the attestor holds. Not the
      // authoritative verdict (the attestor re-verifies), but it turns "the
      // signature is broken" into a stage the audience can see.
      emit('stage', { id: 'verify', state: 'running' });
      const eml = parseEml(raw);
      const candidates = selectSignaturesForDomain(parseDkimSignatures(eml), config.issuerDomain);
      if (candidates.length === 0) {
        throw new Error(`No DKIM signature from ${config.issuerDomain} on this message.`);
      }
      let check = undefined;
      for (const candidate of candidates) {
        const attempt = verifyDkim(raw, candidate, { dnsRecord: entry.dkim!.dnsRecord });
        check ??= attempt;
        if (attempt.valid && !attempt.expired) {
          check = attempt;
          break;
        }
      }
      if (check!.expired) throw new Error('The DKIM signature has expired (x=).');
      if (!check!.valid) {
        throw new Error(
          check!.bodyHashMatches
            ? 'DKIM signature mismatch — a signed header was altered.'
            : 'DKIM body hash mismatch — the message body was altered after signing.',
        );
      }
      emit('stage', {
        id: 'verify',
        state: 'done',
        detail: `d=${check!.domain} · body hash ✓ · RSA signature ✓`,
      });

      const health = await fetchHealth(config.attestorUrl);
      emit('stage', {
        id: 'attestor',
        state: 'running',
        note: health.cryptographicVerification
          ? undefined
          : 'Attestor is running the fixture verifier — no proof is being checked.',
      });

      const attestation = await requestAttestation(config.attestorUrl, {
        blueprintId: config.blueprintSlug,
        campaignId: config.campaign,
        subjectBinding: toHex(
          deriveSubjectBinding(privateState.subjectSecret, config.campaignId),
        ),
        publicOutputs: DKIM_DIRECT_OUTPUTS,
        proofData: raw,
      });
      emit('stage', {
        id: 'attestor',
        state: 'done',
        detail: `signed by ${attestation.attestorKeyId}`,
        nullifier: toHex(attestation.claim.claimNullifier),
      });

      emit('stage', { id: 'submit', state: 'running' });
      const startedAt = Date.now();
      const tx = await deployed.callTx.redeemClaim(attestation.claim, attestation.signature);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      emit('stage', {
        id: 'submit',
        state: 'done',
        detail: `block ${tx.public.blockHeight} · ${seconds}s`,
        txId: String(tx.public.txId),
      });

      const ledger = await readLedger();
      emit('stage', {
        id: 'confirm',
        state: 'done',
        detail: `approved claims: ${ledger ? Number(ledger.approvedClaimCount) : '?'}`,
      });
      emit('done', { approvedClaimCount: ledger ? Number(ledger.approvedClaimCount) : 0 });
    } catch (error) {
      const message =
        error instanceof AttestorRejection
          ? error.message
          : error instanceof Error
            ? error.message.split('\n')[0]
            : 'unknown error';
      // "claim already used" is the replay demo succeeding, not a crash.
      const alreadyUsed = message.includes('claim already used');
      emit('failed', {
        code: alreadyUsed ? 'CLAIM_ALREADY_USED' : 'ERROR',
        message: alreadyUsed
          ? 'This evidence was already redeemed in this campaign.'
          : message,
      });
    } finally {
      reply.raw.end();
    }
  });

  const port = Number(process.env.MAILPROOF_WEB_PORT ?? 3000);
  await app.listen({ port, host: '127.0.0.1' });
  console.log(`\n  MailProof demo → http://127.0.0.1:${port}\n`);
  console.log(`  contract: ${deployment.address}`);
  console.log(`  attestor: ${config.attestorUrl}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
