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
12. **The attestor sees the proof and its public outputs.** It never sees the
    raw email — but "private from the attestor" applies to the message body,
    not to the fact that a request happened.

## Operations

13. **Browser proving can be slow.** The demo has a disclosed fallback to a
    locally generated proof fixture; it is never presented as live.
14. **The demo may run on local devnet.** Public deployment is a bonus, not a
    requirement (§37.3).
