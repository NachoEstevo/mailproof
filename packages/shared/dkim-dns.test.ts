import { describe, expect, it } from 'vitest';

import { DkimDnsError, resolveDkimKey } from './dkim-dns.js';

const KEY = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A';

function resolverReturning(records: string[][]) {
  const asked: string[] = [];
  const resolveTxt = async (name: string) => {
    asked.push(name);
    return records;
  };
  return { resolveTxt, asked };
}

describe('resolveDkimKey', () => {
  it('asks the name RFC 6376 defines', async () => {
    const { resolveTxt, asked } = resolverReturning([[KEY]]);
    await resolveDkimKey('google', 'udesa.edu.ar', { resolveTxt });
    expect(asked).toEqual(['google._domainkey.udesa.edu.ar']);
  });

  it('joins a record split across chunks', async () => {
    // DNS caps a string at 255 octets and a key record always exceeds it, so
    // a resolver that returned only the first chunk would fail on every real
    // domain while passing any short test fixture.
    const { resolveTxt } = resolverReturning([['v=DKIM1; k=rsa; ', 'p=MIIBIjANBg']]);
    expect(await resolveDkimKey('s', 'x.edu', { resolveTxt })).toBe('v=DKIM1; k=rsa; p=MIIBIjANBg');
  });

  it('ignores TXT records that are not keys', async () => {
    const { resolveTxt } = resolverReturning([['v=spf1 include:_spf.google.com ~all'], [KEY]]);
    expect(await resolveDkimKey('s', 'x.edu', { resolveTxt })).toBe(KEY);
  });

  it('refuses a revoked key rather than verifying against nothing', async () => {
    const { resolveTxt } = resolverReturning([['v=DKIM1; k=rsa; p=']]);
    await expect(resolveDkimKey('s', 'x.edu', { resolveTxt })).rejects.toMatchObject({
      failure: 'NOT_A_KEY',
    });
  });

  it('refuses to choose between two key records', async () => {
    const { resolveTxt } = resolverReturning([[KEY], [`${KEY}other`]]);
    await expect(resolveDkimKey('s', 'x.edu', { resolveTxt })).rejects.toMatchObject({
      failure: 'NOT_A_KEY',
    });
  });

  it('reports an absent record as absent, not as a lookup failure', async () => {
    const resolveTxt = async () => {
      throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    await expect(resolveDkimKey('s', 'x.edu', { resolveTxt })).rejects.toMatchObject({
      failure: 'NO_RECORD',
    });
  });

  it('never lets a crafted signature steer the query', async () => {
    // `d=` and `s=` come from the message. A value carrying a dot-segment, a
    // space or a newline must be refused before it reaches the resolver, or
    // the lookup is no longer for the domain that signed.
    const { resolveTxt, asked } = resolverReturning([[KEY]]);
    for (const bad of ['a b', 'a\nb', '../evil', 'x..y', '-lead', 'trail-', '']) {
      await expect(
        resolveDkimKey(bad, 'x.edu', { resolveTxt }),
        `selector ${JSON.stringify(bad)}`,
      ).rejects.toBeInstanceOf(DkimDnsError);
      await expect(
        resolveDkimKey('s', bad, { resolveTxt }),
        `domain ${JSON.stringify(bad)}`,
      ).rejects.toBeInstanceOf(DkimDnsError);
    }
    expect(asked).toEqual([]);
  });
});
