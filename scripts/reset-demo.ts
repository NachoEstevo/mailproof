/**
 * Reset the demo to a clean slate (§38.2, §50.5).
 *
 * Picks a fresh campaign and redeploys. A campaign is baked into the contract
 * at construction and every nullifier is derived from it, so a new campaign
 * means the demo evidence has never been redeemed — without touching state by
 * hand, which is the one thing §50.5 says not to do during a pitch.
 *
 *   npm run demo:reset [-- <blueprint slug>]
 *
 * The optional slug switches which allowlist entry the demo runs on — the
 * contract pins its hashes at deploy time, so changing blueprints *is* a
 * reset. Without a slug the previous selection (or the default) is kept.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { loadConfig, writeDemoState } from '../config/mailproof';
import { parseDkimSignatures, parseEml } from '../packages/shared/eml';
import { getDeployment, resolveNetwork } from '../src/network';
import { campaignName, repointAllowlist as repointBlueprintCampaign } from '../src/round';

const BLUEPRINTS_FILE = 'config/blueprints.json';
const PRIVATE_DEMO_EML = 'fixtures/private-emails/flight-edu.eml';

interface AllowlistEntry {
  slug: string;
  status: 'pending' | 'pinned';
  issuerDomain: string;
  claimType: string;
  campaigns: string[];
  dkim?: { dnsRecord: string; selector?: string };
}

/**
 * Which blueprint to deploy against.
 *
 * An explicit argument wins. Otherwise the previous selection is kept — but
 * only if it is still usable: `.mailproof-demo.json` is gitignored, so on a
 * fresh checkout `loadConfig` falls back to a built-in default that may name
 * a `pending` entry. Deploying a contract pinned to one produces a demo where
 * every claim dies at the attestor, so a pinned entry is chosen instead.
 */
function chooseBlueprint(entries: AllowlistEntry[], requested: string | undefined): AllowlistEntry {
  if (requested) {
    const explicit = entries.find((b) => b.slug === requested);
    if (!explicit) {
      console.error(`\n❌ ${BLUEPRINTS_FILE} has no entry for ${requested}\n`);
      process.exit(1);
    }
    if (explicit.status !== 'pinned') {
      console.log(`  ⚠ ${explicit.slug} is "pending" — the attestor will refuse every claim.`);
    }
    return explicit;
  }

  const previous = entries.find((b) => b.slug === loadConfig().blueprintSlug);
  if (previous?.status === 'pinned') return previous;

  const pinned = entries.find((b) => b.status === 'pinned');
  if (!pinned) {
    console.error(`\n❌ ${BLUEPRINTS_FILE} has no pinned blueprint to demo\n`);
    process.exit(1);
  }
  if (previous) {
    console.log(`  ℹ ${previous.slug} is pending; falling back to ${pinned.slug}`);
  }
  return pinned;
}

function readAllowlist(): AllowlistEntry[] {
  return (JSON.parse(readFileSync(BLUEPRINTS_FILE, 'utf8')) as { blueprints: AllowlistEntry[] })
    .blueprints;
}

/**
 * The demo email is real, and real DKIM signatures expire (`x=`). Better to
 * hear it at reset time than on stage.
 */
function warnIfDemoEmailExpiring(issuerDomain: string): void {
  if (!existsSync(PRIVATE_DEMO_EML)) return;
  try {
    const signatures = parseDkimSignatures(parseEml(readFileSync(PRIVATE_DEMO_EML, 'utf8')));
    const sig = signatures.find((s) => s.domain?.toLowerCase() === issuerDomain.toLowerCase());
    if (!sig?.expiry) return;
    const msLeft = sig.expiry * 1000 - Date.now();
    const days = msLeft / 86_400_000;
    if (msLeft <= 0) {
      console.log(`  ⚠ ${PRIVATE_DEMO_EML} DKIM signature EXPIRED — send a fresh email`);
    } else if (days < 3) {
      console.log(
        `  ⚠ ${PRIVATE_DEMO_EML} DKIM signature expires in ${days.toFixed(1)} days ` +
          `(${new Date(sig.expiry * 1000).toISOString()})`,
      );
    }
  } catch {
    // A malformed private fixture is its own problem; not this script's.
  }
}

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
  try {
    repointBlueprintCampaign(BLUEPRINTS_FILE, slug, campaign);
  } catch (error) {
    console.error(`\n❌ ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
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
  const campaign = campaignName(new Date());

  console.log(`\n─── demo:reset ──────────────────────────────────────────────`);
  const entry = chooseBlueprint(readAllowlist(), process.argv[2]?.trim() || undefined);

  console.log(`  network:    ${network}`);
  console.log(`  campaign:   ${campaign}`);
  console.log(`  blueprint:  ${entry.slug}  (${entry.dkim ? 'dkim-direct' : 'zk-email'})`);
  console.log(`  issuer:     ${entry.issuerDomain}\n`);

  // Contract, attestor and web app must agree on all four values, or a claim
  // signed by one is rejected by the other with a confusing error.
  writeDemoState({
    campaign,
    blueprintSlug: entry.slug,
    issuerDomain: entry.issuerDomain,
    claimType: entry.claimType as never,
  });
  repointAllowlist(entry.slug, campaign);
  console.log(`  allowlist:  ${entry.slug} → ${campaign}`);
  warnIfDemoEmailExpiring(entry.issuerDomain);
  console.log('');

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
