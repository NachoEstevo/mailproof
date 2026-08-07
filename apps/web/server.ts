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

import { Transaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';

import { getDeployment, getOrCreateWallet, resolveNetwork } from '../../src/network.js';
import { createWallet, persistWalletState, type WalletContext } from '../../src/wallet.js';
import {
  browserWalletProviders,
  decodeWalletKeys,
  DelegatingWalletProvider,
  Mutex,
  WalletBridge,
  type WalletResponse,
} from './wallet-bridge.js';
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
import { extensionOriginFromManifest } from '../../packages/shared/extension-id.js';
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

/** Writes one Server-Sent Events frame. */
type Emit = (event: string, data: unknown) => void;

/** The demo email is private (§61.3): gitignored, served only on localhost. */
const PRIVATE_DEMO_EML = path.resolve(here, '../../fixtures/private-emails/flight-edu.eml');

/**
 * The side panel is a first-class client of this daemon and is a different
 * origin, so it needs CORS. Exactly one origin is allowed, derived from the
 * `key` the extension manifest pins: `*` would let any page or extension the
 * user happens to have open post someone's mail into this process.
 */
const EXTENSION_ORIGIN = extensionOriginFromManifest(
  path.resolve(here, '../extension/manifest.json'),
);

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

/** The devnet wallet this process holds — the fallback when none is connected. */
function serverWalletProvider(walletCtx: WalletContext): WalletProvider & MidnightProvider {
  return {
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
}

async function createProviders(walletCtx: WalletContext, walletProvider: DelegatingWalletProvider) {
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

  const walletProvider = new DelegatingWalletProvider(serverWalletProvider(walletCtx));
  const providers = await createProviders(walletCtx, walletProvider);
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

  /** The allowed origin, echoed back only on an exact match. */
  const corsOrigin = (request: { headers: Record<string, unknown> }): string | undefined =>
    request.headers.origin === EXTENSION_ORIGIN ? EXTENSION_ORIGIN : undefined;

  app.addHook('onRequest', async (request, reply) => {
    const origin = corsOrigin(request as never);
    if (!origin) return;
    reply.header('access-control-allow-origin', origin).header('vary', 'origin');

    // The panel posts text/plain, which is CORS-safelisted and so never
    // preflighted. Answer OPTIONS anyway so a later content type does not
    // silently start failing.
    if (request.method === 'OPTIONS') {
      await reply
        .header('access-control-allow-methods', 'GET, POST, OPTIONS')
        .header('access-control-allow-headers', 'content-type')
        .header('access-control-max-age', '600')
        .status(204)
        .send();
    }
  });

  const redemptions = new Mutex();
  /** Bridges awaiting browser answers, keyed by the redemption's session id. */
  const bridges = new Map<string, WalletBridge>();

  const sendFile = (name: string, type: string) => async (_req: any, reply: any) => {
    reply.type(type).send(readFileSync(path.join(PUBLIC_DIR, name), 'utf8'));
  };
  app.get('/', sendFile('index.html', 'text/html; charset=utf-8'));
  app.get('/app.js', sendFile('app.js', 'text/javascript; charset=utf-8'));
  app.get('/wallet.js', sendFile('wallet.js', 'text/javascript; charset=utf-8'));
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
      // The id a wallet must be connected to. `connect()` takes this hint and
      // the browser refuses a wallet reporting anything else.
      walletNetworkId: network,
      walletSimulator: process.env.MAILPROOF_WALLET_SIMULATOR === '1',
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
   * A stand-in for a connector wallet, for exercising the bridge without one.
   *
   * Midnight Lace cannot join a local `undeployed` devnet, which would leave
   * the whole browser-wallet path untested until a public deployment. This
   * endpoint performs the two operations a wallet would — balance and submit
   * — using this process's devnet wallet, so the bridge itself (framing,
   * correlation, hex round-trip, deserialisation) runs for real against the
   * chain.
   *
   * It is NOT a wallet: the keys are the server's, not a user's. Opt-in only,
   * and the UI labels any run that uses it, in the same spirit as the
   * attestor's fixture verifier (§50.4).
   */
  if (process.env.MAILPROOF_WALLET_SIMULATOR === '1') {
    const simulated = serverWalletProvider(walletCtx);
    console.warn(
      '\n  ⚠ WALLET SIMULATOR ENABLED — /api/wallet-simulator balances and\n' +
        '    submits with the server devnet wallet. It is not a user wallet.\n',
    );

    app.post('/api/wallet-simulator', async (request, reply) => {
      const { method, tx } = request.body as { method?: string; tx?: string };
      if (typeof tx !== 'string') {
        return reply.status(400).send({ error: 'missing tx' });
      }
      const bytes = Uint8Array.from(Buffer.from(tx, 'hex'));
      try {
        if (method === 'balanceUnsealedTransaction') {
          const unbound = Transaction.deserialize('signature', 'proof', 'pre-binding', bytes);
          const balanced = await simulated.balanceTx(unbound as never);
          return { tx: Buffer.from(balanced.serialize()).toString('hex') };
        }
        if (method === 'submitTransaction') {
          const sealed = Transaction.deserialize('signature', 'proof', 'binding', bytes);
          await simulated.submitTx(sealed as never);
          return { tx };
        }
        return reply.status(400).send({ error: `unsupported method "${method}"` });
      } catch (error) {
        return reply
          .status(500)
          .send({ error: error instanceof Error ? error.message : 'simulator failed' });
      }
    });
  }

  /**
   * Answers a `wallet-request` frame. Posted by the browser once its wallet
   * has balanced or submitted the transaction the server asked about.
   */
  app.post('/api/wallet-response', async (request, reply) => {
    const body = request.body as { session?: unknown } & WalletResponse;
    const bridge = typeof body?.session === 'string' ? bridges.get(body.session) : undefined;
    if (!bridge) return reply.status(404).send({ ok: false, error: 'no such wallet session' });
    if (typeof body.id !== 'number') {
      return reply.status(400).send({ ok: false, error: 'missing request id' });
    }
    return { ok: bridge.settle(body) };
  });

  /**
   * Runs the pipeline over the submitted `.eml`, streaming each stage so the
   * UI is never a bare spinner. POST because the message rides in the body —
   * the client reads the SSE stream off `fetch` rather than EventSource.
   *
   * When the browser has a wallet connected it sends the session headers
   * below, and balancing plus submission are routed to it instead of to the
   * devnet wallet this process holds.
   */
  app.post('/api/redeem', async (request, reply) => {
    // writeHead goes straight to the socket, so it does not pick up the
    // headers the CORS hook set on `reply`. Repeat the one that matters or
    // the side panel cannot read its own stream.
    const origin = corsOrigin(request as never);
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
    });
    const emit: Emit = (event, data) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const raw = typeof request.body === 'string' ? request.body : '';
    const session = readWalletSession(request.headers as Record<string, string | undefined>);

    // Serialised: a redemption mutates private state, consumes a nullifier,
    // and borrows the shared wallet provider.
    await redemptions.run(() => redeem(raw, session, emit));
    reply.raw.end();
  });

  /** Wallet details a browser sends when it wants its own wallet to pay. */
  interface WalletSession {
    readonly id: string;
    readonly coinPublicKey: string;
    readonly encryptionPublicKey: string;
  }

  function readWalletSession(
    headers: Record<string, string | undefined>,
  ): WalletSession | undefined {
    const id = headers['x-mailproof-wallet-session'];
    const coinPublicKey = headers['x-mailproof-wallet-coin-key'];
    const encryptionPublicKey = headers['x-mailproof-wallet-enc-key'];
    return id && coinPublicKey && encryptionPublicKey
      ? { id, coinPublicKey, encryptionPublicKey }
      : undefined;
  }

  /**
   * The pipeline: verify the signature, get the claim attested, redeem it on
   * chain. Never throws — every outcome leaves through an SSE frame, because
   * a rejected replay is a result the demo wants to show, not a crash.
   */
  async function redeem(raw: string, session: WalletSession | undefined, emit: Emit): Promise<void> {
    let releaseWallet: (() => void) | undefined;
    let bridge: WalletBridge | undefined;

    try {
      if (session) {
        bridge = new WalletBridge((walletRequest) => emit('wallet-request', walletRequest));
        bridges.set(session.id, bridge);
        releaseWallet = walletProvider.use(
          browserWalletProviders(bridge, decodeWalletKeys(network, session)),
        );
      }

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

      emit('stage', {
        id: 'submit',
        state: 'running',
        note: bridge ? 'Approve the transaction in your wallet.' : undefined,
      });
      const startedAt = Date.now();
      const tx = await deployed.callTx.redeemClaim(attestation.claim, attestation.signature);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      emit('stage', {
        id: 'submit',
        state: 'done',
        detail:
          `block ${tx.public.blockHeight} · ${seconds}s` +
          (bridge ? ' · paid by your wallet' : ''),
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
      // Release the shared provider first: anything left borrowed here would
      // make every later redemption fail.
      releaseWallet?.();
      if (session) bridges.delete(session.id);
      bridge?.close();
    }
  }

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
