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
15. **The wallet lives in the web server, not the browser.** The demo app
    holds the devnet wallet itself instead of connecting to a browser wallet
    via the DApp Connector API. That was chosen for reliability on stage; it
    means the frontend is chain-connected but not wallet-connected, which is
    weaker against the hackathon's frontend criterion.
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
