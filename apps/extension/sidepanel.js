/**
 * Side panel.
 *
 * One action: read the message open in Gmail and redeem it. Reading and
 * redeeming are not two steps the user has to sequence — nobody opens an
 * email in order to load it somewhere, they open it because they want the
 * claim. The drop zone exists, but it stays out of sight until reading from
 * Gmail has actually failed.
 *
 * The panel holds no keys, runs no proofs and talks to no remote host. The
 * one network rule that matters: the raw message goes to DAEMON and nowhere
 * else. Anything rendered from Gmail or from an error is written with
 * textContent, so a hostile subject line stays a subject line.
 */

import { readSse } from './sse.js';

/** Bound to loopback by the daemon itself; never make this configurable to a remote host. */
const DAEMON = 'http://127.0.0.1:3000';

const $ = (id) => document.getElementById(id);
const els = {
  chips: $('chips'),
  notice: $('notice'),
  verify: $('verify'),
  hint: $('hint'),
  stages: $('stages'),
  result: $('result'),
  fallback: $('fallback'),
  dropzone: $('dropzone'),
  file: $('file'),
  loadDemoEmail: $('load-demo-email'),
  disclosureSection: $('disclosure-section'),
  revealed: $('revealed'),
  private: $('private'),
  onchain: $('onchain'),
};

let state = null;
/** Set only when Gmail could not be read and a file was supplied instead. */
let droppedEml = null;
let busy = false;

const say = (text, tone = '') => {
  els.hint.className = tone ? `hint ${tone}` : 'hint';
  els.hint.textContent = text;
};

// ─── Chrome plumbing ─────────────────────────────────────────────────────────

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

const isGmail = (tab) => Boolean(tab?.url?.startsWith('https://mail.google.com/'));

/**
 * Gmail's per-session request key, read from the page's own globals.
 *
 * Only the fallback URL needs it — "Download Original" does not — so failing
 * to find it is not fatal. Content scripts run isolated and cannot see page
 * variables, hence the MAIN-world injection.
 */
async function gmailSessionKey(tabId) {
  try {
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
  } catch {
    return null;
  }
}

/** Content scripts are absent on a tab that loaded before the extension did. */
async function askContentScript(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

// ─── Is there something to verify? ───────────────────────────────────────────

async function detectSource() {
  if (busy) return;

  if (droppedEml) {
    els.verify.disabled = false;
    say(`Ready: ${droppedEml.label}`, 'ok');
    return;
  }

  const tab = await activeTab();
  if (!isGmail(tab)) {
    els.verify.disabled = true;
    say('Open a message in Gmail.');
    return;
  }

  const located = await askContentScript(tab.id, { type: 'mailproof:locate' });
  if (!located) {
    els.verify.disabled = true;
    say('Reload the Gmail tab so MailProof can read it.');
    return;
  }
  if (!located.message) {
    els.verify.disabled = true;
    say('No message open. Click one in Gmail.');
    return;
  }

  els.verify.disabled = false;
  say(located.message.subject || 'A message is open.', 'ok');
}

/** The bytes to verify: whatever Gmail has open, or the file that replaced it. */
async function collectEml() {
  if (droppedEml) return droppedEml.raw;

  const tab = await activeTab();
  if (!isGmail(tab)) throw new Error('Open a message in Gmail.');

  say('Reading the original source…');
  const ik = await gmailSessionKey(tab.id);
  const captured = await askContentScript(tab.id, { type: 'mailproof:capture', ik });
  if (!captured?.ok) {
    els.fallback.hidden = false;
    throw new Error(captured?.detail ?? 'Gmail did not return the original source.');
  }
  say(`${captured.subject || 'Message'} · ${captured.raw.length.toLocaleString()} bytes`, 'ok');
  return captured.raw;
}

// ─── The one action ──────────────────────────────────────────────────────────

async function verify() {
  if (busy) return;
  busy = true;
  els.verify.disabled = true;
  els.dropzone?.classList.add('busy');
  resetStages();
  els.result.hidden = true;
  els.disclosureSection.hidden = true;

  let nullifier = null;
  let txId = null;

  try {
    const raw = await collectEml();
    const response = await fetch(`${DAEMON}/api/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: raw,
    });

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
        // Let the room watch the on-chain counter advance, rather than
        // leaving the chip on the figure it had when the panel opened.
        void refreshState();
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'something went wrong';
    showResult('rejected', 'COULD NOT VERIFY', message, '');
    say(message);
  } finally {
    busy = false;
    els.dropzone?.classList.remove('busy');
    await detectSource();
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

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

function renderDisclosure() {
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
    `That ${state?.issuerDomain ?? 'the trusted sender'} signed it`,
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

const daemonHint = (error) =>
  `${error instanceof Error ? error.message : 'request failed'} — is the daemon running? ` +
  'npm run web:dev';

function chip(text, tone = '') {
  const node = document.createElement('span');
  node.className = tone ? `chip ${tone}` : 'chip';
  node.textContent = text;
  return node;
}

function notify(text, tone = '') {
  els.notice.className = tone ? `notice ${tone}` : 'notice';
  els.notice.textContent = text;
  els.notice.hidden = false;
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

  // Gitignored evidence that only exists on the machine that received it.
  els.loadDemoEmail.hidden = !state.demoEmailAvailable;

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

// ─── Fallback, once it has been earned ───────────────────────────────────────

async function useFile(raw, label) {
  droppedEml = { raw, label };
  els.result.hidden = true;
  els.disclosureSection.hidden = true;
  await detectSource();
}

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
  if (file) await useFile(await file.text(), file.name);
});
els.file.addEventListener('change', async () => {
  const file = els.file.files?.[0];
  if (file) await useFile(await file.text(), file.name);
  els.file.value = '';
});
els.loadDemoEmail.addEventListener('click', async () => {
  try {
    const response = await fetch(`${DAEMON}/api/demo-eml`);
    if (!response.ok) throw new Error(`daemon replied ${response.status}`);
    await useFile(await response.text(), "this machine's demo email");
  } catch (error) {
    notify(daemonHint(error), 'bad');
  }
});

// ─── Wiring ──────────────────────────────────────────────────────────────────

els.verify.addEventListener('click', verify);

/**
 * Follow whatever the reader is looking at.
 *
 * Switching messages must drop a file that replaced an earlier read, or the
 * panel would keep verifying that file while naming a different subject.
 *
 * Gmail is a single page: opening another message changes only the URL
 * fragment, so `status === 'complete'` never fires again after the first
 * load. The poll is the safety net for the case where even the URL does not
 * change — asking the content script costs nothing and the alternative is a
 * panel that quietly points at the wrong email.
 */
function sourceChanged() {
  droppedEml = null;
  void detectSource();
}

chrome.tabs.onActivated.addListener(sourceChanged);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.url) sourceChanged();
  else if (change.status === 'complete') void detectSource();
});
setInterval(() => void detectSource(), 2000);

await refreshState();
await detectSource();
