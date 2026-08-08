## Quickstart

From an empty project to a granted tier. Every identifier below exists in the repository; the SDK lives in-tree at `packages/sdk`, so the imports use that path.

### 1. What has to be running

Node 22 or later (`engines` in `package.json`), then three things, in this order.

```
npm run proof-server:start   # docker compose: node :9944, indexer :8088, proof server :6300
npm run attestor:dev         # :8787
npm run web:dev              # :3000
```

**The attestor** signs a canonical `ClaimAttestationV1` with Schnorr over Jubjub. In DKIM-direct mode, which is what this repo runs today, it verifies a message's own RSA-SHA256 DKIM signature; Compact 0.31.1 has no signature or proof verifier builtin, so the chain verifies the attestor's signature instead of the email's (D-001). `GET /health` reports `cryptographicVerification`, which is `false` when a fixture verifier is standing in — a fixture-backed deployment cannot look like a real one.

**The daemon** at `:3000` owns the chain connection, the wallet, proving and the contract. The SDK is a thin client and touches none of that.

One gap to plan around: `httpRedemptionClient` posts to `POST /api/redeem-identity`, and the daemon in this repo does not serve that route yet. What it serves today includes `/api/redeem` (an SSE stream over a raw `.eml`, driving the pinned-blueprint demo), `/api/new-round`, `/api/state` and `/api/inspect`, alongside the demo's own `/api/sample-eml`, `/api/demo-eml` and wallet-bridge routes. Until the identity route exists, implement the interface yourself — it is one method:

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

`httpRedemptionClient` validates the receipt rather than casting it: a response missing a 32-byte hex `nullifier`, a `contractAddress` or a `campaign`, or carrying an unrecognised `outcome`, is rejected as `MALFORMED_RESPONSE`, because a wrong shape here becomes a wrongly granted tier. A client you write yourself gets no such check — `verify` copies `receipt.nullifier` straight into `handle` — so apply the same rigour.

### 2. Two secrets, not one

```
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Run it twice. Both values must be at least 32 bytes. A short `blindingKey` makes `createMailProof` itself throw a `BlindingError` at construction, before it can serve a single request; a short `challengeSecret` makes `startVerification` throw a `ChallengeError` with code `BAD_SECRET`.

They are separate because their lifetimes are. `challengeSecret` authenticates codes that live fifteen minutes by default; rotating it invalidates only the codes in flight, which come back as `CHALLENGE_INVALID` and are re-minted by the person clicking again. `blindingKey` keys the hash that turns a mailbox into a handle. Rotating it renames every person on the ledger and silently hands everyone a fresh benefit. That is why `trust.blindingKeyId` — the first 16 hex characters of an HMAC-SHA256 keyed by the blinding key over a fixed label — is in every success: a rotation becomes visible instead of quiet, and a deployment can refuse to mix two generations.

### 3. Pinning a domain's DKIM key

A `p=` record is the public half of the key a domain signs its outbound mail with. It is a TXT record at `<selector>._domainkey.<domain>` and looks like `v=DKIM1; k=rsa; p=MIIBIjANBg…`. Take one message the domain signed and read the signature off it:

```
npx tsx scripts/inspect-eml.ts message.eml --expect-domain udesa.edu.ar
```

The report prints each signature's `d=`, `s=`, and the DNS record name to fetch — `google._domainkey.udesa.edu.ar`. Then `dig +short TXT google._domainkey.udesa.edu.ar` and join the quoted chunks into one string.

`config/blueprints.json` already does this for the attestor side. The entry `flight-cancel-edu-dkim-v1` carries `dkim.dnsRecord` for `udesa.edu.ar` with `selector: "google"`, and the attestor verifies against that pinned copy rather than resolving DNS at claim time. Verification therefore does not depend on DNS being up; the cost is that an issuer rotating their key requires re-pinning, and naming the selector means a rotated key fails as "wrong selector" instead of looking like tampering. The `status` field is load-bearing too: while it is `"pending"` the ZK Email path refuses to run, because the slug has not been compiled on the registry and accepting proofs against it would mean verifying nothing.

The SDK takes the same records in `domainKeys`. A domain with no pinned key cannot be verified; lookup walks up to the nearest parent that has one, so pinning `udesa.edu.ar` covers `mail.udesa.edu.ar`. `verifiableDomains()` returns the domains your rules name explicitly minus the ones missing a key.

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

Rules are tried in order and the first match wins. A domain matching nothing gets no tier — there is no default, because "unrecognised means generic" is how a domain registered this morning collects a benefit.

`notFreeProvider` is a friction tax, not an anti-sybil control: `FREE_MAIL_PROVIDERS` cannot be complete, and a $1/yr domain with catch-all MX defeats it outright. Gate anything that matters on an explicit `domains` list. **Security model** has the rest of that argument.

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

The code is Crockford base32 with an `MP-` prefix — sixteen characters in four groups, carrying a 4-byte expiry and a 48-bit tag over the audience. Nothing is stored to issue it and nothing is looked up to check it.

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

`verify` never throws for anything expected. A refusal is a value with `reason` — one of `NO_PINNED_KEY`, `NO_TIER`, `REDEMPTION_FAILED`, or a self-attestation failure such as `DOMAIN_NOT_ALIGNED`, `CHALLENGE_MISSING`, `SIGNATURE_STALE` — and a `detail` sentence safe to log. All thirteen are enumerated in **API reference**. `alreadyClaimed` is a field for the same reason: "has this person already had their benefit" is the question you are asking.

### 6. What to store

Store `result.handle`: one keyed-hash value per person, stable, and opaque to anyone without your `blindingKey`. That is what makes "one per person" enforceable without holding a person.

Do not put it on the same row as an email address. The nullifier set is public and insert-only, and a bare hash of a mailbox is recoverable by anyone with a wordlist — that is why the value is blinded at all. A row holding both re-creates exactly that join for whoever reads your database later, including the person who breaches it. Store the handle with the tier, the campaign and the `blindingKeyId`; keep addresses, if you need them at all, in a table that has no handle column.

Be clear about what read the message. `verify` runs the DKIM check in your own process, so the raw bytes are in your server's memory for the duration of the call; in the daemon pipeline it is the attestor that sees the message. `trust.emailReadBy` is the constant `'attestor'` either way. Nothing but hashes reaches the chain.

### 7. Getting the message back

**The extension.** `apps/extension`, loaded unpacked from `chrome://extensions` with developer mode on — Chrome 137 dropped `--load-extension` and now silently ignores it. The manifest pins a `key`, so the id is always `hfajeimcllaejcchhhfifacpaggiilao` and the daemon can allow one exact origin. The panel reads the open Gmail message and posts the original bytes to `http://127.0.0.1:3000` in one click. That capture is the part worth reusing: it holds no keys and makes no proofs.

**The upload.** Works in any browser and needs nothing installed.

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

In Gmail the person uses **Show original → Download Original**. One thing to warn them about: a Gmail message sent to your own Gmail address never leaves Google's infrastructure and is never DKIM-signed. The proof needs a message that actually crossed a boundary — send it to a second mailbox and export the received copy.
