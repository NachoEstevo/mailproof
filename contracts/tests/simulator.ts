/**
 * In-process harness for the MailProof contract.
 *
 * Runs circuits against the real compiled contract and the real on-chain
 * runtime — same ledger semantics, same asserts, same encodings — but without
 * a node, an indexer or a proof server. That keeps the C-xx matrix fast enough
 * to run on every change. Proof generation and submission are covered
 * separately by the end-to-end check.
 */
import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
  type CircuitContext,
  type JubjubPoint,
  type WitnessContext,
} from '@midnight-ntwrk/compact-runtime';

import {
  Contract,
  ledger,
  type ClaimAttestationV1,
  type Ledger,
  type SchnorrSignature,
} from '../managed/mailproof/contract/index.js';

/** Private state: just the subject's secret. */
export interface MailProofPrivateState {
  readonly subjectSecret: Uint8Array;
}

export interface DeployOptions {
  attestorPublicKey: JubjubPoint;
  campaignId: Uint8Array;
  blueprintIdHash: Uint8Array;
  issuerDomainHash: Uint8Array;
  claimType: bigint;
  subjectSecret: Uint8Array;
}

// A stand-in Zswap coin public key. The contract neither reads nor mints
// coins, so its value is irrelevant — it only has to be well-formed.
const COIN_PUBLIC_KEY = { bytes: new Uint8Array(32) };

export class MailProofSimulator {
  readonly contract: Contract<MailProofPrivateState>;
  private circuitContext: CircuitContext<MailProofPrivateState>;

  constructor(options: DeployOptions) {
    this.contract = new Contract<MailProofPrivateState>({
      subjectSecret: (
        context: WitnessContext<Ledger, MailProofPrivateState>,
      ): [MailProofPrivateState, Uint8Array] => [
        context.privateState,
        context.privateState.subjectSecret,
      ],
    });

    const initial = this.contract.initialState(
      createConstructorContext<MailProofPrivateState>(
        { subjectSecret: options.subjectSecret },
        COIN_PUBLIC_KEY,
      ),
      options.attestorPublicKey,
      options.campaignId,
      options.blueprintIdHash,
      options.issuerDomainHash,
      options.claimType,
    );

    this.circuitContext = createCircuitContext<MailProofPrivateState>(
      dummyContractAddress(),
      COIN_PUBLIC_KEY,
      initial.currentContractState,
      initial.currentPrivateState,
    );
  }

  /** Current public state. */
  get ledger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  /**
   * Call `redeemClaim`, committing the resulting state only on success.
   *
   * A failed call must leave the ledger untouched, which is what lets the
   * replay and tamper tests assert "nothing changed" after a rejection.
   */
  redeemClaim(claim: ClaimAttestationV1, signature: SchnorrSignature): void {
    const result = this.contract.impureCircuits.redeemClaim(
      this.circuitContext,
      claim,
      signature,
    );
    this.circuitContext = result.context;
  }

  /** Swap the subject secret, to model a different user redeeming (C-09). */
  withSubjectSecret(secret: Uint8Array): void {
    this.circuitContext = {
      ...this.circuitContext,
      currentPrivateState: { subjectSecret: secret },
    };
  }
}
