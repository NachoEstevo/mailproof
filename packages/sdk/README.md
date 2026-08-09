# MailProof SDK

Prove someone has a mailbox at a domain you trust — a university, an employer,
a bank — and grant them something for it, **once**, without ever learning their
address.

```ts
const result = await mailproof.verify(eml)

if (result.ok && result.tier === 'STUDENT' && !result.alreadyClaimed) {
  await db.user.update({ where: { id }, data: { plan: 'PRO' } })
}
```

## What problem this solves

Every site that offers a student discount, a work-email-only tier, or a free
plan has the same two problems, and today they are in tension:

- **To know you are a student, they must see your student address.** Which
  they then keep, spam, and leak when they are breached.
- **To stop one person taking the free tier fifty times, they must recognise
  the person.** `email @unique` does not do it: `me+1@`, `me+2@`, and dots in
  a Gmail address are all the same inbox and all different rows.

MailProof answers both with one proof. The site learns *"educational domain,
and this is the first time"* — and nothing else. The `@unique` column stops
being the anti-abuse mechanism, so it stops needing to hold a real address.

## How the person experiences it

1. The site shows a code: `MP-4KQ7-9XW2-3TFA`.
2. They send themselves an email from the address they want to prove, with the
   code in it.
3. They hand that message back. Done.

That is not a workaround for missing infrastructure — it is what makes the
proof sound. A message *addressed to* you proves nothing: whoever sent it chose
that address, and if they can sign for the domain they can invent any recipient
they like, including yours. A message *from* you is different, because a
provider will not sign a message claiming to come from a mailbox the sender
does not control. That is what DKIM alignment is, and it is the whole basis of
this.

The browser extension does steps 2 and 3 in one click, but it is an
accelerator. The `.eml` upload path works in any browser.

## Setting it up

```ts
import { createMailProof, httpRedemptionClient } from '@mailproof/sdk'

export const mailproof = createMailProof({
  audience: 'lain',                          // binds codes to this site alone
  challengeSecret: env.MAILPROOF_CHALLENGE_SECRET,   // ≥32 bytes
  blindingKey:     env.MAILPROOF_BLINDING_KEY,       // ≥32 bytes
  campaign: '2026-S1',                       // the period a benefit covers

  tiers: [
    { id: 'STUDENT',   domains:  ['udesa.edu.ar', 'uba.ar'] },
    { id: 'STUDENT',   suffixes: ['.edu', '.edu.ar', '.ac.uk'] },
    { id: 'CORPORATE', notFreeProvider: true },
  ],

  domainKeys: [
    { domain: 'udesa.edu.ar', dnsRecord: 'v=DKIM1; k=rsa; p=MIIBIjANBg…' },
  ],

  redemption: httpRedemptionClient({ baseUrl: 'http://127.0.0.1:3000' }),
  reveal: 'tier',                            // or 'domain'
})
```

Rules are tried in order and the first match wins, so an explicit domain beats
a suffix and a suffix beats a catch-all. **A domain matching nothing gets no
tier** — there is no default, because "unrecognised means generic" is how a
domain someone registered this morning collects a benefit.

`reveal: 'tier'` means you learn *"is a student"*. `reveal: 'domain'` means you
also learn *which university*. Ask for the smaller one unless you need the
larger.

## The two routes

```ts
// POST /api/verify/start
const { code, expiresAt, instructions } = mailproof.startVerification()

// POST /api/verify/finish
const result = await mailproof.verify(eml)
```

`verify` never throws for anything expected. A refusal is a value:

```ts
if (!result.ok) {
  // result.reason: 'NO_TIER' | 'CHALLENGE_MISSING' | 'SIGNATURE_STALE' | …
  // result.detail: a sentence you can log, safe to show a user
}
```

And `alreadyClaimed` is a field, not an error, because "has this person already
had their benefit" is the question you are actually asking.

## What you store

For a one-time benefit, store `result.handle`: the campaign-scoped Midnight
nullifier. For account continuity, store `result.identityHandle` together with
`result.identityKeyId`. The account handle is HMAC-derived from the audience
and canonical mailbox, so the same mailbox returns to the same account while a
different mailbox at the same domain does not.

The two handles are deliberately different. `handle` is public chain material;
`identityHandle` is scoped to this relying application and must not be copied
from the nullifier. Both are opaque to anyone without the blinding key, but the
attestor holding that key can recompute them for a guessed address.

**Do not store either handle on the same row as an email address.** Doing so recreates
exactly the join the blinding exists to prevent, for anyone who later reads
your database.

`blindingKey` is durable identity infrastructure. Back it up and keep it
server-only. Rotating it without a migration changes every `identityHandle` and
would make returning users look new; `identityKeyId` makes that generation
change visible.

## What you must be honest about

`result.trust` is part of every success, on purpose:

```ts
{ emailReadBy: 'attestor', cryptographic: true, blindingKeyId: '4f2a…' }
```

- **Something reads the raw message.** In DKIM-direct mode that is the
  attestor, which verifies the email's own RSA signature. It is not you, and
  it is not the chain — but it is not nobody. A pinned ZK Email blueprint
  removes even that; the field will say so when it does.
- **The attestor is trusted.** If it signs a false claim, the contract accepts
  it. Run your own, or accept whoever runs the one you point at.
- **`notFreeProvider` is a friction tax, not an anti-sybil control.** A $1/yr
  domain with catch-all MX defeats it. Anything that matters should be gated on
  an explicit domain list.
- **Rotating `blindingKey` renames everyone** and hands out a second round of
  benefits. `blindingKeyId` is there so you can see it happened.

See `docs/KNOWN_LIMITATIONS.md` for the rest, including shared mailboxes,
alumni addresses that never expire, and what a griefer can do.

## Running the daemon

The SDK is a client. Chain access, proving and the wallet live in a MailProof
daemon you run:

```
npm run attestor:dev     # :8787 — verifies email signatures
npm run web:dev          # :3000 — the daemon the SDK talks to
```

Point `httpRedemptionClient` at it. Nothing in the SDK assumes it is ours.
