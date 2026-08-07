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
 * Undo the escaping Gmail applies when it prints the source into a page.
 *
 * Not DOMParser: Gmail enforces Trusted Types, and parseFromString throws
 * under that policy. These five are the whole set Gmail emits, and getting
 * the order wrong (&amp; before the others) would corrupt the bytes DKIM
 * signed — which is why &amp; is last.
 */
function unescapeHtml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Where the original bytes can be had, best first.
 *
 * "Download Original" serves the message verbatim — no HTML, no escaping, no
 * session key. "Show original" needs `ik` and prints the source into a <pre>,
 * so it is the fallback. The two identify the message differently: `th` takes
 * the hex id Gmail puts in the DOM, `permmsgid` takes it in decimal.
 */
function sources(ik, message) {
  const base = `${location.origin}/mail/u/${message.accountIndex}`;
  const hex = message.legacyMessageId;
  const decimal = BigInt(`0x${hex}`).toString(10);

  const attempts = [
    { url: `${base}?view=att&th=${hex}&attid=0&disp=comp&safe=1&zw`, extract: (t) => t },
  ];
  if (ik) {
    attempts.push({
      url: `${base}/?ui=2&ik=${encodeURIComponent(ik)}&view=om&permmsgid=msg-f:${decimal}`,
      extract: (text) => {
        const match = /<pre[^>]*id="raw_message_text"[^>]*>([\s\S]*?)<\/pre>/.exec(text);
        return match ? unescapeHtml(match[1]) : null;
      },
    });
  }
  return attempts;
}

async function capture(ik) {
  const message = openMessage();
  if (!message) {
    return { ok: false, reason: 'no-message', detail: 'Open a single email first.' };
  }

  const failures = [];
  for (const { url, extract } of sources(ik, message)) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        failures.push(`HTTP ${response.status}`);
        continue;
      }
      const raw = extract(await response.text());
      if (raw && looksLikeRfc822(raw)) return { ok: true, raw, subject: message.subject };
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
