/**
 * Blueprint allowlist (§32.5).
 *
 * The attestor never accepts an arbitrary slug. Everything it is willing to
 * sign for is declared in config/blueprints.json and validated on load, so a
 * malformed entry fails at startup rather than at the first request.
 */
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

import { CLAIM_TYPE, type ClaimTypeName } from '../../../packages/shared/constants.js';
import { ATTESTOR_ERROR, AttestorError } from './errors.js';

const blueprintSchema = z
  .object({
    key: z.string().min(1),
    /**
     * "pending" means the slug is not yet ready to verify against. For a ZK
     * Email entry that is "not compiled on the registry"; for a DKIM-direct
     * entry it is "the DNS key has not been pinned and checked". Both
     * verifiers refuse pending entries.
     */
    status: z.enum(['pending', 'pinned']),
    slug: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+@v\d+$/, 'slug must be owner/Name@vN — never `latest`'),
    claimType: z.enum(Object.keys(CLAIM_TYPE) as [ClaimTypeName, ...ClaimTypeName[]]),
    issuerDomain: z.string().min(1),
    campaigns: z.array(z.string().min(1)).min(1),
    /**
     * What the blueprint proves, which is also what verifies it.
     *
     * `claim-in-body` — the message states a fact and the nullifier comes from
     * the message. One claim per email.
     *
     * `domain-membership` — the sender proved they control the mailbox, and
     * the nullifier comes from the mailbox. One claim per person. Needs no
     * marker fields, because the challenge code replaces them.
     *
     * Defaulted so every entry written before this existed keeps its meaning.
     */
    proves: z.enum(['claim-in-body', 'domain-membership']).default('claim-in-body'),
    requiredOutputs: z.array(z.string().min(1)).min(1).optional(),
    markerOutput: z.string().min(1).optional(),
    uniqueIdOutput: z.string().min(1).optional(),
    markerPattern: z.string().min(1).optional(),
    /**
     * Present only on DKIM-direct entries (D-007): the issuer's published
     * DKIM public key, pinned here so verification does not depend on DNS
     * being reachable — or unchanged — at claim time.
     */
    dkim: z
      .strictObject({
        dnsRecord: z
          .string()
          .min(1)
          .refine((r) => /(^|;)\s*p=/.test(r.replace(/"\s*"/g, '').replace(/"/g, '')), {
            message: 'dnsRecord must carry a p= public key tag',
          }),
        /**
         * The selector the pinned key belongs to. Optional but strongly
         * preferred: without it, a signature from the same domain under a
         * different selector is checked against the wrong key and reported as
         * tampering.
         */
        selector: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const complain = (message: string) => ctx.addIssue({ code: 'custom', message });

    if (entry.proves === 'domain-membership') {
      // A challenge code carries the claim here, so marker fields would be
      // decoration nothing reads — and configuration nothing reads is
      // configuration that quietly stops being true.
      for (const [name, value] of Object.entries({
        requiredOutputs: entry.requiredOutputs,
        markerOutput: entry.markerOutput,
        uniqueIdOutput: entry.uniqueIdOutput,
        markerPattern: entry.markerPattern,
      })) {
        if (value !== undefined) complain(`${name} means nothing on a domain-membership entry`);
      }
      if (!entry.dkim) {
        complain('domain-membership needs a pinned dkim.dnsRecord to verify against');
      }
      return;
    }

    if (!entry.requiredOutputs || !entry.markerOutput || !entry.uniqueIdOutput || !entry.markerPattern) {
      complain('claim-in-body needs requiredOutputs, markerOutput, uniqueIdOutput and markerPattern');
      return;
    }

    for (const name of [entry.markerOutput, entry.uniqueIdOutput]) {
      if (!entry.requiredOutputs.includes(name)) {
        complain(`requiredOutputs must include "${name}"`);
      }
    }
    try {
      new RegExp(entry.markerPattern);
    } catch {
      complain('markerPattern is not a valid regex');
    }
    // §41.8: a bare substring match accepts "has not been cancelled".
    if (!entry.markerPattern.startsWith('^') || !entry.markerPattern.endsWith('$')) {
      complain('markerPattern must be anchored with ^ and $ so a negated sentence cannot match');
    }
  });

const fileSchema = z.object({
  $comment: z.unknown().optional(),
  blueprints: z.array(blueprintSchema).min(1),
});

export interface BlueprintPolicy {
  readonly key: string;
  readonly status: 'pending' | 'pinned';
  readonly slug: string;
  readonly claimType: ClaimTypeName;
  readonly issuerDomain: string;
  readonly campaigns: readonly string[];
  /** What this blueprint proves, and therefore what verifies it. */
  readonly proves: 'claim-in-body' | 'domain-membership';
  /** Present only on `claim-in-body` entries. */
  readonly requiredOutputs?: readonly string[];
  readonly markerOutput?: string;
  readonly uniqueIdOutput?: string;
  readonly markerPattern?: string;
  /** Set only on DKIM-direct entries; routes verification (D-007). */
  readonly dkim?: { readonly dnsRecord: string; readonly selector?: string };
}

export class BlueprintAllowlist {
  private readonly bySlug: Map<string, BlueprintPolicy>;

  constructor(policies: readonly BlueprintPolicy[]) {
    this.bySlug = new Map(policies.map((p) => [p.slug, p]));
    if (this.bySlug.size !== policies.length) {
      throw new Error('blueprint allowlist contains duplicate slugs');
    }
  }

  /** Exact match only — no prefix, no version coercion. */
  require(slug: string): BlueprintPolicy {
    const policy = this.bySlug.get(slug);
    if (!policy) throw new AttestorError(ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED);
    return policy;
  }

  get slugs(): string[] {
    return [...this.bySlug.keys()];
  }
}

export function parseAllowlist(raw: unknown): BlueprintAllowlist {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid blueprint allowlist: ${parsed.error.issues[0]?.message}`);
  }
  return new BlueprintAllowlist(parsed.data.blueprints);
}

/**
 * A blueprint whose marker fields are present, narrowed at the one place that
 * knows they are.
 *
 * The fields are optional on the type because a domain-membership entry has no
 * use for them, but the two marker-based verifiers cannot work without them.
 * Narrowing here beats four non-null assertions scattered across two files,
 * each of which would be a silent crash the day an entry is misconfigured.
 */
export interface ClaimInBodyPolicy extends BlueprintPolicy {
  readonly requiredOutputs: readonly string[];
  readonly markerOutput: string;
  readonly uniqueIdOutput: string;
  readonly markerPattern: string;
}

export function requireClaimInBody(policy: BlueprintPolicy): ClaimInBodyPolicy {
  if (
    policy.requiredOutputs === undefined ||
    policy.markerOutput === undefined ||
    policy.uniqueIdOutput === undefined ||
    policy.markerPattern === undefined
  ) {
    throw new AttestorError(
      ATTESTOR_ERROR.BLUEPRINT_NOT_ALLOWED,
      `${policy.slug} is missing the marker fields a claim-in-body blueprint needs`,
    );
  }
  return policy as ClaimInBodyPolicy;
}

export function loadAllowlist(path: string): BlueprintAllowlist {
  return parseAllowlist(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * An allowlist that follows the file, re-read when its mtime moves.
 *
 * Opening a new demo round means a new campaign, and the attestor will not
 * sign for a campaign it has never heard of — without this, every round would
 * need the service restarted. The policy this reads is exactly as trusted as
 * before: anyone able to rewrite the file could already restart the process.
 *
 * A broken file keeps the last good policy rather than emptying it. Losing
 * the allowlist would turn a typo into "sign nothing", and the operator would
 * see it as every claim being rejected for the wrong reason.
 */
export function reloadingAllowlist(
  path: string,
  onReload: (allowlist: BlueprintAllowlist) => void = () => {},
): () => BlueprintAllowlist {
  let current = loadAllowlist(path);
  let seenMtimeMs = statSync(path).mtimeMs;

  return () => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      return current; // file momentarily gone: keep serving the last policy
    }
    if (mtimeMs === seenMtimeMs) return current;
    seenMtimeMs = mtimeMs;

    try {
      current = loadAllowlist(path);
      onReload(current);
    } catch {
      // Left on the last good policy on purpose; see above.
    }
    return current;
  };
}
