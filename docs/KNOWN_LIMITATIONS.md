# Known Limitations

What MailProof does not guarantee. Kept honest deliberately — §41.21 and
Appendix K. Update this file whenever scope changes.

## Trust

1. **The MVP trusts one attestor.** It verifies the ZK Email proof off-chain
   and signs the claim. If it signs a false claim, the contract accepts it.
   The roadmap is threshold attestation or direct proof verification.
2. **DKIM does not prove objective truth.** It proves a domain signed a
   message matching the template. If the airline's message is wrong, the proof
   is still valid. The correct claim is "`d=` domain signed a message
   satisfying the cancellation template", never "the flight was cancelled".
3. **Possession of a `.eml` is not inbox ownership.** A forwarded or stolen
   file produces a valid proof. Subject binding ties redemption to a secret
   held in private state, which stops a third party redeeming *someone else's
   signed claim* — but not someone who holds the file generating their own.
   Proving inbox control needs a fresh challenge.

## Cryptography

4. **The Fiat-Shamir challenge is 224 bits, not full width.** A deliberate
   narrowing so the challenge is always a valid curve scalar; the runtime
   faults rather than asserts on an out-of-range scalar. Soundness margin is
   still far above 128 bits. See D-003.
5. **Signatures are malleable in the scalar limbs only in principle.** The
   range check rejects any `s >= l`, so the accepted encoding of a given
   signature is unique. Malleability would not be a forgery regardless: the
   nullifier, not the signature, is what prevents double redemption.
6. **The signature scheme is assembled, not audited.** Textbook Schnorr over
   the stdlib's embedded curve, cross-checked between two independent
   implementations. That is not the same as a reviewed cryptographic library.
6b. **An off-curve announcement traps the runtime instead of rejecting.**
   `redeemClaim` range-checks the signature scalar precisely so a bad scalar
   fails as a rejected signature, but `sig.announcement` gets no equivalent
   guard and cannot: Compact 0.31.1 exposes no on-curve predicate
   (`isOnCurve`, `isPrimeOrder`, `assertOnCurve` are all unbound) and
   `JubjubPoint` is opaque, so the curve equation cannot be checked by hand
   either. Verified empirically: `R = (1,1)` and `R = (0,0)` fail with
   `unreachable`, which is not one of the stable §42.3 error codes, while the
   identity `(0,1)` rejects cleanly as `invalid attestor signature`. The cost
   is a clear error message, not soundness — `c = H(R, P, m)` still binds `R`,
   and no forgery follows from an invalid point.

## Scope

7. **One pinned blueprint, one claim type, one campaign per deployment.**
   Anything else is rejected.
8. **No direct ZK Email proof verification in Compact.** See D-001.
9. **The email source has no revocation channel.** Once an email is signed,
   the issuer cannot withdraw the claim it supports.
10. **No Gmail/OAuth integration.** `.eml` upload only, by decision (§41.19).

## Privacy

11. **Metadata remains visible.** A chain observer sees the contract, the
    circuit called, timing, the nullifier and the claim count. Repeated use of
    the same subject binding within a campaign is linkable. Mitigations
    (relayers, batching, delayed submission) are out of MVP scope.
12. **In DKIM-direct mode (D-007) the attestor sees the raw email.** That is
    the mode the demo runs in, and the UI says so. Verifying the message's own
    RSA signature requires the message; ZK Email exists precisely to remove
    this, and the moment a blueprint is pinned the routing verifier sends that
    blueprint's submissions down the proof path, where the attestor sees only
    the proof and its public outputs. Either way, nothing but hashes ever
    reaches the chain.

## The demo as it stands

13. **ZK Email proof verification is not live.** No blueprint has been
    compiled on the registry yet. The demo instead verifies real cryptography
    end to end via DKIM-direct (D-007): the email's own RSA-SHA256 signature
    against the pinned issuer key. The fixture verifier still exists for tests
    and requires the explicit `MAILPROOF_ALLOW_FIXTURE_VERIFIER=1` opt-in,
    disclosed in three places — a startup banner, `cryptographicVerification:
    false` on `/health`, and an amber banner in the UI.
13b. **DKIM signatures expire.** Google signs with `x=` seven days out. The
    real demo email must be re-sent (and the fixture refreshed) if the demo
    is later than that; `demo:reset` warns when expiry is near.
13c. **A claim can only be read from a plain-text part.** An HTML-only message
    is refused: rendering HTML to text is a transformation this project does
    not implement, and matching a marker against HTML source would match
    something no reader ever saw. Extraction fails closed (D-007).
13d. **The browser demo can only redeem a pinned DKIM-direct blueprint.** On a
    ZK Email blueprint `/api/redeem` refuses outright rather than forwarding
    the raw message to a verifier whose purpose is never to see one.
14. **A Gmail-to-self email cannot be used.** Self-addressed mail never leaves
    Google's infrastructure and is therefore never DKIM-signed. Confirmed
    empirically: "delivered in 0 seconds", no `Received` headers, no signature.
    A second mailbox, a received third-party email, or a controlled domain is
    required.
15. **Only the web UI can borrow a browser wallet; the extension cannot.**
    The web app at `:3000` will hand balancing and submission to a connector
    wallet when one is connected (`apps/web/wallet-bridge.ts`), falling back
    to the devnet wallet this process holds. The side panel cannot: wallets
    inject `window.midnight` into web pages, not into other extensions'
    pages, so a redemption driven from the panel is always paid by the
    daemon. The bridge itself is exercised end to end against the chain only
    through `MAILPROOF_WALLET_SIMULATOR=1`, which is the daemon standing in
    for a wallet — Midnight Lace cannot join a local `undeployed` devnet, so
    the Lace-specific link is the one part of that path still unverified.
15b. **The extension's Gmail capture depends on markup that can change.**
    Locating the open message and fetching its source both rely on Gmail
    internals (`data-legacy-message-id`, `view=att&th=`, `GLOBALS[9]`). Each
    step has more than one strategy and a validation gate, and the panel
    falls back to a file picker when they fail — but the capture button is an
    accelerator, not the demo's critical path (D-008).
15c. **`--load-extension` no longer works.** Chrome 137 dropped it; the flag
    is accepted and silently ignored, and the only symptom is
    `ERR_BLOCKED_BY_CLIENT` on the extension's own pages. Load it from
    `chrome://extensions` with developer mode on. See `apps/extension/README.md`.
16. **The sample `.eml` carries a placeholder DKIM signature.** It exercises
    the inspector and the UI. It does not verify, and the inspector says so.

## Operations

17. **Browser proving can be slow.** The demo has a disclosed fallback to a
    locally generated proof fixture; it is never presented as live.
18. **The demo runs on local devnet.** Public deployment is a bonus, not a
    requirement (§37.3).
19. **A demo reset requires restarting the services.** `npm run demo:reset`
    redeploys under a fresh campaign; the attestor and web app read the
    campaign at startup, so both must be restarted afterwards.
