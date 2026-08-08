## Security model

### What a successful verification asserts

A `result.ok === true` from `verify()` asserts three things and nothing else:

1. Some party controls a mailbox at a domain you pinned a DKIM key for — at the moment that message was signed.
2. That message was written for your site, recently: it carries a challenge code that authenticates under your `challengeSecret` and your `audience`, and the DKIM signature is inside your age bound.
3. The blinded identity derived from that mailbox either had, or had not, already been spent in this campaign.

It does not assert that the person is still enrolled, still employed, or a distinct human being. It does not assert that the party who submitted the `.eml` is the person who opened your signup page. Possession of the bytes is possession of the proof, for as long as the code lives.

### The trust boundary

There is one, it is not hidden, and it is large.

Something reads the raw message. Verifying the provider's RSA-SHA256 signature requires the message, so it cannot be otherwise. When you call `verify()`, that something is your own process: the DKIM check runs in-process and the only thing that leaves is the blinded identity. When a person uploads the `.eml` to the daemon instead — the demo's and the extension's path — the attestor reads it, which is the mode D-007 describes and the one this repo runs in. The SDK stamps `trust: { emailReadBy: 'attestor', … }` on every success regardless; it is a fixed literal in the return value, not a measurement of where the bytes went.

The attestor holds the Schnorr key that `mailproof.compact` pins into `attestorPublicKey` at construction. `redeemClaim` runs nine asserts and not one of them looks at an email: one checks the claim encoding, four check it against values pinned at construction, one binds it to the caller's private subject secret, two check the attestor's signature, and one checks that the nullifier is unspent. If the attestor signs a false claim, the contract accepts it. There is no rotation circuit and no pause circuit; the pinned key is pinned for the life of the deployment.

```ts
const result = await mailproof.verify(eml)
if (result.ok) {
  result.trust // { emailReadBy: 'attestor', cryptographic: true, blindingKeyId: '4f2a…' }
}
```

The correct response is to run your own daemon and point at it:

```ts
redemption: httpRedemptionClient({ baseUrl: 'https://mailproof.internal.example', token })
```

Nothing in the SDK assumes the daemon is ours. If you point at someone else's, you have accepted them as the authority on whether a claim is spent, and as the holder of the key the contract trusts.

### `From:`, not `To:`

The design that reads `To:` is unsound, and the attack is cheap. DKIM signs what the sender wrote, and the sender chose the recipient. Anyone who can sign for a domain can therefore mint a message addressed to any mailbox they invent inside it — including a colleague's — and pre-burn that slot at no cost. On an insert-only nullifier set there is no way to give it back.

`From:` inverts the requirement. A provider will not sign a message claiming to come from a mailbox the sender does not control; that is what DKIM alignment is for and what DMARC checks. So `verifySelfAttestation` requires the signature to cover `From:`, takes the bottom-most instance (RFC 6376 §5.4.2 consumes instances bottom-up), and refuses outright when the message carries more `From:` instances than `h=` covered — an unsigned prepended header is `FROM_NOT_SIGNED`, not a guess. `domainAligns` then requires the signing domain to be the mailbox domain or a parent of it: `udesa.edu.ar` vouches for `mail.udesa.edu.ar` and for nothing called `notudesa.edu.ar` or `udesa.edu.ar.evil.com`.

The code is read only from signed material: the covered `Subject:`, and the body truncated to the octets `l=` accounts for, decoded through each part's declared `Content-Transfer-Encoding`. Searching transfer-encoded bytes lets a quoted-printable soft break fabricate a line boundary that was never signed.

### What the challenge code buys

A code is `MP-` plus a 4-byte expiry and a 48-bit HMAC tag over `(audience, expiry)`. It buys three things: the message was composed for this verification rather than found; it was composed for *your* audience, so a code minted for another site fails as a forgery rather than as a mismatch; and evidence that would otherwise never go stale acquires an expiry. Default TTL is 15 minutes.

It does not buy single use. Verification is stateless by design — there is no table to look up, and the code is a deterministic function of the secret, the audience and the expiry minute — so a code can be presented more than once inside its window. It does not buy liveness of a particular human either: a forwarded or stolen `.eml` carrying a valid code verifies. What stops the second submission mattering is the nullifier, not the code.

### The freshness bound

This project pins the `p=` record instead of resolving it. That removes DNS availability from the claim path, and it also means a rotated or revoked key keeps verifying forever. Without an age bound, a 2014 archive is evidence in 2026 and a breach dump is a farm. `dkim-freshness.test.ts` shows exactly that: a fourteen-year-old signature verifying, `stale: false`, because nobody asked for a bound.

So `maxSignatureAgeMs` defaults to 24 hours, and staleness is kept distinct from invalidity — the signature is genuine, it is the age that is refused, and reporting "signature mismatch" for an untampered message sends people after a bug that is not there. A signature with no `t=` at all is stale by default, since its age cannot be established. A future `t=` is not stale: clock skew is common and a future timestamp only makes the evidence younger.

### Why the identity is blinded

The nullifier set is public and insert-only, and mailboxes are enumerable. `blinding.test.ts` runs the attack rather than describing it: it publishes an unkeyed hash of `anademo@gmail.com`, hashes a candidate list against it, and recovers the exact victim. The same attack against `blindIdentity` under a different key finds nothing.

`blindIdentity` is HMAC-SHA256 under a key of at least 32 bytes, domain-separated with `MAILPROOF:BLINDED-IDENTITY:V1`, folded to 32 bytes. It keeps the *ledger* opaque. It does nothing about the key holder: anyone with `blindingKey` — which, through the SDK, is you — can recompute the mapping for any address they can guess. Rotating the key renames every person and silently hands everyone a second benefit, which is why `blindingKeyId` is published: so a rotation is visible instead of quiet.

One consequence worth stating: the daemon receives the same blinded identity for the same person across campaigns, since `blindIdentity` takes only the mailbox and the key. The on-chain nullifier is campaign-scoped; the identity you hand the daemon is not.

### Canonicalisation is a security control

"One per person" is only as good as the function from a header field to a mailbox, so `mailbox.ts` parses the RFC 5322 grammar and discards everything an adversary writes. Quoted strings and comments are masked before any index arithmetic runs, so:

- `"evil@harvard.edu" <me@gmail.com>` yields `me@gmail.com`. A regex hunting for `@` grants a university tier to a Gmail account.
- `me@gmail.com (evil@harvard.edu)` and `(evil@harvard.edu) me@gmail.com` likewise.
- `"a,b<c>d:e;" <me@gmail.com>` is one mailbox; the structural characters are inert.
- `a@x.com, b@y.com` and `Team: a@x.com, b@y.com;` are refused — "the first recipient" is the sender's choice, not a fact about the claimant.
- `undisclosed-recipients:;` names nobody and is refused.
- `me(a(nested)comment)@gmail.com`, `ana@[192.0.2.1]`, `ana@localhost`, `ana@a..b.com` and `+tag@gmail.com` all fail closed.

Folding runs the other way: `anademo@`, `AnaDemo@`, `a.n.a.d.e.m.o@` and `anademo+lain@gmail.com` are one person, and `ana@ÜNI.example` is `ana@xn--ni-wka.example`. Dot-collapsing applies only to `gmail.com`, `googlemail.com` and domains you name, because applying it to a domain that distinguishes `a.b@` from `ab@` merges two colleagues into one nullifier and locks the second out permanently.

### What is not covered

- **Catch-all domains.** A person who owns a domain and its DKIM key can sign `From:` any local part in it, so they own unboundedly many mailboxes and unboundedly many nullifiers. `notFreeProvider` does not touch this: it is a friction tax on casual farming, not an anti-sybil control, and a $1/yr domain with catch-all MX defeats it outright. Anything that matters must be gated on an explicit domain list — and then it is only as strong as that institution's own mailbox issuance.
- **Shared mailboxes.** `admissions@`, `info@`, a team alias: one mailbox, one nullifier, many people. Whoever spends it spends it for all of them, and nothing in the evidence distinguishes them.
- **Alumni and leavers.** DKIM proves the mailbox is controlled now. It says nothing about entitlement, and there is no revocation channel — once a message is signed, the domain cannot withdraw what it supports. An address that outlives enrolment keeps earning the tier. The only real lever is a short campaign.
- **Griefing an insert-only set.** `usedNullifiers` supports `member` and `insert`; there is no removal, no pause, no attestor rotation. A slot burned in error or in malice stays burned for the life of that campaign. The remedy is a new campaign — which resets everyone, including whoever caused it.
- **The off-curve announcement.** `redeemClaim` range-checks the signature scalar so a bad one rejects cleanly, but `sig.announcement` gets no equivalent guard and cannot: Compact 0.31.1 exposes no on-curve predicate and `JubjubPoint` is opaque. `R = (1,1)` and `R = (0,0)` fail with `unreachable`, which is not one of the stable error codes. The cost is a clear error message, not soundness — `c = H(R, P, m)` still binds `R`.
- **Metadata.** A chain observer sees the contract, the circuit called, the timing, the nullifier and the claim count. Repeated use of the same subject binding within a campaign is linkable.

### Malicious integrator versus malicious attestor

A malicious integrator gets very little *from the protocol*. The return value carries no address — the SDK's own test asserts that neither the local part nor the domain appears anywhere in it — and what goes to the daemon is 32 blinded bytes, the campaign name and the tier id. `reveal: 'tier'` means they learn "is a student"; `reveal: 'domain'` is the larger ask and should be justified. Be clear about the one thing the SDK cannot enforce: `verify(eml)` runs in the caller's process, so whichever party calls it holds the raw message for the duration of that call, and holds the blinding key permanently. The guarantee is that nothing downstream — the handle you store, the ledger, any later reader of your database — carries an address. It is not a guarantee against a party that already has the message in hand. Store `result.handle`, and never on the same row as an email address; doing so recreates precisely the join the blinding exists to prevent.

A malicious attestor can do a great deal. In DKIM-direct mode it reads every message sent to it. It never receives your blinding key — `httpRedemptionClient` posts only the blinded identity, the campaign and the tier — so it cannot test a guessed address against the set, but it can link one person across campaigns, because the identity it is handed is not campaign-scoped. And it holds the signing key the contract pins, so it can mint claims for identities that never existed and burn nullifiers belonging to people who never showed up. No assert in the circuit stands between it and any of that. Run your own.
