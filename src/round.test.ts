import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { campaignName, repointAllowlist } from './round.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function allowlistFile(blueprints: Array<{ slug: string; campaigns: string[] }>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'mailproof-round-'));
  directories.push(directory);
  const file = path.join(directory, 'blueprints.json');
  writeFileSync(file, `${JSON.stringify({ blueprints }, null, 2)}\n`);
  return file;
}

const read = (file: string) =>
  JSON.parse(readFileSync(file, 'utf8')) as { blueprints: Array<{ slug: string; campaigns: string[] }> };

describe('campaignName', () => {
  it('is readable and carries the moment it was opened', () => {
    expect(campaignName(new Date('2026-08-08T00:07:30.123Z'))).toBe('mailproof-demo-260808000730');
  });

  it('distinguishes two rounds opened in the same minute', () => {
    // At minute resolution these collided, and a round that reuses a campaign
    // is not a round at all — the same email lands as an already-spent replay.
    const first = campaignName(new Date('2026-08-08T00:07:05Z'));
    const second = campaignName(new Date('2026-08-08T00:07:55Z'));
    expect(first).not.toBe(second);
  });
});

describe('repointAllowlist', () => {
  it('replaces the campaign rather than accumulating rounds', () => {
    const file = allowlistFile([{ slug: 'demo/Flight@v1', campaigns: ['round-1'] }]);
    repointAllowlist(file, 'demo/Flight@v1', 'round-2');
    expect(read(file).blueprints[0]!.campaigns).toEqual(['round-2']);
  });

  it('leaves other blueprints alone', () => {
    const file = allowlistFile([
      { slug: 'demo/Flight@v1', campaigns: ['round-1'] },
      { slug: 'demo/Other@v1', campaigns: ['untouched'] },
    ]);
    repointAllowlist(file, 'demo/Flight@v1', 'round-2');
    expect(read(file).blueprints[1]!.campaigns).toEqual(['untouched']);
  });

  it('refuses a slug the file does not declare', () => {
    const file = allowlistFile([{ slug: 'demo/Flight@v1', campaigns: ['round-1'] }]);
    expect(() => repointAllowlist(file, 'demo/Missing@v1', 'round-2')).toThrow(/no entry for/);
    expect(read(file).blueprints[0]!.campaigns).toEqual(['round-1']);
  });

  it('writes back something the attestor can still parse', () => {
    const file = allowlistFile([{ slug: 'demo/Flight@v1', campaigns: ['round-1'] }]);
    repointAllowlist(file, 'demo/Flight@v1', 'round-2');
    // Trailing newline and two-space indent: the file is committed, and a
    // round should not show up as a whitespace diff across every line.
    const text = readFileSync(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "blueprints"');
  });
});
