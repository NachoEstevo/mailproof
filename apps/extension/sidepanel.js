/**
 * Side panel.
 *
 * The panel is a client of the MailProof daemon on loopback — it holds no
 * keys, runs no proofs and talks to no remote host. The one network rule that
 * matters: the raw message goes to DAEMON and nowhere else. Everything the
 * panel renders from Gmail or from an error is written with textContent, so
 * a hostile subject line stays a subject line.
 */

import { readSse } from './sse.js';

/** Bound to loopback by the daemon itself; never make this configurable to a remote host. */
const DAEMON = 'http://127.0.0.1:3000';

const $ = (id) => document.getElementById(id);
const els = {
  chips: $('chips'),
  notice: $('notice'),
  capture: $('capture'),
  sourceHint: $('source-hint'),
  dropzone: $('dropzone'),
  file: $('file'),
  loadSample: $('load-sample'),
  evidence: $('evidence'),
  stages: $('stages'),
  redeem: $('redeem'),
  result: $('result'),
  disclosureSection: $('disclosure-section'),
  revealed: $('revealed'),
  private: $('private'),
  onchain: $('onchain'),
};

let state = null;
/** The message under consideration. In memory only. */
let currentEml = null;
let redeeming = false;

// ─── Chrome plumbing ─────────────────────────────────────────────────────────

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

const isGmail = (tab) => Boolean(tab?.url?.startsWith('https://mail.google.com/'));

/**
 * Gmail's per-session request key, read from the page's own globals.
 *
 * Content scripts run in an isolated world and cannot see page variables, so
 * this has to be a MAIN-world injection. Older builds only expose it in link
 * hrefs, hence the second attempt.
 */
async function gmailSessionKey(tabId) {
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const fromGlobals = Array.isArray(globalThis.GLOBALS) ? globalThis.GLOBALS[9] : null;
      if (typeof fromGlobals === 'string' && fromGlobals.length > 0) return fromGlobals;
      const node = document.querySelector('a[href*="ik="], img[src*="ik="]');
      const url = node?.getAttribute('href') ?? node?.getAttribute('src') ?? '';
      return /[?&]ik=([^&]+)/.exec(url)?.[1] ?? null;
    },
  });
  return injected?.result ?? null;
}

/** Content scripts are absent on a tab that loaded before the extension did. */
async function askContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

// ─── Evidence ────────────────────────────────────────────────────────────────

async function detectSource() {
  const tab = await activeTab();
  if (!isGmail(tab)) {
    els.capture.disabled = true;
    els.sourceHint.className = 'hint';
    els.sourceHint.textContent = 'Open a message in Gmail, or drop a file below.';
    return;
  }

  const located = await askContentScript(tab.id, { type: 'mailproof:locate' });
  if (!located) {
    els.capture.disabled = true;
    els.sourceHint.className = 'hint';
    els.sourceHint.textContent = 'Reload the Gmail tab so MailProof can read it.';
    return;
  }

  if (!located.message) {
    els.capture.disabled = true;
    els.sourceHint.className = 'hint';
    els.sourceHint.textContent = 'No message open. Click one in Gmail.';
    return;
  }

  els.capture.disabled = false;
  els.sourceHint.className = 'hint ok';
  els.sourceHint.textContent = located.message.subject
    ? `Ready: “${located.message.subject}”`
    : 'A message is open and ready to read.';
}

async function captureFromGmail() {
  const tab = await activeTab();
  if (!isGmail(tab)) return;

  els.capture.disabled = true;
  els.sourceHint.className = 'hint';
  els.sourceHint.textContent = 'Reading the original source…';

  const ik = await gmailSessionKey(tab.id);
  const captured = await askContentScript(tab.id, { type: 'mailproof:capture', ik });

  if (!captured?.ok) {
    els.capture.disabled = false;
    els.sourceHint.className = 'hint';
    els.sourceHint.textContent =
      captured?.detail ?? 'Could not read the message. Use "Show original" and drop the file.';
    return;
  }

  await useEml(captured.raw, captured.subject || 'the open message');
}

async function useEml(raw, label) {
  currentEml = raw;
  resetStages();
  els.result.hidden = true;
  els.disclosureSection.hidden = true;
  els.redeem.disabled = false;
  els.capture.disabled = false;
  els.sourceHint.className = 'hint ok';
  els.sourceHint.textContent = `Loaded: ${label} · ${raw.length.toLocaleString()} bytes`;
  await inspect(raw);
}

/** Structural report from the daemon: which DKIM signatures the message carries. */
async function inspect(raw) {
  els.evidence.hidden = true;
  els.evidence.replaceChildren();

  const report = await postText('/api/inspect', raw)
    .then((r) => r.json())
    .catch(() => null);
  if (!report?.ok) return;

  const rows = [
    ['Line endings', report.lineEnding, ''],
    ['Body', `${report.bodyBytes.toLocaleString()} bytes`, ''],
    ['DKIM signatures', String(report.signatures.length), ''],
  ];
  for (const signature of report.signatures) {
    const matches = signature.domain === report.expectedIssuer;
    rows.push([
      'Signed by',
      `d=${signature.domain ?? '?'} · s=${signature.selector ?? '?'} · ${signature.algorithm ?? '?'}`,
      matches ? 'ok' : '',
    ]);
  }
  rows.push([
    'Expected issuer',
    report.expectedIssuer,
    report.matchesExpectedIssuer ? 'ok' : 'bad',
  ]);

  for (const [term, detail, tone] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = detail;
    if (tone) dd.className = tone;
    els.evidence.append(dt, dd);
  }
  els.evidence.hidden = false;
}

// ─── Redemption ──────────────────────────────────────────────────────────────

function resetStages() {
  for (const li of els.stages.children) {
    li.className = '';
    li.querySelector('.detail')?.remove();
  }
}

function setStage(id, status, detail) {
  const li = els.stages.querySelector(`[data-stage="${id}"]`);
  if (!li) return;
  li.className = status;
  if (!detail) return;
  const existing = li.querySelector('.detail');
  const node = existing ?? document.createElement('span');
  node.className = 'detail';
  node.textContent = detail;
  if (!existing) li.append(node);
}

function showResult(kind, headline, sub, hash) {
  els.result.className = `result ${kind}`;
  els.result.replaceChildren();
  const add = (cls, text) => {
    if (!text) return;
    const node = document.createElement('div');
    node.className = cls;
    node.textContent = text;
    els.result.append(node);
  };
  add('headline', headline);
  add('sub', sub);
  add('hash', hash);
  els.result.hidden = false;
}

async function redeem() {
  if (!currentEml || redeeming) return;
  redeeming = true;
  resetStages();
  els.redeem.disabled = true;
  els.capture.disabled = true;
  els.dropzone.classList.add('busy');
  els.result.hidden = true;

  let nullifier = null;
  let txId = null;

  try {
    const response = await postText('/api/redeem', currentEml);
    await readSse(response, {
      stage: (data) => {
        setStage(data.id, data.state === 'done' ? 'done' : 'running', data.detail ?? data.note ?? '');
        if (data.nullifier) nullifier = data.nullifier;
        if (data.txId) txId = data.txId;
      },
      failed: (data) => {
        for (const li of els.stages.children) {
          if (li.className === 'running') li.className = 'failed';
        }
        showResult(
          'rejected',
          data.code === 'CLAIM_ALREADY_USED' ? 'ALREADY CLAIMED' : 'REJECTED',
          data.message,
          nullifier ? `nullifier ${nullifier}` : '',
        );
      },
      done: (data) => {
        showResult(
          'ok',
          'CLAIM VERIFIED',
          `Approved claims on chain: ${data.approvedClaimCount}`,
          [nullifier && `nullifier ${nullifier}`, txId && `tx ${txId}`].filter(Boolean).join('\n'),
        );
        renderDisclosure();
      },
    });
  } catch (error) {
    showResult('rejected', 'NO CONNECTION', daemonHint(error), '');
  } finally {
    redeeming = false;
    els.redeem.disabled = false;
    els.capture.disabled = false;
    els.dropzone.classList.remove('busy');
  }
}

function renderDisclosure() {
  const domain = state?.issuerDomain ?? 'the trusted sender domain';
  const fill = (list, items) => {
    list.replaceChildren();
    for (const text of items) {
      const li = document.createElement('li');
      li.textContent = text;
      list.append(li);
    }
  };
  fill(els.revealed, [
    `The claim type — ${state?.claimType ?? 'a claim'}`,
    `That ${domain} signed it`,
    'That the claim is valid',
    'That it has not been used before',
  ]);
  fill(els.private, [
    'The full email',
    'The recipient address',
    'The booking reference',
    'Everything else in the inbox',
  ]);
  els.onchain.textContent = state
    ? `contract ${state.contractAddress} · campaign ${state.campaign} · ${state.network}`
    : '';
  els.disclosureSection.hidden = false;
}

// ─── Daemon ──────────────────────────────────────────────────────────────────

function postText(path, body) {
  return fetch(`${DAEMON}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body,
  });
}

const daemonHint = (error) =>
  `${error instanceof Error ? error.message : 'request failed'} — is the daemon running? ` +
  'npm run web:dev';

function chip(text, tone = '') {
  const node = document.createElement('span');
  node.className = tone ? `chip ${tone}` : 'chip';
  node.textContent = text;
  return node;
}

async function refreshState() {
  try {
    const response = await fetch(`${DAEMON}/api/state`);
    if (!response.ok) throw new Error(`daemon replied ${response.status}`);
    const fresh = await response.json();
    if (typeof fresh?.network !== 'string' || !fresh?.attestor) {
      throw new Error('unrecognised daemon response');
    }
    state = fresh;
  } catch (error) {
    els.chips.replaceChildren(chip('daemon offline', 'bad'));
    notify(daemonHint(error), 'bad');
    return;
  }

  els.chips.replaceChildren(
    chip(state.network, 'ok'),
    chip(state.verificationMode, state.verificationMode === 'dkim-direct' ? 'ok' : 'warn'),
    chip(`d=${state.issuerDomain}`),
    chip(`claims ${state.approvedClaimCount}`),
    chip(state.attestor.online ? 'attestor up' : 'attestor down', state.attestor.online ? 'ok' : 'bad'),
  );

  if (!state.attestor.cryptographicVerification) {
    notify('The attestor is running its fixture verifier — no signature is being checked.', 'bad');
  } else if (state.walletSimulator) {
    notify('Wallet simulator is on: the daemon pays, not a user wallet.');
  } else {
    els.notice.hidden = true;
  }
}

function notify(text, tone = '') {
  els.notice.className = tone ? `notice ${tone}` : 'notice';
  els.notice.textContent = text;
  els.notice.hidden = false;
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

els.capture.addEventListener('click', captureFromGmail);
els.redeem.addEventListener('click', redeem);

els.dropzone.addEventListener('click', () => els.file.click());
els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    els.file.click();
  }
});
els.dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  els.dropzone.classList.add('over');
});
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('over'));
els.dropzone.addEventListener('drop', async (event) => {
  event.preventDefault();
  els.dropzone.classList.remove('over');
  const file = event.dataTransfer?.files?.[0];
  if (file) await useEml(await file.text(), file.name);
});
els.file.addEventListener('change', async () => {
  const file = els.file.files?.[0];
  if (file) await useEml(await file.text(), file.name);
  els.file.value = '';
});

els.loadSample.addEventListener('click', async () => {
  try {
    const response = await fetch(`${DAEMON}/api/sample-eml`);
    if (!response.ok) throw new Error(`daemon replied ${response.status}`);
    await useEml(await response.text(), 'the synthetic sample');
  } catch (error) {
    notify(daemonHint(error), 'bad');
  }
});

// The panel outlives the tab it was opened over, so keep the source in step.
chrome.tabs.onActivated.addListener(() => void detectSource());
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === 'complete') void detectSource();
});

await refreshState();
await detectSource();
