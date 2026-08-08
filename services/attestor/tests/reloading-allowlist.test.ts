/**
 * The allowlist follows its file.
 *
 * Opening a new demo round means a new campaign, and the attestor refuses a
 * campaign it has never heard of. Without reloading, every round would need
 * the service restarted — so what matters here is that a change is picked up,
 * and that a bad file cannot quietly empty the policy.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadingAllowlist } from '../src/allowlist.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function blueprintFile(campaigns: string[], slug = 'demo/Flight@v1') {
  const directory = mkdtempSync(path.join(tmpdir(), 'mailproof-allowlist-'));
  directories.push(directory);
  const file = path.join(directory, 'blueprints.json');

  const write = (nextCampaigns: string[], mtimeSeconds?: number) => {
    writeFileSync(
      file,
      JSON.stringify({
        blueprints: [
          {
            key: 'demo',
            status: 'pinned',
            slug,
            claimType: 'FLIGHT_CANCELLED',
            issuerDomain: 'demo-airline.example',
            campaigns: nextCampaigns,
            requiredOutputs: ['cancellationMarker', 'uniqueId'],
            markerOutput: 'cancellationMarker',
            uniqueIdOutput: 'uniqueId',
            markerPattern: '^cancelled$',
          },
        ],
      }),
    );
    // mtime has whole-second resolution on some filesystems, and these writes
    // are microseconds apart; without stamping it the reload would look like
    // a no-op for reasons that have nothing to do with the code.
    if (mtimeSeconds !== undefined) utimesSync(file, mtimeSeconds, mtimeSeconds);
  };

  write(campaigns, 1_000_000);
  return { file, write };
}

describe('reloadingAllowlist', () => {
  it('serves the file as it was at startup', () => {
    const { file } = blueprintFile(['round-1']);
    const allowlist = reloadingAllowlist(file);
    expect(allowlist().slugs).toEqual(['demo/Flight@v1']);
  });

  it('picks up a campaign added after startup', () => {
    const { file, write } = blueprintFile(['round-1']);
    const allowlist = reloadingAllowlist(file);
    const policy = () => allowlist().require('demo/Flight@v1');

    expect(policy().campaigns).toEqual(['round-1']);
    write(['round-1', 'round-2'], 1_000_100);
    expect(policy().campaigns).toEqual(['round-1', 'round-2']);
  });

  it('announces each reload, and only when the file moved', () => {
    const { file, write } = blueprintFile(['round-1']);
    const reloads: string[][] = [];
    const allowlist = reloadingAllowlist(file, (next) => reloads.push([...next.slugs]));

    allowlist();
    allowlist();
    expect(reloads).toHaveLength(0);

    write(['round-1', 'round-2'], 1_000_100);
    allowlist();
    allowlist();
    expect(reloads).toEqual([['demo/Flight@v1']]);
  });

  it('keeps the last good policy when the file becomes invalid', () => {
    // Emptying the allowlist would turn a typo into "sign nothing", which the
    // operator meets as every claim rejected for a reason that is not true.
    const { file, write } = blueprintFile(['round-1']);
    const allowlist = reloadingAllowlist(file);
    expect(allowlist().slugs).toHaveLength(1);

    writeFileSync(file, '{ this is not json');
    utimesSync(file, 1_000_200, 1_000_200);
    expect(allowlist().slugs).toEqual(['demo/Flight@v1']);

    // And recovers once the file is valid again.
    write(['round-1', 'round-2'], 1_000_300);
    expect(allowlist().require('demo/Flight@v1').campaigns).toEqual(['round-1', 'round-2']);
  });

  it('keeps serving while the file is momentarily absent', () => {
    const { file } = blueprintFile(['round-1']);
    const allowlist = reloadingAllowlist(file);
    rmSync(file);
    expect(allowlist().slugs).toEqual(['demo/Flight@v1']);
  });

  it('refuses to start against a file that is already broken', () => {
    const { file } = blueprintFile(['round-1']);
    writeFileSync(file, 'not json at all');
    expect(() => reloadingAllowlist(file)).toThrow();
  });
});
