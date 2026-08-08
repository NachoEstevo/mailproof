import { describe, expect, it } from 'vitest';

import { isAcademicDomain } from './academic.js';

describe('isAcademicDomain', () => {
  it('accepts the registries that reserve a label for education', () => {
    for (const domain of ['mit.edu', 'udesa.edu.ar', 'ox.ac.uk', 'u-tokyo.ac.jp', 'unam.edu.mx']) {
      expect(isAcademicDomain(domain), domain).toBe(true);
    }
  });

  it('refuses the free providers a student tier would leak to', () => {
    for (const domain of ['gmail.com', 'outlook.com', 'proton.me', 'hotmail.com.ar']) {
      expect(isAcademicDomain(domain), domain).toBe(false);
    }
  });

  it('matches on label boundaries, not on substrings', () => {
    // The whole point of the boundary: a registrant cannot buy their way in
    // by putting the suffix in the middle of a name they control.
    expect(isAcademicDomain('myedu')).toBe(false);
    expect(isAcademicDomain('fake-edu.com')).toBe(false);
    expect(isAcademicDomain('notedu.com.ar')).toBe(false);
    // But a genuine registration under the academic suffix does qualify, even
    // if its name looks like another institution's — that is the registry's
    // job to police, not ours.
    expect(isAcademicDomain('notudesa.edu.ar')).toBe(true);
  });

  it('is not fooled by a bare country code', () => {
    expect(isAcademicDomain('cualquiercosa.ar')).toBe(false);
    expect(isAcademicDomain('shop.uk')).toBe(false);
  });

  it('normalises case and a trailing dot', () => {
    expect(isAcademicDomain('UDESA.EDU.AR.')).toBe(true);
  });

  it('accepts institutions named explicitly, and their subdomains', () => {
    expect(isAcademicDomain('ethz.ch')).toBe(false);
    expect(isAcademicDomain('ethz.ch', ['ethz.ch'])).toBe(true);
    expect(isAcademicDomain('mail.ethz.ch', ['ethz.ch'])).toBe(true);
    // The boundary applies to the extras too.
    expect(isAcademicDomain('notethz.ch', ['ethz.ch'])).toBe(false);
  });

  it('refuses nothing at all', () => {
    expect(isAcademicDomain('')).toBe(false);
    expect(isAcademicDomain('   ')).toBe(false);
  });
});
