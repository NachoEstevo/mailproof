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
honest way to get a clean slate. It keeps the previously selected blueprint;
to switch, pass the slug:

```bash
npm run demo:reset -- mailproof/FlightCancelledEduDkim@v1   # DKIM-direct (default demo)
```

It also warns if the real demo email's DKIM signature (`x=`) is close to
expiry. **Google signs with a 7-day expiry** — if the demo is more than a
week after the email was sent, send a fresh one and refresh
`fixtures/private-emails/flight-edu.eml` first.

Then, in two terminals:

```bash
npm run attestor:dev      # terminal 1 — DKIM-direct + zk-email routing verifier
npm run web:dev           # terminal 2
```

The web app takes ~20s to sync the wallet before it serves. Wait for
`MailProof demo → http://127.0.0.1:3000`.

**Sanity check before presenting:**

```bash
curl -s http://127.0.0.1:8787/health | grep verifier
curl -s http://127.0.0.1:3000/api/state
```

`approvedClaimCount` must be `0`. If it is not, run `demo:reset` again.

## Say this about the verification model

The default demo runs DKIM-direct (D-007): the attestor verifies the email's
own RSA-SHA256 signature against the pinned issuer key — the same signature
Gmail checks on receipt. That is real cryptography end to end. The honest
sentence to say once, early:

> We verify the email's own DKIM signature — real RSA, the issuer's published
> key. In this mode our attestor sees the email; the chain never does. The ZK
> Email blueprint slots into the same seam and removes even the attestor from
> the picture — it isn't compiled on the registry yet.

If the attestor were ever running on canned evidence instead, the UI shows an
amber banner and `/health` reports `cryptographicVerification: false`. **Do
not talk around that banner.** Claiming a live proof when there isn't one is
the one thing that turns a good demo into a dishonest one.

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

**0:45–1:30 — the evidence.** Click *use the real signed email on this
machine* (or drop the `.eml`). The inspector appears.

> This is a real email, signed by a real Google Workspace domain. Look at what
> the inspector reports: the signing domain, the selector, which headers the
> signature covers. Nothing here leaves the laptop.

Point at the *Never reaches the chain* column.

**1:30–2:10 — Midnight.** Click **Verify claim**. It takes ~25 seconds; the
stage list advances, so there is something real to narrate.

> First the email's own RSA signature is verified against the issuer's
> published key — watch the DKIM stage. Then the claim goes to Midnight.
> Compact verifies the attestor's signature in-circuit, checks the campaign,
> checks this subject, and consumes a nullifier so the evidence can't be used
> again.

Land on **CLAIM VERIFIED**. Point at the approved-claims counter.

> The insurer got the fact it needed. It never received the email.

**2:10–2:40 — attack 1: replay.** Click **Try to claim again**.

> Same evidence, second time.

**ALREADY CLAIMED.**

> The proof is still valid. The signature is still valid. But the nullifier is
> spent, and Compact refuses.

**2:40–3:05 — attack 2: tamper.** Open a copy of the `.eml`, change one word
of the body, and re-drop it. Verification **actually fails** — the body hash
no longer matches the signature, and the UI names the reason.

> A screenshot can be edited. A signed email can't. One changed word and the
> RSA check fails.

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
| `DKIM signature has expired` | The email is older than its `x=` (7 days for Google). Send a fresh one, refresh the fixture. |
| Redemption hangs past ~60s | Check `docker compose ps`. The proof server is the usual culprit. |
| Everything is down | Fall back to the CLI: `npx tsx scripts/e2e-claim.ts --eml fixtures/private-emails/flight-edu.eml`. Same pipeline, same chain, prints all six stages. |
| The laptop is down | Play the recording. Say it is a recording. |

## What is real and what is not

Be able to answer this precisely, because a judge will ask.

| Stage | Real? |
|---|---|
| `.eml` parsing and DKIM inspection | Real — RFC 5322/6376 reader |
| Email signature verification | **Real** — RSA-SHA256 against the issuer's published DKIM key, done by the attestor (D-007). The attestor sees the email in this mode. |
| ZK Email proof verification | Not yet — blueprint pending on the registry; the seam is built and the router falls back to it per blueprint |
| Canonical claim + Schnorr signature | Real |
| Compact signature verification | Real, in-circuit |
| Campaign / issuer / blueprint binding | Real, in-circuit |
| Nullifier consumption and replay rejection | Real, on chain |
| Proof generation and submission | Real, ~21–26s on local devnet |
| Wallet | Server-side devnet wallet, not a browser wallet |
