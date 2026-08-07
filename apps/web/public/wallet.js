/**
 * DApp Connector glue.
 *
 * The only part of MailProof that runs midnight-specific code in the browser.
 * Everything heavier — building the contract call, proving it — stays on the
 * server; see apps/web/wallet-bridge.ts for why. What is left here is small
 * enough to read in one sitting, which is the point.
 *
 * Wallets inject themselves at `window.midnight` as a map of uuid → API.
 */

/** Wallets currently injected, newest API version first for a stable order. */
export function discoverWallets() {
  const injected = window.midnight ?? {};
  return Object.entries(injected)
    .filter(([, api]) => api && typeof api.connect === 'function')
    .map(([uuid, api]) => ({
      uuid,
      rdns: String(api.rdns ?? uuid),
      // Rendered as a text node by the caller, never as HTML: the name comes
      // from an extension and is not trusted.
      name: String(api.name ?? 'Unknown wallet'),
      apiVersion: String(api.apiVersion ?? '?'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class WalletError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WalletError';
  }
}

/**
 * Connect, then refuse anything that is not on our network.
 *
 * This check is the difference between a clear error and a baffling one. A
 * wallet on another network balances against a UTXO set that does not contain
 * our contract, and the transaction fails much later with something that
 * reads like a contract bug.
 */
export async function connectWallet(uuid, expectedNetworkId) {
  const api = window.midnight?.[uuid];
  if (!api) throw new WalletError('that wallet is no longer available');

  let wallet;
  try {
    wallet = await api.connect(expectedNetworkId);
  } catch (error) {
    throw new WalletError(error?.message ?? 'the wallet refused the connection');
  }

  // Asking up front lets the wallet bundle its permission prompts into one.
  await wallet
    .hintUsage(['getShieldedAddresses', 'balanceUnsealedTransaction', 'submitTransaction'])
    .catch(() => {
      /* Optional: a wallet may prompt per call instead. */
    });

  const configuration = await wallet.getConfiguration();
  if (configuration.networkId !== expectedNetworkId) {
    throw new WalletError(
      `wallet is on "${configuration.networkId}" but this deployment is on ` +
        `"${expectedNetworkId}". Switch networks in the wallet and reconnect.`,
    );
  }

  const addresses = await wallet.getShieldedAddresses();
  return {
    uuid,
    name: String(api.name ?? uuid),
    networkId: configuration.networkId,
    shieldedAddress: addresses.shieldedAddress,
    coinPublicKey: addresses.shieldedCoinPublicKey,
    encryptionPublicKey: addresses.shieldedEncryptionPublicKey,
    api: wallet,
  };
}

/**
 * Answer one `wallet-request` frame from the server.
 *
 * Returns the shape `/api/wallet-response` expects. Errors are returned
 * rather than thrown so that a declined signature travels back to the server
 * as a rejection it can report, instead of stalling until the bridge's
 * timeout.
 */
export async function handleWalletRequest(wallet, request) {
  try {
    switch (request.method) {
      case 'balanceUnsealedTransaction': {
        const { tx } = await wallet.api.balanceUnsealedTransaction(request.tx);
        return { id: request.id, tx };
      }
      case 'submitTransaction': {
        await wallet.api.submitTransaction(request.tx);
        // Nothing to return; the server derives the id from the transaction.
        return { id: request.id, tx: request.tx };
      }
      default:
        return { id: request.id, error: `unsupported wallet method "${request.method}"` };
    }
  } catch (error) {
    return { id: request.id, error: error?.message ?? 'the wallet rejected the request' };
  }
}
