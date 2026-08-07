/**
 * Bridge between midnight-js (here, on the server) and a DApp Connector
 * wallet (there, in the browser).
 *
 * The split is deliberate. Building a contract call needs the compiled
 * circuit, the ZK config and the subject's private state; proving needs the
 * proof server. Moving all of that into the browser would mean a bundler and
 * a WASM payload, and the demo's whole construction argument is that fewer
 * moving parts fail less often (see apps/web/server.ts).
 *
 * But *balancing, paying fees and submitting* is exactly what a wallet is
 * for, and it is the part that has to be the user's. midnight-js exposes both
 * as provider methods, so those two calls — and only those two — are
 * forwarded to the browser and answered by the user's wallet:
 *
 *     server                       browser                    wallet
 *     ──────                       ───────                    ──────
 *     balanceTx(tx)   ──SSE──▶  wallet-request  ──────▶  balanceUnsealedTransaction
 *                     ◀─POST──  /api/wallet-response ◀──
 *     submitTx(tx)    ──SSE──▶  wallet-request  ──────▶  submitTransaction
 *                     ◀─POST──  /api/wallet-response ◀──
 *
 * Transactions cross as hex. The DApp Connector takes strings, and hex keeps
 * the payload greppable in a log without a decoding step.
 */
import {
  MidnightBech32m,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import { Transaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type {
  CoinPublicKey,
  EncPublicKey,
  FinalizedTransaction,
  TransactionId,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { MidnightProvider, UnboundTransaction, WalletProvider } from '@midnight-ntwrk/midnight-js-types';

/** Methods the browser is allowed to be asked to perform. */
export type WalletMethod = 'balanceUnsealedTransaction' | 'submitTransaction';

export interface WalletRequest {
  readonly id: number;
  readonly method: WalletMethod;
  /** Hex-encoded serialised transaction. */
  readonly tx: string;
}

export interface WalletResponse {
  readonly id: number;
  /** Hex-encoded serialised transaction, for methods that return one. */
  readonly tx?: string;
  readonly error?: string;
}

/**
 * A wallet is a person clicking "approve". The timeout is generous on
 * purpose, but finite: without one, a closed wallet popup would hang the
 * redemption forever with no diagnosis.
 */
const DEFAULT_TIMEOUT_MS = 180_000;

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

export class WalletBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletBridgeError';
  }
}

/**
 * One redemption's worth of pending wallet calls.
 *
 * Scoped to a single request rather than kept alive globally: the SSE stream
 * it answers over only exists for the duration of that request, so a
 * longer-lived bridge could only ever hold requests it cannot deliver.
 */
export class WalletBridge {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (tx: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;

  constructor(
    private readonly emit: (request: WalletRequest) => void,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /** Ask the browser to run `method` and wait for the answer. */
  request(method: WalletMethod, tx: string): Promise<string> {
    if (this.closed) return Promise.reject(new WalletBridgeError('wallet bridge is closed'));

    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WalletBridgeError(`the wallet did not answer ${method} in time`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.emit({ id, method, tx });
    });
  }

  /**
   * Deliver a browser response.
   *
   * @returns false when the id is unknown — a late, duplicated or forged
   * response, which is ignored rather than treated as an error.
   */
  settle(response: WalletResponse): boolean {
    const entry = this.pending.get(response.id);
    if (!entry) return false;
    this.pending.delete(response.id);
    clearTimeout(entry.timer);

    if (response.error !== undefined) {
      entry.reject(new WalletBridgeError(response.error));
    } else if (typeof response.tx === 'string') {
      entry.resolve(response.tx);
    } else {
      entry.reject(new WalletBridgeError('wallet response carried neither a transaction nor an error'));
    }
    return true;
  }

  /** Fail everything still outstanding. Safe to call more than once. */
  close(reason = 'the connection closed before the wallet answered'): void {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new WalletBridgeError(reason));
      this.pending.delete(id);
    }
  }

  get outstanding(): number {
    return this.pending.size;
  }
}

export interface BrowserWalletKeys {
  readonly coinPublicKey: CoinPublicKey;
  readonly encryptionPublicKey: EncPublicKey;
}

/**
 * Convert the Bech32m keys a connector wallet reports into the hex strings
 * midnight-js uses internally.
 *
 * The connector speaks Bech32m because those values are shown to people;
 * `CoinPublicKey` and `EncPublicKey` are bare hex. Decoding also validates
 * both the type prefix and the network, so a wallet on the wrong network is
 * caught here even if it misreported its own configuration.
 *
 * Go through `codec.decode` rather than `MidnightBech32m#decode`: the latter
 * looks the codec up as `tclass[Bech32mSymbol]`, a symbol only the address
 * classes declare. Handed `ShieldedCoinPublicKey` it dereferences undefined.
 */
export function decodeWalletKeys(
  networkId: string,
  bech32m: { coinPublicKey: string; encryptionPublicKey: string },
): BrowserWalletKeys {
  const decode = <T extends { toHexString(): string }>(
    value: string,
    codec: { decode(networkId: string, repr: MidnightBech32m): T },
    label: string,
  ): string => {
    try {
      return codec.decode(networkId, MidnightBech32m.parse(value)).toHexString();
    } catch (error) {
      throw new WalletBridgeError(
        `could not read the wallet's ${label} for network "${networkId}": ` +
          (error instanceof Error ? error.message : 'malformed Bech32m'),
      );
    }
  };

  return {
    coinPublicKey: decode(bech32m.coinPublicKey, ShieldedCoinPublicKey.codec, 'coin public key'),
    encryptionPublicKey: decode(
      bech32m.encryptionPublicKey,
      ShieldedEncryptionPublicKey.codec,
      'encryption public key',
    ),
  };
}

/**
 * midnight-js providers backed by the browser wallet.
 *
 * The two key getters are synchronous in midnight-js, so the keys are read
 * once when the wallet connects and passed in here rather than fetched per
 * call.
 */
export function browserWalletProviders(
  bridge: WalletBridge,
  keys: BrowserWalletKeys,
): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey: () => keys.coinPublicKey,
    getEncryptionPublicKey: () => keys.encryptionPublicKey,

    async balanceTx(tx: UnboundTransaction): Promise<FinalizedTransaction> {
      const balanced = await bridge.request('balanceUnsealedTransaction', toHex(tx.serialize()));
      // The wallet returns a sealed transaction: signed, proven and bound.
      return Transaction.deserialize(
        'signature',
        'proof',
        'binding',
        fromHex(balanced),
      ) as FinalizedTransaction;
    },

    async submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
      await bridge.request('submitTransaction', toHex(tx.serialize()));
      // The connector's submitTransaction resolves with nothing, so the
      // identifier comes from the transaction itself. `identifiers()` returns
      // every id the transaction can be watched by; the first is the one
      // midnight-js uses to await finalisation.
      const [id] = tx.identifiers();
      if (!id) throw new WalletBridgeError('submitted transaction exposes no identifier');
      return id;
    },
  };
}

/**
 * Run tasks one at a time.
 *
 * A redemption mutates the subject's private state and consumes a nullifier,
 * and the wallet provider below is swapped per request — two concurrent
 * redemptions would interleave both. The browser already prevents this for
 * one tab; this makes it true for two.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // Swallow rejections on the chain itself, or one failed task would reject
    // every task queued behind it.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * A wallet provider whose target can be swapped between redemptions.
 *
 * `findDeployedContract` binds its providers once, at startup, but which
 * wallet should balance and submit is a per-redemption choice. Rather than
 * re-resolving the contract for every request, the provider delegates to
 * whichever wallet the current redemption selected.
 *
 * Safe only because redemptions are serialised — see {@link Mutex}. The guard
 * below turns a violation of that invariant into a loud failure instead of a
 * transaction balanced by the wrong wallet.
 */
export class DelegatingWalletProvider implements WalletProvider, MidnightProvider {
  private delegate: (WalletProvider & MidnightProvider) | undefined;

  constructor(private readonly fallback: WalletProvider & MidnightProvider) {}

  /** Route this redemption through `delegate`; returns a restore function. */
  use(delegate: WalletProvider & MidnightProvider): () => void {
    if (this.delegate) {
      throw new Error('DelegatingWalletProvider is already in use — redemptions must be serialised');
    }
    this.delegate = delegate;
    return () => {
      this.delegate = undefined;
    };
  }

  /** The wallet currently answering: the delegate, or the server wallet. */
  private get active(): WalletProvider & MidnightProvider {
    return this.delegate ?? this.fallback;
  }

  getCoinPublicKey(): CoinPublicKey {
    return this.active.getCoinPublicKey();
  }

  getEncryptionPublicKey(): EncPublicKey {
    return this.active.getEncryptionPublicKey();
  }

  balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
    return this.active.balanceTx(tx, ttl);
  }

  submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
    return this.active.submitTx(tx);
  }
}
