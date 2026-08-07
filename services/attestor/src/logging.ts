/**
 * Logging with an allowlist, not a denylist (§19.7, §41.17, §45.2).
 *
 * A denylist fails open: the first time someone logs a new object, whatever
 * it contains ends up on disk. Here only the fields named below are ever
 * emitted, so a raw email, a booking reference or a proof cannot leak by
 * accident — there is no code path that would write them.
 */
import { randomUUID } from 'node:crypto';

export interface AttestLogFields {
  requestId: string;
  blueprintSlug?: string;
  claimType?: string;
  /** Truncated. Enough to correlate, not enough to reconstruct. */
  proofDigest?: string;
  claimNullifier?: string;
  result: 'ok' | 'rejected' | 'error';
  errorCode?: string;
  detail?: string;
  durationMs?: number;
}

/** Correlation id. Random, never derived from the request (§45.3). */
export function newRequestId(): string {
  return randomUUID();
}

function truncate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length <= 18 ? value : `${value.slice(0, 18)}…`;
}

export type Sink = (line: string) => void;

export function logAttest(fields: AttestLogFields, sink: Sink = console.log): void {
  // Built field by field from a fixed list — never by spreading an input.
  const safe: Record<string, string | number> = {
    requestId: fields.requestId,
    result: fields.result,
  };
  if (fields.blueprintSlug) safe.blueprintSlug = fields.blueprintSlug;
  if (fields.claimType) safe.claimType = fields.claimType;
  const digest = truncate(fields.proofDigest);
  if (digest) safe.proofDigest = digest;
  const nullifier = truncate(fields.claimNullifier);
  if (nullifier) safe.claimNullifier = nullifier;
  if (fields.errorCode) safe.errorCode = fields.errorCode;
  if (fields.detail) safe.detail = fields.detail;
  if (fields.durationMs !== undefined) safe.durationMs = fields.durationMs;

  sink(JSON.stringify(safe));
}
