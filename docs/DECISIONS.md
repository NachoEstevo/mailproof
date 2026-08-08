# Decisions

Architecture decisions taken during implementation. Format per Appendix J.

---

## D-001 — Use a signed attestor bridge

**Date:** 2026-08-07
**Status:** accepted

### Context

Gate 0 (§26) asks a mentor whether Compact can verify an external ZK Email
proof directly. No mentor was available at implementation time, so the
question was answered against the toolchain itself: the Compact 0.31.1
standard library was probed for a verifier primitive. It exposes
`persistentHash`, `transientHash`, `hashToCurve`, `ecAdd`, `ecMul` and
`ecMulGenerator`, but no Groth16/Plonk verifier and no `verifySignature`.
There is no documented path to verifying a foreign proof inside Compact.

### Decision

Verify the ZK Email proof off-chain in the attestor. Sign a canonical
`ClaimAttestationV1`. Verify that signature inside Compact.

Gate 0 outcome (§26.3):

```text
DIRECT_EXTERNAL_PROOF = no
ATTESTOR_BRIDGE       = yes
TARGET_NETWORK        = undeployed (local devnet) first, preview optional
SIGNATURE_PATTERN     = Schnorr over Jubjub, built on stdlib curve primitives
```

### Consequence

The attestor is a trust boundary. Recorded in `KNOWN_LIMITATIONS.md` and
stated in the README rather than hidden.

### Rejected alternatives

- RSA/DKIM verification inside Compact — out of scope for the time budget (§8, option C).
- Storing only a proof hash — verifies nothing (§8, option D).
- Backend boolean — makes Compact decorative (§8, option E).

---

## D-002 — Schnorr over Jubjub, hand-rolled on stdlib primitives

**Date:** 2026-08-07
**Status:** accepted

### Context

§18 prefers a native signature primitive, falling back to the ZK Loan
tutorial pattern. Compact 0.31.1 has no signature verification builtin
(`verifySignature` is an unbound identifier), but it does expose the embedded
curve operations needed to build one.

### Decision

Implement textbook Schnorr over the embedded Jubjub curve:

```text
keygen   x <- [1, l),  P = x·G
sign     R = k·G,  c = H(dom, R, P, m),  s = k + c·x mod l
verify   s·G == R + c·P
```

Verification uses only `ecMulGenerator`, `ecAdd`, `ecMul` and
`persistentHash`. The scheme is not invented — only its assembly from these
primitives is.

### Consequence

Two implementations exist: the circuit and its TypeScript twin in
`packages/shared/schnorr.ts`. They must agree byte for byte.
`contracts/tests/golden-vectors.test.ts` compares them against the compiled
circuit on every run, which is the §44.3 golden vector requirement.

---

## D-003 — 224-bit Fiat-Shamir challenge

**Date:** 2026-08-07
**Status:** accepted

### Context

`ecMul` takes a scalar the runtime decodes as `EmbeddedFr`, valid only in
`[0, l)`. A value at or above `l` does not fail an assert — it **faults the
runtime** with `failed to decode for built-in type EmbeddedFr`. Verified
empirically. A challenge derived as a full field element would therefore
crash on roughly one input in sixteen instead of rejecting cleanly.

Compact also has no mutable locals and no modulo on `Field`, so reducing a
hash mod `l` inside a circuit is not straightforward.

### Decision

Derive the challenge from the leading 28 bytes of the digest, big-endian.
The result is always below 2^224, structurally below `l`, so the derivation
is total. 224 bits is well above the 128 bits Schnorr soundness needs.

### Consequence

The challenge is not a full-width field element. This is a deliberate
narrowing, not an oversight, and is re-checked by
`jubjub-constants.test.ts` (`2^224 < l`).

### Rejected alternatives

- Rejection-sampling the nonce until the challenge fits 248 bits — biases the
  published scalar in a non-standard way; not worth inventing a variant for.
- Witness-provided quotient with an in-circuit `full == q·l + c` constraint —
  sound, but more machinery than the problem needs.

---

## D-004 — Signature scalar carried as two limbs

**Date:** 2026-08-07
**Status:** accepted

### Context

The Schnorr response `s` is a 252-bit scalar. Compact caps `Uint<N>` at
N = 248, so `s` does not fit in one field of the signature struct.

### Decision

Carry `s` as `responseHi: Uint<124>` and `responseLo: Uint<128>`. The circuit
range-checks the pair lexicographically against `l`'s limbs before
recombining them, so an out-of-range scalar is rejected as an invalid
signature rather than faulting the runtime (see D-003).

### Consequence

`splitScalar` / `joinScalar` in `packages/shared/schnorr.ts` own this
encoding. The limb boundary is an implementation detail of the wire format,
not of the scheme.

---

## D-006 — Pin `onchain-runtime-v3` to 3.0.0 with an npm override

**Date:** 2026-08-07
**Status:** accepted

### Context

`redeemClaim` failed on chain with `expected instance of StateValue`, thrown
from an `instanceof` check inside the transaction builder — while deployment
worked. Two copies of `@midnight-ntwrk/onchain-runtime-v3` were installed:
3.1.0 hoisted for `compact-runtime@0.16.0` (which asks for `^3.0.0`) and 3.0.0
nested for `midnight-js-protocol@4.1.1` (which pins it exactly).

The package exposes WASM-backed classes. Two copies means two class
identities, so an object built by one is not recognised by the other.

Both packages are at the versions the compatibility matrix specifies. The
conflict is created by npm's resolution of the caret range, not by either
package being wrong.

### Decision

```json
"overrides": { "@midnight-ntwrk/onchain-runtime-v3": "3.0.0" }
```

followed by `npm dedupe`. 3.0.0 satisfies both `^3.0.0` and the exact pin, so
this narrows resolution rather than forcing anything out of range.

### Consequence

Anyone regenerating `package-lock.json` must keep the override, or this
returns as a confusing runtime error far from its cause. Note that
`npm install` alone left two same-version copies; `npm dedupe` was needed to
collapse them.

---

## D-005 — Subject binding from private state, not from a wallet address

**Date:** 2026-08-07
**Status:** accepted

### Context

§73 offers two options: bind the claim to a secret held in private state, or
to a public wallet identity. The second is simpler but more linkable.

### Decision

Bind to a witness-supplied secret:
`subjectBindingHash = H("MAILPROOF:SUBJECT:V1", secret, campaignId)`.

### Consequence

A stolen but validly signed claim cannot be redeemed by anyone who does not
hold the secret — covered by the second C-09 test. The binding is
campaign-scoped, so the same user is not linkable across deployments by their
subject binding. This does **not** prove inbox ownership; see
`KNOWN_LIMITATIONS.md`.

## D-007 — DKIM-direct verification while the ZK Email blueprint is pending

**Date:** 2026-08-07
**Status:** accepted

### Context

The pinned ZK Email blueprint does not exist on registry.zk.email yet, which
left the demo verifying nothing (fixture verifier) while every stage
downstream of verification was already real. Meanwhile the repo carries a
complete RFC 6376 verifier (`packages/shared/dkim.ts`), validated against a
real Google-signed message.

### Decision

Add a second cryptographic path: blueprints that pin a DKIM DNS record in
`config/blueprints.json` (`dkim.dnsRecord`) are verified directly by the
attestor — RSA-SHA256 over the message the provider actually signed. A
routing verifier picks the path per blueprint; ZK Email remains the path for
every entry without a pinned key.

The nullifier derives from the signed Message-ID, consumed bottom-up per
§5.4.2, with an instance-count check so an unsigned prepended Message-ID can
never mint a second nullifier from one signed email.

The claim marker is read only from decoded `text/plain` parts (`mime.ts`),
never from the transfer-encoded bytes. An adversarial review found this to be
load-bearing rather than cosmetic: a quoted-printable soft break placed before
the marker makes the *encoded* text look like it has a line boundary there, so
searching encoded bytes lets

    Please disregard the earlier notice. It is not true that =
    Your flight MP401 has been cancelled.

satisfy the anchored `^…$` pattern — from a message that says the opposite of
the claim, with a perfectly valid signature. Decoding is therefore a security
requirement, and it must follow each part's declared
`Content-Transfer-Encoding`: decoding unconditionally lets a literal `=0A` in a
non-QP body manufacture the same fake line boundary.

### Consequence

Every stage of the demo is now real cryptography: the email's own RSA
signature, the attestor's Schnorr signature verified in-circuit on Midnight,
and the one-time nullifier. The honest cost, stated in the UI: in this mode
the attestor sees the email. That is exactly the disclosure ZK Email removes,
and the seam (`ProofVerifier`) is unchanged — pinning the blueprint swaps the
path without touching anything downstream. The pinned DNS record also means
verification does not depend on DNS availability at claim time; key rotation
by the issuer requires re-pinning, and the pinned entry names its selector so
a rotated key fails as "wrong selector" rather than as apparent tampering.

An HTML-only message cannot back a claim: rendering HTML to text is a
transformation this project does not implement, and matching a marker against
HTML source would match something no reader ever saw. Extraction fails closed.

---

## D-008 — A browser extension as the front end, with the daemon unchanged

**Date:** 2026-08-07
**Status:** accepted

### Context

DKIM signs the original RFC822 bytes. Once Gmail has rendered a message those
bytes are gone from the page, so the web demo has to ask the user to open
"Show original", save a file, and drag it back — three manual steps in front
of a room, and three steps a real product would never ask for. That gap is
the one thing a web page structurally cannot close.

The obvious counter-proposal, rewriting the app as an extension, would have
put midnight-js behind a bundler in a service worker: WASM, a proof server
connection and a wallet, all in the environment with the least room to debug
on stage.

### Decision

Keep the daemon exactly as it is and add `apps/extension` as a second client
of the same HTTP API. The side panel holds no keys, generates no proofs and
speaks to no remote host; it reads the open message and posts it to
`127.0.0.1:3000`, the same bytes the drop zone would have carried.

Two things make that safe rather than merely convenient:

- The manifest pins a `key`, which fixes the extension id. The daemon derives
  the allowed origin from that same key at startup
  (`packages/shared/extension-id.ts`), so its CORS rule names one origin and
  cannot drift from the extension. `*` would have let any page or extension
  on the machine post someone's mail into the process.
- Capture is an accelerator, never the critical path. Locating the open
  message and reading its source each have more than one strategy and a
  validation gate, and the panel falls back to a file picker whenever they
  come up empty.

### Consequence

The demo becomes one click beside the inbox, and the capture was verified to
produce the message byte for byte identically to saving it by hand.

Three costs, all real:

- **Gmail's markup is not a contract.** Three separate details had to be
  found empirically: `permmsgid` takes the message id in decimal while the
  DOM carries hex, Gmail enforces Trusted Types so `DOMParser` throws, and
  "Download Original" (`view=att&th=<hex>`) serves the message verbatim with
  no session key — which is why it now leads. Any of these can change.
- **A connector wallet cannot reach the panel.** Wallets inject
  `window.midnight` into web pages, not into other extensions' pages, so the
  bridge added in `apps/web/wallet-bridge.ts` only works from the web UI. The
  panel is served by the daemon's own devnet wallet.
- **Chrome 137 dropped `--load-extension`.** The flag is accepted and
  silently ignored; the only symptom is `ERR_BLOCKED_BY_CLIENT` on the
  extension's own pages. Loading is a manual step, or
  `Extensions.loadUnpacked` over CDP for automation.

The web UI at `:3000` is unchanged and remains the fallback if the extension
misbehaves on the day.

---

## D-009 — More than one run, without a reusable claim

**Date:** 2026-08-08
**Status:** accepted

### Context

A claim is spendable exactly once: the nullifier is
`H(domain, blueprintIdHash, uniqueClaimIdHash, campaignId)`, the contract
inserts it into `usedNullifiers`, and the second attempt is rejected. That is
the property the whole project exists to demonstrate.

It also meant the demo could be run once per deployment. Every further run
needed `npm run demo:reset` at a terminal, plus restarting the attestor and
the web app, which is not something to do in front of a room — and not
something a user of the extension should ever have to know about.

The tempting fix is to make the claim reusable. That would delete the reason
Midnight is in this project at all.

### Decision

Keep the claim one-time and make **rounds** cheap. A round is a campaign: a
fresh contract, pinned to a fresh campaign id, with an empty nullifier set.
`POST /api/new-round` opens one from the side panel, and the button appears
only once the current round has been spent — so the rejection is still seen
before the way past it is offered.

Nothing is weakened. The campaign is part of the nullifier's preimage, so a
new campaign is a genuinely different claim, and the previous contract keeps
its spent nullifier forever. A new campaign is also exactly what a real
deployment opens for a new promotion.

Two supporting changes were needed:

- The attestor re-reads `config/blueprints.json` when its mtime moves. It
  refuses a campaign it has never heard of, so without this every round
  required a restart. A broken file keeps the last good policy.
- `campaignName` is precise to the second. At minute resolution two rounds
  opened in the same minute shared a campaign, which silently turned the
  second into a replay.

The subject's secret is carried across rounds on purpose: it is the user's
identity, not the round's, and minting a fresh one would quietly make each
round a different person rather than a new promotion.

### Consequence

Opening a round costs one deployment, about 25 seconds, and is unlimited.
The demo now reads: verify → replay rejected → new round → the same email
verifies again. The middle step is the pitch; the third stops it from being
a one-shot.

`npm run demo:reset` still exists and still recompiles, which the route does
not — it is the right tool after a contract change, and the wrong one on
stage.
