/**
 * The Chrome extension id, derived the way Chrome derives it.
 *
 * An unpacked extension normally gets a random id, which would leave the
 * daemon with no origin to allow but `*`. Pinning `key` in the manifest fixes
 * the id instead, and computing it here from that same key means the CORS rule
 * and the extension can never drift apart.
 *
 * Chrome takes SHA-256 of the SPKI DER public key, keeps the leading 16 bytes,
 * and renders each nibble as a letter in a–p.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const NIBBLE_TO_LETTER = (nibble: number) => String.fromCharCode(0x61 + nibble);

export function chromeExtensionId(base64PublicKey: string): string {
  const der = Buffer.from(base64PublicKey, 'base64');
  if (der.length === 0) throw new Error('extension key is empty or not base64');

  const digest = createHash('sha256').update(der).digest().subarray(0, 16);
  return Array.from(digest, (byte) => NIBBLE_TO_LETTER(byte >> 4) + NIBBLE_TO_LETTER(byte & 0x0f))
    .join('');
}

/** `chrome-extension://<id>`, the Origin header the side panel sends. */
export function extensionOriginFromManifest(manifestPath: string): string {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: unknown };
  if (typeof manifest.key !== 'string') {
    throw new Error(`${manifestPath} has no "key", so its id is not stable`);
  }
  return `chrome-extension://${chromeExtensionId(manifest.key)}`;
}
