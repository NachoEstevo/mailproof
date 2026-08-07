/**
 * Reads the raw source of the message currently open in Gmail.
 *
 * This is the whole reason MailProof is an extension rather than a page: the
 * DKIM signature only survives in the original RFC822 bytes, so a web app has
 * to ask the user to click "Show original", save a file, and drag it back.
 * Here the same bytes are one click away.
 *
 * Gmail's markup is not a contract and it changes. Every step below therefore
 * has more than one strategy and a validation gate, and the panel falls back
 * to a file picker whenever this returns nothing. It is an accelerator, never
 * the only way in.
 */

/** A header block, a blank line, and something that identifies a message. */
function looksLikeRfc822(text) {
  if (typeof text !== 'string' || text.length < 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9-]*:/.test(text.trimStart())) return false;
  const separator = text.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n';
  const headerBlock = text.slice(0, Math.max(0, text.indexOf(separator)));
  if (headerBlock.length === 0) return false;
  return /^(message-id|from|dkim-signature)\s*:/im.test(headerBlock);
}

/** Gmail's account index, from /mail/u/<n>/. Defaults to the first account. */
function accountIndex() {
  return /\/mail\/u\/(\d+)\//.exec(location.pathname)?.[1] ?? '0';
}

/**
 * The message the reader is actually looking at.
 *
 * A thread renders every message, most of them collapsed. The open one is the
 * last whose body container is laid out, which survives Gmail renaming its
 * classes in a way that hunting for `.h7` does not.
 */
function openMessage() {
  const candidates = Array.from(document.querySelectorAll('[data-legacy-message-id]'));
  if (candidates.length === 0) return null;

  const expanded = candidates.filter((node) => {
    const body = node.querySelector('.a3s, [data-message-id] .ii');
    return body !== null && body.offsetParent !== null;
  });

  const chosen = (expanded.length > 0 ? expanded : candidates).at(-1);
  const legacyMessageId = chosen?.getAttribute('data-legacy-message-id') ?? '';
  if (!/^[0-9a-f]+$/i.test(legacyMessageId)) return null;

  return {
    legacyMessageId,
    accountIndex: accountIndex(),
    // Shown in the panel so the user can confirm we grabbed the right message
    // before anything is sent anywhere.
    subject: document.querySelector('h2[data-thread-perm-id]')?.textContent?.trim() ?? '',
    messageCount: candidates.length,
  };
}

/**
 * Pull the original source out of whatever "Show original" answers with.
 *
 * That endpoint has returned plain text in some Gmail builds and an HTML
 * viewer in others, so accept both rather than betting on one.
 */
async function readSource(response) {
  const text = await response.text();
  if (looksLikeRfc822(text)) return text;

  const doc = new DOMParser().parseFromString(text, 'text/html');
  for (const pre of doc.querySelectorAll('pre')) {
    const candidate = pre.textContent ?? '';
    if (looksLikeRfc822(candidate)) return candidate;
  }

  // The viewer offers a "Download Original" link that serves message/rfc822.
  const download = doc.querySelector('a[href*="view=att"]');
  if (download) {
    const url = new URL(download.getAttribute('href'), location.origin).toString();
    const raw = await fetch(url, { credentials: 'include' }).then((r) => r.text());
    if (looksLikeRfc822(raw)) return raw;
  }

  return null;
}

/**
 * `ik` is Gmail's per-session request key. It lives in a page global, so the
 * panel reads it from the MAIN world and hands it in — a content script runs
 * isolated and cannot see it.
 */
function sourceUrls(ik, message) {
  const base = `${location.origin}/mail/u/${message.accountIndex}/`;
  const permmsgid = `msg-f:${message.legacyMessageId}`;
  return [
    `${base}?ui=2&ik=${encodeURIComponent(ik)}&view=om&permmsgid=${permmsgid}`,
    `${base}?view=om&permmsgid=${permmsgid}`,
  ];
}

async function capture(ik) {
  const message = openMessage();
  if (!message) {
    return { ok: false, reason: 'no-message', detail: 'Open a single email first.' };
  }
  if (!ik) {
    return { ok: false, reason: 'no-session-key', detail: "Could not read Gmail's session key." };
  }

  const failures = [];
  for (const url of sourceUrls(ik, message)) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        failures.push(`HTTP ${response.status}`);
        continue;
      }
      const raw = await readSource(response);
      if (raw) return { ok: true, raw, subject: message.subject };
      failures.push('response was not a raw message');
    } catch (error) {
      failures.push(error instanceof Error ? error.message : 'fetch failed');
    }
  }

  return {
    ok: false,
    reason: 'unreadable',
    detail: `Gmail did not return the original source (${failures.join('; ')}).`,
  };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type === 'mailproof:locate') {
    sendResponse({ ok: true, message: openMessage() });
    return false;
  }
  if (request?.type === 'mailproof:capture') {
    capture(request.ik).then(sendResponse);
    return true; // response arrives asynchronously
  }
  return false;
});
