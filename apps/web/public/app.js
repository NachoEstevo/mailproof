/**
 * Demo UI.
 *
 * Plain ES modules, no build step — the fewer things between this file and the
 * browser, the fewer ways a live demo can fail.
 *
 * Two rules the UI must never break:
 *  - It never says "verified" before the chain has confirmed it.
 *  - A rejected replay is a result, not a crash. That rejection is the point.
 */

import { connectWallet, discoverWallets, handleWalletRequest } from '/wallet.js';

const $ = (id) => document.getElementById(id);

const els = {
  chips: $('chips'),
  fixtureBanner: $('fixture-banner'),
  dropzone: $('dropzone'),
  loadSample: $('load-sample'),
  loadDemoEmail: $('load-demo-email'),
  inspection: $('inspection'),
  emlSummary: $('eml-summary'),
  dkim: $('dkim'),
  stages: $('stages'),
  redeem: $('redeem'),
  replay: $('replay'),
  result: $('result'),
  onchain: $('onchain'),
  wallet: $('wallet'),
  walletStatus: $('wallet-status'),
  walletConnect: $('wallet-connect'),
};

let state = null;

// The message being redeemed. Kept in memory only; sent to the local backend
// when the user asks to verify, never anywhere else.
let currentEml = null;

// A redemption takes ~25s on chain. Loading another email mid-flight would
// re-enable the button, start a second stream over the first one's display,
// and race two submissions — so evidence input is frozen while one runs.
let redeeming = false;

// The connected DApp Connector wallet, or null for the server's devnet
// wallet. Connecting is optional: the demo runs either way, and the UI says
// which one paid.
let wallet = null;

// ── Chain state ────────────────────────────────────────────────────────────

async function refreshState() {
  // A 500 from Fastify is still valid JSON, so `.json()` succeeding proves
  // nothing about the shape. Check the status and the fields we go on to read
  // — otherwise a downed indexer surfaces as a TypeError and the chips sit on
  // "connecting…" forever instead of saying the backend is unreachable.
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`/api/state returned ${response.status}`);
    const body = await response.json();
    if (!body || typeof body !== 'object' || !body.attestor) throw new Error('malformed state');
    state = body;
  } catch {
    state = null;
    els.chips.innerHTML = '<span class="chip bad">backend offline</span>';
    els.fixtureBanner.hidden = true;
    els.loadDemoEmail.hidden = true;
    return;
  }

  const attestorChip = !state.attestor.online
    ? '<span class="chip bad">attestor offline</span>'
    : state.attestor.cryptographicVerification
      ? '<span class="chip ok">attestor verifying</span>'
      : '<span class="chip warn">attestor: fixture</span>';

  els.chips.innerHTML = [
    `<span class="chip">${escapeHtml(state.network)}</span>`,
    `<span class="chip">${escapeHtml(state.campaign)}</span>`,
    attestorChip,
    `<span class="chip ok">${escapeHtml(state.approvedClaimCount)} approved</span>`,
  ].join('');

  els.fixtureBanner.hidden = !state.attestor.online || state.attestor.cryptographicVerification;
  els.loadDemoEmail.hidden = !state.demoEmailAvailable;

  els.onchain.innerHTML = [
    `contract  ${state.contractAddress.slice(0, 20)}…`,
    `blueprint ${state.blueprint}`,
    `issuer    ${state.issuerDomain}`,
    `claims    ${state.approvedClaimCount} approved · ${state.nullifiersUsed} nullifiers consumed`,
  ]
    .map((line) => `<div>${escapeHtml(line)}</div>`)
    .join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// ── Wallet ─────────────────────────────────────────────────────────────────

/**
 * Render the wallet panel.
 *
 * Wallet names come from browser extensions, so they are written with
 * `textContent` rather than into `innerHTML`.
 */
function renderWallet(message, kind) {
  const available = discoverWallets();
  els.walletStatus.textContent = '';
  els.walletStatus.className = `wallet-status${kind ? ` ${kind}` : ''}`;

  if (wallet) {
    els.walletStatus.textContent = `${wallet.name} · ${shorten(wallet.shieldedAddress)}`;
    els.walletConnect.textContent = 'Disconnect';
    els.walletConnect.hidden = false;
  } else if (available.length === 0) {
    els.walletStatus.textContent =
      message ?? 'No Midnight wallet detected — this demo will pay from its own devnet wallet.';
    els.walletConnect.hidden = true;
  } else {
    els.walletStatus.textContent = message ?? `${available.length} wallet(s) available`;
    els.walletConnect.textContent = 'Connect wallet';
    els.walletConnect.hidden = false;
  }
}

function shorten(value) {
  return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

async function toggleWallet() {
  if (redeeming) return;
  if (wallet) {
    wallet = null;
    renderWallet('Disconnected — the demo will pay from its own devnet wallet.');
    return;
  }

  const available = discoverWallets();
  if (available.length === 0) return;

  els.walletConnect.disabled = true;
  try {
    // One wallet is the overwhelmingly common case; with several, the first
    // by name is taken rather than adding a picker to a demo screen.
    wallet = await connectWallet(available[0].uuid, state?.walletNetworkId ?? 'undeployed');
    renderWallet(null, 'ok');
  } catch (error) {
    wallet = null;
    renderWallet(error?.message ?? 'could not connect', 'bad');
  } finally {
    els.walletConnect.disabled = false;
  }
}

// ── Email inspection ───────────────────────────────────────────────────────

async function inspect(text) {
  if (redeeming) return;

  const response = await fetch('/api/inspect', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: text,
  });
  const report = await response.json();

  if (!report.ok) {
    currentEml = null;
    els.inspection.hidden = false;
    els.emlSummary.innerHTML = `<dt>Error</dt><dd>${escapeHtml(report.error)}</dd>`;
    els.dkim.innerHTML = '';
    els.redeem.disabled = true;
    // Nothing left to replay; leaving the button up makes a dead click look
    // like a broken demo.
    els.replay.hidden = true;
    return;
  }
  currentEml = text;

  // Only shapes and lengths — never the values. This panel gets projected.
  const present = (h) => (h ? `present · ${h.length} chars` : 'absent');
  els.emlSummary.innerHTML = [
    ['Line endings', report.lineEnding],
    ['Header fields', String(report.headerFields)],
    ['Body', `${report.bodyBytes} bytes`],
    ['From', present(report.headers.from)],
    ['Subject', present(report.headers.subject)],
    ['Message-ID', present(report.headers.messageId)],
  ]
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('');

  els.dkim.innerHTML = report.signatures.length
    ? report.signatures
        .map((sig) => {
          const match = sig.domain === report.expectedIssuer;
          return `
            <div class="sig ${match ? 'match' : ''}">
              <div class="domain">d=${escapeHtml(sig.domain ?? '?')} ${match ? '✓ expected issuer' : ''}</div>
              <div class="meta">s=${escapeHtml(sig.selector ?? '?')} · ${escapeHtml(sig.algorithm ?? '?')} · c=${escapeHtml(sig.canonicalization)}</div>
              <div class="meta">signs: ${escapeHtml(sig.signedHeaders.join(', ') || 'nothing')}</div>
              ${sig.bodyLengthLimit ? `<div class="meta">⚠ l=${sig.bodyLengthLimit} — content past this byte is unsigned</div>` : ''}
            </div>`;
        })
        .join('')
    : '<div class="sig"><div class="domain">No DKIM signature</div><div class="meta">This message cannot back a proof.</div></div>';

  els.inspection.hidden = false;
  els.redeem.disabled = !report.matchesExpectedIssuer;
  if (!report.matchesExpectedIssuer) {
    els.dkim.innerHTML += `<p class="note">Expected a signature from <code>${escapeHtml(report.expectedIssuer)}</code>. This deployment only accepts that issuer.</p>`;
  }
}

// ── Redemption ─────────────────────────────────────────────────────────────

function setStage(id, cls, detail) {
  const li = els.stages.querySelector(`[data-id="${id}"]`);
  if (!li) return;
  li.classList.remove('running', 'done', 'failed');
  if (cls) li.classList.add(cls);
  if (detail !== undefined) li.querySelector('.detail').textContent = detail;
}

function resetStages() {
  for (const id of ['verify', 'attestor', 'submit', 'confirm']) setStage(id, null, '');
  els.result.hidden = true;
  els.result.className = 'result';
}

/**
 * Read an SSE stream off a fetch response. EventSource cannot POST, and the
 * email has to travel in the body — so the ~20 lines it saves are hand-rolled
 * here instead.
 */
async function readSse(response, handlers) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      // Awaited: the server sends nothing more until a wallet-request is
      // answered, and awaiting also stops the stream ending before `done` has
      // finished painting its result.
      if (data && handlers[event]) await handlers[event](JSON.parse(data));
    }
  }
}

async function redeem() {
  if (!currentEml || redeeming) return;
  redeeming = true;
  resetStages();
  els.redeem.disabled = true;
  els.redeem.textContent = 'Verifying…';
  els.replay.hidden = true;
  els.dropzone.classList.add('busy');

  let nullifier = null;
  let settled = false;

  const finishOk = async () => {
    settled = true;
    els.result.hidden = false;
    els.result.className = 'result ok';
    els.result.innerHTML =
      `<div class="headline">CLAIM VERIFIED</div>` +
      `<div class="sub">The email's own RSA signature was verified, and Midnight recorded only hashes — never the message.</div>` +
      (nullifier ? `<div class="hash">nullifier consumed: ${escapeHtml(nullifier)}</div>` : '');
    await refreshState();
  };

  const finishFailed = async (data) => {
    settled = true;
    for (const li of els.stages.querySelectorAll('li:not(.done)')) {
      li.classList.remove('running');
      li.classList.add('failed');
    }
    els.result.hidden = false;
    els.result.className = 'result rejected';
    els.result.innerHTML =
      `<div class="headline">${data.code === 'CLAIM_ALREADY_USED' ? 'ALREADY CLAIMED' : 'REJECTED'}</div>` +
      `<div class="sub">${escapeHtml(data.message)}</div>`;
    await refreshState();
  };

  // Identifies this redemption's wallet channel; the server routes its
  // balance and submit calls back over the same stream.
  const session = crypto.randomUUID();
  const headers = { 'content-type': 'text/plain' };
  if (wallet) {
    headers['x-mailproof-wallet-session'] = session;
    headers['x-mailproof-wallet-coin-key'] = wallet.coinPublicKey;
    headers['x-mailproof-wallet-enc-key'] = wallet.encryptionPublicKey;
  }

  try {
    const response = await fetch('/api/redeem', {
      method: 'POST',
      headers,
      body: currentEml,
    });
    if (!response.ok || !response.body) throw new Error(`server returned ${response.status}`);
    await readSse(response, {
      stage: (data) => {
        setStage(data.id, data.state === 'done' ? 'done' : 'running', data.detail ?? data.note ?? '');
        if (data.nullifier) nullifier = data.nullifier;
      },
      'wallet-request': async (request) => {
        const answer = wallet
          ? await handleWalletRequest(wallet, request)
          : { id: request.id, error: 'no wallet is connected' };
        await fetch('/api/wallet-response', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session, ...answer }),
        }).catch(() => {
          /* The server times the request out and reports it. */
        });
      },
      done: finishOk,
      failed: finishFailed,
    });
    // A stream that ends without a verdict is a failure too — silently
    // leaving the stage dots pulsing reads as "still working" forever.
    if (!settled) {
      await finishFailed({
        code: 'ERROR',
        message: 'The connection closed before the claim was resolved. Check the web server.',
      });
    }
  } catch (error) {
    await finishFailed({ code: 'ERROR', message: error?.message ?? 'The request failed.' });
  } finally {
    redeeming = false;
    els.redeem.disabled = false;
    els.redeem.textContent = 'Verify claim';
    els.replay.hidden = false;
    els.dropzone.classList.remove('busy');
  }
}

// ── Wiring ─────────────────────────────────────────────────────────────────

async function readFile(file) {
  await inspect(await file.text());
}

els.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropzone.classList.add('over');
});
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('over'));
els.dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('over');
  const file = e.dataTransfer?.files?.[0];
  if (file) await readFile(file);
});

els.dropzone.addEventListener('click', () => {
  if (redeeming) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.eml,message/rfc822,text/plain';
  input.addEventListener('change', async () => {
    if (input.files?.[0]) await readFile(input.files[0]);
  });
  input.click();
});

els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    els.loadSample.click();
  }
});

els.loadSample.addEventListener('click', async (e) => {
  e.stopPropagation();
  await inspect(await (await fetch('/api/sample-eml')).text());
});

els.loadDemoEmail.addEventListener('click', async (e) => {
  e.stopPropagation();
  const response = await fetch('/api/demo-eml');
  if (response.ok) await inspect(await response.text());
});

els.redeem.addEventListener('click', redeem);
els.replay.addEventListener('click', redeem);
els.walletConnect.addEventListener('click', toggleWallet);

// Extensions inject `window.midnight` on their own schedule, so the panel is
// drawn once now and again shortly after load rather than only at startup.
renderWallet();
setTimeout(renderWallet, 1000);

// Bare call at module scope: an unhandled rejection here would leave the page
// on "connecting…" with no explanation, so refreshState swallows its own.
refreshState();
