## Quickstart

From an empty project to a granted tier. The SDK is in-tree at `packages/sdk`; the imports use that path.

### 1. What has to be running

Node 22 or later (`engines` in `package.json`). Start these in order:

```
npm run proof-server:start   # docker compose: node :9944, indexer :8088, proof server :6300
npm run attestor:dev         # :8787
npm run web:dev              # :3000
```

- **Attestor** — signs a canonical `ClaimAttestationV1` (Schnorr over Jubjub). In DKIM-direct mode, what runs today, it verifies the message's own RSA-SHA256 DKIM signature; Compact 0.31.1 has no signature or proof verifier builtin, so the chain verifies the attestor's signature, not the email's (D-001). `GET /health` reports `cryptographicVerification` — `false` under a fixture verifier.
- **Daemon** `:3000` — owns the chain connection, the wallet, proving and the contract; the SDK is a thin client.
- **Missing route** — `httpRedemptionClient` posts to `POST /api/redeem-identity`, which the daemon does not serve yet. It serves `/api/redeem` (SSE over a raw `.eml`, the pinned-blueprint demo), `/api/new-round`, `/api/state`, `/api/inspect`, `/api/sample-eml`, `/api/demo-eml` and wallet-bridge routes. Write the one-method client yourself:

```ts
import type { RedemptionClient } from './packages/sdk/index.js';

const spent = new Set<string>();

export const redemption: RedemptionClient = {
  async redeem(request) {
    // request: { identity: Uint8Array, campaign: string, tier: string }
    const nullifier = Buffer.from(request.identity).toString('hex');
    const already = spent.has(nullifier);
    spent.add(nullifier);
    return {
      outcome: already ? 'already-claimed' : 'redeemed',
      nullifier,
      contractAddress: '0200deadbeef',
      campaign: request.campaign,
      ...(already ? {} : { txId: `tx-${spent.size}` }),
    };
  },
};
```

`httpRedemptionClient` validates the receipt and rejects a wrong shape as `MALFORMED_RESPONSE`; **API reference** lists the checks. Your own client has none of them, and `verify` copies `receipt.nullifier` straight into `handle`.

### 2. Two secrets, not one

```
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Run it twice. Both values must be at least 32 bytes.

|  | `challengeSecret` | `blindingKey` |
| --- | --- | --- |
| Keys | challenge codes, which live 15 minutes by default | the hash that turns a mailbox into a handle |
| Under 32 bytes | `startVerification` throws `ChallengeError`, code `BAD_SECRET` | `createMailProof` throws `BlindingError` at construction |
| Rotating it | codes in flight come back `CHALLENGE_INVALID`; the person clicks again | renames every person on the ledger and silently hands everyone a fresh benefit |

`trust.blindingKeyId` — the first 16 hex characters of an HMAC-SHA256 keyed by the blinding key over a fixed label — is in every success, so a rotation is visible and two generations cannot be mixed silently. See **Security model**.

### 3. Pinning a domain's DKIM key

The `p=` record is a domain's public signing key: a TXT record at `<selector>._domainkey.<domain>`, like `v=DKIM1; k=rsa; p=MIIBIjANBg…`. Read it off one message the domain signed:

```
npx tsx scripts/inspect-eml.ts message.eml --expect-domain udesa.edu.ar
```

That prints each signature's `d=`, `s=` and the record to fetch — `google._domainkey.udesa.edu.ar`. Then `dig +short TXT google._domainkey.udesa.edu.ar` and join the quoted chunks into one string.

`config/blueprints.json` pins the attestor's copy: `flight-cancel-edu-dkim-v1` carries `dkim.dnsRecord` for `udesa.edu.ar`, `selector: "google"`, checked instead of resolving DNS at claim time. Naming the selector makes a rotated key fail as "wrong selector" rather than as tampering. While `status` is `"pending"` the ZK Email path refuses to run: the slug is not compiled on the registry, so a proof against it verifies nothing.

`domainKeys` takes the same records. Lookup walks up to the nearest pinned parent, so `udesa.edu.ar` covers `mail.udesa.edu.ar`; an unpinned domain is refused as `NO_PINNED_KEY`. `verifiableDomains()` returns your explicit domains minus those missing a key.

### 4. The configuration

```ts
import { createMailProof } from './packages/sdk/index.js';
import { redemption } from './redemption.js';   // from step 1

const challengeSecret = Buffer.from(process.env.MAILPROOF_CHALLENGE_SECRET!, 'hex');
const blindingKey = Buffer.from(process.env.MAILPROOF_BLINDING_KEY!, 'hex');

export const mailproof = createMailProof<'STUDENT' | 'CORPORATE'>({
  audience: 'lain',                  // bound into every code; a code minted here works nowhere else
  challengeSecret,
  blindingKey,
  campaign: '2026-S1',               // the period a benefit is granted for
  tiers: [
    { id: 'STUDENT', domains: ['udesa.edu.ar'] },                // exact, subdomains included
    { id: 'STUDENT', suffixes: ['.edu', '.edu.ar', '.ac.uk'] },  // label-boundary match
    { id: 'CORPORATE', notFreeProvider: true },                  // anything not on the free list
  ],
  domainKeys: [
    { domain: 'udesa.edu.ar', dnsRecord: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0B…' },
  ],
  redemption,                        // swap in httpRedemptionClient once your daemon
                                     // serves POST /api/redeem-identity
  maxSignatureAgeMs: 6 * 60 * 60 * 1000,   // default 24h
  challengeTtlMs: 10 * 60 * 1000,          // default 15m
  reveal: 'tier',                          // 'domain' also returns which domain matched
});
```

Rules are tried in order, first match wins. No match earns no tier: there is no default, because "unrecognised means generic" is how a domain registered this morning collects a benefit.

`notFreeProvider` is a friction tax, not an anti-sybil control: `FREE_MAIL_PROVIDERS` cannot be complete and a $1/yr domain with catch-all MX defeats it. Gate what matters on an explicit `domains` list — **Security model** has the argument.

### 5. Two routes

```ts
app.post('/api/verify/start', async () => {
  const { code, expiresAt, instructions } = mailproof.startVerification();
  return { code, expiresAt: expiresAt.toISOString(), instructions };
});
```

```json
{
  "code": "MP-0733-X0EW-JDBZ-FQ0R",
  "expiresAt": "2026-08-08T03:45:00.000Z",
  "instructions": "Send yourself an email from the address you want to prove, with this code…"
}
```

The code is sixteen Crockford base32 characters in four groups behind an `MP-` prefix: a 4-byte expiry and a 48-bit tag over the audience. Stateless to issue and to check.

```ts
app.post<{ Body: { eml: string } }>('/api/verify/finish', async (request, reply) => {
  const result = await mailproof.verify(request.body.eml);

  if (!result.ok) {
    return reply.code(422).send({ ok: false, reason: result.reason, detail: result.detail });
  }
  if (result.alreadyClaimed) {
    return { ok: true, tier: result.tier, granted: false, alreadyClaimed: true };
  }

  await grant({
    handle: result.handle,
    tier: result.tier,
    campaign: '2026-S1',
    blindingKeyId: result.trust.blindingKeyId,
  });

  return { ok: true, tier: result.tier, granted: true, alreadyClaimed: false, txId: result.txId };
});
```

`verify` never throws for anything expected: a refusal is a value with a `reason` — `NO_PINNED_KEY`, `NO_TIER`, `REDEMPTION_FAILED`, or a self-attestation failure such as `DOMAIN_NOT_ALIGNED`, `CHALLENGE_MISSING`, `SIGNATURE_STALE` — and a `detail` safe to log. All thirteen are in **API reference**.

### 6. What to store

Store `result.handle` with the tier and campaign to enforce a one-time benefit.
For a returning account, store `result.identityHandle` with
`result.identityKeyId`: one audience-scoped HMAC value per mailbox, stable
while the blinding key is stable and distinct from the on-chain nullifier.

Never store either handle on the same row as an email address. The nullifier set is public and insert-only, and a bare mailbox hash falls to a wordlist — hence the blinding. A row with both re-creates that join for whoever later reads or breaches the database. An email-free account needs no address table at all.

Back up `MAILPROOF_BLINDING_KEY`. A silent rotation changes both handle
generations and makes a returning mailbox look new; use `identityKeyId` to
detect that condition and perform an explicit migration.

`verify` runs the DKIM check in your own process, so the raw bytes are in your server's memory for the call; in the daemon pipeline the attestor sees them. `trust.emailReadBy` is the constant `'attestor'` either way. Nothing but hashes reaches the chain.

### 7. Getting the message back

**The extension.** `apps/extension`, loaded unpacked from `chrome://extensions` with developer mode on — Chrome 137 dropped `--load-extension` and silently ignores it. The manifest pins a `key`, so the id is always `hfajeimcllaejcchhhfifacpaggiilao` and the daemon can allow one exact origin. The panel posts the open Gmail message's original bytes to `http://127.0.0.1:3000`; it holds no keys and makes no proofs.

**The upload.** Any browser, nothing installed.

```html
<input type="file" accept=".eml,message/rfc822,text/plain">
```

```js
const eml = await input.files[0].text();
const res = await fetch('/api/verify/finish', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ eml }),
});
```

In Gmail: **Show original → Download Original**. Warn them: a Gmail message sent to your own Gmail address never leaves Google's infrastructure and is never DKIM-signed. It must cross a boundary — send it to a second mailbox and export the received copy.

`domainKeys` takes the same records. Lookup walks up to the nearest pinned parent, so `udesa.edu.ar` covers `mail.udesa.edu.ar`. A domain with no pinned key cannot be verified: with keys pinned for other domains the message is refused as `SIGNATURE_INVALID`, not `NO_PINNED_KEY` — its signature was offered to your keys and none matched. `NO_PINNED_KEY` means `domainKeys` was empty, or the message verified but no key is pinned for its `From:` domain or any parent. `verifiableDomains()` returns your explicit domains minus those missing a key.

Verification therefore does not depend on DNS being up; the cost is that an issuer rotating their key requires re-pinning.

`httpRedemptionClient` validates the receipt rather than casting it: a response missing a 32-byte hex `nullifier`, a `contractAddress` or a `campaign`, or carrying an unrecognised `outcome`, is rejected as `MALFORMED_RESPONSE`. Your own client has none of those checks, and `verify` copies `receipt.nullifier` straight into `handle`.

The `blindingKeyId` in `result.trust` names the generation of the key that produced a handle, so a rotation is visible instead of quiet and a deployment can refuse to mix two of them.
