/**
 * MailProof — prove a domain, once per person, without seeing the address.
 *
 * See `packages/sdk/README.md` for the integration walk-through.
 */
export { createMailProof } from './mailproof.js';
export type {
  DomainKey,
  MailProof,
  MailProofConfig,
  TrustDisclosure,
  VerificationRefusal,
  VerificationResult,
  VerificationStart,
} from './mailproof.js';

export { httpRedemptionClient, RedemptionError } from './redemption.js';
export type {
  HttpRedemptionOptions,
  RedemptionClient,
  RedemptionOutcome,
  RedemptionReceipt,
  RedemptionRequest,
} from './redemption.js';

export { FREE_MAIL_PROVIDERS, isFreeMailProvider, resolveTier } from '../shared/tiers.js';
export type { TierMatch, TierRule } from '../shared/tiers.js';
