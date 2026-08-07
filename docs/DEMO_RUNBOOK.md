# Demo Runbook

Everything needed to run the demo, in order. Follow it exactly — §50.5's rule
is that state is never edited by hand during a pitch.

## Before the room fills

```bash
docker compose up -d --wait node indexer          # devnet
npm run demo:reset                                 # fresh campaign + contract
```

`demo:reset` picks a new campaign, so the demo evidence has never been
redeemed against the new contract. Nullifiers are derived from the campaign,
which is baked into the contract at construction — a new campaign is the only
honest way to get a clean slate.

Then, in two terminals:

```bash
MAILPROOF_ALLOW_FIXTURE_VERIFIER=1 npm run attestor:dev   # terminal 1
npm run web:dev                                            # terminal 2
```

The web app takes ~20s to sync the wallet before it serves. Wait for
`MailProof demo → http://127.0.0.1:3000`.

**Sanity check before presenting:**

```bash
curl -s http://127.0.0.1:8787/health | grep verifier
curl -s http://127.0.0.1:3000/api/state
```

`approvedClaimCount` must be `0`. If it is not, run `demo:reset` again.

## Say this about the fixture verifier

If the attestor is running on canned evidence, the UI shows an amber banner
and `/health` reports `cryptographicVerification: false`. **Do not talk around
it.** Say once, early:

> The DKIM proof step is running on a fixture — we don't have a compiled
> blueprint yet. Everything after it is real: the signed claim, the Compact
> verification, the one-time redemption on chain.

Claiming a live proof when there isn't one is the one thing that turns a good
demo into a dishonest one.

## The script (3–4 minutes)

**0:00–0:25 — the problem.** Show the sample email. Name, booking reference,
fare, passenger.

> When an airline cancels your flight, the evidence already exists: the email.
> But to claim, you forward the whole message or upload a screenshot. That
> hands over your address, your booking, what you paid.

**0:25–0:45 — the proposal.**

> MailProof turns that email into a private proof. The airline changes
> nothing — it keeps sending normal email. The app that needs the evidence
> gets only the claim.

**0:45–1:30 — the evidence.** Click *load the synthetic sample* (or drop a
`.eml`). The inspector appears.

> This is parsed on this machine. Look at what it reports: the signing domain,
> the selector, which headers the signature actually covers. Nothing here
> leaves the laptop.

Point at the *Stays private* column.

**1:30–2:10 — Midnight.** Click **Verify claim**. It takes ~20 seconds; the
stage list advances, so there is something real to narrate.

> Now the claim goes to Midnight. Compact verifies the attestor's signature,
> checks it belongs to this campaign, checks this subject, and consumes a
> nullifier so the evidence can't be used again.

Land on **CLAIM VERIFIED**. Point at the approved-claims counter.

> The insurer got the fact it needed. It never received the email.

**2:10–2:40 — attack 1: replay.** Click **Try to claim again**.

> Same evidence, second time.

**ALREADY CLAIMED.**

> The proof is still valid. The signature is still valid. But the nullifier is
> spent, and Compact refuses.

**2:40–3:05 — attack 2: tamper.** Open the sample `.eml`, change one word, and
re-drop it. The inspector reports the change in structure; a real blueprint
would fail the body hash.

> A screenshot can be edited. A signed email can't.

**3:05–3:30 — the vision.**

> Today a flight cancellation. The same pattern proves a purchase, an
> invitation, a booking, a membership. The sender never needs to know Midnight
> exists.

**3:30 — close.**

> Turn emails into private proofs. Your inbox already knows. MailProof lets
> you prove it.

## When something breaks

| Symptom | Do this |
|---|---|
| UI says `attestor offline` | Restart terminal 1. The web app recovers on its own. |
| `ALREADY CLAIMED` on the first try | The campaign was already used. `npm run demo:reset`, restart both terminals. |
| Redemption hangs past ~60s | Check `docker compose ps`. The proof server is the usual culprit. |
| Everything is down | Fall back to the CLI: `npm run e2e:claim -- --via-attestor`. Same pipeline, same chain, prints all six stages. |
| The laptop is down | Play the recording. Say it is a recording. |

## What is real and what is not

Be able to answer this precisely, because a judge will ask.

| Stage | Real? |
|---|---|
| `.eml` parsing and DKIM inspection | Real — RFC 5322/6376 reader, structure only, no signature verification |
| ZK Email proof verification | **Fixture** until a blueprint is compiled |
| Canonical claim + Schnorr signature | Real |
| Compact signature verification | Real, in-circuit |
| Campaign / issuer / blueprint binding | Real, in-circuit |
| Nullifier consumption and replay rejection | Real, on chain |
| Proof generation and submission | Real, ~21s on local devnet |
| Wallet | Server-side devnet wallet, not a browser wallet |
