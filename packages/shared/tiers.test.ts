/**
 * Domain tiers.
 *
 * The interesting cases are the lookalikes: a rule that can be satisfied by
 * registering a similar-looking domain hands out benefits to whoever thought
 * of it first.
 */
import { describe, expect, it } from 'vitest';

import { explicitDomains, isFreeMailProvider, resolveTier, type TierRule } from './tiers.js';

const RULES: TierRule<'STUDENT' | 'CORPORATE'>[] = [
  { id: 'STUDENT', domains: ['udesa.edu.ar', 'uba.ar'] },
  { id: 'STUDENT', suffixes: ['.edu', '.edu.ar', '.ac.uk'] },
  { id: 'CORPORATE', notFreeProvider: true },
];

const tier = (domain: string) => resolveTier(domain, RULES)?.id ?? null;

describe('lookalikes', () => {
  it('a suffix rule is not satisfied by a domain that merely ends the same way', () => {
    // `.edu.ar` must not be matched by `notaedu.ar`, or anyone can buy the
    // student tier for the price of a domain.
    expect(tier('udesa.edu.ar')).toBe('STUDENT');
    expect(tier('notaedu.ar')).toBe('CORPORATE');
    expect(tier('fakeedu.com')).toBe('CORPORATE');
  });

  it('an explicit domain rule is not satisfied by a prefixed impostor', () => {
    expect(resolveTier('notudesa.edu.ar', [{ id: 'STUDENT', domains: ['udesa.edu.ar'] }])).toBeNull();
  });

  it('covers real subdomains of what it names', () => {
    expect(tier('mail.udesa.edu.ar')).toBe('STUDENT');
    expect(tier('alumnos.uba.ar')).toBe('STUDENT');
  });
});

describe('order decides', () => {
  it('an explicit domain beats a later catch-all', () => {
    const match = resolveTier('udesa.edu.ar', RULES);
    expect(match).toEqual({ id: 'STUDENT', ruleIndex: 0, reason: 'domain' });
  });

  it('a suffix beats a later catch-all', () => {
    expect(resolveTier('harvard.edu', RULES)).toEqual({
      id: 'STUDENT',
      ruleIndex: 1,
      reason: 'suffix',
    });
  });

  it('explains itself, so a grant can be audited', () => {
    expect(resolveTier('mercadolibre.com', RULES)).toEqual({
      id: 'CORPORATE',
      ruleIndex: 2,
      reason: 'not-free-provider',
    });
  });
});

describe('free providers', () => {
  it('does not hand a corporate tier to a webmail account', () => {
    for (const domain of ['gmail.com', 'outlook.com', 'proton.me', 'yahoo.com.ar', 'icloud.com']) {
      expect(tier(domain)).toBeNull();
    }
  });

  it('treats disposable addresses as free', () => {
    expect(tier('mailinator.com')).toBeNull();
    expect(tier('yopmail.com')).toBeNull();
  });

  it('counts a subdomain of a provider as that provider', () => {
    expect(isFreeMailProvider('mail.gmail.com')).toBe(true);
  });

  it('accepts extra providers from configuration', () => {
    const rules: TierRule[] = [{ id: 'CORP', notFreeProvider: true, alsoFreeProviders: ['unmail.ar'] }];
    expect(resolveTier('unmail.ar', rules)).toBeNull();
    expect(resolveTier('otra.ar', rules)?.id).toBe('CORP');
  });
});

describe('no tier is a real answer', () => {
  it('returns nothing when nothing matches, rather than a default', () => {
    // "Unrecognised means generic" is how a domain registered this morning
    // collects a benefit.
    expect(resolveTier('gmail.com', [{ id: 'STUDENT', suffixes: ['.edu'] }])).toBeNull();
    expect(resolveTier('', RULES)).toBeNull();
  });

  it('is case- and trailing-dot-insensitive', () => {
    expect(tier('UDESA.edu.ar.')).toBe('STUDENT');
  });
});

describe('explicitDomains', () => {
  it('lists what a deployment must pin DNS keys for', () => {
    expect(explicitDomains(RULES).sort()).toEqual(['uba.ar', 'udesa.edu.ar']);
  });
});
