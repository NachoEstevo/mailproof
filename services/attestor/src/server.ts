/**
 * MailProof attestor: POST /attest, GET /health (§19.2, §32).
 *
 * `buildServer` returns the app without binding a port, so the tests drive it
 * through `inject()` instead of over a socket.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';

import { loadAttestorSecretKey, loadConfig } from '../../../config/mailproof.js';
import { toHex } from '../../../packages/shared/hashes.js';
import { publicKeyFromSecret } from '../../../packages/shared/schnorr.js';
import { attest } from './attest.js';
import { loadAllowlist, type BlueprintAllowlist } from './allowlist.js';
import { ATTESTOR_ERROR, AttestorError, toAttestorError } from './errors.js';
import { FixtureProofVerifier, type FixtureEntry } from './fixture-verifier.js';
import { logAttest, newRequestId, type Sink } from './logging.js';
import { attestRequestSchema, serialiseSignedClaim } from './schema.js';
import { DkimProofVerifier } from './dkim-verifier.js';
import { RoutingProofVerifier } from './routing-verifier.js';
import type { ProofVerifier } from './verifier.js';
import { ZkEmailProofVerifier } from './zk-email-verifier.js';

const VERSION = '0.1.0';

/** Appendix A: MAILPROOF_MAX_REQUEST_BYTES, default 5 MB. */
function maxRequestBytes(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.MAILPROOF_MAX_REQUEST_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000_000;
}

export interface ServerDeps {
  verifier: ProofVerifier;
  allowlist: BlueprintAllowlist;
  secretKey: bigint;
  attestorKeyId: string;
  env?: NodeJS.ProcessEnv;
  logSink?: Sink;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const env = deps.env ?? process.env;
  const app = Fastify({
    logger: false,
    bodyLimit: maxRequestBytes(env),
  });

  app.get('/health', async () => ({
    status: 'ok',
    version: VERSION,
    blueprints: deps.allowlist.slugs,
    verifier: deps.verifier.name,
    // Surfaced so a fixture-backed deployment cannot look like a real one.
    cryptographicVerification: deps.verifier.isCryptographic,
    signerReady: true,
    attestorKeyId: deps.attestorKeyId,
    attestorPublicKey: (() => {
      const pk = publicKeyFromSecret(deps.secretKey);
      return { x: `0x${pk.x.toString(16)}`, y: `0x${pk.y.toString(16)}` };
    })(),
  }));

  app.post('/attest', async (request, reply) => {
    const requestId = newRequestId();
    const startedAt = Date.now();

    const parsed = attestRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // The validation message names fields, never values.
      const issue = parsed.error.issues[0];
      const detail = issue ? `${issue.path.join('.')}: ${issue.message}` : undefined;
      logAttest(
        { requestId, result: 'rejected', errorCode: ATTESTOR_ERROR.INVALID_REQUEST, detail },
        deps.logSink,
      );
      return reply.status(400).send({ error: ATTESTOR_ERROR.INVALID_REQUEST, detail, requestId });
    }

    const body = parsed.data;
    try {
      const signed = await attest(
        {
          blueprintSlug: body.blueprintId,
          campaign: body.campaignId,
          subjectBindingHash: Buffer.from(body.subjectBinding.slice(2), 'hex'),
          publicOutputs: body.publicOutputs,
          proofData: body.proofData,
        },
        {
          verifier: deps.verifier,
          allowlist: deps.allowlist,
          secretKey: deps.secretKey,
          attestorKeyId: deps.attestorKeyId,
        },
      );

      logAttest(
        {
          requestId,
          result: 'ok',
          blueprintSlug: body.blueprintId,
          proofDigest: toHex(signed.claim.proofDigest),
          claimNullifier: toHex(signed.claim.claimNullifier),
          durationMs: Date.now() - startedAt,
        },
        deps.logSink,
      );
      return reply.status(200).send(serialiseSignedClaim(signed));
    } catch (error) {
      const attestorError = toAttestorError(error);
      logAttest(
        {
          requestId,
          result: attestorError.code === ATTESTOR_ERROR.INTERNAL_ERROR ? 'error' : 'rejected',
          blueprintSlug: body.blueprintId,
          errorCode: attestorError.code,
          detail: attestorError.detail,
          durationMs: Date.now() - startedAt,
        },
        deps.logSink,
      );
      return reply
        .status(attestorError.status)
        .send({ error: attestorError.code, detail: attestorError.detail, requestId });
    }
  });

  /**
   * Errors Fastify raises before a handler runs — an oversized body, a
   * malformed JSON payload, an unroutable request.
   *
   * These used to collapse to an unlogged 500, which meant a client sending
   * broken JSON got "INTERNAL_ERROR" and left no trace to diagnose it by.
   * The framework's own status is preserved when it set one, and every case
   * is logged like any other rejection.
   */
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const code =
      status === 413
        ? ATTESTOR_ERROR.REQUEST_TOO_LARGE
        : status >= 400 && status < 500
          ? ATTESTOR_ERROR.INVALID_REQUEST
          : ATTESTOR_ERROR.INTERNAL_ERROR;
    logAttest(
      {
        requestId: newRequestId(),
        result: code === ATTESTOR_ERROR.INTERNAL_ERROR ? 'error' : 'rejected',
        errorCode: code,
        // Framework messages describe the envelope, never the payload.
        detail:
          code === ATTESTOR_ERROR.INTERNAL_ERROR
            ? undefined
            : error instanceof Error
              ? error.message
              : undefined,
      },
      deps.logSink,
    );
    return reply.status(status).send({ error: code });
  });

  return app;
}

/**
 * Pick the verifier.
 *
 * Defaults to the real ones — DKIM-direct for blueprints with a pinned DNS
 * key, ZK Email for the rest, routed per blueprint. The fixture verifier
 * requires an explicit opt-in *and* announces itself loudly, because a fake
 * verifier that looks real is how a project ends up demoing "the backend
 * said true" (§8, option E).
 */
function resolveVerifier(env: NodeJS.ProcessEnv, moduleDir: string): ProofVerifier {
  if (env.MAILPROOF_ALLOW_FIXTURE_VERIFIER !== '1') {
    return new RoutingProofVerifier(new DkimProofVerifier(), new ZkEmailProofVerifier());
  }

  const file =
    env.MAILPROOF_DEMO_EVIDENCE_FILE?.trim() ||
    path.resolve(moduleDir, '../../../fixtures/demo-evidence.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { evidence?: FixtureEntry[] };
  const entries = parsed.evidence ?? [];

  console.warn(
    '\n' +
      '  ╔════════════════════════════════════════════════════════════════╗\n' +
      '  ║  FIXTURE VERIFIER — NO PROOF IS BEING CHECKED                  ║\n' +
      '  ║  Claims are signed from canned evidence. Never present a run   ║\n' +
      '  ║  backed by this as a live ZK Email proof.                      ║\n' +
      '  ╚════════════════════════════════════════════════════════════════╝\n',
  );
  console.warn(`  loaded ${entries.length} demo evidence entries from ${file}\n`);

  return new FixtureProofVerifier(entries);
}

/** Wire up from the environment and listen. */
export async function start(): Promise<void> {
  const env = process.env;
  const config = loadConfig(env);
  const network = env.MIDNIGHT_NETWORK?.trim() || 'undeployed';

  const { secretKey, isDemoKey } = loadAttestorSecretKey({
    allowDevnetDemoKey: network === 'undeployed',
    env,
  });
  if (isDemoKey) {
    console.warn(
      '⚠ Using the published local-devnet demo attestor key. Anyone can forge ' +
        'claims this attestor would sign. Set MAILPROOF_ATTESTOR_SEED for anything real.',
    );
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const allowlist = loadAllowlist(
    env.MAILPROOF_BLUEPRINTS_FILE?.trim() ||
      path.resolve(here, '../../../config/blueprints.json'),
  );

  const verifier = resolveVerifier(env, here);
  if (!verifier.isCryptographic && env.MAILPROOF_ALLOW_FIXTURE_VERIFIER !== '1') {
    throw new AttestorError(
      ATTESTOR_ERROR.SIGNING_UNAVAILABLE,
      'refusing to start with a non-cryptographic verifier',
    );
  }

  const app = buildServer({
    verifier,
    allowlist,
    secretKey,
    attestorKeyId: config.attestorKeyId,
    env,
  });

  const port = Number(env.MAILPROOF_ATTESTOR_PORT ?? 8787);
  const host = env.MAILPROOF_ATTESTOR_HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  console.log(`attestor listening on http://${host}:${port}  (verifier: ${verifier.name})`);
  console.log(`allowlisted blueprints: ${allowlist.slugs.join(', ')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  start().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
