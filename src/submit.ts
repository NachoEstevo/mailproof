/**
 * Transaction submission that survives a real network.
 *
 * wallet-sdk 1.2.0's node client shares one polkadot.js `Api` between
 * `getGenesis()` and `sendMidnightTransaction()`, and each wraps itself in
 * `ensuring(() => this.api.disconnect())`. Over loopback the disconnect always
 * lands after the send, so the local devnet never sees a problem. Over a real
 * network it lands during it, every pending request dies with
 * "disconnected: 1000 Normal Closure", and the SDK reports a submission
 * failure that names the layer that gave up rather than the cause.
 *
 * Verified empirically on preview: the identical transaction the SDK failed
 * three times went Ready → Broadcast → InBlock → Finalized on the first try
 * over a dedicated connection. So this submits the same extrinsic the SDK
 * would — `midnight.sendMnTransaction(hex)` — on a connection nothing else
 * can disconnect.
 *
 * Retirement condition: a wallet-sdk release whose node client stops sharing
 * the connection. 2.0 canaries exist; nothing stable at the time of writing.
 */
import { ApiPromise, WsProvider } from '@polkadot/api';
import { u8aToHex } from '@polkadot/util';

/** Anything the ledger can serialise — wallet-sdk and midnight-js txs both. */
export interface SerializableTransaction {
  serialize(): Uint8Array;
}

export class SubmitError extends Error {
  constructor(
    message: string,
    readonly phase: 'connect' | 'submit' | 'in-block',
  ) {
    super(message);
    this.name = 'SubmitError';
  }
}

export interface SubmitOptions {
  /** `ws://` or `wss://`; an `http(s)` URL is converted. */
  readonly nodeUrl: string;
  /** Resolve on first inclusion or wait for finality. Default: finalized. */
  readonly waitFor?: 'in-block' | 'finalized';
  readonly timeoutMs?: number;
}

export interface SubmitReceipt {
  /** Hash of the block the transaction landed in. */
  readonly blockHash: string;
  readonly finalized: boolean;
}

/**
 * Submit one serialised Midnight transaction and wait for it to land.
 *
 * The connection is created for this call and torn down after it, which is
 * the entire point: nobody else holds it, so nobody else can close it while
 * the submission is pending.
 */
export async function submitDirect(
  transaction: SerializableTransaction,
  options: SubmitOptions,
): Promise<SubmitReceipt> {
  const nodeWs = options.nodeUrl.replace(/^http/, 'ws');
  const waitFor = options.waitFor ?? 'finalized';
  const timeoutMs = options.timeoutMs ?? 180_000;

  let api: ApiPromise;
  try {
    api = await ApiPromise.create({
      provider: new WsProvider(nodeWs, 2_500),
      noInitWarn: true,
      throwOnConnect: true,
    });
  } catch (error) {
    throw new SubmitError(
      `could not connect to ${nodeWs}: ${error instanceof Error ? error.message : 'unknown'}`,
      'connect',
    );
  }

  try {
    return await new Promise<SubmitReceipt>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new SubmitError(`no ${waitFor} status within ${timeoutMs / 1000}s`, 'in-block'),
          ),
        timeoutMs,
      );
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        fn();
      };

      api.tx.midnight
        .sendMnTransaction(u8aToHex(transaction.serialize()))
        .send((result) => {
          // A dispatch error is the node executing the transaction and the
          // ledger saying no — the one message the SDK was swallowing.
          if (result.dispatchError) {
            settle(() =>
              reject(new SubmitError(result.dispatchError!.toString(), 'in-block')),
            );
            return;
          }
          if (result.status.isInvalid || result.status.isDropped || result.status.isUsurped) {
            settle(() =>
              reject(new SubmitError(`transaction ${result.status.type}`, 'in-block')),
            );
            return;
          }
          if (waitFor === 'in-block' && result.status.isInBlock) {
            settle(() =>
              resolve({ blockHash: result.status.asInBlock.toHex(), finalized: false }),
            );
            return;
          }
          if (result.status.isFinalized) {
            settle(() =>
              resolve({ blockHash: result.status.asFinalized.toHex(), finalized: true }),
            );
          }
        })
        .catch((error) =>
          settle(() =>
            reject(
              new SubmitError(
                error instanceof Error ? error.message : 'submission rejected',
                'submit',
              ),
            ),
          ),
        );
    });
  } finally {
    await api.disconnect().catch(() => undefined);
  }
}

/**
 * Whether a network needs the workaround at all.
 *
 * Loopback never loses the race, and the local devnet is where the demo has
 * to be at its most boring — so the SDK's own path stays in use there, and
 * the day the SDK is fixed this predicate is the single thing to delete.
 */
export function needsDirectSubmission(nodeUrl: string): boolean {
  return !/127\.0\.0\.1|localhost/.test(nodeUrl);
}

/**
 * A `submitTx` for the midnight-js providers, choosing the path per network.
 *
 * Returns the transaction's own identifier because that is what the SDK's
 * submitTransaction returns, and downstream code compares against it.
 */
export function submitTxVia(
  wallet: { submitTransaction(tx: unknown): Promise<unknown> },
  nodeUrl: string,
): (tx: SerializableTransaction & { identifiers(): string[] }) => Promise<string> {
  return async (tx) => {
    if (!needsDirectSubmission(nodeUrl)) {
      return (await wallet.submitTransaction(tx)) as string;
    }
    await submitDirect(tx, { nodeUrl, waitFor: 'in-block' });
    const [id] = tx.identifiers();
    if (!id) throw new SubmitError('transaction exposes no identifier', 'submit');
    return id;
  };
}
