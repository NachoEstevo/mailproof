/**
 * Is this domain a university's?
 *
 * A campaign open to every institution still has to say what an institution
 * *is*, or it grants a student tier to gmail.com. There is no registry to ask,
 * so this reads the public suffix conventions that registrars actually
 * enforce: `.edu` is restricted to accredited US institutions, and dozens of
 * countries reserve a second-level `ac.` or `edu.` for the same purpose.
 *
 * Deliberately conservative. It refuses domains it cannot place, because the
 * cost of a false accept is a paid tier handed to anyone with a mailbox, and
 * the cost of a false reject is one line added to `ACADEMIC_SUFFIXES` for an
 * institution that asks. Argentina is the case in point: `udesa.edu.ar` passes
 * on `edu.ar`, while a hypothetical `udesa.com.ar` would not.
 */

/**
 * Suffixes reserved for education, as a domain must *end* with one.
 *
 * `edu` alone covers the US registry. The two-label entries are the academic
 * second-level domains their registries reserve; a plain country code is never
 * enough, or `anything.ar` would qualify.
 */
export const ACADEMIC_SUFFIXES: readonly string[] = [
  'edu',
  'ac.ae', 'edu.ar', 'edu.au', 'ac.at', 'ac.bd', 'ac.be', 'edu.bo', 'edu.br',
  'ac.cn', 'edu.cn', 'edu.co', 'ac.cr', 'edu.cu', 'ac.cy', 'edu.do',
  'edu.ec', 'edu.eg', 'edu.es', 'ac.fj', 'edu.gh', 'edu.gr', 'edu.gt',
  'edu.hk', 'edu.hn', 'ac.id', 'ac.il', 'ac.in', 'edu.in', 'ac.ir', 'edu.it',
  'ac.jp', 'ac.ke', 'ac.kr', 'edu.lb', 'edu.lk', 'edu.mx', 'edu.my',
  'ac.nz', 'edu.ni', 'edu.pa', 'edu.pe', 'edu.ph', 'edu.pk', 'edu.pl',
  'edu.pt', 'edu.py', 'edu.sa', 'edu.sg', 'edu.sv', 'ac.th', 'edu.tr',
  'ac.tz', 'edu.tw', 'ac.ug', 'ac.uk', 'edu.uy', 'edu.ve', 'ac.za',
];

/**
 * Whether `domain` belongs to an educational institution.
 *
 * Matches on label boundaries, so `notudesa.edu.ar` passes on `edu.ar` — it
 * genuinely is under that registry — while `myedu` or `fake-edu.com` do not.
 * The trailing dot of a fully-qualified name is tolerated.
 *
 * @param extra Domains to accept outright, for institutions whose mail lives
 * somewhere the suffix rules cannot see (`ethz.ch`, `mit.edu` needs nothing).
 */
export function isAcademicDomain(domain: string, extra: readonly string[] = []): boolean {
  const host = domain.trim().toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return false;

  if (extra.some((allowed) => {
    const a = allowed.trim().toLowerCase();
    return host === a || host.endsWith(`.${a}`);
  })) {
    return true;
  }

  return ACADEMIC_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}
