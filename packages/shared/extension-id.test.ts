import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { chromeExtensionId, extensionOriginFromManifest } from './extension-id.js';

const MANIFEST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../apps/extension/manifest.json',
);

describe('chromeExtensionId', () => {
  it('produces 32 characters drawn from a–p', () => {
    const id = chromeExtensionId(
      Buffer.from('a public key that is not really DER').toString('base64'),
    );
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  it('is a function of the key alone', () => {
    const key = Buffer.from('stable input').toString('base64');
    expect(chromeExtensionId(key)).toBe(chromeExtensionId(key));
    expect(chromeExtensionId(key)).not.toBe(
      chromeExtensionId(Buffer.from('different input').toString('base64')),
    );
  });

  it('refuses an empty key rather than returning the hash of nothing', () => {
    expect(() => chromeExtensionId('')).toThrow(/empty or not base64/);
  });
});

describe('extensionOriginFromManifest', () => {
  it('pins the origin the daemon allows', () => {
    // Ground truth is Chrome: load apps/extension unpacked and compare this
    // against the id on chrome://extensions. If they ever disagree, the CORS
    // rule stops matching and every request from the panel is blocked.
    expect(extensionOriginFromManifest(MANIFEST)).toBe(
      'chrome-extension://hfajeimcllaejcchhhfifacpaggiilao',
    );
  });
});
