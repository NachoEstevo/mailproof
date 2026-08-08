# MailProof — browser extension

The side panel is the demo's front end. It sits beside Gmail, reads the
message you have open, and drives the same redemption the web page drives.

## Why an extension at all

DKIM signs the original RFC822 bytes. Once Gmail has rendered a message those
bytes are gone from the page, so a web app has to ask you to open **Show
original**, save the file, and drag it back. The extension takes the same
bytes in one click, which is the only thing here a web page cannot do.

Everything else is unchanged: the panel holds no keys, generates no proofs and
talks to no remote host. It is a client of the local daemon.

## Install

Chrome 137 dropped `--load-extension`. The flag is still accepted and silently
ignored, and the only symptom is `ERR_BLOCKED_BY_CLIENT` when you open one of
the extension's own pages — so load it by hand:

1. `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select `apps/extension`
4. Pin MailProof to the toolbar

The id is always `hfajeimcllaejcchhhfifacpaggiilao`, because the manifest pins
a `key`. That is what lets the daemon allow one exact origin instead of every
extension on the machine — if the id ever differs, the daemon will refuse the
panel and `packages/shared/extension-id.test.ts` will fail.

For automation, `Extensions.loadUnpacked` over CDP still works.

## Run

Start the two local services first:

```
npm run attestor:dev     # :8787
npm run web:dev          # :3000 — the daemon the panel talks to
```

Then open Gmail, click a signed message, and click the MailProof icon.

## The panel

Click a message in Gmail. Press **Verify this email**. That is the whole
interface — reading the message and redeeming the claim are one action,
because nobody opens an email in order to load it somewhere.

The panel names the message it is about to verify, so you can see it followed
you to the right one before anything is sent.

A drop zone and a *use this machine's demo email* link exist, but they stay
hidden until reading from Gmail has actually failed. If you can see them,
something went wrong — that is the signal, not the normal state.

## What can break

**Gmail's markup is not a contract.** Locating the open message and reading
its source both have more than one strategy and a validation gate, and the
panel falls back to the drop zone whenever they come up empty. Treat the
capture button as an accelerator, never as the demo's critical path.

**A connector wallet cannot reach this panel.** Wallets inject `window.midnight`
into web pages, not into other extensions' pages, so the browser-wallet bridge
in `apps/web/wallet-bridge.ts` only works from the web UI at `:3000`. From the
panel the daemon's own devnet wallet pays. See `docs/KNOWN_LIMITATIONS.md`.
