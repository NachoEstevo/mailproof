## What an SDK is

An SDK — a software development kit — is the code a system's authors publish so that everybody who integrates does not have to rebuild it: here, an RFC 6376 DKIM verifier, a challenge format, an address canonicaliser and a nullifier scheme, worth nothing unless the four agree with each other.

What you install is a library. It runs in your own process, on your own server — not a service you send your users to.

## What the MailProof SDK does

`createMailProof` returns three methods. Server-side only: the configuration holds `challengeSecret` and `blindingKey`, and neither may reach a browser.

**`startVerification()`** returns `code`, `expiresAt` and `instructions`, with the code already in the text. The code carries its own expiry and an HMAC tag bound to your `audience`: verifying it needs no stored state, and it authenticates on no other site.

**`verify(eml)`** parses the `.eml` and tries every pinned DKIM key. A signature passes only if: it verifies; it is within its `x=` and no older than `maxSignatureAgeMs` (default 24 hours); it covers `From:`, with no unsigned instance of `From:` prepended; its signing domain aligns with the mailbox domain; and the signed subject or plain-text body carries a code that authenticates for your `audience` and has not expired (`challengeTtlMs`, default 15 minutes). When every key fails, the reason returned is from the attempt that got furthest, not the last one tried. The mailbox is then canonicalised and folded through a keyed hash.

It returns `{ ok: true, tier, handle, alreadyClaimed, nullifier, contractAddress, trust }` — plus `domain` under `reveal: 'domain'`, and `txId` only when a transaction was submitted, which for a repeat claim it was not — or `{ ok: false, reason, detail }`. Refusals are values, not exceptions.

In `tiers`, the first matching rule wins; no match means no tier, never a default. `notFreeProvider` is a friction tax on casual farming, not an anti-sybil control — a dollar-a-year domain with catch-all MX defeats it. Gate anything that matters on an explicit domain list.

**`verifiableDomains()`** returns the domains your rules name explicitly, minus those with no pinned DKIM key.

## What it does not do

- **Decide what the person gets.** It answers which tier, and whether this is the first time; the discount, plan or badge is your code.
- **Store anything.** Nothing is written when a code is issued; `handle` comes back for you to store. Never on the same row as an email address — that recreates the join the blinding exists to prevent.
- **Talk to a chain.** Redemption goes through `RedemptionClient`, one method. `httpRedemptionClient` posts the blinded identity, campaign and tier as JSON to `POST /api/redeem-identity` on a MailProof daemon; the timeout defaults to 180 seconds because proving is slow. No daemon here serves that route yet — `npm run web:dev` serves `POST /api/redeem`, which takes a whole `.eml` — so supply your own `RedemptionClient` (**Quickstart** shows one).

## The division of labour

| Component | Job |
| --- | --- |
| **SDK** | Policy. Runs in the integrator's process. Holds the challenge secret and the blinding key. Decides tiers. |
| **Daemon** | Chain access, proving, wallet. `npm run web:dev`, port 3000. The only component that submits a transaction. |
| **Attestor** | Signs a canonical `ClaimAttestationV1` with a Schnorr key. Verifier is pluggable: DKIM-direct, which this repo runs today, gets the raw email and checks its RSA signature; a pinned ZK Email blueprint sees only the proof and its public outputs. `npm run attestor:dev`, port 8787. |
| **Contract** | `contracts/mailproof.compact`. Nine asserts, then one insert into `usedNullifiers`. Membership in that set is what makes a claim one-time. |

All four are self-hostable: the daemon and the attestor are processes in this repo, and the contract is deployed per campaign, so your instance holds your nullifiers. Nothing in the SDK assumes the daemon is ours.

Every success carries `result.trust`: `{ emailReadBy: 'attestor', cryptographic: true, blindingKeyId }`. Through the SDK, `verify()` checks DKIM in your own process and only the blinded identity goes onward; the daemon's `/api/redeem` path — demo and browser extension — sends the raw message to the attestor. Something always reads it, and the attestor is trusted: a false claim it signs is accepted by the contract. **Security model** sets out what that costs you.

## The smallest real integration

```ts
import { createMailProof } from '@mailproof/sdk'
import type { RedemptionClient } from '@mailproof/sdk'

declare function grantStudentPlan(handle: string): Promise<void>   // yours
declare const redemption: RedemptionClient                          // yours, for now

const mailproof = createMailProof<'STUDENT'>({
  audience: 'lain',
  challengeSecret: Buffer.from(process.env.MAILPROOF_CHALLENGE_SECRET!, 'hex'),
  blindingKey: Buffer.from(process.env.MAILPROOF_BLINDING_KEY!, 'hex'),
  campaign: '2026-S1',
  tiers: [{ id: 'STUDENT', suffixes: ['.edu', '.edu.ar'] }],
  domainKeys: [{ domain: 'udesa.edu.ar', dnsRecord: 'v=DKIM1; k=rsa; p=MIIBIjANBg…' }],
  redemption,
})

// Step one: show the person a code.
export function start() {
  const { code, instructions, expiresAt } = mailproof.startVerification()
  return { code, instructions, expiresAt }
}

// Step two: take the message back and decide.
export async function finish(eml: string) {
  const result = await mailproof.verify(eml)

  if (!result.ok) return { granted: false, reason: result.reason, detail: result.detail }
  if (result.alreadyClaimed) return { granted: false, reason: 'ALREADY_CLAIMED' }

  await grantStudentPlan(result.handle)   // your decision, your database
  return { granted: true }
}
```

Expected refusals are values, not exceptions; an unexpected error — a `.eml` that will not parse, a blinding key under 32 bytes — still throws.

One caveat on the daemon: `npm run web:dev` serves `POST /api/redeem`, which takes a whole `.eml` and streams the demo's stages back as server-sent events rather than returning a JSON receipt. `httpRedemptionClient` talks to `POST /api/redeem-identity`, which is the endpoint an integrator needs.
