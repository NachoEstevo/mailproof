## API reference

Exported from `packages/sdk/index.ts`; examples import from `@mailproof/sdk`.

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

Twenty exports: six values and fourteen types. Nothing else is public. `SelfAttestationError`, `BlindingError` and `ChallengeError` are not re-exported, even though the first contributes ten members to `VerificationRefusal` and the other two can be thrown — see [What throws](#what-throws).

`handle` and `nullifier` on a success are the same string. Below, `handle` is used for your database and `nullifier` for the chain.

---

### `createMailProof`

```ts
function createMailProof<T extends string>(config: MailProofConfig<T>): MailProof<T>
```

`T` is the union of your tier ids, inferred from `config.tiers`: ids `'STUDENT'` and `'CORPORATE'` give a `MailProof<'STUDENT' | 'CORPORATE'>` and a `result.tier` that switches exhaustively.

**Throws** `BlindingError` synchronously at construction when `blindingKey` is shorter than 32 bytes, so it fails at boot rather than on the first user. Nothing else is validated eagerly.

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
| `audience` | `string` | — | Integrator id, authenticated into every challenge tag: a code minted here verifies nowhere else. Changing it invalidates every outstanding code. |
| `challengeSecret` | `Uint8Array` | — | Secret for challenge codes. At least 32 bytes. Rotatable — invalidates only codes in flight. |
| `blindingKey` | `Uint8Array` | — | Key for the mailbox-to-handle keyed hash. At least 32 bytes. **Not** safely rotatable: a new key renames every person and grants everyone a second benefit. |
| `tiers` | `readonly TierRule<T>[]` | — | Which domains earn which tier. In order; first match wins; no match earns nothing. |
| `domainKeys` | `readonly DomainKey[]` | — | Pinned DKIM public keys. No pinned key for a domain or a parent of it means it cannot be verified. |
| `campaign` | `string` | — | Period the benefit covers. Sent to the redemption client on every claim. |
| `redemption` | `RedemptionClient` | — | Where claims are spent. |
| `maxSignatureAgeMs` | `number` | `86_400_000` (24 h) | DKIM signature age limit, read from `t=`. No `t=` at all is refused as `SIGNATURE_STALE`; the underlying opt-out is not exposed. |
| `challengeTtlMs` | `number` | `900_000` (15 min) | Lifetime of a minted code. Must be positive. |
| `reveal` | `'tier'` or `'domain'` | `'tier'` | `'domain'` adds `domain` to the success result; anything else, including omitting it, withholds it. |

Not configurable, and load-bearing for "one per person":

- Canonicalisation. `verify` always folds `me+tag@d` onto `me@d`, always lowercases the local part, and always collapses dots for `gmail.com` and `googlemail.com`.
- `allowedDomains`. The SDK never sets it; domain policy is `tiers` and `domainKeys`, not a third list.

---

### `DomainKey`

```ts
interface DomainKey {
  readonly domain: string     // the domain whose mail this key signs
  readonly dnsRecord: string  // the pinned p= record, e.g. 'v=DKIM1; k=rsa; p=MIIBIjANBg…'
}
```

`domain` is lowercased and stripped of a trailing dot, then looked up by walking up the label chain: one key pinned for `udesa.edu.ar` covers `mail.udesa.edu.ar`. Pinned rather than fetched, so verification does not depend on DNS at claim time; issuer rotation means re-pinning here.

---

### `MailProof<T extends string = string>`

```ts
interface MailProof<T extends string = string> {
  startVerification(now?: Date): VerificationStart
  verify(eml: string, now?: Date): Promise<VerificationResult<T>>
  verifiableDomains(): string[]
}
```

#### `startVerification`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `now` | `Date` | `new Date()` | Injectable clock. Only affects the code's expiry. |

Mints a code and its instructions. Stateless: nothing is recorded, and the code carries its own expiry and authentication tag. It is a pure function of `challengeSecret`, `audience` and the expiry minute, so two calls in the same minute return the identical code.

**Throws** `ChallengeError` — `code: 'BAD_SECRET'` for a `challengeSecret` under 32 bytes, `code: 'MALFORMED'` for `challengeTtlMs <= 0`. Neither class is exported; both should surface at boot.

```ts
const { code, expiresAt, instructions } = mailproof.startVerification()
```

#### `verify`

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `eml` | `string` | — | Raw RFC 822 message, exactly as saved. Any re-encoding breaks the body hash. |
| `now` | `Date` | `new Date()` | Injectable clock. Signature age and code expiry. |

In order:

1. Tries each **distinct** `dnsRecord` in `domainKeys`, in insertion order, with the full self-attestation check; first success wins.
2. Re-checks that a key is pinned for the `From:` domain or a parent.
3. Resolves a tier from the `From:` domain — the mailbox domain, not necessarily the signing domain.
4. Blinds the canonical mailbox with `blindingKey`.
5. Calls `redemption.redeem({ identity, campaign, tier })`.

Never throws for an expected refusal — see `VerificationRefusal`. It does reject on input that is not a message: with at least one key pinned, `await verify('From: a@mit.edu')` (no blank line between headers and body) raises `Error: parseEml: no blank line separating headers from body`. Catch it with `try`/`await` — the method is `async`. With `domainKeys: []` nothing is parsed and the same input returns `{ ok: false, reason: 'NO_PINNED_KEY' }`. Guard the call if you accept arbitrary uploads.

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

#### `verifiableDomains`

Domains named explicitly in a `TierRule.domains` array, lowercased, de-duplicated, filtered to those with a pinned key; suffix and `notFreeProvider` rules contribute none. Use it as a startup assertion — a domain in `tiers` but missing from `verifiableDomains()` is a rule that can never fire.

```ts
// tiers: [{ id: 'STUDENT', domains: ['udesa.edu.ar', 'sin-clave.edu.ar'] }]
// domainKeys: only udesa.edu.ar
mailproof.verifiableDomains() // ['udesa.edu.ar']
```

---

### `VerificationStart`

| Field | Type | Notes |
| --- | --- | --- |
| `code` | `string` | `MP-XXXX-XXXX-XXXX-XXXX` — sixteen Crockford base32 characters (no `I`, `L`, `O`, `U`) over a 4-byte expiry and a 6-byte HMAC tag. Case-insensitive coming back; hyphens, spaces and `0`/`O`, `1`/`I` substitutions are folded before verification. |
| `expiresAt` | `Date` | Rounded **up** to the next whole minute — the expiry travels inside the code at minute resolution, so the effective TTL is `challengeTtlMs` plus up to 59 seconds. |
| `instructions` | `string` | Ready to show a person, code interpolated. Ends with "We read the domain and nothing else." |

---

### `VerificationResult<T extends string = string>`

A discriminated union on `ok`. Narrow on it first.

#### Success — `ok: true`

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | `true` | Discriminant. |
| `tier` | `T` | Id of the first `TierRule` that matched. |
| `handle` | `string` | The value to store. Verbatim the `nullifier` your `RedemptionClient` returned; with a MailProof daemon, the campaign-scoped on-chain nullifier — stable per mailbox, campaign and blinding key. |
| `domain` | `string`, optional | Only with `reveal: 'domain'`. The **mailbox** domain, not the signing domain: `ana@mail.udesa.edu.ar` signed by `d=udesa.edu.ar` reports `mail.udesa.edu.ar`. |
| `alreadyClaimed` | `boolean` | `true` when the ledger already held this nullifier. An outcome, not an error. |
| `nullifier` | `string` | The same string as `handle`. |
| `contractAddress` | `string` | Contract the claim was spent against. Log it: a different address is a different campaign. |
| `txId` | `string`, optional | Present when the receipt carried one; absent when `alreadyClaimed` is `true`, nothing having been submitted. |
| `trust` | `TrustDisclosure` | See below. |

`handle` is safe to store. **Do not store it on the same row as an email address** — that recreates the join the blinding exists to prevent.

#### Refusal — `ok: false`

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | `false` | Discriminant. |
| `reason` | `VerificationRefusal` | One of thirteen codes. Machine-readable; stable. |
| `detail` | `string` | One sentence, safe to log and to show. Written for a human, not parsed. |

---

### `VerificationRefusal`

```ts
type VerificationRefusal =
  | 'NO_PINNED_KEY'
  | 'NO_TIER'
  | SelfAttestationError['failure']   // the ten below
  | 'REDEMPTION_FAILED'
```

| `reason` | What happened | What to do |
| --- | --- | --- |
| `NO_SIGNATURE` | No `DKIM-Signature` header. | Ask for the original — "Show original" or "Download Original", not a copy-paste of the rendered view. |
| `SIGNATURE_INVALID` | No pinned key verified it. `detail` separates a body-hash mismatch (body changed after signing) from a header mismatch (signed header changed, or wrong key). Also what an unpinned domain returns. | Ask for an unmodified original; if it recurs on a pinned domain, re-check `p=` and the selector. |
| `SIGNATURE_EXPIRED` | Past its own `x=`. Google sets this seven days out. | Resend. |
| `SIGNATURE_STALE` | Older than `maxSignatureAgeMs`, **or** no `t=` at all — an age that cannot be established counts as stale. | Resend. Raise `maxSignatureAgeMs` only if an archive is acceptable evidence. |
| `FROM_NOT_SIGNED` | `h=` omits `From:`, no `From:` is present, or there are more `From:` instances than `h=` covers — one was prepended unsigned. | Refuse. The third case is an attack shape, not a broken mailer. |
| `FROM_UNPARSEABLE` | The signed `From:` names no single mailbox: zero, several, an empty group, an address literal, or a malformed local part. | Refuse — a nullifier must stand for one person. |
| `DOMAIN_NOT_ALIGNED` | Signing domain does not cover the `From:` domain — the check that makes `From:` mean anything; without it any domain vouches for any mailbox. | Refuse. Usually a third-party mailer signing for an address it does not own. |
| `DOMAIN_NOT_ALLOWED` | **Unreachable through this SDK**: raised only when `allowedDomains` is set, which `createMailProof` never does. Present because the union is the underlying failure type. | Handle for exhaustiveness; treat as `NO_TIER`. |
| `CHALLENGE_MISSING` | No `MP-…` code in the signed subject or signed plain-text body. The body is read through the MIME decoder, and only the octets `l=` covers — an HTML-only message carries nothing readable. | Ask for the code in the subject or plain text. |
| `CHALLENGE_INVALID` | A code was found and did not verify: expired, not a well-formed MailProof code, or minted for a different `audience` or `challengeSecret`. `detail` names the expiry when that is the cause; the last two are indistinguishable on purpose — the audience is authenticated, not compared. | Mint a fresh code. |
| `NO_PINNED_KEY` | `domainKeys` is empty, so nothing was tried; or the message verified but no key is pinned for its `From:` domain or a parent. | Yours to fix: pin the key, or drop the domain. |
| `NO_TIER` | Signature good, domain proven, no `TierRule` matched. | The policy answer "you do not qualify". Show it as one. |
| `REDEMPTION_FAILED` | `redemption.redeem` threw. `detail` is the `RedemptionError` message, or `'could not spend the claim'` for anything else. | Yours, not theirs. Retry; do not deny. |

Retrying a `REDEMPTION_FAILED` cannot double-spend — the nullifier is deterministic. It can come back as `alreadyClaimed: true` if the first attempt reached the chain and only the response was lost.

**Which reason you get.** A message is checked against every signature it carries and every distinct pinned key; the reason reported comes from the attempt that got *furthest*, not the last:

```
NO_SIGNATURE < SIGNATURE_INVALID < SIGNATURE_EXPIRED < SIGNATURE_STALE
  < FROM_NOT_SIGNED < FROM_UNPARSEABLE < DOMAIN_NOT_ALIGNED
  < DOMAIN_NOT_ALLOWED < CHALLENGE_MISSING < CHALLENGE_INVALID
```

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

Returned on every success, so it travels into logs and support tickets with the grant.

| Field | Type | Value in this build | Meaning |
| --- | --- | --- | --- |
| `emailReadBy` | `'attestor'` | fixed literal | What read the raw message. The type admits one value. |
| `cryptographic` | `boolean` | always `true` | Whether real cryptography was checked rather than a fixture. `verify` returns `ok: true` only after a real RSA-SHA256 check, so no path through this API sets it `false`. |
| `blindingKeyId` | `string` | 16 lowercase hex characters | Which blinding-key generation produced the handle. HMAC-SHA256 keyed by the blinding key over a fixed label, so it cannot be set to something that does not match, and publishing it is safe. |

Two honest notes:

- `emailReadBy` is a constant, not a measurement: call `verify()` in-process and the raw bytes are in **your** process while it runs. It names the trust boundary of the deployment the SDK is built for, not the memory the string was in. **Security model** covers both paths.
- `blindingKeyId` is the only way a rotation becomes visible. Store it next to the handle and refuse to mix generations.

---

### `RedemptionClient`

```ts
interface RedemptionClient {
  redeem(request: RedemptionRequest): Promise<RedemptionReceipt>
}
```

The seam between policy and chain. Point it at a MailProof daemon you run, or a test double. `verify` does not validate what you return, so a client that returns junk produces a success with a junk handle. `already-claimed` must be returned as a receipt, not thrown.

#### `RedemptionRequest`

| Field | Type | Meaning |
| --- | --- | --- |
| `identity` | `Uint8Array` | Blinded identity: 32 bytes, one per mailbox per blinding key, unguessable without that key. Not campaign-scoped — the campaign is a separate field, and the on-chain nullifier derives from both. |
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
| `txId` | `string` | no | Absent when `outcome` is `'already-claimed'`. |
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

A thin client for a MailProof daemon, which owns the chain connection, proving and wallet. The daemon in this repo does not serve `/api/redeem-identity` yet — see **Quickstart**.

#### `HttpRedemptionOptions`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `baseUrl` | `string` | — | Base URL of the daemon. A trailing slash is stripped. |
| `token` | `string` | none | Sent as `authorization: Bearer <token>`. Omit on loopback; set it anywhere else. |
| `timeoutMs` | `number` | `180_000` | Proving takes tens of seconds; a stingy timeout turns a slow block into a lost grant the chain nonetheless recorded. |
| `fetch` | `typeof globalThis.fetch` | `globalThis.fetch` | Injectable for tests and for a proxied runtime. |

**Wire format.** `POST {baseUrl}/api/redeem-identity`, `content-type: application/json`, body `{ identity, campaign, tier }`, `identity` being the 32 bytes as 64 lowercase hex characters with no `0x` prefix. The response is validated rather than cast — a wrong shape would become a wrongly granted tier.

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
| `UNREACHABLE` | `fetch` rejected or the `timeoutMs` abort fired. | Daemon down, unroutable, or slower than the timeout. Not necessarily unspent — a timeout can hide a transaction that landed. |
| `REJECTED` | Non-2xx status **and** a JSON body: the body is parsed before the status is examined. The message quotes `body.error` when present, otherwise `HTTP <status>`. | Understood and refused: bad token, unknown campaign, unknown tier. |
| `MALFORMED_RESPONSE` | Body not JSON (a proxy's HTML 502 or an empty 401 lands here, not in `REJECTED`); or not an object; or an unrecognised `outcome`; or `nullifier` not 32 bytes of hex; or `contractAddress` or `campaign` missing or empty. | Not a MailProof daemon at that URL, or a version disagreement. |

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
| `alsoFreeProviders` | `readonly string[]` | `[]` | Extra domains to treat as free. Consulted only by the `notFreeProvider` branch. |

Branches within a rule are tried `domains`, `suffixes`, `notFreeProvider`, and `TierMatch.reason` names whichever fired. Across rules the first match in array order wins, so an explicit domain beats a suffix and a suffix beats a catch-all. No match means no tier; there is no default, because "unrecognised means generic" hands a benefit to a domain registered this morning.

`notFreeProvider` is a friction tax on casual farming, not an anti-sybil control — see `FREE_MAIL_PROVIDERS`. Gate anything that matters on `domains`; **Security model** explains why the gap cannot be closed from this side.

### `TierMatch<T extends string = string>`

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `T` | The tier granted. |
| `ruleIndex` | `number` | Which rule matched, by index into the array you passed. |
| `reason` | `'domain'`, `'suffix'` or `'not-free-provider'` | Why it matched. For logs and audit trails. |

### `resolveTier`

```ts
function resolveTier<T extends string>(
  domain: string,
  rules: readonly TierRule<T>[],
): TierMatch<T> | null
```

The tier a domain earns, or `null`. `domain` is lowercased and stripped of a trailing dot first; an empty domain returns `null`. Never throws. The same function `verify` uses, so it previews a policy without an email.

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

`true` for a domain in either list and for any subdomain of one — a subdomain of a free provider is still that provider. Never throws.

### `FREE_MAIL_PROVIDERS`

```ts
const FREE_MAIL_PROVIDERS: readonly string[]
```

52 domains: large webmail providers, privacy-first independents, big regional providers, and a sample of disposable-mail services.

The list cannot be complete and must not be relied on as if it were. It is a floor, not a fence: new disposable domains appear daily, and a $1/yr domain with catch-all MX is not on it and never will be.

---

### What throws

| Call | Throws | When |
| --- | --- | --- |
| `createMailProof` | `BlindingError` (not exported) | `blindingKey` under 32 bytes. |
| `startVerification` | `ChallengeError` (not exported), `code: 'BAD_SECRET'` | `challengeSecret` under 32 bytes. |
| `startVerification` | `ChallengeError`, `code: 'MALFORMED'` | `challengeTtlMs <= 0`. |
| `verify` | rejects with an `Error` from the message parser | At least one key is pinned and the input is not a parseable message. |
| `verify` | nothing else | Expected failures are a `VerificationResult` with `ok: false`. Anything the `RedemptionClient` throws is caught and becomes `REDEMPTION_FAILED`. |
| `httpRedemptionClient(...).redeem` | `RedemptionError` | Only. See the code table above. |

A short `challengeSecret` reaches `verify` too, but only after the signature verifies and a code is found, where it surfaces as `CHALLENGE_INVALID` rather than throwing. Validate secret lengths at boot.

A well-formed message from a domain you have not pinned reports `SIGNATURE_INVALID`, not `NO_PINNED_KEY`: its signature was offered to your keys and none matched.
