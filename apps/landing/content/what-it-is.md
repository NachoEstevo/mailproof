## Two problems that pull against each other

Every site that gives something away to a particular kind of person — a student discount, a work-email-only tier, a free plan with one per human — has two jobs, and today they are solved by the same field.

The first job is **eligibility**. To know someone is a student you ask for their student address. Now you have it: in your users table, in your logs, in your backups, in whatever analytics tool the signup form also posts to, and in the dump if you are ever breached. You did not want the address. You wanted one bit of information about it, and you kept the whole thing because that was the only way to get the bit.

The second job is **uniqueness**. To stop one person taking the free tier fifty times you have to recognise them coming back. The usual answer is a unique index on the email column, and it does not work. Gmail delivers `me+1@gmail.com`, `me+2@gmail.com`, `m.e@gmail.com` and `M.E@gmail.com` to one inbox; a unique index sees four different people. MailProof's canonicaliser exists because of exactly this: it lowercases the local part, strips everything after the first `+`, and — for the short, explicit list of providers that behave this way, `gmail.com` and `googlemail.com` — removes dots, so all four spellings collapse to one string.

So the two jobs pull against each other. The thing that actually recognises a person is the thing you would rather not be holding, and the version of it you do hold does not recognise anybody.

## What MailProof answers instead

One question, with one answer: **educational domain, first time.** Nothing else.

```ts
const result = await mailproof.verify(eml)

if (result.ok && result.tier === 'STUDENT' && !result.alreadyClaimed) {
  await grantDiscount(result.handle)   // your function, your database
}
```

`result.tier` comes from your own rules — domains, suffixes, or a catch-all — and `result.alreadyClaimed` is a field rather than a thrown error, because "has this person already had their benefit" is the question you were asking. What you store is `result.handle`: a keyed hash, stable enough to enforce "once" and opaque to anyone who does not hold your `blindingKey` — the ledger, and anyone reading your database later.

The address never reaches your database. `verify` takes the raw message, reads the mailbox out of the signed `From:`, folds it into a keyed hash, and returns only the hash. No field of the result is an address, a name or an inbox, and nothing that leaves your process carries one.

## Why email is the right source of truth

Three facts, none of them invented here.

**The domains you care about already sign their mail.** DKIM is an RFC 6376 signature that the sending domain puts over its own headers, with the public key published in DNS. There is no new PKI, no issuer to onboard, no university that has to agree to anything. You do pin each signing domain's `p=` record yourself, in `domainKeys` — the SDK does no DNS lookup, and a domain with no pinned key is refused as `NO_PINNED_KEY`. A `.edu` suffix rule therefore reaches only the domains you pinned; `verifiableDomains()` returns that intersection.

**A signature over `From:` proves control of that mailbox.** A provider will not sign a message claiming to come from a mailbox the sender does not control — that is what alignment means, and it is what DMARC checks. This is why the flow is *send yourself an email*, not *forward us something you received*. Reading `To:` would prove nothing: whoever sent the message chose the recipient, so anyone able to sign for a domain could invent an address inside it and burn a colleague's slot before they ever showed up.

**Freshness comes from a code.** The site mints one — `MP-0733-X0EW-JDBZ-FQ0R`, four bytes of expiry and six bytes of tag in Crockford base32 — and it goes inside the signed message. It is authenticated with the site's own secret and carries its own expiry, so a fourteen-year-old archived email, an autoresponder, or a code minted for another site all fail. Without it, any signed message from the right domain would be evidence.

And the hard part — deciding who counts as a university — was already done by someone with a legal process. `.edu` is administered by EDUCAUSE for accredited institutions; `.edu.ar` is issued by NIC Argentina only to recognised educational bodies. A suffix rule is not a heuristic, it is a delegation to a registrar that verifies. Nobody stands behind "is not Gmail", which is why the `notFreeProvider` rule is a friction tax rather than an anti-sybil control; **Security model** says what it does and does not stop.

## What is revealed, and what is not

| | Email column today | MailProof |
| --- | --- | --- |
| Eligibility | derived from an address you hold | `tier`, computed from the domain of the signed `From:` |
| The address itself | stored, logged, backed up, breachable | never in the result; canonicalised, then keyed-hashed |
| Which institution | always visible | only if you set `reveal: 'domain'` |
| Repeat detection | broken by `+tags`, dots, case | one canonical mailbox, one handle, one nullifier |
| A database breach yields | a list of real addresses | a list of opaque handles |
| Who reads the raw message | you, and everything downstream of you | whatever calls `verify` — and nothing downstream of it |

That last row is the honest one. Verifying the message's own RSA-SHA256 signature requires the message, so something reads it in full. In the SDK path that something is `verify`, running in your own process. In the daemon deployment this repo ships for the demo, it is the attestor service (`docs/KNOWN_LIMITATIONS.md` §12). Either way the SDK stamps `trust: { emailReadBy: 'attestor', … }` on every success — a fixed literal, not a measurement — so no integrator can claim they were not told the raw message gets read somewhere. What is true in both paths is that the message stops there: the only thing that leaves is the blinded identity, and the only thing that reaches the chain is a nullifier.

## Why this needs a chain

The "already claimed" set has four requirements at once, and it is the conjunction that is hard.

It must be **public**, so a user can check that a refusal is real rather than convenient. It must be **owned by no one**, so nobody can quietly delete an entry and hand a favoured account a second benefit. It must be **shareable**, so integrators that agree to pool a campaign see one person as one person rather than five. And it must be **unreadable backwards**, so publishing it does not publish a membership list.

The third one is opt-in rather than automatic: the value spent is derived under your own `blindingKey` and then under the deployment's blueprint and campaign, so two integrators with different keys, or pointed at different deployments, see the same mailbox as two different people. Pooling means sharing both.

A normal database gives you the fourth requirement and none of the first three: whoever runs it can edit it, and nobody else can verify it. A normal public chain gives you the first three and loses the fourth — write a plain hash of a mailbox to a public ledger and an observer with a wordlist recovers it. `packages/shared/blinding.test.ts` runs that exact attack against an unkeyed mailbox hash and shows it succeeding. The input space is small and enumerable; a hash is not an anonymiser.

MailProof keeps all four by hashing with a key before anything is published, and then spending that value on Midnight, where the ledger holds an insert-only `Set<Bytes<32>>` and a counter:

```compact
const nullifier = disclose(claim.claimNullifier);
assert(!usedNullifiers.member(nullifier), "claim already used");
usedNullifiers.insert(nullifier);
approvedClaimCount.increment(1);
```

Per redemption, the derived nullifier is the only thing disclosed. What an observer of the chain gets from a claim is a 32-byte value, a claim count and a timestamp.

Nothing more is claimed than that. A deployment is pinned at construction to one attestor, one campaign, one blueprint, one issuer domain and one claim type, and all five are disclosed into the ledger at deployment — so the *population* is public even though its members are not. Timing and repeated use within a campaign remain linkable. The full list is in `docs/KNOWN_LIMITATIONS.md`; **Security model** covers the parts that are load-bearing.
