## Two problems that pull against each other

Every site that gives something to a particular kind of person — a student discount, a work-email-only tier, one free plan per human — has two jobs, and one field does both.

**Eligibility.** You ask for the student address, so now you hold it: users table, logs, backups, analytics, breach dump. You wanted one bit about the address and kept all of it.

**Uniqueness.** A unique index on the email column does not recognise a returning person: Gmail delivers `me+1@gmail.com`, `me+2@gmail.com`, `m.e@gmail.com` and `M.E@gmail.com` to one inbox, and the index sees four. MailProof's canonicaliser lowercases the local part, strips everything after the first `+`, and removes dots for a short, explicit provider list (`gmail.com`, `googlemail.com`), so all four spellings become one string.

The thing that recognises a person is the thing you would rather not hold; the version you do hold recognises nobody.

## What MailProof answers instead

One question: **educational domain, first time.**

```ts
const result = await mailproof.verify(eml)

if (result.ok && result.tier === 'STUDENT' && !result.alreadyClaimed) {
  await grantDiscount(result.handle)   // your function, your database
}
```

`result.tier` comes from your own rules — domains, suffixes, or a catch-all; `result.alreadyClaimed` is a field, not a thrown error. Store `result.handle`: a keyed hash, stable enough to enforce "once" and opaque to anyone without your `blindingKey` — the ledger, and anyone reading your database later. `verify` reads the mailbox out of the signed `From:` and returns only the hash; no field of the result is an address, a name or an inbox.

## Why email is the right source of truth

- **The domains already sign.** DKIM (RFC 6376): the sending domain signs its own headers, public key in DNS. No new PKI, no issuer to onboard.
- **You pin the keys.** Each signing domain's `p=` record goes in `domainKeys`. The SDK does no DNS lookup, a domain with no pinned key is refused as `NO_PINNED_KEY`, and a `.edu` suffix rule reaches only domains you pinned; `verifiableDomains()` returns that intersection.
- **`From:`, not `To:`.** A signature over `From:` proves control of that mailbox — alignment, which DMARC checks. Hence *send yourself an email*, not *forward one*. `To:` proves nothing: the sender picks the recipient, so anyone able to sign for a domain could invent an address in it and burn a colleague's slot.
- **A code gives freshness.** `MP-0733-X0EW-JDBZ-FQ0R` — four bytes of expiry, six bytes of tag, Crockford base32 — is minted by the site under its own secret and travels inside the signed message. A fourteen-year-old archived email, an autoresponder, or a code minted for another site all fail; without it, any signed message from the right domain would be evidence.
- **A registrar already decided who is a university.** `.edu`: EDUCAUSE, accredited institutions. `.edu.ar`: NIC Argentina, recognised educational bodies only. Nobody stands behind "is not Gmail", so `notFreeProvider` is a friction tax, not an anti-sybil control — **Security model** says what it does and does not stop.

## What is revealed, and what is not

| | Email column today | MailProof |
| --- | --- | --- |
| Eligibility | derived from an address you hold | `tier`, computed from the domain of the signed `From:` |
| The address itself | stored, logged, backed up, breachable | never in the result; canonicalised, then keyed-hashed |
| Which institution | always visible | only if you set `reveal: 'domain'` |
| Repeat detection | broken by `+tags`, dots, case | one canonical mailbox, one handle, one nullifier |
| A database breach yields | a list of real addresses | a list of opaque handles |
| Who reads the raw message | you, and everything downstream of you | whatever calls `verify` — and nothing downstream of it |

That last row is the honest one. Verifying the RSA-SHA256 signature requires the message, so something reads it in full: `verify` in your own process on the SDK path; the attestor service in the daemon deployment this repo ships for the demo (`docs/KNOWN_LIMITATIONS.md` §12). Either way the SDK stamps `trust: { emailReadBy: 'attestor', … }` on every success — a fixed literal, not a measurement. Only the blinded identity leaves, and only a nullifier reaches the chain; **Security model** has the rest.

## Why this needs a chain

The "already claimed" set needs four things at once, and the conjunction is the hard part.

- **Public** — a user can check that a refusal is real rather than convenient.
- **Owned by no one** — nobody can delete an entry and hand a favoured account a second benefit.
- **Shareable** — integrators that pool a campaign see one person as one, not five.
- **Unreadable backwards** — publishing it does not publish a membership list.

Sharing is opt-in: the value spent is derived under your `blindingKey`, then under the deployment's blueprint and campaign, so different keys or different deployments make one mailbox two people. Pooling means sharing both.

A database gives you the fourth and none of the first three: its operator can edit it, nobody else can verify it. A public chain gives the first three and loses the fourth — a plain hash of a mailbox on a public ledger falls to an observer with a wordlist. `packages/shared/blinding.test.ts` runs that attack against an unkeyed mailbox hash and shows it succeeding: the input space is small and enumerable, and a hash is not an anonymiser.

Keying the hash before publication keeps all four. That value is spent on Midnight, whose ledger holds an insert-only `Set<Bytes<32>>` and a counter:

```compact
const nullifier = disclose(claim.claimNullifier);
assert(!usedNullifiers.member(nullifier), "claim already used");
usedNullifiers.insert(nullifier);
approvedClaimCount.increment(1);
```

Per redemption the derived nullifier is the only disclosure; a chain observer gets a 32-byte value, a claim count and a timestamp. A deployment is pinned at construction to one attestor, one campaign, one blueprint, one issuer domain and one claim type, all five disclosed into the ledger — so the *population* is public even though its members are not. Timing and repeated use within a campaign remain linkable; the full list is in `docs/KNOWN_LIMITATIONS.md`.
