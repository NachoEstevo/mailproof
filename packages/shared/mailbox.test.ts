/**
 * Address canonicalisation.
 *
 * Every case here is an attack on "one benefit per person": either two
 * spellings of one mailbox that would become two people, or a field crafted so
 * that a careless parser reads someone else's address out of it.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicaliseMailbox,
  domainAligns,
  domainOf,
  MailboxError,
  parseAddressList,
  soleMailbox,
} from './mailbox.js';

// ─── Reading the right address ───────────────────────────────────────────────

describe('parseAddressList', () => {
  it('takes the addr-spec, not a display name that looks like one', () => {
    // The classic: a regex scanning for the first `@` reads harvard.edu and
    // hands out a university tier to a Gmail account.
    expect(parseAddressList('"evil@harvard.edu" <me@gmail.com>')).toEqual([
      { localPart: 'me', domain: 'gmail.com' },
    ]);
  });

  it('discards comments, wherever they sit', () => {
    expect(parseAddressList('me@gmail.com (evil@harvard.edu)')).toEqual([
      { localPart: 'me', domain: 'gmail.com' },
    ]);
    expect(parseAddressList('(evil@harvard.edu) me@gmail.com')).toEqual([
      { localPart: 'me', domain: 'gmail.com' },
    ]);
    expect(parseAddressList('me@gmail.com (a (nested) comment)')).toEqual([
      { localPart: 'me', domain: 'gmail.com' },
    ]);
  });

  it('refuses a comment spliced into the middle of the address', () => {
    // `me(x)@gmail.com` is legal under the obsolete grammar and essentially
    // never occurs. Accepting it would mean the bytes that make up the address
    // and the bytes a human reads are different, which is the entire class of
    // confusion this parser exists to shut down — so it fails closed.
    expect(() => parseAddressList('me(a(nested)comment)@gmail.com')).toThrow(
      /unquoted whitespace/,
    );
  });

  it('reads a bare address with no angle brackets', () => {
    expect(parseAddressList('evil@harvard.edu')).toEqual([
      { localPart: 'evil', domain: 'harvard.edu' },
    ]);
  });

  it('is not fooled by structural characters inside quotes', () => {
    expect(parseAddressList('"a,b<c>d:e;" <me@gmail.com>')).toEqual([
      { localPart: 'me', domain: 'gmail.com' },
    ]);
  });

  it('unfolds a header split across lines', () => {
    expect(parseAddressList('"Long Name"\r\n <me@gmail.com>')).toEqual([
      { localPart: 'me', domain: 'gmail.com' },
    ]);
  });

  it('reports every mailbox when there are several', () => {
    expect(parseAddressList('a@x.com, b@y.com')).toHaveLength(2);
    expect(parseAddressList('Team: a@x.com, b@y.com;')).toHaveLength(2);
  });

  it('finds nothing in a group with no members', () => {
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
    expect(parseAddressList('')).toEqual([]);
  });

  it('refuses malformed fields instead of guessing', () => {
    expect(() => parseAddressList('"unterminated <me@gmail.com>')).toThrow(MailboxError);
    expect(() => parseAddressList('me@gmail.com (unterminated')).toThrow(MailboxError);
    expect(() => parseAddressList('<me@gmail.com')).toThrow(MailboxError);
    expect(() => parseAddressList('me at gmail.com')).toThrow(MailboxError);
    expect(() => parseAddressList('nodomain')).toThrow(/local@domain/);
    expect(() => parseAddressList('@gmail.com')).toThrow(/local@domain/);
    expect(() => parseAddressList('me@')).toThrow(/local@domain/);
  });
});

// ─── One spelling per person ─────────────────────────────────────────────────

describe('canonicaliseMailbox', () => {
  const canon = (field: string) => soleMailbox(field);

  it('folds the four spellings of one Gmail inbox onto one', () => {
    // 16,384 dot-variants of a 15-character local part, times any tag, times
    // case. Without this, one person farms the free tier indefinitely.
    const spellings = [
      'anademo@gmail.com',
      'AnaDemo@Gmail.com',
      'a.n.a.d.e.m.o@gmail.com',
      'anademo+lain@gmail.com',
      'A.na.Demo+whatever@GMAIL.COM',
    ];
    expect(new Set(spellings.map(canon))).toEqual(new Set(['anademo@gmail.com']));
  });

  it('keeps dots outside the providers that ignore them', () => {
    // Assuming otherwise would merge two colleagues into one nullifier and
    // lock the second out permanently.
    expect(canon('a.b@udesa.edu.ar')).toBe('a.b@udesa.edu.ar');
    expect(canon('ab@udesa.edu.ar')).toBe('ab@udesa.edu.ar');
    expect(canon('a.b@udesa.edu.ar')).not.toBe(canon('ab@udesa.edu.ar'));
  });

  it('strips the tag everywhere, since that is the anti-farming default', () => {
    expect(canon('ana+2026@udesa.edu.ar')).toBe('ana@udesa.edu.ar');
  });

  it('can keep the tag for a domain that routes on it', () => {
    const spec = parseAddressList('ana+2026@corp.example')[0]!;
    expect(canonicaliseMailbox(spec, { plusAddressing: 'keep' })).toBe('ana+2026@corp.example');
  });

  it('accepts extra dot-insensitive domains from configuration', () => {
    const spec = parseAddressList('a.n.a@corp.example')[0]!;
    expect(canonicaliseMailbox(spec, { dotInsensitiveDomains: ['CORP.example'] })).toBe(
      'ana@corp.example',
    );
  });

  it('renders an international domain in one form only', () => {
    expect(canon('ana@ÜNI.example')).toBe(canon('ana@xn--ni-wka.example'));
  });

  it('ignores a trailing root dot', () => {
    expect(canon('ana@udesa.edu.ar.')).toBe('ana@udesa.edu.ar');
  });

  it('refuses what cannot stand for a person', () => {
    expect(() => canon('+tag@gmail.com')).toThrow(/only a tag/);
    expect(() => canon('ana@localhost')).toThrow(/no dot/);
    expect(() => canon('ana@[192.0.2.1]')).toThrow(/literal/);
    expect(() => canon('ana@a..b.com')).toThrow(MailboxError);
  });
});

// ─── Exactly one ─────────────────────────────────────────────────────────────

describe('soleMailbox', () => {
  it('refuses a field naming more than one mailbox', () => {
    // "The first recipient" is a choice the sender makes, not a fact about
    // whoever is claiming.
    expect(() => soleMailbox('a@x.com, b@y.com')).toThrow(/2 mailboxes/);
    expect(() => soleMailbox('Team: a@x.com, b@y.com;')).toThrow(/2 mailboxes/);
  });

  it('refuses a field naming none', () => {
    expect(() => soleMailbox('undisclosed-recipients:;')).toThrow(/no mailbox/);
    expect(() => soleMailbox('   ')).toThrow(/no mailbox/);
  });

  it('returns the domain half on request', () => {
    expect(domainOf(soleMailbox('Ana <ana@Udesa.edu.ar>'))).toBe('udesa.edu.ar');
  });
});

// ─── Who is allowed to vouch ─────────────────────────────────────────────────

describe('domainAligns', () => {
  it('accepts the domain itself and its subdomains', () => {
    expect(domainAligns('udesa.edu.ar', 'udesa.edu.ar')).toBe(true);
    expect(domainAligns('udesa.edu.ar', 'mail.udesa.edu.ar')).toBe(true);
  });

  it('rejects a domain that merely ends the same way', () => {
    // Without the leading dot, `notudesa.edu.ar` passes a suffix test and
    // anyone who registers it mints university tiers.
    expect(domainAligns('udesa.edu.ar', 'notudesa.edu.ar')).toBe(false);
    expect(domainAligns('udesa.edu.ar', 'udesa.edu.ar.evil.com')).toBe(false);
    expect(domainAligns('mail.udesa.edu.ar', 'udesa.edu.ar')).toBe(false);
  });

  it('ignores case and a trailing root dot', () => {
    expect(domainAligns('UDESA.edu.ar', 'ana.UDESA.edu.ar.')).toBe(true);
  });
});
