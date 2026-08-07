// Orchestrator for `npm run setup`. Replaces the prior package.json chain
// `docker compose up -d --wait && npm run compile && npm run deploy` so
// we can branch on --network and forward it to deploy.
import { spawnSync } from 'node:child_process';
import { resolveNetwork, setActiveNetwork, parseNetworkFlag } from './network';

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    process.stderr.write(`\nCommand failed: ${cmd} ${args.join(' ')}\n`);
    process.exit(r.status ?? 1);
  }
}

/**
 * Is something already serving on the configured proof-server URL?
 *
 * The proof server is stateless, and Midnight developers commonly leave one
 * running for another project on the same port. Starting a second one just
 * fails the whole compose bring-up with "port is already allocated", so
 * detect that case and reuse what is there instead. Point
 * MIDNIGHT_PROOF_SERVER_URL elsewhere if you want a dedicated one.
 */
async function proofServerAlreadyRunning(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2000) });
    return true;
  } catch (err: any) {
    const code = err?.cause?.code ?? err?.code ?? '';
    // A refused connection means nothing is listening. Anything else — a
    // non-2xx, an unexpected body — still means the port is served.
    return code !== 'ECONNREFUSED' && code !== 'UND_ERR_CONNECT_TIMEOUT';
  }
}

async function main(): Promise<void> {
  const argv = process.argv;
  const flag = parseNetworkFlag(argv);
  if (flag) setActiveNetwork(flag);
  const { network, config } = resolveNetwork({ argv });

  process.stdout.write(`\n→ Setting up mailproof on network: ${network}\n\n`);

  // 1. Bring up only the services this network needs.
  let services = config.composeServices;
  if (services.includes('proof-server') && (await proofServerAlreadyRunning(config.proofServer))) {
    process.stdout.write(
      `  ℹ Reusing the proof server already listening on ${config.proofServer};\n` +
        `    not starting our own. It is stateless, so this is safe.\n\n`,
    );
    services = services.filter((s) => s !== 'proof-server');
  }
  run('docker', ['compose', 'up', '-d', '--wait', ...services]);

  // 2. Compile the contract (network-agnostic).
  run('npm', ['run', 'compile']);

  // 3. Deploy. Forward --network so deploy.ts sees the same network.
  const deployArgs = network === 'undeployed' ? [] : ['--', '--network', network];
  run('npm', ['run', 'deploy', ...deployArgs]);
}

main().catch((e) => {
  process.stderr.write(`\nSetup failed: ${(e as Error).message}\n`);
  process.exit(1);
});
