## What an SDK is

An SDK — a software development kit — is the code the authors of a system publish so that everybody who integrates with it does not have to rebuild it. It is the difference between being handed the fitted parts and being handed the specification. You could write an RFC 6376 DKIM verifier, a challenge format, an address canonicaliser and a nullifier scheme yourself; the SDK is the argument that you should not have to, and that the four of them have to agree with each other to be worth anything.

What you install is a library. It runs inside your own process, on your own server, called from your own code — not a service you send your users to.

## What the MailProof SDK does

`createMailProof` returns an object with three methods, and those three methods are the whole surface. It is server-side by construction: the configuration holds `challengeSecret` and `blindingKey`, and neither may reach a browser.

**It mints codes.** `startVerification()` returns a `code`, an `expiresAt` and an `instructions` string with the code already in it, ready to show. The code carries its own expiry and its own HMAC tag, bound to your `audience`, so verifying it needs no stored state, and a code minted for your site does not authenticate anywhere else.

**It reads the message.** `verify(eml)` parses the `.eml`, tries each pinned DKIM key, and for each signature checks that it verifies, that it has not passed its `x=` and is no older than `maxSignatureAgeMs` (24 hours by default), that it covers `From:`, that no unsigned instance of `From:` was prepended, that the signing domain aligns with the mailbox domain, and that the signed subject or plain-text body carries a code that authenticates for your `audience` and has not expired (`challengeTtlMs`, 15 minutes by default). When every key fails, the reason you get back is from the attempt that got furthest, not the last one tried. It then canonicalises the mailbox and folds it through a keyed hash.

**It applies your tier rules.** `tiers` is a list; the first rule that matches the domain wins; a domain matching nothing gets no tier, never a default one. `notFreeProvider` is available and is a friction tax on casual farming, not an anti-sybil control — a dollar-a-year domain with catch-all MX defeats it. Gate anything that matters on an explicit domain list.

**It hands back a decision.** The result is `{ ok: true, tier, handle, alreadyClaimed, nullifier, contractAddress, trust }` — plus `domain` when you set `reveal: 'domain'`, and `txId` when something was actually submitted, which for a repeat claim it was not — or `{ ok: false, reason, detail }`. Expected refusals are values, not exceptions, and `alreadyClaimed` is a field, because "has this person already had their benefit" is the question you were asking.

`verifiableDomains()` is the third method: the domains your rules name explicitly, minus the ones you have not pinned a DKIM key for.

## What it deliberately does not do

**It does not decide what the person gets.** It answers "which tier, and is this the first time". Turning that into a discount, a plan or a badge is your code, and stays your code.

**It stores nothing.** There is no table to migrate and no cache to run. Codes are self-authenticating, so nothing is written when one is issued; `handle` is returned to you to store, if you want to store it. Do not store it on the same row as an email address — that recreates the join the blinding exists to prevent.

**It does not talk to a chain.** Redemption goes through `RedemptionClient`, an interface with one method. `httpRedemptionClient` is the supplied implementation: it posts the blinded identity, the campaign and the tier as JSON to `POST /api/redeem-identity` on a MailProof daemon, with a 180-second default timeout because proving is slow. The daemon in this repo does not serve that route yet — `npm run web:dev` exposes `POST /api/redeem`, which takes a whole `.eml` and streams the demo's stages back — so until it does, supply your own `RedemptionClient`. **Quickstart** shows one. Nothing in the SDK assumes the daemon is ours.

## The division of labour

- **The SDK** — policy. Runs in the integrator's process. Holds the challenge secret and the blinding key. Decides tiers.
- **The daemon** — chain access, proving and the wallet. `npm run web:dev`, port 3000. The only component that submits a transaction.
- **The attestor** — signs a canonical `ClaimAttestationV1` with a Schnorr key. Its verifier is pluggable: in DKIM-direct mode, which is what this repo runs today, it is sent the raw email and checks the message's own RSA signature; with a pinned ZK Email blueprint it sees only the proof and its public outputs. `npm run attestor:dev`, port 8787.
- **The contract** — `contracts/mailproof.compact`. Nine asserts, then one insert into `usedNullifiers`. Membership in that set is what makes a claim one-time.

An integrator can self-host all four: the daemon and the attestor are processes in this repo, and the contract is deployed per campaign, so it is your instance holding your nullifiers.

Something reads the raw message, and the SDK says so on every success: `result.trust` is `{ emailReadBy: 'attestor', cryptographic: true, blindingKeyId }`. Through the SDK, the DKIM check runs inside `verify()` in your own process and only the blinded identity is posted onward; in the daemon's `/api/redeem` path — the one the demo and the browser extension use — the message is sent to the attestor. Either way it is not nobody, and the attestor is trusted: if it signs a false claim, the contract accepts it. **Security model** sets out what that costs you.

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
