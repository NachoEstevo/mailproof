## Security model

### What a successful verification asserts

`result.ok === true` from `verify()` asserts three things, no more:

1. Some party controlled a mailbox at a domain you pinned a DKIM key for, when that message was signed.
2. The message carries a challenge code authenticating under your `challengeSecret` and `audience`, and the DKIM signature is inside your age bound.
3. The blinded identity from that mailbox had, or had not, already been spent in this campaign.

Not asserted: current enrolment, current employment, a distinct human being, or that whoever submitted the `.eml` opened your signup page. Possession of the bytes is possession of the proof, for as long as the code lives.

### The trust boundary

Something reads the raw message — the provider's RSA-SHA256 signature cannot be verified without it.

- `verify()`: your own process. The DKIM check runs in-process; only the blinded identity leaves.
- Upload to the daemon (the demo's and the extension's path, mode D-007, the one this repo runs): the attestor reads it.
- `trust` is stamped on every success either way — a fixed literal in the return value, not a measurement of where the bytes went:

```ts
const result = await mailproof.verify(eml)
if (result.ok) {
  result.trust // { emailReadBy: 'attestor', cryptographic: true, blindingKeyId: '4f2a…' }
}
```

`mailproof.compact` pins the attestor's Schnorr key into `attestorPublicKey` at construction. None of `redeemClaim`'s nine asserts looks at an email: claim encoding (1), values pinned at construction (4), the caller's private subject secret (1), the attestor's signature (2), nullifier unspent (1). If the attestor signs a false claim, the contract accepts it. No rotation circuit, no pause circuit: the pinned key lasts the life of the deployment. So run your own daemon:

```ts
redemption: httpRedemptionClient({ baseUrl: 'https://mailproof.internal.example', token })
```

Nothing in the SDK assumes the daemon is ours. Whoever runs it is the authority on whether a claim is spent, and holds the key the contract trusts.

### `From:`, not `To:`

DKIM signs what the sender wrote, and the sender chose `To:`. So anyone who can sign for a domain mints a message addressed to any mailbox they invent inside it — a colleague's included — and pre-burns that slot at no cost; an insert-only nullifier set cannot give it back.

A provider will not sign a message claiming to come from a mailbox the sender does not control: that is DKIM alignment, and what DMARC checks. So `verifySelfAttestation`:

- requires the signature to cover `From:`, and takes the bottom-most instance (RFC 6376 §5.4.2 consumes instances bottom-up);
- refuses when the message carries more `From:` instances than `h=` covered — an unsigned prepended header is `FROM_NOT_SIGNED`, not a guess;
- applies `domainAligns`: the signing domain must be the mailbox domain or a parent of it. `udesa.edu.ar` vouches for `mail.udesa.edu.ar`, and for nothing called `notudesa.edu.ar` or `udesa.edu.ar.evil.com`;
- reads the code only from signed material — the covered `Subject:`, and the body truncated to the octets `l=` accounts for, decoded through each part's declared `Content-Transfer-Encoding`. Searching transfer-encoded bytes lets a quoted-printable soft break fabricate a line boundary that was never signed.

### What the challenge code buys

A code is `MP-` plus a 4-byte expiry and a 48-bit HMAC tag over `(audience, expiry)`; default TTL 15 minutes.

- Buys: composed for this verification rather than found; composed for *your* audience, so a code minted for another site fails as a forgery rather than a mismatch; an expiry on evidence that never goes stale by itself.
- Not single use: verification is stateless, and the code is a deterministic function of the secret, the audience and the expiry minute, so it can be presented more than once inside its window.
- Not liveness: a forwarded or stolen `.eml` carrying a valid code verifies. The nullifier, not the code, stops the second submission mattering.

### The freshness bound

`p=` is pinned, not resolved: no DNS in the claim path, but a rotated or revoked key keeps verifying forever. Without an age bound, a 2014 archive is evidence in 2026 and a breach dump is a farm — `dkim-freshness.test.ts` verifies a fourteen-year-old signature with `stale: false`.

- `maxSignatureAgeMs` defaults to 24 hours.
- Stale is reported apart from invalid: the signature is genuine, the age is refused.
- No `t=` is stale by default, since the age cannot be established.
- A future `t=` is not stale: clock skew is common, and it only makes the evidence younger.

### Why the identity is blinded

The nullifier set is public and insert-only, and mailboxes are enumerable: `blinding.test.ts` publishes an unkeyed hash of `anademo@gmail.com`, hashes a candidate list against it, and recovers the exact victim. The same attack against `blindIdentity` under a different key finds nothing.

`blindIdentity` is HMAC-SHA256 under a key of at least 32 bytes, domain-separated with `MAILPROOF:BLINDED-IDENTITY:V1`, folded to 32 bytes.

- It makes the *ledger* opaque, nothing more: anyone holding `blindingKey` — through the SDK, you — can recompute the mapping for any address they can guess.
- Rotation renames every person and silently grants everyone a second benefit; `blindingKeyId` is published so a rotation is visible.
- It takes only the mailbox and the key, so the daemon receives the same blinded identity for one person in every campaign. The on-chain nullifier is campaign-scoped; that identity is not.
- Account continuity uses a second derivation over `audience + mailbox`. Its
  returned `identityHandle` is not the public nullifier and cannot be linked
  across integrators with different audiences. It still changes on key
  rotation, so the key must be backed up and rotated only with migration.

### Canonicalisation is a security control

"One per person" is only as good as the map from a header field to a mailbox, so `mailbox.ts` parses the RFC 5322 grammar, masking quoted strings and comments before any index arithmetic.

| | |
| --- | --- |
| **Inert** | `"evil@harvard.edu" <me@gmail.com>`, `me@gmail.com (evil@harvard.edu)`, `(evil@harvard.edu) me@gmail.com`, `"a,b<c>d:e;" <me@gmail.com>` all yield `me@gmail.com`. A regex hunting for `@` grants a university tier to a Gmail account. |
| **Refused** | `a@x.com, b@y.com` and `Team: a@x.com, b@y.com;` — "the first recipient" is the sender's choice, not a fact about the claimant — and `undisclosed-recipients:;`, which names nobody. |
| **Fail closed** | `me(a(nested)comment)@gmail.com`, `ana@[192.0.2.1]`, `ana@localhost`, `ana@a..b.com`, `+tag@gmail.com`. |
| **One person** | `anademo@`, `AnaDemo@`, `a.n.a.d.e.m.o@`, `anademo+lain@gmail.com`; `ana@ÜNI.example` is `ana@xn--ni-wka.example`. Dot-collapsing applies only to `gmail.com`, `googlemail.com` and domains you name — elsewhere it merges `a.b@` with `ab@`, putting two colleagues on one nullifier and locking the second out permanently. |

### What is not covered

- **Catch-all domains.** A domain owner holding its DKIM key signs `From:` any local part in it: unbounded mailboxes, unbounded nullifiers. `notFreeProvider` is a friction tax on casual farming, not an anti-sybil control — a $1/yr domain with catch-all MX defeats it. Gate what matters on an explicit domain list, itself only as strong as that institution's mailbox issuance.
- **Shared mailboxes.** `admissions@`, `info@`, a team alias: one mailbox, one nullifier, many people, spent for all of them indistinguishably.
- **Alumni and leavers.** DKIM proves control now, not entitlement. No revocation channel: a signed message cannot be withdrawn, so an address that outlives enrolment keeps earning the tier. The only real lever is a short campaign.
- **Griefing an insert-only set.** `usedNullifiers` has `member` and `insert` only — no removal, no pause, no attestor rotation. A slot burned in error or in malice stays burned for the life of that campaign; the remedy is a new campaign, which resets everyone, including whoever caused it.
- **The off-curve announcement.** `redeemClaim` range-checks the signature scalar so a bad one rejects cleanly; `sig.announcement` gets no equivalent guard and cannot — Compact 0.31.1 exposes no on-curve predicate and `JubjubPoint` is opaque. `R = (1,1)` and `R = (0,0)` fail with `unreachable`, which is not one of the stable error codes. The cost is a clear error message, not soundness: `c = H(R, P, m)` still binds `R`.
- **Metadata.** A chain observer sees the contract, the circuit called, the timing, the nullifier and the claim count. Repeated use of the same subject binding within a campaign is linkable.

### Malicious integrator versus malicious attestor

**A malicious integrator** gets little *from the protocol*: no address in the return value — the SDK's own test asserts that neither the local part nor the domain appears anywhere in it — and the daemon receives 32 blinded bytes, the campaign name and the tier id. `reveal: 'tier'` discloses "is a student"; `reveal: 'domain'` is the larger ask. But `verify(eml)` runs in the caller's process: whoever calls it holds the raw message for that call, and the blinding key permanently. The guarantee covers what is downstream — the handles you store, the ledger, any later reader of your database — not a party already holding the message. Store the campaign handle or account handle, never on the same row as an email address: that recreates the join blinding exists to prevent.

**A malicious attestor** can do a great deal. It reads every message sent to it in DKIM-direct mode, and holds the signing key the contract pins, so it can mint claims for identities that never existed and burn nullifiers belonging to people who never showed up — no assert in the circuit stands between it and that. It never receives your blinding key (`httpRedemptionClient` posts only the blinded identity, the campaign and the tier), so it cannot test a guessed address against the set, but it can link one person across campaigns: the identity it is handed is not campaign-scoped.
