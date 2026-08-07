/**
 * Reset the demo to a clean slate (§38.2, §50.5).
 *
 * Picks a fresh campaign and redeploys. A campaign is baked into the contract
 * at construction and every nullifier is derived from it, so a new campaign
 * means the demo evidence has never been redeemed — without touching state by
 * hand, which is the one thing §50.5 says not to do during a pitch.
 *
 *   npm run demo:reset
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { loadConfig, writeDemoCampaign } from '../config/mailproof';
import { getDeployment, resolveNetwork } from '../src/network';

const BLUEPRINTS_FILE = 'config/blueprints.json';

/**
 * Point the attestor's allowlist at the new campaign.
 *
 * Without this the attestor correctly refuses every request with
 * CAMPAIGN_NOT_ALLOWED — the contract would be pinned to a campaign the
 * attestor is not willing to sign for. Rewriting to a single-element list
 * keeps the allowlist an allowlist rather than letting stale campaigns
 * accumulate.
 */
function repointAllowlist(slug: string, campaign: string): void {
  const file = JSON.parse(readFileSync(BLUEPRINTS_FILE, 'utf8')) as {
    blueprints: Array<{ slug: string; campaigns: string[] }>;
  };
  const entry = file.blueprints.find((b) => b.slug === slug);
  if (!entry) {
    console.error(`\n❌ ${BLUEPRINTS_FILE} has no entry for ${slug}\n`);
    process.exit(1);
  }
  entry.campaigns = [campaign];
  writeFileSync(BLUEPRINTS_FILE, `${JSON.stringify(file, null, 2)}\n`);
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    console.error(`\n❌ demo:reset failed at: ${command} ${args.join(' ')}\n`);
    process.exit(result.status ?? 1);
  }
}

async function checkAttestor(url: string): Promise<void> {
  try {
    const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(3000) });
    const health = (await response.json()) as { verifier?: string; cryptographicVerification?: boolean };
    console.log(`  attestor:   up  (${health.verifier})`);
    if (health.cryptographicVerification === false) {
      console.log('              ⚠ fixture verifier — no proof is being checked');
    }
  } catch {
    console.log('  attestor:   DOWN — start it with: npm run attestor:dev');
  }
}

async function main(): Promise<void> {
  const { network } = resolveNetwork();

  // Time-based so consecutive resets never collide, readable so it is obvious
  // in the UI which run is on screen.
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12);
  const campaign = `mailproof-demo-${stamp}`;

  console.log(`\n─── demo:reset ──────────────────────────────────────────────`);
  console.log(`  network:    ${network}`);
  console.log(`  campaign:   ${campaign}\n`);

  writeDemoCampaign(campaign);

  // The contract and the attestor must agree on the campaign, or every
  // request is refused with CAMPAIGN_NOT_ALLOWED.
  const { blueprintSlug } = loadConfig();
  repointAllowlist(blueprintSlug, campaign);
  console.log(`  allowlist:  ${blueprintSlug} → ${campaign}\n`);

  // Redeploy against the new campaign. Fresh contract, empty nullifier set.
  run('npm', ['run', 'compile']);
  run('npm', ['run', 'deploy']);

  const deployment = getDeployment(network);
  const config = loadConfig();

  console.log(`\n─── ready ───────────────────────────────────────────────────`);
  console.log(`  contract:   ${deployment?.address ?? '(not recorded)'}`);
  console.log(`  campaign:   ${config.campaign}`);
  await checkAttestor(config.attestorUrl);
  console.log('');
  console.log('  Restart the attestor and the web app so they pick up the new');
  console.log('  campaign, then open http://127.0.0.1:3000\n');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
