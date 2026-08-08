/**
 * Deciding what a domain means.
 *
 * A proof says "this person controls a mailbox at D". What that is worth is
 * entirely a property of D — specifically, of how hard a mailbox there is to
 * obtain. `@gmail.com` costs thirty seconds; `@udesa.edu.ar` requires being a
 * student; `@mercadolibre.com` requires working there. Same mechanism, three
 * very different guarantees.
 *
 * The useful part is that somebody else already did the hard work. `.edu` is
 * administered by EDUCAUSE for accredited institutions; `.edu.ar` is issued by
 * NIC Argentina only to recognised educational bodies. A suffix rule is
 * therefore not a heuristic, it is a delegation to a registrar that verifies.
 *
 * Rules are evaluated in the order given and the first match wins, so an
 * explicit domain always beats a suffix and a suffix always beats a catch-all.
 * A domain matching nothing gets no tier — never a default one, because the
 * failure mode of "unrecognised means generic" is handing benefits to whoever
 * registered a cheap domain this morning.
 */

/**
 * Domains where anyone can have a mailbox in a minute.
 *
 * This list cannot be complete and must not be relied on as if it were. It is
 * a floor, not a fence: `notFreeProvider` using it is a friction tax on
 * casual farming, not an anti-sybil control, because a $1/yr domain with
 * catch-all MX defeats it outright. Anything that actually matters should be
 * gated on an explicit list.
 */
export const FREE_MAIL_PROVIDERS: readonly string[] = [
  // Google, Microsoft, Yahoo, Apple
  'gmail.com', 'googlemail.com',
  'outlook.com', 'outlook.es', 'hotmail.com', 'hotmail.es', 'hotmail.com.ar',
  'live.com', 'live.com.ar', 'live.com.mx', 'msn.com',
  'yahoo.com', 'yahoo.com.ar', 'yahoo.com.mx', 'yahoo.es', 'yahoo.co.uk', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com',
  // Privacy-first and independents
  'proton.me', 'protonmail.com', 'pm.me',
  'tutanota.com', 'tuta.io',
  'fastmail.com', 'hey.com',
  'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'zoho.com',
  'aol.com', 'yandex.com', 'yandex.ru',
  // Large regional providers
  'qq.com', '163.com', '126.com', 'naver.com', 'daum.net',
  // Disposable — a floor here too; new ones appear daily
  'mailinator.com', 'guerrillamail.com', 'sharklasers.com', '10minutemail.com',
  'temp-mail.org', 'yopmail.com', 'throwaway.email', 'trashmail.com',
  'getnada.com', 'dispostable.com', 'maildrop.cc', 'mailnesia.com',
];

const FREE_SET = new Set(FREE_MAIL_PROVIDERS);

/** One rule. The first that matches decides. */
export interface TierRule<T extends string = string> {
  /** What this rule grants. */
  readonly id: T;
  /** Exact domains, matched including their subdomains. */
  readonly domains?: readonly string[];
  /** Suffixes such as `.edu.ar`. Matched on label boundaries only. */
  readonly suffixes?: readonly string[];
  /** Matches any domain that is not a known free or disposable provider. */
  readonly notFreeProvider?: boolean;
  /** Extra providers to treat as free, on top of the built-in list. */
  readonly alsoFreeProviders?: readonly string[];
}

export interface TierMatch<T extends string = string> {
  readonly id: T;
  /** Which rule matched, by index, so a decision can be explained. */
  readonly ruleIndex: number;
  /** Why it matched, for logs and for the integrator's own audit trail. */
  readonly reason: 'domain' | 'suffix' | 'not-free-provider';
}

const normalise = (domain: string): string => domain.toLowerCase().replace(/\.$/, '');

/** `udesa.edu.ar` covers `mail.udesa.edu.ar` but never `notudesa.edu.ar`. */
function underDomain(domain: string, parent: string): boolean {
  const d = normalise(domain);
  const p = normalise(parent);
  return d === p || d.endsWith(`.${p}`);
}

/**
 * `.edu.ar` matches `udesa.edu.ar`, not `notaedu.ar`.
 *
 * A bare `endsWith` would accept the second, and a suffix rule that can be
 * satisfied by registering a lookalike is not a rule at all.
 */
function underSuffix(domain: string, suffix: string): boolean {
  const d = normalise(domain);
  const s = normalise(suffix).replace(/^\./, '');
  return d === s || d.endsWith(`.${s}`);
}

export function isFreeMailProvider(domain: string, extra: readonly string[] = []): boolean {
  const d = normalise(domain);
  if (FREE_SET.has(d)) return true;
  if (extra.some((e) => normalise(e) === d)) return true;
  // A subdomain of a free provider is still that provider.
  return (
    FREE_MAIL_PROVIDERS.some((p) => underDomain(d, p)) || extra.some((e) => underDomain(d, e))
  );
}

/**
 * The tier a domain earns, or nothing.
 *
 * Returning nothing is a real answer and the safe default. An integrator that
 * wants "everyone else gets the basic tier" writes that rule explicitly, and
 * then owns what it means.
 */
export function resolveTier<T extends string>(
  domain: string,
  rules: readonly TierRule<T>[],
): TierMatch<T> | null {
  const d = normalise(domain);
  if (d.length === 0) return null;

  for (const [ruleIndex, rule] of rules.entries()) {
    if (rule.domains?.some((candidate) => underDomain(d, candidate))) {
      return { id: rule.id, ruleIndex, reason: 'domain' };
    }
    if (rule.suffixes?.some((suffix) => underSuffix(d, suffix))) {
      return { id: rule.id, ruleIndex, reason: 'suffix' };
    }
    if (rule.notFreeProvider && !isFreeMailProvider(d, rule.alsoFreeProviders)) {
      return { id: rule.id, ruleIndex, reason: 'not-free-provider' };
    }
  }
  return null;
}

/** Every domain a rule set names explicitly — the set worth pinning DNS keys for. */
export function explicitDomains(rules: readonly TierRule[]): string[] {
  return [...new Set(rules.flatMap((rule) => (rule.domains ?? []).map(normalise)))];
}
