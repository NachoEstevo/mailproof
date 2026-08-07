/**
 * The wallet bridge.
 *
 * Everything here is the plumbing between midnight-js and a connector wallet:
 * request/response correlation, timeouts, teardown, and the serialisation the
 * two sides agree on. A real wallet's own behaviour is not exercised — that
 * is the one link these tests cannot reach.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnight-ntwrk/wallet-sdk-address-format';

import {
  DelegatingWalletProvider,
  Mutex,
  WalletBridge,
  WalletBridgeError,
  browserWalletProviders,
  decodeWalletKeys,
  type WalletRequest,
} from '../wallet-bridge.js';

// ─── Request / response correlation ──────────────────────────────────────────

describe('WalletBridge', () => {
  function bridgeWithLog(timeoutMs = 50) {
    const sent: WalletRequest[] = [];
    const bridge = new WalletBridge((request) => sent.push(request), timeoutMs);
    return { bridge, sent };
  }

  it('emits a request and resolves with the answer', async () => {
    const { bridge, sent } = bridgeWithLog(5_000);
    const pending = bridge.request('balanceUnsealedTransaction', 'aabb');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 1, method: 'balanceUnsealedTransaction', tx: 'aabb' });

    expect(bridge.settle({ id: sent[0]!.id, tx: 'ccdd' })).toBe(true);
    await expect(pending).resolves.toBe('ccdd');
    expect(bridge.outstanding).toBe(0);
  });

  it('gives each request a distinct id and matches answers out of order', async () => {
    const { bridge, sent } = bridgeWithLog(5_000);
    const first = bridge.request('balanceUnsealedTransaction', '01');
    const second = bridge.request('submitTransaction', '02');

    expect(sent.map((r) => r.id)).toEqual([1, 2]);
    bridge.settle({ id: 2, tx: 'second' });
    bridge.settle({ id: 1, tx: 'first' });

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('rejects when the wallet reports an error', async () => {
    const { bridge, sent } = bridgeWithLog(5_000);
    const pending = bridge.request('submitTransaction', '01');
    bridge.settle({ id: sent[0]!.id, error: 'user declined' });
    await expect(pending).rejects.toThrow(/user declined/);
  });

  it('rejects a response carrying neither a transaction nor an error', async () => {
    const { bridge, sent } = bridgeWithLog(5_000);
    const pending = bridge.request('submitTransaction', '01');
    bridge.settle({ id: sent[0]!.id });
    await expect(pending).rejects.toThrow(/neither a transaction nor an error/);
  });

  it('ignores an unknown, duplicated or forged id', async () => {
    const { bridge, sent } = bridgeWithLog(5_000);
    const pending = bridge.request('submitTransaction', '01');

    expect(bridge.settle({ id: 999, tx: 'forged' })).toBe(false);
    expect(bridge.settle({ id: sent[0]!.id, tx: 'real' })).toBe(true);
    // The second delivery of the same id must not throw or double-resolve.
    expect(bridge.settle({ id: sent[0]!.id, tx: 'again' })).toBe(false);
    await expect(pending).resolves.toBe('real');
  });

  it('times out rather than hanging on an unanswered request', async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = bridgeWithLog(1_000);
      const pending = bridge.request('submitTransaction', '01');
      const assertion = expect(pending).rejects.toThrow(/did not answer submitTransaction in time/);
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails outstanding requests when closed, and refuses new ones', async () => {
    const { bridge } = bridgeWithLog(5_000);
    const pending = bridge.request('submitTransaction', '01');
    bridge.close();

    await expect(pending).rejects.toThrow(/connection closed/);
    await expect(bridge.request('submitTransaction', '02')).rejects.toThrow(/closed/);
    // Idempotent: teardown runs in a `finally` that can be reached twice.
    expect(() => bridge.close()).not.toThrow();
  });

  it('leaves no timer behind after settling', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, sent } = bridgeWithLog(1_000);
      const pending = bridge.request('submitTransaction', '01');
      bridge.settle({ id: sent[0]!.id, tx: 'ok' });
      await expect(pending).resolves.toBe('ok');
      // A surviving timer would reject an already-resolved promise.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bridge.outstanding).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Provider wiring ─────────────────────────────────────────────────────────

describe('browserWalletProviders', () => {
  const keys = { coinPublicKey: 'aa'.repeat(32), encryptionPublicKey: 'bb'.repeat(32) };

  it('reports the keys captured at connect time', () => {
    const providers = browserWalletProviders(new WalletBridge(() => {}), keys);
    expect(providers.getCoinPublicKey()).toBe(keys.coinPublicKey);
    expect(providers.getEncryptionPublicKey()).toBe(keys.encryptionPublicKey);
  });

  it('sends balanceTx to the wallet as hex', async () => {
    const sent: WalletRequest[] = [];
    const bridge = new WalletBridge((r) => sent.push(r), 5_000);
    const providers = browserWalletProviders(bridge, keys);

    const tx = { serialize: () => Uint8Array.from([0xde, 0xad, 0xbe, 0xef]) };
    // Deserialising a fabricated payload is expected to fail; what matters is
    // that the outbound half hexed the right bytes and named the right method.
    void providers.balanceTx(tx as never).catch(() => undefined);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'balanceUnsealedTransaction', tx: 'deadbeef' });
  });

  it('derives the transaction id itself, since submitTransaction returns nothing', async () => {
    const sent: WalletRequest[] = [];
    const bridge = new WalletBridge((r) => sent.push(r), 5_000);
    const providers = browserWalletProviders(bridge, keys);

    const tx = {
      serialize: () => Uint8Array.from([0x01, 0x02]),
      identifiers: () => ['tx-identifier'],
    };
    const pending = providers.submitTx(tx as never);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'submitTransaction', tx: '0102' });
    bridge.settle({ id: sent[0]!.id, tx: '0102' });
    await expect(pending).resolves.toBe('tx-identifier');
  });

  it('fails loudly when a submitted transaction exposes no identifier', async () => {
    const sent: WalletRequest[] = [];
    const bridge = new WalletBridge((r) => sent.push(r), 5_000);
    const providers = browserWalletProviders(bridge, keys);

    const tx = { serialize: () => Uint8Array.from([0x01]), identifiers: () => [] };
    const pending = providers.submitTx(tx as never);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    bridge.settle({ id: sent[0]!.id, tx: '01' });
    await expect(pending).rejects.toThrow(/no identifier/);
  });
});

// ─── Key decoding ────────────────────────────────────────────────────────────

describe('decodeWalletKeys', () => {
  it('round-trips the keys a wallet would report', () => {
    // The failure cases below throw either way, so on their own they pass even
    // when decoding is broken outright. Only encoding real keys and reading
    // them back exercises the path a connected wallet actually takes.
    const coin = Uint8Array.from({ length: 32 }, (_, i) => i);
    const enc = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
    const asString = (codec: { encode(n: string, d: unknown): { asString(): string } }, d: unknown) =>
      codec.encode('undeployed', d).asString();

    const decoded = decodeWalletKeys('undeployed', {
      coinPublicKey: asString(ShieldedCoinPublicKey.codec, new ShieldedCoinPublicKey(coin)),
      encryptionPublicKey: asString(
        ShieldedEncryptionPublicKey.codec,
        new ShieldedEncryptionPublicKey(enc),
      ),
    });

    expect(decoded.coinPublicKey).toBe(Buffer.from(coin).toString('hex'));
    expect(decoded.encryptionPublicKey).toBe(Buffer.from(enc).toString('hex'));
  });

  it('rejects a coin public key presented as an encryption key', () => {
    // Same length, same network, wrong type prefix — caught by the codec.
    const enc = ShieldedEncryptionPublicKey.codec
      .encode('undeployed', new ShieldedEncryptionPublicKey(new Uint8Array(32)))
      .asString();
    expect(() =>
      decodeWalletKeys('undeployed', { coinPublicKey: enc, encryptionPublicKey: enc }),
    ).toThrow(/coin public key/);
  });

  it('rejects malformed Bech32m with a message naming the field', () => {
    expect(() =>
      decodeWalletKeys('undeployed', {
        coinPublicKey: 'not-bech32m',
        encryptionPublicKey: 'also-not',
      }),
    ).toThrow(/coin public key/);
  });

  it('rejects keys encoded for a different network', () => {
    // Catching this here is the point: a wallet on the wrong network would
    // otherwise balance against a chain that has never seen our contract.
    expect(() =>
      decodeWalletKeys('undeployed', {
        coinPublicKey: 'mn_shield-cpk_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
        encryptionPublicKey: 'mn_shield-epk_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      }),
    ).toThrow(WalletBridgeError);
  });
});

// ─── Serialisation ───────────────────────────────────────────────────────────

describe('Mutex', () => {
  it('runs tasks one at a time, in order', async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const task = (name: string, ms: number) => async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name}:end`);
    };

    await Promise.all([mutex.run(task('a', 20)), mutex.run(task('b', 1))]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('a failed task does not poison the queue', async () => {
    const mutex = new Mutex();
    const failed = mutex.run(async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');
    await expect(mutex.run(async () => 'still works')).resolves.toBe('still works');
  });

  it('propagates a rejection to its own caller only', async () => {
    const mutex = new Mutex();
    const bad = mutex.run(() => Promise.reject(new Error('one')));
    const good = mutex.run(() => Promise.resolve('two'));
    await expect(bad).rejects.toThrow('one');
    await expect(good).resolves.toBe('two');
  });
});

// ─── Provider delegation ─────────────────────────────────────────────────────

describe('DelegatingWalletProvider', () => {
  const stub = (tag: string) => ({
    getCoinPublicKey: () => `${tag}-coin`,
    getEncryptionPublicKey: () => `${tag}-enc`,
    balanceTx: async () => `${tag}-balanced` as never,
    submitTx: async () => `${tag}-submitted`,
  });

  it('uses the fallback wallet when nothing is borrowed', async () => {
    const provider = new DelegatingWalletProvider(stub('server'));
    expect(provider.getCoinPublicKey()).toBe('server-coin');
    await expect(provider.submitTx({} as never)).resolves.toBe('server-submitted');
  });

  it('routes to the delegate while borrowed, and restores afterwards', async () => {
    const provider = new DelegatingWalletProvider(stub('server'));
    const release = provider.use(stub('browser'));

    expect(provider.getCoinPublicKey()).toBe('browser-coin');
    expect(provider.getEncryptionPublicKey()).toBe('browser-enc');
    await expect(provider.balanceTx({} as never)).resolves.toBe('browser-balanced');

    release();
    expect(provider.getCoinPublicKey()).toBe('server-coin');
  });

  it('refuses a second borrow instead of silently using the wrong wallet', () => {
    const provider = new DelegatingWalletProvider(stub('server'));
    provider.use(stub('browser'));
    expect(() => provider.use(stub('other'))).toThrow(/serialised/);
  });

  it('can be borrowed again after release', () => {
    const provider = new DelegatingWalletProvider(stub('server'));
    provider.use(stub('first'))();
    expect(() => provider.use(stub('second'))).not.toThrow();
  });
});
