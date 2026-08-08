## API reference

Everything below is exported from `packages/sdk/index.ts`. The examples import from `@mailproof/sdk`, the specifier the SDK README uses.

```ts
import {
  createMailProof,
  httpRedemptionClient,
  RedemptionError,
  resolveTier,
  isFreeMailProvider,
  FREE_MAIL_PROVIDERS,
} from '@mailproof/sdk'

import type {
  DomainKey,
  MailProof,
  MailProofConfig,
  TrustDisclosure,
  VerificationRefusal,
  VerificationResult,
  VerificationStart,
  HttpRedemptionOptions,
  RedemptionClient,
  RedemptionOutcome,
  RedemptionReceipt,
  RedemptionRequest,
  TierMatch,
  TierRule,
} from '@mailproof/sdk'
```

Twenty exports: six values and fourteen types. Nothing else is public. In particular `SelfAttestationError`, `BlindingError` and `ChallengeError` are not re-exported, even though the first contributes ten members to `VerificationRefusal` and the other two can be thrown — see [What throws](#what-throws).

**One naming note, once.** `handle` and `nullifier` on a success are the same string. `handle` is the name to store it under; `nullifier` is the ledger's word for it. The section uses `handle` when talking about your database and `nullifier` when talking about the chain.

---

### `createMailProof`

```ts
function createMailProof<T extends string>(config: MailProofConfig<T>): MailProof<T>
```

`T` is the union of your tier ids. It is inferred from `config.tiers`, so `tiers: [{ id: 'STUDENT', … }, { id: 'CORPORATE', … }]` gives you a `MailProof<'STUDENT' | 'CORPORATE'>` and a `result.tier` that switches exhaustively.

**Throws** `BlindingError` — synchronously, at construction — when `blindingKey` is shorter than 32 bytes. This is deliberate: it fails at boot rather than on the first user. Nothing else is validated eagerly.

```ts
export const mailproof = createMailProof({
  audience: 'lain',
  challengeSecret: Buffer.from(process.env.MAILPROOF_CHALLENGE_SECRET!, 'hex'),
  blindingKey: Buffer.from(process.env.MAILPROOF_BLINDING_KEY!, 'hex'),
  campaign: '2026-S1',
  tiers: [
    { id: 'STUDENT', domains: ['udesa.edu.ar'] },
    { id: 'STUDENT', suffixes: ['.edu', '.edu.ar'] },
    { id: 'CORPORATE', notFreeProvider: true },
  ],
  domainKeys: [
    { domain: 'udesa.edu.ar', dnsRecord: 'v=DKIM1; k=rsa; p=MIIBIjANBg…' },
  ],
  redemption: httpRedemptionClient({ baseUrl: 'http://127.0.0.1:3000' }),
  maxSignatureAgeMs: 6 * 60 * 60 * 1000,
  challengeTtlMs: 10 * 60 * 1000,
  reveal: 'tier',
})
```

---

### `MailProofConfig<T extends string = string>`

All fields are `readonly`.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `audience` | `string` | — | Identifies this integrator. Authenticated into every challenge tag, so a code minted here does not verify anywhere else. Changing it invalidates every outstanding code. |
| `challengeSecret` | `Uint8Array` | — | Per-integrator secret for challenge codes. Must be at least 32 bytes. Rotatable: it only invalidates codes in flight. |
| `blindingKey` | `Uint8Array` | — | Key for the keyed hash that turns a mailbox into a handle. Must be at least 32 bytes. **Not** rotatable without consequence: a new key renames every person and hands everyone a second benefit. |
| `tiers` | `readonly TierRule<T>[]` | — | Which domains earn which tier. Evaluated in order; first match wins; no match earns nothing. |
| `domainKeys` | `readonly DomainKey[]` | — | Pinned DKIM public keys. A domain with no pinned key — its own or a parent's — cannot be verified. |
| `campaign` | `string` | — | The period a benefit is granted for. Passed through to the redemption client on every claim. |
| `redemption` | `RedemptionClient` | — | Where claims are spent. |
| `maxSignatureAgeMs` | `number` | `86_400_000` (24 h) | How old the DKIM signature may be, by its `t=` tag. A signature with no `t=` at all is refused as `SIGNATURE_STALE`; the SDK does not offer the underlying opt-out. |
| `challengeTtlMs` | `number` | `900_000` (15 min) | How long a minted code lives. Must be positive. |
| `reveal` | `'tier'` or `'domain'` | `'tier'` | `'domain'` adds `domain` to the success result. Anything other than the literal `'domain'`, including omitting the field, withholds it. |

Two things are **not** configurable and are load-bearing for "one per person":

- Mailbox canonicalisation. `verify` always folds `me+tag@d` onto `me@d`, always lowercases the local part, and always collapses dots for `gmail.com` and `googlemail.com`. There is no config field for this.
- `allowedDomains`. The SDK never sets it; domain policy is `tiers` and `domainKeys`, not a third list.

---

### `DomainKey`

```ts
interface DomainKey {
  readonly domain: string     // the domain whose mail this key signs
  readonly dnsRecord: string  // the pinned p= record, e.g. 'v=DKIM1; k=rsa; p=MIIBIjANBg…'
}
```

`domain` is lowercased and stripped of a trailing dot before lookup. Lookup walks up the label chain, so one key pinned for `udesa.edu.ar` covers `mail.udesa.edu.ar`. The DNS record is pinned rather than fetched, so verification does not depend on DNS at claim time — and key rotation by the issuer means re-pinning here.

---

### `MailProof<T extends string = string>`

```ts
interface MailProof<T extends string = string> {
  startVerification(now?: Date): VerificationStart
  verify(eml: string, now?: Date): Promise<VerificationResult<T>>
  verifiableDomains(): string[]
}
```

#### `startVerification(now?: Date): VerificationStart`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `now` | `Date` | `new Date()` | Injectable clock. Only affects the code's expiry. |

Mints a code and the instructions that go with it. Stateless — nothing is recorded, and the code carries its own expiry and its own authentication tag. The code is a pure function of `challengeSecret`, `audience` and the expiry minute, so two calls inside the same minute return the identical code; it changes when the minute it expires in changes.

**Throws** `ChallengeError` with `code: 'BAD_SECRET'` when `challengeSecret` is under 32 bytes, and `code: 'MALFORMED'` when `challengeTtlMs <= 0`. Neither class is exported; both are configuration errors that should surface at boot.

```ts
const { code, expiresAt, instructions } = mailproof.startVerification()
```

#### `verify(eml: string, now?: Date): Promise<VerificationResult<T>>`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `eml` | `string` | — | The raw RFC 822 message, exactly as saved. Any re-encoding breaks the body hash. |
| `now` | `Date` | `new Date()` | Injectable clock. Used for signature age and code expiry. |

What it does, in order:

1. Tries each **distinct** `dnsRecord` in `domainKeys`, in insertion order, running the full self-attestation check against each. First success wins.
2. Re-checks that a key is pinned for the `From:` domain, or a parent of it.
3. Resolves a tier from the `From:` domain — the mailbox domain, not necessarily the signing domain.
4. Blinds the canonical mailbox with `blindingKey`.
5. Calls `redemption.redeem({ identity, campaign, tier })`.

Never throws for an expected refusal — see `VerificationRefusal`. It does reject for a message that is not a message at all: with at least one key pinned, `await verify('From: a@mit.edu')` — no blank line separating headers from body — raises `Error: parseEml: no blank line separating headers from body`. It is an `async` method, so catch it with `try`/`await`, not around the bare call. With `domainKeys: []` nothing is parsed at all and the same input returns `{ ok: false, reason: 'NO_PINNED_KEY' }`. Guard the call if you accept arbitrary uploads.

```ts
const result = await mailproof.verify(eml)

if (!result.ok) {
  log.warn({ reason: result.reason, detail: result.detail })
  return
}

if (!result.alreadyClaimed) {
  await db.grant({ handle: result.handle, tier: result.tier })
}
```

#### `verifiableDomains(): string[]`

The domains this configuration can actually verify: every domain named explicitly in a `TierRule.domains` array, lowercased, de-duplicated, filtered to those with a pinned key. Suffix rules and `notFreeProvider` name no domains, so they contribute nothing here.

Use it as a startup assertion — a domain in `tiers` but missing from `verifiableDomains()` is a rule that can never fire.

```ts
// tiers: [{ id: 'STUDENT', domains: ['udesa.edu.ar', 'sin-clave.edu.ar'] }]
// domainKeys: only udesa.edu.ar
mailproof.verifiableDomains() // ['udesa.edu.ar']
```

---

### `VerificationStart`

| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` | `MP-XXXX-XXXX-XXXX-XXXX` — sixteen Crockford base32 characters, no `I`, `L`, `O` or `U`, over a 4-byte expiry and a 6-byte HMAC tag. Case-insensitive on the way back, and hyphens, spaces and the usual `0`/`O`, `1`/`I` substitutions are folded before verification. |
| `expiresAt` | `Date` | Rounded **up** to the next whole minute, because the expiry travels inside the code at minute resolution. The effective TTL is therefore `challengeTtlMs` plus up to 59 seconds. |
| `instructions` | `string` | Ready to show a person, with the code already interpolated. Ends with "We read the domain and nothing else." |

---

### `VerificationResult<T extends string = string>`

A discriminated union on `ok`. Narrow on it before touching anything else.

#### Success — `ok: true`

| Field | Type | Present | Meaning |
| --- | --- | --- | --- |
| `ok` | `true` | always | Discriminant. |
| `tier` | `T` | always | The id of the first `TierRule` that matched. |
| `handle` | `string` | always | The value to store. Verbatim the `nullifier` your `RedemptionClient` returned; with a MailProof daemon that is the campaign-scoped on-chain nullifier, so it is stable per mailbox per campaign per blinding key. |
| `domain` | `string`, optional | only when `reveal: 'domain'` | The **mailbox** domain, not the signing domain: `ana@mail.udesa.edu.ar` signed by `d=udesa.edu.ar` reports `mail.udesa.edu.ar`. |
| `alreadyClaimed` | `boolean` | always | `true` when the ledger already held this nullifier. An outcome, not an error — it is the question you were asking. |
| `nullifier` | `string` | always | The same string as `handle`. |
| `contractAddress` | `string` | always | The contract the claim was spent against. Worth logging: a claim spent under a different address is a different campaign. |
| `txId` | `string`, optional | when the receipt carried one | Absent when `alreadyClaimed` is `true`, because nothing was submitted. |
| `trust` | `TrustDisclosure` | always | See below. |

`handle` is safe to store. **Do not store it on the same row as an email address** — that recreates exactly the join the blinding exists to prevent.

#### Refusal — `ok: false`

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | `false` | Discriminant. |
| `reason` | `VerificationRefusal` | One of thirteen codes. Machine-readable; stable. |
| `detail` | `string` | One sentence, safe to log and safe to show. Written for a human, not parsed. |

---

### `VerificationRefusal`

```ts
type VerificationRefusal =
  | 'NO_PINNED_KEY'
  | 'NO_TIER'
  | SelfAttestationError['failure']   // the ten below
  | 'REDEMPTION_FAILED'
```

`SelfAttestationError` is not re-exported, so the ten values it contributes are only reachable through this union. The complete list:

| `reason` | What happened | What to do |
| --- | --- | --- |
| `NO_SIGNATURE` | The message carries no `DKIM-Signature` header at all. | Ask for the original, saved from "Show original" or "Download Original" — not a copy-paste of the rendered view. |
| `SIGNATURE_INVALID` | No pinned key verified the message. `detail` distinguishes a body-hash mismatch (the body changed after signing) from a header mismatch (a signed header changed, or the key is wrong). Also what you get for a domain you never pinned. | Ask for an unmodified original. If it recurs for a domain you did pin, re-check the `p=` record and the selector. |
| `SIGNATURE_EXPIRED` | The signature passed its own `x=`. Google sets this seven days out. | The person resends. Nothing is wrong with your configuration. |
| `SIGNATURE_STALE` | Older than `maxSignatureAgeMs`, **or** carries no `t=` at all — an age that cannot be established counts as stale. | The person resends. Raise `maxSignatureAgeMs` only if you have decided an archive is acceptable evidence. |
| `FROM_NOT_SIGNED` | `h=` does not cover `From:`, the message has no `From:`, or it carries more `From:` instances than the signature covers — meaning one was prepended unsigned. | Refuse. The third case is the shape of an attack, not of a broken mailer. |
| `FROM_UNPARSEABLE` | The signed `From:` names no single mailbox: zero, several, an empty group, an address literal, or a malformed local part. | Refuse. A nullifier has to stand for one person. |
| `DOMAIN_NOT_ALIGNED` | The signing domain does not cover the `From:` domain. This is the check that makes `From:` mean anything — without it, any domain vouches for any mailbox. | Refuse. Typically a third-party mailer signing on behalf of an address it does not own. |
| `DOMAIN_NOT_ALLOWED` | **Unreachable through this SDK.** The underlying check only raises it when `allowedDomains` is set, and `createMailProof` never sets it. It is in the union because the union is the underlying failure type. | Handle it for exhaustiveness; treat it as `NO_TIER`. |
| `CHALLENGE_MISSING` | No `MP-…` code in the signed subject or the signed plain-text body. The body is read through the MIME decoder and only the octets `l=` accounts for, so an HTML-only message carries nothing readable. | Ask them to put the code in the subject or in plain text. |
| `CHALLENGE_INVALID` | A code was found and did not verify: it expired, it is not a well-formed MailProof code, or it was minted for a different `audience` or a different `challengeSecret`. `detail` names the expiry when that is the cause; the last two are indistinguishable on purpose, because the audience is authenticated rather than compared. | Mint a fresh code and start over. |
| `NO_PINNED_KEY` | Either `domainKeys` is empty, so nothing was tried, or the message verified but no key is pinned for its `From:` domain or any parent. | Your configuration, not the person's message. Pin the key, or accept that the domain is out of scope. |
| `NO_TIER` | The signature is good and the domain is proven, but no `TierRule` matched. | This is the policy answer "you do not qualify". Show it as one. |
| `REDEMPTION_FAILED` | `redemption.redeem` threw. `detail` is the `RedemptionError` message, or `'could not spend the claim'` for anything else. | Your infrastructure, not the person. Retry; do not deny. |

Retrying a `REDEMPTION_FAILED` cannot double-spend — the nullifier is deterministic. It can come back as `alreadyClaimed: true` if the first attempt reached the chain and only the response was lost.

**Which reason you get.** A message is checked against every signature it carries and every distinct pinned key. Most of those attempts fail immediately, so the reason reported is from the attempt that got *furthest*, not the last:

```
NO_SIGNATURE < SIGNATURE_INVALID < SIGNATURE_EXPIRED < SIGNATURE_STALE
  < FROM_NOT_SIGNED < FROM_UNPARSEABLE < DOMAIN_NOT_ALIGNED
  < DOMAIN_NOT_ALLOWED < CHALLENGE_MISSING < CHALLENGE_INVALID
```

The practical consequence: a well-formed message from a domain you have not pinned reports `SIGNATURE_INVALID`, not `NO_PINNED_KEY`. Its signature was offered to your keys and none of them matched.

```ts
function explain(result: VerificationResult<'STUDENT' | 'CORPORATE'>): string {
  if (result.ok) return `granted: ${result.tier}`
  switch (result.reason) {
    case 'NO_SIGNATURE':
    case 'SIGNATURE_INVALID':
    case 'FROM_NOT_SIGNED':
    case 'FROM_UNPARSEABLE':
    case 'DOMAIN_NOT_ALIGNED':
    case 'DOMAIN_NOT_ALLOWED':
      return 'That file is not a signed message from your own mailbox.'
    case 'SIGNATURE_EXPIRED':
    case 'SIGNATURE_STALE':
    case 'CHALLENGE_MISSING':
    case 'CHALLENGE_INVALID':
      return 'Send yourself a new message with a fresh code.'
    case 'NO_PINNED_KEY':
    case 'NO_TIER':
      return 'That domain is not one we recognise.'
    case 'REDEMPTION_FAILED':
      return 'We could not record your claim. Try again shortly.'
  }
}
```

---

### `TrustDisclosure`

```ts
interface TrustDisclosure {
  readonly emailReadBy: 'attestor'
  readonly cryptographic: boolean
  readonly blindingKeyId: string
}
```

| Field | Type | Value in this build | Meaning |
| --- | --- | --- | --- |
| `emailReadBy` | `'attestor'` | fixed literal | What read the raw message. The type admits one value. |
| `cryptographic` | `boolean` | always `true` | Whether real cryptography was checked rather than a fixture standing in. `verify` only returns `ok: true` after a real RSA-SHA256 check, so there is no path through this API that sets it `false`. |
| `blindingKeyId` | `string` | 16 lowercase hex characters | Which blinding-key generation produced the handle. HMAC-SHA256 keyed by the blinding key over a fixed label, so it cannot be configured to something that does not match, and publishing it is safe. |

**Why it is in the return value rather than a README.** A README is read once, by whoever integrates. The disclosure is attached to every success so it travels into logs, into support tickets, and into whatever you show the person — where a claim like "we never see your address" can be checked against what actually happened rather than against what the docs said in 2026.

Two honest notes:

- `emailReadBy` is a constant, not a measurement. When you call `verify()` in-process, the raw bytes are in **your** process while it runs; the field names the trust boundary of the deployment the SDK is built for, not the memory the string was in. **Security model** works through both paths.
- `blindingKeyId` is the only way a rotation becomes visible. Store it next to the handle and refuse to mix generations.

---

### `RedemptionClient`

```ts
interface RedemptionClient {
  redeem(request: RedemptionRequest): Promise<RedemptionReceipt>
}
```

The seam between policy and chain. Implement it to point at a MailProof daemon you run, or at a test double — nothing in the SDK assumes otherwise. `verify` does not validate what you return, so a client of your own that returns junk produces a success with a junk handle.

`already-claimed` must be returned as a receipt, not thrown. It is the answer the caller most often wants, and throwing for it pushes every integrator into a try/catch that treats the normal case as exceptional.

#### `RedemptionRequest`

| Field | Type | Meaning |
| --- | --- | --- |
| `identity` | `Uint8Array` | The blinded identity: 32 bytes, one per mailbox per blinding key, unguessable without that key. Not campaign-scoped — the campaign is a separate field, and the on-chain nullifier is derived from both. |
| `campaign` | `string` | Straight from `MailProofConfig.campaign`. |
| `tier` | `string` | The tier being granted, recorded so a claim cannot be re-scoped later. |

#### `RedemptionOutcome`

```ts
type RedemptionOutcome = 'redeemed' | 'already-claimed'
```

#### `RedemptionReceipt`

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `outcome` | `RedemptionOutcome` | yes | Becomes `alreadyClaimed` on the result. |
| `nullifier` | `string` | yes | The nullifier the chain holds. Becomes both `nullifier` and `handle`. |
| `contractAddress` | `string` | yes | Surfaced on the result. |
| `campaign` | `string` | yes | Echoed back. Validated by `httpRedemptionClient`, but **not** surfaced on `VerificationResult`. |
| `txId` | `string` | no | Absent when `outcome` is `'already-claimed'` — nothing was submitted. |
| `blockHeight` | `number` | no | Not surfaced on `VerificationResult` either. |

```ts
const inMemory: RedemptionClient = {
  async redeem(request) {
    const nullifier = Buffer.from(request.identity).toString('hex')
    const already = spent.has(nullifier)
    spent.add(nullifier)
    return {
      outcome: already ? 'already-claimed' : 'redeemed',
      nullifier,
      contractAddress: 'c0ffee',
      campaign: request.campaign,
      ...(already ? {} : { txId: `tx-${spent.size}` }),
    }
  },
}
```

---

### `httpRedemptionClient`

```ts
function httpRedemptionClient(options: HttpRedemptionOptions): RedemptionClient
```

A thin client for a MailProof daemon. The daemon owns the chain connection, the proving and the wallet. Note the gap described in **Quickstart**: the daemon in this repo does not serve `/api/redeem-identity` yet.

#### `HttpRedemptionOptions`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `baseUrl` | `string` | — | Base URL of the daemon. A trailing slash is stripped. |
| `token` | `string` | none | Sent as `authorization: Bearer <token>`. Omit on loopback; set it anywhere else. |
| `timeoutMs` | `number` | `180_000` | Deliberately generous. Proving takes tens of seconds, and a stingy timeout turns a slow block into a lost grant the chain nonetheless recorded. |
| `fetch` | `typeof globalThis.fetch` | `globalThis.fetch` | Injectable for tests and for a proxied runtime. |

**Wire format.** `POST {baseUrl}/api/redeem-identity`, `content-type: application/json`, body `{ identity, campaign, tier }` where `identity` is the 32 bytes as 64 lowercase hex characters with no `0x` prefix. The response is validated rather than cast — a wrong shape here would become a wrongly granted tier.

```ts
const client = httpRedemptionClient({
  baseUrl: 'https://mailproof.internal',
  token: process.env.MAILPROOF_TOKEN,
  timeoutMs: 240_000,
})
```

---

### `RedemptionError`

```ts
class RedemptionError extends Error {
  readonly code: 'UNREACHABLE' | 'REJECTED' | 'MALFORMED_RESPONSE'
  constructor(message: string, code: 'UNREACHABLE' | 'REJECTED' | 'MALFORMED_RESPONSE')
}
```

`name` is `'RedemptionError'`. The only error `httpRedemptionClient.redeem` throws.

| `code` | Raised when | What it means |
| --- | --- | --- |
| `UNREACHABLE` | `fetch` rejected or the `timeoutMs` abort fired. | The daemon is down, unroutable, or slower than the timeout. Nothing was necessarily left unspent — a timeout can hide a transaction that landed. |
| `REJECTED` | The daemon answered with a non-2xx status **and** a JSON body: the body is parsed before the status is examined. The message quotes `body.error` when the JSON has one, otherwise `HTTP <status>`. | The daemon understood and refused: bad token, unknown campaign, unknown tier. |
| `MALFORMED_RESPONSE` | The body is not JSON — which includes a proxy's HTML 502 or an empty 401, so those arrive here rather than as `REJECTED`; or it is not an object; or it has an unrecognised `outcome`; or `nullifier` is not 32 bytes of hex; or `contractAddress` or `campaign` is missing or empty. | The thing at that URL is not a MailProof daemon, or its version disagrees with yours. |

Reaching `verify`, all three collapse into `reason: 'REDEMPTION_FAILED'` with the error's message as `detail`. Catch `RedemptionError` directly only when you call a redemption client yourself.

```ts
try {
  await client.redeem({ identity, campaign: '2026-S1', tier: 'STUDENT' })
} catch (error) {
  if (error instanceof RedemptionError && error.code === 'UNREACHABLE') {
    // retry; the claim is not lost
  }
}
```

---

### `TierRule<T extends string = string>`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `id` | `T` | — | What this rule grants. |
| `domains` | `readonly string[]` | none | Exact domains, matched including subdomains. `udesa.edu.ar` covers `mail.udesa.edu.ar` and never `notudesa.edu.ar`. |
| `suffixes` | `readonly string[]` | none | Suffixes such as `.edu.ar`, matched on label boundaries only. `.edu.ar` covers `udesa.edu.ar` and never `notaedu.ar`. A leading dot is optional. |
| `notFreeProvider` | `boolean` | `false` | Matches any domain not in `FREE_MAIL_PROVIDERS` or `alsoFreeProviders`. |
| `alsoFreeProviders` | `readonly string[]` | `[]` | Extra domains to treat as free. Only consulted by the `notFreeProvider` branch. |

Within one rule the branches are tried `domains`, then `suffixes`, then `notFreeProvider`, and the `reason` reported names whichever fired. Across rules, the first match in array order wins, so an explicit domain beats a suffix and a suffix beats a catch-all. A domain matching nothing gets no tier — there is no default, because "unrecognised means generic" is how a domain registered this morning collects a benefit.

`notFreeProvider` is a friction tax on casual farming, not an anti-sybil control. A $1/yr domain with catch-all MX defeats it outright. Anything that actually matters should be gated on `domains`; **Security model** explains why the gap cannot be closed from this side.

### `TierMatch<T extends string = string>`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `T` | The tier granted. |
| `ruleIndex` | `number` | Which rule matched, by index into the array you passed. |
| `reason` | `'domain'`, `'suffix'` or `'not-free-provider'` | Why it matched. For logs and for your own audit trail. |

### `resolveTier`

```ts
function resolveTier<T extends string>(
  domain: string,
  rules: readonly TierRule<T>[],
): TierMatch<T> | null
```

The tier a domain earns, or `null`. `domain` is lowercased and stripped of a trailing dot first; an empty domain returns `null`. Never throws. This is the same function `verify` uses, so calling it directly is how you preview a policy without an email.

```ts
const rules = [
  { id: 'STUDENT', suffixes: ['.edu.ar'] },
  { id: 'CORPORATE', notFreeProvider: true },
] as const

resolveTier('mail.udesa.edu.ar', rules)
// { id: 'STUDENT', ruleIndex: 0, reason: 'suffix' }
resolveTier('gmail.com', rules)      // null
resolveTier('mercadolibre.com', rules)
// { id: 'CORPORATE', ruleIndex: 1, reason: 'not-free-provider' }
```

### `isFreeMailProvider`

```ts
function isFreeMailProvider(domain: string, extra?: readonly string[]): boolean
```

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `domain` | `string` | — | Lowercased and stripped of a trailing dot before comparison. |
| `extra` | `readonly string[]` | `[]` | Additional domains to treat as free, on top of the built-in list. |

`true` for a domain in either list, and for any subdomain of one — a subdomain of a free provider is still that provider. Never throws.

### `FREE_MAIL_PROVIDERS`

```ts
const FREE_MAIL_PROVIDERS: readonly string[]
```

52 domains: the large webmail providers, the privacy-first independents, the big regional providers, and a sample of disposable-mail services.

This list cannot be complete and must not be relied on as if it were. It is a floor, not a fence. New disposable domains appear daily, and a cheap domain with catch-all MX is not on it and never will be.

---

### What throws

| Call | Throws | When |
| --- | --- | --- |
| `createMailProof` | `BlindingError` (not exported) | `blindingKey` under 32 bytes. |
| `startVerification` | `ChallengeError` (not exported), `code: 'BAD_SECRET'` | `challengeSecret` under 32 bytes. |
| `startVerification` | `ChallengeError`, `code: 'MALFORMED'` | `challengeTtlMs <= 0`. |
| `verify` | rejects with an `Error` from the message parser | At least one key is pinned and the input is not a parseable message — for instance, no blank line between headers and body. |
| `verify` | nothing else | Every expected failure is a `VerificationResult` with `ok: false`. Anything the `RedemptionClient` throws is caught and becomes `REDEMPTION_FAILED`. |
| `httpRedemptionClient(...).redeem` | `RedemptionError` | Only. See the code table above. |

A short `challengeSecret` reaches `verify` too, but only after the signature has verified and a code has been found — at which point it surfaces as `CHALLENGE_INVALID` rather than throwing. Validate secret lengths at boot and the question does not arise.
