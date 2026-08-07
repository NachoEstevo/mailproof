/**
 * Stable error codes (§42.2).
 *
 * These are API: the CLI and the frontend map them to human messages, and the
 * tests assert on them. Add codes, never repurpose them.
 */
export const ATTESTOR_ERROR = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',
  BLUEPRINT_NOT_ALLOWED: 'BLUEPRINT_NOT_ALLOWED',
  CAMPAIGN_NOT_ALLOWED: 'CAMPAIGN_NOT_ALLOWED',
  PROOF_INVALID: 'PROOF_INVALID',
  PUBLIC_OUTPUT_MISSING: 'PUBLIC_OUTPUT_MISSING',
  SENDER_NOT_ALLOWED: 'SENDER_NOT_ALLOWED',
  CLAIM_NOT_SATISFIED: 'CLAIM_NOT_SATISFIED',
  INVALID_SUBJECT_BINDING: 'INVALID_SUBJECT_BINDING',
  NULLIFIER_DERIVATION_FAILED: 'NULLIFIER_DERIVATION_FAILED',
  SIGNING_UNAVAILABLE: 'SIGNING_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type AttestorErrorCode = (typeof ATTESTOR_ERROR)[keyof typeof ATTESTOR_ERROR];

const STATUS: Record<AttestorErrorCode, number> = {
  INVALID_REQUEST: 400,
  REQUEST_TOO_LARGE: 413,
  BLUEPRINT_NOT_ALLOWED: 422,
  CAMPAIGN_NOT_ALLOWED: 422,
  PROOF_INVALID: 422,
  PUBLIC_OUTPUT_MISSING: 422,
  SENDER_NOT_ALLOWED: 422,
  CLAIM_NOT_SATISFIED: 422,
  INVALID_SUBJECT_BINDING: 422,
  NULLIFIER_DERIVATION_FAILED: 500,
  SIGNING_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/**
 * A rejection the caller is allowed to see.
 *
 * `detail` is for operators and must never carry evidence: no raw email, no
 * booking reference, no proof bytes. Anything derived from the message body
 * belongs in neither the response nor the log.
 */
export class AttestorError extends Error {
  readonly code: AttestorErrorCode;
  readonly status: number;
  readonly detail: string | undefined;

  constructor(code: AttestorErrorCode, detail?: string) {
    super(code);
    this.name = 'AttestorError';
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }
}

/** Anything that is not an AttestorError is a bug; do not leak its message. */
export function toAttestorError(error: unknown): AttestorError {
  if (error instanceof AttestorError) return error;
  return new AttestorError(ATTESTOR_ERROR.INTERNAL_ERROR);
}
