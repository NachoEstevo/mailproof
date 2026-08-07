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

const $ = (id) => document.getElementById(id);

const els = {
  chips: $('chips'),
  fixtureBanner: $('fixture-banner'),
  dropzone: $('dropzone'),
  loadSample: $('load-sample'),
  inspection: $('inspection'),
  emlSummary: $('eml-summary'),
  dkim: $('dkim'),
  stages: $('stages'),
  redeem: $('redeem'),
  replay: $('replay'),
  result: $('result'),
  onchain: $('onchain'),
};

let state = null;

// ── Chain state ────────────────────────────────────────────────────────────

async function refreshState() {
  try {
    state = await (await fetch('/api/state')).json();
  } catch {
    els.chips.innerHTML = '<span class="chip bad">backend offline</span>';
    return;
  }

  const attestorChip = !state.attestor.online
    ? '<span class="chip bad">attestor offline</span>'
    : state.attestor.cryptographicVerification
      ? '<span class="chip ok">attestor verifying</span>'
      : '<span class="chip warn">attestor: fixture</span>';

  els.chips.innerHTML = [
    `<span class="chip">${state.network}</span>`,
    `<span class="chip">${state.campaign}</span>`,
    attestorChip,
    `<span class="chip ok">${state.approvedClaimCount} approved</span>`,
  ].join('');

  els.fixtureBanner.hidden = !state.attestor.online || state.attestor.cryptographicVerification;

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

// ── Email inspection ───────────────────────────────────────────────────────

async function inspect(text) {
  const response = await fetch('/api/inspect', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: text,
  });
  const report = await response.json();

  if (!report.ok) {
    els.inspection.hidden = false;
    els.emlSummary.innerHTML = `<dt>Error</dt><dd>${escapeHtml(report.error)}</dd>`;
    els.dkim.innerHTML = '';
    els.redeem.disabled = true;
    return;
  }

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
  for (const id of ['attestor', 'submit', 'confirm']) setStage(id, null, '');
  els.result.hidden = true;
  els.result.className = 'result';
}

function redeem() {
  resetStages();
  els.redeem.disabled = true;
  els.redeem.textContent = 'Verifying…';
  els.replay.hidden = true;

  const source = new EventSource('/api/redeem');
  let nullifier = null;

  source.addEventListener('stage', (event) => {
    const data = JSON.parse(event.data);
    setStage(data.id, data.state === 'done' ? 'done' : 'running', data.detail ?? data.note ?? '');
    if (data.nullifier) nullifier = data.nullifier;
  });

  source.addEventListener('done', async (event) => {
    const data = JSON.parse(event.data);
    source.close();
    els.result.hidden = false;
    els.result.className = 'result ok';
    els.result.innerHTML =
      `<div class="headline">CLAIM VERIFIED</div>` +
      `<div class="sub">Compensation unlocked. The verifier never received the email.</div>` +
      (nullifier ? `<div class="hash">nullifier consumed: ${escapeHtml(nullifier)}</div>` : '');
    els.redeem.textContent = 'Verify claim';
    els.replay.hidden = false;
    await refreshState();
  });

  source.addEventListener('failed', async (event) => {
    const data = JSON.parse(event.data);
    source.close();
    for (const li of els.stages.querySelectorAll('li:not(.done)')) {
      li.classList.remove('running');
      li.classList.add('failed');
    }
    els.result.hidden = false;
    els.result.className = 'result rejected';
    els.result.innerHTML =
      `<div class="headline">${data.code === 'CLAIM_ALREADY_USED' ? 'ALREADY CLAIMED' : 'REJECTED'}</div>` +
      `<div class="sub">${escapeHtml(data.message)}</div>`;
    els.redeem.disabled = false;
    els.redeem.textContent = 'Verify claim';
    els.replay.hidden = false;
    await refreshState();
  });

  source.onerror = () => {
    source.close();
    els.redeem.disabled = false;
    els.redeem.textContent = 'Verify claim';
  };
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

els.redeem.addEventListener('click', redeem);
els.replay.addEventListener('click', redeem);

refreshState();
