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
