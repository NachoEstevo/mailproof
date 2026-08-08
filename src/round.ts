/**
 * Demo rounds.
 *
 * A claim is one-time *within a campaign* — the nullifier is
 * `H(domain, blueprint, message id, campaignId)`, so the same email is spent
 * once per campaign and never twice. That is the property worth showing, and
 * it is also why a demo can only be run once per deployment.
 *
 * A round is therefore a campaign: a fresh contract, pinned to a fresh
 * campaign id, with an empty nullifier set. Nothing is weakened by opening
 * one — a new campaign is a new promotion, which is exactly what a real
 * deployment would do, and the old contract keeps its spent nullifier
 * forever.
 *
 * Shared by `scripts/reset-demo.ts` and the daemon's new-round route so the
 * two cannot disagree about what a round is.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Readable, so it is obvious on screen which run is being shown, and precise
 * to the second: minute resolution let two rounds opened in the same minute
 * share a campaign, which silently makes the second one a replay.
 */
export function campaignName(now: Date): string {
  return `mailproof-demo-${now.toISOString().replace(/[-:T]/g, '').slice(2, 14)}`;
}

/**
 * Point a blueprint at one campaign.
 *
 * Replaces rather than appends: the attestor's allowlist should name the
 * campaigns it will sign for right now, and every earlier round's contract is
 * already deployed and unreachable from this one.
 */
export function repointAllowlist(file: string, slug: string, campaign: string): void {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    blueprints: Array<{ slug: string; campaigns: string[] }>;
  };
  const entry = parsed.blueprints.find((blueprint) => blueprint.slug === slug);
  if (!entry) throw new Error(`${file} has no entry for ${slug}`);

  entry.campaigns = [campaign];
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
}
