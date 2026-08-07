import { describe, expect, it } from 'vitest';

import {
  dkimDnsRecordName,
  getHeader,
  getHeaders,
  parseDkimSignature,
  parseDkimSignatures,
  parseEml,
  selectSignatureForDomain,
} from './eml.js';

/** Synthetic. Not a real message, not a real key, not a real signature. */
const SAMPLE = [
  'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;',
  '\td=demo-airline.example; s=mp2026; t=1786000000;',
  '\th=from:to:subject:date:message-id;',
  '\tbh=2jmj7l5rSw0yVb/vlWAYkK/YBwk=;',
  '\tb=Zm9vYmFyYmF6cXV4Y29ycmdlZ3JhdWx0',
  '\t  d2FsZG9mcmVkdGh1ZA==',
  'From: Demo Air <noreply@demo-airline.example>',
  'To: ana.demo@example.test',
  'Subject: Your flight MP401 has been cancelled',
  'Date: Fri, 07 Aug 2026 09:15:00 +0000',
  'Message-ID: <mp401-8f2a19@demo-airline.example>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello Ana Demo,',
  '',
  'Your flight MP401 has been cancelled.',
  '',
  'Booking reference: MP-8F2A19',
  'Claim code: CLAIM-DEMO-0001',
  '',
].join('\r\n');

describe('parseEml', () => {
  it('splits headers from body at the blank line', () => {
    const eml = parseEml(SAMPLE);
    expect(eml.body).toContain('Your flight MP401 has been cancelled.');
    expect(eml.body).not.toContain('Subject:');
  });

  it('detects CRLF line endings', () => {
    expect(parseEml(SAMPLE).lineEnding).toBe('CRLF');
  });

  it('flags a message that was rewritten to bare LF', () => {
    // Worth reporting: an editor that strips CR breaks the body hash.
    expect(parseEml(SAMPLE.replace(/\r\n/g, '\n')).lineEnding).toBe('LF');
  });

  it('unfolds continuation lines', () => {
    const eml = parseEml(SAMPLE);
    const dkim = getHeader(eml, 'dkim-signature');
    expect(dkim?.value).toContain('d=demo-airline.example');
    expect(dkim?.value).not.toContain('\n');
  });

  it('preserves the raw field, folding included', () => {
    const dkim = getHeader(parseEml(SAMPLE), 'dkim-signature');
    expect(dkim?.raw).toContain('\r\n\t');
  });

  it('looks headers up case-insensitively but keeps the original name', () => {
    const eml = parseEml(SAMPLE);
    expect(getHeader(eml, 'MESSAGE-ID')?.rawName).toBe('Message-ID');
  });

  it('reports sizes', () => {
    const eml = parseEml(SAMPLE);
    expect(eml.headerBlockBytes).toBeGreaterThan(0);
    expect(eml.bodyBytes).toBeGreaterThan(0);
  });

  it('rejects a message with no header/body separator', () => {
    expect(() => parseEml('From: a@b.example\r\nSubject: no body')).toThrow(/no blank line/);
  });
});

describe('parseDkimSignature', () => {
  it('extracts the signing domain and selector', () => {
    const [sig] = parseDkimSignatures(parseEml(SAMPLE));
    expect(sig?.domain).toBe('demo-airline.example');
    expect(sig?.selector).toBe('mp2026');
    expect(sig?.algorithm).toBe('rsa-sha256');
    expect(sig?.version).toBe('1');
  });

  it('lists the signed headers in order', () => {
    const [sig] = parseDkimSignatures(parseEml(SAMPLE));
    expect(sig?.signedHeaders).toEqual(['from', 'to', 'subject', 'date', 'message-id']);
  });

  it('strips folding whitespace out of base64 values', () => {
    const [sig] = parseDkimSignatures(parseEml(SAMPLE));
    // b= was folded across two lines; the value must rejoin without spaces.
    expect(sig?.signature).toBe('Zm9vYmFyYmF6cXV4Y29ycmdlZ3JhdWx0d2FsZG9mcmVkdGh1ZA==');
    expect(sig?.signature).not.toMatch(/\s/);
  });

  it('expands a bare c= tag to its implied body algorithm', () => {
    const header = {
      name: 'dkim-signature',
      rawName: 'DKIM-Signature',
      value: 'v=1; c=relaxed; d=x.example; s=k',
      raw: '',
    };
    // RFC 6376: an omitted body algorithm means simple.
    expect(parseDkimSignature(header).canonicalization).toBe('relaxed/simple');
  });

  it('defaults canonicalisation to simple/simple when c= is absent', () => {
    const header = {
      name: 'dkim-signature',
      rawName: 'DKIM-Signature',
      value: 'v=1; d=x.example; s=k',
      raw: '',
    };
    expect(parseDkimSignature(header).canonicalization).toBe('simple/simple');
  });

  it('reports an l= body-length limit when the signer set one', () => {
    const header = {
      name: 'dkim-signature',
      rawName: 'DKIM-Signature',
      value: 'v=1; d=x.example; s=k; l=1024',
      raw: '',
    };
    // Matters: content past l= is unsigned and can be appended freely.
    expect(parseDkimSignature(header).bodyLength).toBe(1024);
  });
});

describe('selecting among multiple signatures', () => {
  const MULTI = [
    'DKIM-Signature: v=1; a=rsa-sha256; d=list.example; s=relay; h=from; bh=x; b=y',
    'DKIM-Signature: v=1; a=rsa-sha256; d=demo-airline.example; s=mp2026; h=from; bh=x; b=y',
    'From: Demo Air <noreply@demo-airline.example>',
    '',
    'body',
    '',
  ].join('\r\n');

  it('finds both signatures', () => {
    expect(getHeaders(parseEml(MULTI), 'dkim-signature')).toHaveLength(2);
  });

  it('picks by domain rather than by position', () => {
    // The forwarder signed first. Taking signatures[0] would authenticate the
    // mailing list instead of the airline (§20.8).
    const signatures = parseDkimSignatures(parseEml(MULTI));
    expect(signatures[0]?.domain).toBe('list.example');

    const chosen = selectSignatureForDomain(signatures, 'demo-airline.example');
    expect(chosen?.selector).toBe('mp2026');
  });

  it('returns nothing when the expected domain did not sign', () => {
    const signatures = parseDkimSignatures(parseEml(MULTI));
    expect(selectSignatureForDomain(signatures, 'not-present.example')).toBeUndefined();
  });
});

describe('dkimDnsRecordName', () => {
  it('builds the _domainkey record name', () => {
    const [sig] = parseDkimSignatures(parseEml(SAMPLE));
    expect(dkimDnsRecordName(sig!)).toBe('mp2026._domainkey.demo-airline.example');
  });
});
