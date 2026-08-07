# Build Log

Format per Appendix I. Newest gate last.

## Environment

- Date: 2026-08-07
- Platform: macOS (darwin 25.6.0, aarch64)
- Node: v22.18.0
- npm: 10.9.3
- Docker: 28.5.1 (daemon running)
- Docker Compose: v2.40.3-desktop.1
- Compact devtools: 0.5.1
- Compact toolchain: 0.31.1
- compact-runtime: 0.16.0
- Midnight.js: 4.1.1
- Wallet SDK: 1.2.0
- Proof server image: 8.1.0
- Indexer image: 4.3.3
- Node image: 1.0.0
- ZK Email SDK: not installed yet (Gate 5)
- Network: undeployed (local devnet)

Every version above matches the compatibility matrix pinned in §24.2. Nothing
was resolved with `latest`.

Verification command:

```bash
node --version && docker compose version && compact --version && compact compile --version
```

---

## Gate 0 — Scope and decisions

- Goal: eliminate uncertainty before writing code.
- Result: **pass**.

No mentor was reachable, so §26.1's questions were answered against the
toolchain directly. The Compact 0.31.1 standard library was probed by using
the compiler as an oracle — deliberately mistyping each candidate primitive so
the type checker reports its real signature, rather than guessing from
documentation.

Findings:

```text
persistentHash<T>(T)            -> Bytes<32>
transientHash<T>(T)             -> Field
hashToCurve<T>(T)               -> JubjubPoint
ecAdd(JubjubPoint, JubjubPoint) -> JubjubPoint
ecMul(JubjubPoint, Field)       -> JubjubPoint
ecMulGenerator(Field)           -> JubjubPoint
verifySignature                 -> unbound identifier (does not exist)
```

Decisions recorded in `DECISIONS.md` (D-001 … D-005).

---

## Gate 1 — Repo and first compiling contract

- Goal: pass the technical gate.
- Result: **pass**.

Commands:

```bash
npx create-mn-app@0.5.0 mailproof -t hello-world -y --use-npm --skip-git --skip-install
npm install          # 229 packages, 0 vulnerabilities
npm run compile      # exit 0
```

The scaffold was merged into the existing repository rather than replacing it:
`README.md`, `LICENSE`, `docs/` and `.gitignore` were preserved. `.gitignore`
gained `.midnight-state.json` and `.midnight-wallet-state/`, which hold wallet
seeds and the 24-word recovery phrase.

The hello-world contract was replaced by a minimal MailProof contract
(`approvedClaimCount` + `registerDemoClaim`) to prove the toolchain end to
end, then superseded in Gate 2.

Artifacts produced: `contract/index.{js,d.ts}`, `zkir/`, `keys/*.prover`,
`keys/*.verifier`.

---

## Gate 2 — Signed claim in Compact

- Goal: Compact accepts only a validly signed, correctly scoped, unused claim.
- Result: **pass** for the core matrix. Pause and attestor rotation (C-10,
  C-11) are P1 and not yet implemented.

Implemented:

- `ClaimAttestationV1` and `SchnorrSignature` structs.
- Ledger: attestor public key, campaign, allowed blueprint/issuer/claim type,
  `usedNullifiers` set, `approvedClaimCount`.
- `redeemClaim` with nine sequential checks, each with a distinct stable error
  string from §42.3.
- Schnorr verification over Jubjub, built on stdlib curve primitives.
- TypeScript twin of the whole claim/crypto layer in `packages/shared/`.

### Problems hit and how they were resolved

| Problem | Root cause | Fix |
|---|---|---|
| `Uint width 252 is not between 1 and 248` | Compact caps `Uint` at 248 bits; the Schnorr scalar needs 252 | Split into `Uint<124>` + `Uint<128>` limbs with a lexicographic range check (D-004) |
| `failed to decode for built-in type EmbeddedFr` | Scalars ≥ l fault the runtime instead of asserting | Challenge truncated to 224 bits so it is structurally in range; explicit range check on the response before use (D-003) |
| `parse error: found keyword "let"` / `"var"` | Compact has no mutable locals | Byte folding rewritten as a chain of `const` bindings over a 4-byte helper |
| `parse error: found keyword "const"` at top level | No module-level constants | Domain separators and curve constants expressed as zero-argument circuits |
| `expected structure type, received JubjubPoint` | `.x` / `.y` are not accessible on `JubjubPoint` in Compact | Points hashed whole via `persistentHash<JubjubPoint>`, which the TypeScript side reproduces exactly |

### Results

```bash
npm run compile     # exit 0
npm run typecheck   # exit 0
npm test            # 35 passed (3 files)
```

- `jubjub-constants.test.ts` (5) — re-derives the curve order from the runtime.
- `golden-vectors.test.ts` (12) — TypeScript vs compiled circuit agreement.
- `redeem.test.ts` (18) — C-01…C-09, C-12 plus version, issuer, scalar range
  and a no-secret-leak check.

Each negative case was confirmed to fail at its *intended* assert by printing
the actual thrown message, not merely that it threw.

### Not yet done

- C-10 (paused) and C-11 (rotated attestor) — P1, need a safe admin path.
- Deploy to local devnet and run a real proof (`npm run setup`).
- Gates 3–8: email fixture, blueprint, ZK Email proof, attestor service, CLI
  end-to-end, frontend.

### Next action

Deploy to local devnet and confirm `redeemClaim` proves and lands on chain —
the simulator exercises circuit logic, not proof generation.
