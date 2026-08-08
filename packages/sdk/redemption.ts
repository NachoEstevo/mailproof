/**
 * Spending a claim on chain.
 *
 * Kept behind an interface for two reasons. The obvious one is that the whole
 * policy layer can then be tested without a node, an indexer and a proof
 * server. The less obvious one matters more: an integrator should be able to
 * point at a MailProof daemon they run themselves, and nothing in the SDK
 * should assume otherwise.
 */

export type RedemptionOutcome = 'redeemed' | 'already-claimed';

export interface RedemptionRequest {
  /** The blinded identity. One per mailbox per campaign, unguessable. */
  readonly identity: Uint8Array;
  /** Which campaign the claim is spent in. */
  readonly campaign: string;
  /** The tier being granted, recorded so a claim cannot be re-scoped later. */
  readonly tier: string;
}

export interface RedemptionReceipt {
  readonly outcome: RedemptionOutcome;
  /** The nullifier the chain now holds. Safe to store: it is already blinded. */
  readonly nullifier: string;
  readonly contractAddress: string;
  readonly campaign: string;
  /** Absent when the outcome is `already-claimed` — nothing was submitted. */
  readonly txId?: string;
  readonly blockHeight?: number;
}

export class RedemptionError extends Error {
  constructor(
    message: string,
    readonly code: 'UNREACHABLE' | 'REJECTED' | 'MALFORMED_RESPONSE',
  ) {
    super(message);
    this.name = 'RedemptionError';
  }
}

export interface RedemptionClient {
  /**
   * Spend the claim, or report that it was already spent.
   *
   * `already-claimed` is a result, not an error: it is the answer to "has this
   * person had their benefit", and it is the answer the caller most often
   * wants. Throwing for it would push every integrator into a try/catch that
   * treats the normal case as exceptional.
   */
  redeem(request: RedemptionRequest): Promise<RedemptionReceipt>;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export interface HttpRedemptionOptions {
  /** Base URL of a MailProof daemon. */
  readonly baseUrl: string;
  /** Bearer token, when the daemon is not on loopback. */
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Talks to a MailProof daemon over HTTP.
 *
 * The daemon owns the chain connection, the proving and the wallet; this is
 * deliberately a thin client. Proving takes tens of seconds, so the default
 * timeout is generous — a stingy one turns a slow block into a lost grant that
 * the chain nonetheless recorded.
 */
export function httpRedemptionClient(options: HttpRedemptionOptions): RedemptionClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const base = options.baseUrl.replace(/\/$/, '');

  return {
    async redeem(request) {
      let response: Response;
      try {
        response = await doFetch(`${base}/api/redeem-identity`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          body: JSON.stringify({
            identity: toHex(request.identity),
            campaign: request.campaign,
            tier: request.tier,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new RedemptionError(
          `could not reach the MailProof daemon at ${base}: ` +
            (error instanceof Error ? error.message : 'request failed'),
          'UNREACHABLE',
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new RedemptionError(
          `daemon replied ${response.status} with a body that is not JSON`,
          'MALFORMED_RESPONSE',
        );
      }

      if (!response.ok) {
        const detail =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: unknown }).error)
            : `HTTP ${response.status}`;
        throw new RedemptionError(`the daemon refused the claim: ${detail}`, 'REJECTED');
      }

      return parseReceipt(body);
    },
  };
}

/** Validate rather than cast: a wrong shape here becomes a wrongly granted tier. */
function parseReceipt(body: unknown): RedemptionReceipt {
  const bad = (why: string): never => {
    throw new RedemptionError(`daemon response ${why}`, 'MALFORMED_RESPONSE');
  };

  if (typeof body !== 'object' || body === null) return bad('is not an object');
  const record = body as Record<string, unknown>;

  const outcome = record.outcome;
  if (outcome !== 'redeemed' && outcome !== 'already-claimed') {
    return bad(`has an unrecognised outcome ${JSON.stringify(outcome)}`);
  }
  if (typeof record.nullifier !== 'string' || !/^(0x)?[0-9a-f]{64}$/i.test(record.nullifier)) {
    return bad('has no 32-byte nullifier');
  }
  if (typeof record.contractAddress !== 'string' || record.contractAddress.length === 0) {
    return bad('names no contract');
  }
  if (typeof record.campaign !== 'string' || record.campaign.length === 0) {
    return bad('names no campaign');
  }

  return {
    outcome,
    nullifier: record.nullifier,
    contractAddress: record.contractAddress,
    campaign: record.campaign,
    ...(typeof record.txId === 'string' ? { txId: record.txId } : {}),
    ...(typeof record.blockHeight === 'number' ? { blockHeight: record.blockHeight } : {}),
  };
}
