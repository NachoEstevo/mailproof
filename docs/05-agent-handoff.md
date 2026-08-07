# 61. Agent operating contract

The implementation agent must follow these rules.

## 61.1 General

1. Read this document first.
2. Do not invent APIs.
3. Inspect installed package types.
4. Pin versions.
5. Work gate by gate.
6. Run verification after every gate.
7. Update `docs/BUILD_LOG.md`.
8. Record decisions in `docs/DECISIONS.md`.
9. Record failures.
10. Fail closed.

## 61.2 Scope

Do not add features not listed in P0.

Do not add:

- Gmail;
- multiple claims;
- generic blueprint builder;
- direct DKIM Compact circuit;
- payments;
- tokens;
- NFTs;
- mobile app;
- embedded wallet;
- decentralized attestor network.

## 61.3 Privacy

Never commit:

- raw personal email;
- API tokens;
- wallet seed;
- signing private key;
- proof with PII;
- logs with PII.

Use synthetic fixtures.

## 61.4 Claims

Do not claim a feature works until a command or test proves it.

Use language:

```text
implemented
tested
simulated
planned
not supported
```

Do not mix them.

## 61.5 Error handling

Do not add a bypass that converts errors into success.

Do not use:

```ts
catch {
  return true;
}
```

Do not mock proof success in production paths.

## 61.6 Git

Make small commits.

Suggested:

```text
chore: scaffold Midnight contract
feat: verify signed mail claim
test: reject replayed claims
feat: verify ZK Email proof
feat: bridge proof to Compact claim
feat: add MailProof demo flow
docs: add threat model and runbook
```

---

# 62. Master prompt for Codex

Copy this block into the implementation agent.

```text
You are the lead implementation engineer for MailProof.

Read `MailProof_Midnight_Hack_2026_Master_Plan.md` in full before editing files.

Objective:
Build the smallest credible end-to-end MailProof demo.

The demo must:
1. accept a synthetic DKIM-signed `.eml`;
2. generate or load a locally generated ZK Email proof;
3. verify the proof through an allowlisted blueprint;
4. convert the verified proof into a canonical signed MailProof claim;
5. let a Compact contract verify and redeem that claim;
6. reject the same claim a second time;
7. show exactly what stayed private and what became public.

Architecture:
`.eml local -> ZK Email -> MailProof attestor -> Compact -> dApp`

Important trust boundary:
The attestor is trusted in the MVP. Do not hide this fact.
Do not attempt to implement RSA/DKIM or a generic foreign-proof verifier in Compact unless the mentor gives a documented supported path.

Operating method:
- Work gate by gate.
- Do not start the frontend before the Compact signed-claim tests are green.
- At the end of each gate, run the verification command.
- Update `docs/BUILD_LOG.md`.
- Record architecture changes in `docs/DECISIONS.md`.
- Record limitations in `docs/KNOWN_LIMITATIONS.md`.
- Use Node 22+.
- Pin all Midnight and ZK Email versions.
- Inspect current package APIs and generated types. Do not guess.
- Use local devnet first.
- Fail closed on unknown verification results.
- Never log or commit a personal email, signing key, wallet seed, or raw proof containing PII.

Priority:
P0 contract and CLI end-to-end.
P1 browser UX.
P2 physical output and delegation-like extensions are out of scope.

First actions:
1. Inspect the current repository.
2. Read the official Midnight compatibility matrix and record the exact versions.
3. Verify Node, Docker, Compact and Git.
4. Scaffold a minimal Midnight contract.
5. Compile and run the template test.
6. Commit the clean baseline.
7. Implement the signed-claim Compact spike.

Stop conditions:
- If Compact does not compile after one hour, stop all other work and fix the toolchain.
- If a custom ZK Email blueprint does not prove after 90 minutes, switch to the official Luma or another existing blueprint.
- If browser proving blocks progress, prove in Node.
- If live proving is unstable, use a clearly disclosed locally generated proof fixture.
- If preview is unstable, stay on local devnet.
- Never replace a failed security check with a mocked success.

At completion, run:
- typecheck;
- lint;
- unit tests;
- contract tests;
- integration tests;
- production build;
- secret scan;
- demo reset;
- three full demo rehearsals.

Return:
- implemented features;
- commands run;
- test results;
- architecture decisions;
- known limitations;
- exact demo procedure;
- remaining risks.
```

---

# 63. First action checklist for the agent

The agent should output this before code:

```text
Repository status:
Runtime versions:
Midnight versions:
ZK Email version:
Chosen network:
Chosen blueprint:
Chosen claim:
Chosen unique email field:
Attestor signature method:
Subject binding method:
Fallback blueprint:
Time budget:
Open blockers:
```

Do not proceed with unknown signature method.

Do not proceed with no unique claim field.

---

# 64. Final decision tree

```text
Does Compact compile?
  no → fix environment
  yes
    ↓
Can Compact verify signed claim + reject replay?
  no → simplify contract
  yes
    ↓
Can ZK Email prove one fixture?
  no → use existing blueprint
  yes
    ↓
Can attestor verify and sign?
  no → fix bridge
  yes
    ↓
Can CLI redeem end-to-end?
  no → do not build UI
  yes
    ↓
Can browser complete flow?
  no → CLI fallback + continue integration
  yes
    ↓
Are negative tests visible?
  no → add tamper + replay
  yes
    ↓
Freeze features
```

---

# 65. Source registry

Use primary sources.

## Midnight

- Documentation index:  
  https://docs.midnight.network/

- LLM documentation index:  
  https://docs.midnight.network/llms.txt

- Quickstart / create a Midnight DApp:  
  https://docs.midnight.network/getting-started/quickstart

- Security best practices:  
  https://docs.midnight.network/guides/security-best-practices

- ZK Loan tutorial and attestation pattern:  
  Search the official docs for `ZK Loan smart contract`.

- Compatibility matrix:  
  https://github.com/midnightntwrk/midnight-docs/blob/main/docs/relnotes/support-matrix.json

- Official GitHub:  
  https://github.com/midnightntwrk

## ZK Email

- Documentation:  
  https://docs.zk.email/

- SDK repository:  
  https://github.com/zkemail/zk-email-sdk-js

- Registry:  
  https://registry.zk.email/

- SDK package:  
  `@zk-email/sdk`

- RFC DKIM:  
  https://www.rfc-editor.org/rfc/rfc6376

## Hackathon

- Event:  
  https://hackbuenosaires.com/

- Rules:  
  https://hackbuenosaires.com/rules

- Official Rules PDF:  
  https://mpc.midnight.network/hubfs/Midnight_Hack_Buenos_Aires_Official_Rules.pdf

The Official Rules PDF is binding.

---

# 66. Glossary

## Attestation

A signed statement from a trusted verifier.

## Blueprint

A ZK Email template that defines what an email must contain and what fields become public.

## Claim

The minimal fact that the consuming app needs.

## Compact

Midnight's smart contract language.

## DKIM

A standard email signature mechanism.

## Nullifier

A public value used to prevent the same private evidence from being consumed more than once.

## Proof digest

A hash used to bind or audit a specific proof representation.

It is not the replay key unless proven stable for that purpose.

## Subject binding

A commitment that ties a claim to the intended user or context.

## Trust boundary

A component whose honesty or security is an explicit assumption.

## ZK proof

A proof that demonstrates a statement without revealing all private inputs.

---

# 67. Final product statement

> **MailProof lets a user turn an authenticated email into a private, one-time claim for a Midnight application.**

> **The sender keeps sending normal email.**

> **The verifier learns the fact it needs.**

> **The email stays private.**

# **Turn emails into private proofs.**

# 68. Appendix A — Configuration

## 68.1 `.env.example`

```bash
# Network
MIDNIGHT_NETWORK=undeployed

# Attestor
MAILPROOF_ATTESTOR_KEY_ID=demo-v1
MAILPROOF_ATTESTOR_PRIVATE_KEY=
MAILPROOF_MAX_REQUEST_BYTES=5000000
MAILPROOF_REQUEST_TIMEOUT_MS=30000

# Claim
MAILPROOF_CAMPAIGN_ID=travel-insurance-demo-2026
MAILPROOF_CLAIM_TYPE=FLIGHT_CANCELLED
MAILPROOF_BLUEPRINT_ID=owner/FlightCancellation@v1

# Web
NEXT_PUBLIC_MAILPROOF_ATTESTOR_URL=http://localhost:8787
NEXT_PUBLIC_MIDNIGHT_NETWORK=undeployed
```

Rules:

- `.env` is gitignored.
- `.env.example` contains no secret.
- frontend receives no signing key.
- `NEXT_PUBLIC_*` must contain public values only.

---

## 68.2 Blueprint allowlist

```json
{
  "flight-cancel-v1": {
    "slug": "owner/FlightCancellation@v1",
    "claimType": "FLIGHT_CANCELLED",
    "issuerDomainHash": "0x...",
    "campaignId": "travel-insurance-demo-2026",
    "requiredOutputs": [
      "cancellationMarker",
      "uniqueClaimId"
    ]
  }
}
```

The agent must replace placeholder values.

Do not leave `0x...` in a running environment.

---

# 69. Appendix B — Suggested package scripts

Adapt to the generated scaffold.

```json
{
  "scripts": {
    "setup": "...",
    "contract:compile": "compact compile contracts/mailproof.compact managed/mailproof",
    "contract:test": "vitest run contracts/tests",
    "zkemail:prove": "tsx scripts/prove-email.ts",
    "zkemail:verify": "tsx scripts/verify-email.ts",
    "attestor:dev": "tsx services/attestor/src/server.ts",
    "attestor:test": "vitest run services/attestor/tests",
    "e2e:claim": "tsx scripts/e2e-claim.ts",
    "demo:reset": "tsx scripts/reset-demo.ts",
    "test": "npm run contract:test && npm run attestor:test",
    "typecheck": "tsc --noEmit",
    "verify": "npm run typecheck && npm run test && npm run build"
  }
}
```

Do not overwrite scripts generated by `create-mn-app` blindly.

Merge carefully.

---

# 70. Appendix C — TypeScript schemas

These are design sketches.

The agent must adapt them to installed libraries.

## 70.1 Claim type

```ts
export type ClaimType = "FLIGHT_CANCELLED";

export interface ClaimAttestationV1 {
  version: 1;
  claimType: ClaimType;
  blueprintIdHash: string;
  issuerDomainHash: string;
  campaignId: string;
  subjectBindingHash: string;
  claimNullifier: string;
  proofDigest: string;
}
```

## 70.2 Attestation response

```ts
export interface SignedMailProofClaim {
  claim: ClaimAttestationV1;
  signature: {
    announcementX: string;
    announcementY: string;
    response: string;
  };
  attestorKeyId: string;
}
```

## 70.3 UI state

```ts
export type ClaimFlowState =
  | { tag: "idle" }
  | { tag: "file-selected"; fileName: string }
  | { tag: "validating" }
  | { tag: "proving"; startedAt: number }
  | { tag: "proof-ready" }
  | { tag: "attesting" }
  | { tag: "submitting" }
  | { tag: "confirmed"; receiptId: string }
  | { tag: "rejected"; code: string }
  | { tag: "error"; code: string; message: string };
```

Use a reducer or state machine.

---

# 71. Appendix D — Compact design sketch

This is not drop-in code.

The agent must use current Compact syntax and generated types.

```text
ledger:
  attestorPublicKey
  campaignId
  usedNullifiers
  approvedClaimCount
  paused

circuit redeemClaim(claim, signature, subjectSecret):
  assert not paused
  assert claim.version == 1
  assert claim.claimType == FLIGHT_CANCELLED
  assert claim.campaignId == campaignId
  assert claim.subjectBindingHash == deriveSubject(subjectSecret)
  assert verifyAttestorSignature(canonicalClaim(claim), signature)
  assert not usedNullifiers.member(claim.claimNullifier)

  usedNullifiers.insert(claim.claimNullifier)
  approvedClaimCount += 1
```

Security rule:

Every witness-controlled field must be constrained.

Do not trust:

- signature result from TypeScript;
- `ownPublicKey()` as authentication;
- claimed campaign;
- claimed subject;
- claimed proof validity.

---

# 72. Appendix E — Nullifier design decision

Preferred input:

```text
H(
  "MAILPROOF:NULLIFIER:V1",
  blueprint ID,
  hashed unique claim ID,
  campaign ID
)
```

Properties:

- same email claim in same campaign → same nullifier;
- same email claim in another campaign → different nullifier;
- raw booking ID not public.

Do not include random salt if deterministic replay prevention is required.

If public outputs do not expose a stable unique field:

1. inspect blueprint;
2. add a private field exposed only to attestor;
3. hash it;
4. if impossible, use subject + message ID with documented limitations;
5. do not use randomized proof bytes as the only nullifier source.

---

# 73. Appendix F — Subject binding design

Preferred MVP:

```text
subjectBindingHash =
H(
  "MAILPROOF:SUBJECT:V1",
  userSecret,
  campaignId
)
```

Compact derives the same value from private state.

Alternative:

Bind to a public wallet identity.

Tradeoff:

- simpler;
- more linkable.

Do not bind only to an email address unless the blueprint securely exposes and proves the recipient.

---

# 74. Appendix G — Privacy review before commit

Run this review.

Search:

```bash
git grep -n -i \
  -e '@gmail.com' \
  -e '@hotmail.com' \
  -e '@outlook.com' \
  -e 'BEGIN PRIVATE KEY' \
  -e 'mnemonic' \
  -e 'seed phrase' \
  -e 'booking reference'
```

Also inspect:

```bash
git status --short
git diff --cached
```

Verify:

- `.eml` private folder ignored;
- `.env` ignored;
- proof fixture reviewed;
- logs reviewed;
- screenshots use synthetic data.

---

# 75. Appendix H — Demo fixture design

Use names that cannot be confused with real users.

```text
Passenger: Ana Demo
Email: ana.demo@example.test
Airline: Demo Air
Flight: MP401
Booking: MP-8F2A19
Claim ID: CLAIM-DEMO-0001
```

Use reserved test domains where possible.

Add a watermark:

```text
SYNTHETIC DEMO EMAIL
```

The email still needs valid DKIM for the proof flow.

If a real domain sends it, keep personal fields synthetic.

---

# 76. Appendix I — Build log template

`docs/BUILD_LOG.md`

```md
# Build Log

## Environment
- Date:
- Commit:
- Node:
- Compact:
- Midnight.js:
- ZK Email SDK:
- Network:

## Gate
- Gate ID:
- Goal:
- Started:
- Completed:

## Commands
```bash
...
```

## Result
- Pass/fail:
- Tests:
- Proof time:
- Transaction time:

## Errors
- Error:
- Root cause:
- Fix:

## Next action
...
```

---

# 77. Appendix J — Decision log template

`docs/DECISIONS.md`

```md
# Decisions

## D-001 — Use signed attestor bridge
Date:
Status: accepted

### Context
Compact has no documented direct verifier for the selected ZK Email proof.

### Decision
Verify ZK Email off-chain. Sign a canonical claim. Verify the signature in Compact.

### Consequence
The attestor is a trust boundary.

### Rejected alternatives
- RSA/DKIM in Compact
- proof hash only
- backend boolean
```

---

# 78. Appendix K — Known limitations template

`docs/KNOWN_LIMITATIONS.md`

```md
# Known Limitations

1. The MVP trusts one MailProof attestor.
2. It supports one pinned email blueprint.
3. It proves an authenticated email claim, not objective truth.
4. Possession of `.eml` is not permanent inbox ownership.
5. The sender template can change.
6. Metadata can remain visible.
7. Browser proving can be slow.
8. The demo can use local devnet.
9. Direct ZK Email proof verification in Compact is not implemented.
10. Email source does not receive a revocation channel.
```

---

# 79. Appendix L — Demo rehearsal report

After each rehearsal:

```md
## Run 01

- Commit:
- Browser:
- Network:
- Live proof: yes/no
- Proof time:
- Midnight time:
- Total:
- Replay worked:
- Tamper worked:
- Reset worked:
- Manual interventions:
- Failure:
- Fix:
```

Stop feature work if the demo is not reliable.

---

# 80. Final execution order

The agent must execute this exact high-level sequence.

```text
01 Read plan
02 Inspect repo
03 Pin versions
04 Compile scaffold
05 Create minimal contract
06 Verify signed fixture claim
07 Reject replay
08 Acquire valid email fixture
09 Pin blueprint
10 Generate local ZK Email proof
11 Verify proof
12 Build attestor
13 Sign canonical claim
14 Redeem through CLI
15 Repeat end-to-end
16 Build frontend
17 Add tamper path
18 Add replay path
19 Add disclosure panel
20 Add reset
21 Run tests
22 Write docs
23 Record demo
24 Freeze
25 Submit
```

Do not reverse steps 4–15.

The project is not a frontend around an unverified idea.

The project is a working private claim pipeline.

# **Email → proof → Midnight action.**
