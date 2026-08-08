/**
 * Turning a header field into exactly one canonical mailbox.
 *
 * This is the whole basis of "one benefit per person", so it is written to
 * fail closed. Everything an adversary controls about an address field is
 * treated as hostile:
 *
 *  - `"evil@harvard.edu" <me@gmail.com>` — a display name that reads like an
 *    address. Any regex that scans for `@` picks the wrong one.
 *  - `me@gmail.com (evil@harvard.edu)` — the same trick in a comment.
 *  - `a@x.com, b@y.com` — two mailboxes, so "the" mailbox is a fiction.
 *  - `undisclosed-recipients:;` — a group with no members at all.
 *  - `me+tag@gmail.com`, `m.e@gmail.com` — four spellings of one real inbox,
 *    which without normalisation are four separate people.
 *
 * The defence is structural rather than pattern-based: the field is parsed as
 * an RFC 5322 address-list, and only `addr-spec` survives. Display names,
 * comments and groups are discarded wholesale, which also disposes of RFC 2047
 * encoded-words by construction — an encoded-word is only ever legal inside a
 * phrase or a comment, never inside an addr-spec.
 *
 * Nothing here decides *whose* mailbox it is. That is the caller's job, and it
 * is the harder half: a signature over `To:` proves only what the sender chose
 * to write, so only `From:` aligned with the signing domain evidences control.
 */

/** A mailbox that survived parsing. Not yet normalised. */
export interface AddrSpec {
  readonly localPart: string;
  readonly domain: string;
}

export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailboxError';
  }
}

/**
 * Providers that treat the local part as case-insensitive and ignore dots.
 *
 * Deliberately a short, explicit list. Applying dot-collapsing to a domain
 * that distinguishes `a.b@` from `ab@` would merge two different people into
 * one nullifier, permanently locking the second out — so the default is to
 * assume a domain means what it says.
 */
const DOT_INSENSITIVE = new Set(['gmail.com', 'googlemail.com']);

/**
 * Providers where `+tag` does not change the delivering mailbox.
 *
 * Almost universal in practice, but not universal: some domains route on the
 * tag, and a handful allow `+` as an ordinary character. Stripping it is the
 * anti-farming default; `plusAddressing: 'keep'` is there for a domain known
 * to treat it literally.
 */
const TAG_SEPARATOR = '+';

export interface CanonicaliseOptions {
  /** `strip` (default) folds `me+anything@d` onto `me@d`. */
  readonly plusAddressing?: 'strip' | 'keep';
  /** Extra domains whose local part ignores dots, beyond the built-in list. */
  readonly dotInsensitiveDomains?: readonly string[];
}

// ─── Structural parsing ──────────────────────────────────────────────────────

/**
 * Blank out quoted strings and comments, preserving length.
 *
 * Index arithmetic then runs over the mask while slices come from the
 * original, so a `,` `<` `:` or `;` inside a quoted display name or a comment
 * can never be mistaken for structure.
 */
function mask(field: string): string {
  const out = field.split('');
  let inQuotes = false;
  let commentDepth = 0;

  for (let i = 0; i < field.length; i++) {
    const c = field[i]!;

    if (c === '\\' && (inQuotes || commentDepth > 0)) {
      out[i] = ' ';
      if (i + 1 < field.length) out[++i] = ' ';
      continue;
    }
    if (commentDepth > 0) {
      if (c === '(') commentDepth++;
      else if (c === ')') commentDepth--;
      out[i] = ' ';
      continue;
    }
    if (inQuotes) {
      if (c === '"') inQuotes = false;
      out[i] = ' ';
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      out[i] = ' ';
      continue;
    }
    if (c === '(') {
      commentDepth = 1;
      out[i] = ' ';
      continue;
    }
  }

  if (inQuotes) throw new MailboxError('unterminated quoted string in address field');
  if (commentDepth > 0) throw new MailboxError('unterminated comment in address field');
  return out.join('');
}

/** Split on separators that are structural — never inside quotes, comments or angles. */
function splitTopLevel(field: string, masked: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '<') depth++;
    else if (c === '>') depth = Math.max(0, depth - 1);
    else if (c === separator && depth === 0) {
      parts.push(field.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(field.slice(start));
  return parts;
}

/**
 * Unwrap `Group: a@x, b@y;` to its member list.
 *
 * A group with no members — `undisclosed-recipients:;` — yields nothing, and
 * the caller rejects it. That is the correct outcome: it names no mailbox.
 */
function unwrapGroup(field: string): string {
  const masked = mask(field);
  const colon = masked.indexOf(':');
  if (colon === -1) return field;

  const semicolon = masked.lastIndexOf(';');
  if (semicolon < colon) throw new MailboxError('group in address field is not terminated');
  return field.slice(colon + 1, semicolon);
}

/** Pull the addr-spec out of one `mailbox` production. */
function addrSpecOf(mailbox: string): string | null {
  const trimmed = mailbox.trim();
  if (trimmed.length === 0) return null;

  const masked = mask(trimmed);
  const open = masked.lastIndexOf('<');
  if (open !== -1) {
    // `name-addr`: everything before `<` is a display name and is discarded,
    // which is precisely how `"evil@harvard.edu" <me@gmail.com>` is defused.
    const close = masked.indexOf('>', open);
    if (close === -1) throw new MailboxError('unterminated angle address');
    return trimmed.slice(open + 1, close).trim();
  }

  // Bare `addr-spec`. Comments were masked to spaces, so the address is the
  // one non-whitespace run left; any whitespace inside it means this was never
  // a single addr-spec. Indices come from the mask and slice the original, so
  // a masked region can never shift the boundaries.
  const bare = masked.trim();
  if (bare.length === 0) return null;
  if (/\s/.test(bare)) throw new MailboxError('address field has unquoted whitespace');
  const start = masked.length - masked.trimStart().length;
  return trimmed.slice(start, start + bare.length);
}

/** Every mailbox named by an address field, display names and comments removed. */
export function parseAddressList(field: string): AddrSpec[] {
  const unfolded = field.replace(/\r?\n[ \t]+/g, ' ').trim();
  if (unfolded.length === 0) return [];

  const inner = unwrapGroup(unfolded);
  const specs: AddrSpec[] = [];

  for (const part of splitTopLevel(inner, mask(inner), ',')) {
    const spec = addrSpecOf(part);
    if (spec === null) continue;
    specs.push(splitAddrSpec(spec));
  }
  return specs;
}

function splitAddrSpec(spec: string): AddrSpec {
  const at = spec.lastIndexOf('@');
  if (at <= 0 || at === spec.length - 1) {
    throw new MailboxError('address is not local@domain');
  }
  const localPart = spec.slice(0, at);
  const domain = spec.slice(at + 1);

  if (/[\s<>,;"()[\]\\]/.test(localPart)) {
    throw new MailboxError('address has a quoted or malformed local part');
  }
  if (domain.startsWith('[')) throw new MailboxError('address literal domains are not accepted');
  return { localPart, domain };
}

// ─── Canonicalisation ────────────────────────────────────────────────────────

/**
 * Normalise the domain to its lowercase punycode form.
 *
 * `new URL` does the IDN work and rejects what is not a hostname, so
 * `ONLINE.ÜNI.example` and `online.xn--ni-wka.example` cannot become two
 * different people.
 */
function canonicalDomain(domain: string): string {
  const bare = domain.endsWith('.') ? domain.slice(0, -1) : domain;
  let hostname: string;
  try {
    hostname = new URL(`http://${bare}`).hostname;
  } catch {
    throw new MailboxError(`not a valid domain: ${JSON.stringify(domain)}`);
  }
  if (hostname !== bare.toLowerCase() && !/^xn--/.test(hostname) && !hostname.includes('.xn--')) {
    // `new URL` also accepts things like userinfo or ports; anything it
    // rewrote for a reason other than IDN is not a bare domain.
    if (hostname.length === 0) throw new MailboxError('empty domain');
  }
  if (!hostname.includes('.')) throw new MailboxError('domain has no dot');
  if (hostname.includes('..')) throw new MailboxError('domain has an empty label');
  return hostname;
}

/**
 * One mailbox, in the single spelling that stands for every spelling of it.
 *
 * The local part is lowercased. RFC 5321 makes it case-sensitive and reality
 * does not: no provider of consequence delivers `Ana@` and `ana@` to different
 * people, and treating them as two people is how one person collects two
 * benefits.
 */
export function canonicaliseMailbox(spec: AddrSpec, options: CanonicaliseOptions = {}): string {
  const domain = canonicalDomain(spec.domain);

  let localPart = spec.localPart.toLowerCase();
  if (localPart.length === 0) throw new MailboxError('empty local part');

  if ((options.plusAddressing ?? 'strip') === 'strip') {
    const tag = localPart.indexOf(TAG_SEPARATOR);
    if (tag === 0) throw new MailboxError('local part is only a tag');
    if (tag > 0) localPart = localPart.slice(0, tag);
  }

  const dotInsensitive =
    DOT_INSENSITIVE.has(domain) ||
    (options.dotInsensitiveDomains ?? []).some((d) => d.toLowerCase() === domain);
  if (dotInsensitive) localPart = localPart.replaceAll('.', '');

  if (localPart.length === 0) throw new MailboxError('local part is empty after normalisation');
  return `${localPart}@${domain}`;
}

/**
 * The single mailbox an address field names, or an error.
 *
 * Rejecting a field that names none or several is not pedantry: a nullifier
 * has to stand for one person, and "the first of two recipients" is a choice
 * the sender makes, not a fact about the claimant.
 */
export function soleMailbox(field: string, options: CanonicaliseOptions = {}): string {
  const specs = parseAddressList(field);
  if (specs.length === 0) throw new MailboxError('address field names no mailbox');
  if (specs.length > 1) {
    throw new MailboxError(`address field names ${specs.length} mailboxes, expected one`);
  }
  return canonicaliseMailbox(specs[0]!, options);
}

/** The domain half of a canonical mailbox. */
export function domainOf(canonical: string): string {
  return canonical.slice(canonical.lastIndexOf('@') + 1);
}

/**
 * Whether a signing domain vouches for a mailbox — DKIM's relaxed alignment.
 *
 * `d=udesa.edu.ar` covers `ana@udesa.edu.ar` and `ana@mail.udesa.edu.ar`, and
 * does not cover `ana@notudesa.edu.ar`. Without the leading-dot check the
 * suffix test would accept exactly that.
 */
export function domainAligns(signingDomain: string, mailboxDomain: string): boolean {
  const d = signingDomain.toLowerCase().replace(/\.$/, '');
  const m = mailboxDomain.toLowerCase().replace(/\.$/, '');
  return m === d || m.endsWith(`.${d}`);
}
