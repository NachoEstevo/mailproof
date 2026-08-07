/**
 * The Gmail capture helpers.
 *
 * MV3 content scripts are classic scripts — no imports — so the shipped file
 * cannot be split into modules to be tested. It is run here in a `vm` with
 * the three globals it touches stubbed, which has the advantage that these
 * tests exercise the exact bytes Chrome loads.
 *
 * What they cover is the part that is ours: escaping, validation, and how a
 * message id becomes a URL. Whether Gmail still answers those URLs is a
 * question only real Gmail can settle, and the panel falls back to a file
 * picker for exactly that reason.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../content-gmail.js'),
  'utf8',
);

interface ContentScript {
  looksLikeRfc822(text: unknown): boolean;
  unescapeHtml(text: string): string;
  accountIndex(): string;
  sources(
    ik: string | null,
    message: { accountIndex: string; legacyMessageId: string },
  ): Array<{ url: string; extract(text: string): string | null }>;
}

function load(pathname = '/mail/u/0/'): ContentScript {
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener: () => {} } } },
    location: { origin: 'https://mail.google.com', pathname },
    document: { querySelector: () => null, querySelectorAll: () => [] },
  });
  vm.runInContext(SOURCE, context);
  return context as unknown as ContentScript;
}

const script = load();

// ─── Escaping ────────────────────────────────────────────────────────────────

describe('unescapeHtml', () => {
  it('restores the entities Gmail prints into the viewer', () => {
    expect(script.unescapeHtml('&lt;a@b&gt; &quot;x&quot; &#39;y&#39;')).toBe(`<a@b> "x" 'y'`);
  });

  it('resolves &amp; last, so an escaped entity stays escaped', () => {
    // Getting this order wrong turns "&amp;lt;" into "<" and changes bytes
    // that DKIM signed, which fails as a body hash mismatch much later.
    expect(script.unescapeHtml('&amp;lt;')).toBe('&lt;');
    expect(script.unescapeHtml('a&amp;b')).toBe('a&b');
  });

  it('leaves an already-raw message alone', () => {
    const raw = 'From: a@b\r\nSubject: x\r\n\r\nbody & more\r\n';
    expect(script.unescapeHtml(raw)).toBe(raw);
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe('looksLikeRfc822', () => {
  const message =
    'DKIM-Signature: v=1; a=rsa-sha256\r\nFrom: a@b.example\r\nSubject: hello\r\n\r\nbody text here\r\n';

  it('accepts a message with a header block', () => {
    expect(script.looksLikeRfc822(message)).toBe(true);
    expect(script.looksLikeRfc822(message.replace(/\r\n/g, '\n'))).toBe(true);
  });

  it('rejects the HTML Gmail serves when the id is wrong', () => {
    expect(
      script.looksLikeRfc822(
        '<html><head><title>Mensaje original</title></head><body>El mensaje solicitado no existe.</body></html>',
      ),
    ).toBe(false);
  });

  it('rejects a body with no headers, and anything too short to be a message', () => {
    expect(script.looksLikeRfc822('Your flight MP401 has been cancelled.\n\nBooking: X')).toBe(
      false,
    );
    expect(script.looksLikeRfc822('From: a@b\r\n\r\nx')).toBe(false);
    expect(script.looksLikeRfc822(null)).toBe(false);
  });

  it('rejects headers that are not the ones identifying a message', () => {
    const noIdentity = `Content-Type: text/plain\r\nX-Whatever: ${'y'.repeat(80)}\r\n\r\nbody\r\n`;
    expect(script.looksLikeRfc822(noIdentity)).toBe(false);
  });
});

// ─── URLs ────────────────────────────────────────────────────────────────────

describe('sources', () => {
  const message = { accountIndex: '0', legacyMessageId: '19fdd64a3270230c' };

  it('leads with the endpoint that serves the message verbatim', () => {
    const [first] = script.sources('ik-value', message);
    expect(first.url).toContain('view=att');
    expect(first.url).toContain('th=19fdd64a3270230c');
    expect(first.extract('anything at all')).toBe('anything at all');
  });

  it('asks the viewer for the id in decimal, not the hex the DOM carries', () => {
    // Gmail answers "el mensaje solicitado no existe" to the hex form, with
    // HTTP 200, so this is silent until nothing verifies.
    const [, viewer] = script.sources('ik-value', message);
    expect(viewer.url).toContain('permmsgid=msg-f:1872888634218128140');
    expect(viewer.url).not.toContain('19fdd64a3270230c');
    expect(viewer.url).toContain('ik=ik-value');
  });

  it('still offers the verbatim endpoint when the session key is missing', () => {
    const attempts = script.sources(null, message);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.url).toContain('view=att');
  });

  it('pulls the source out of the viewer page', () => {
    const [, viewer] = script.sources('ik', message);
    const page = `<div><pre class="raw_message_text" id="raw_message_text">From: &lt;a@b&gt;\nSubject: x\n\nbody</pre></div>`;
    expect(viewer.extract(page)).toBe('From: <a@b>\nSubject: x\n\nbody');
    expect(viewer.extract('<html>no source here</html>')).toBeNull();
  });

  it('honours the account the reader is signed in as', () => {
    expect(load('/mail/u/3/').accountIndex()).toBe('3');
    expect(load('/mail/').accountIndex()).toBe('0');
  });
});
