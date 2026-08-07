/**
 * Inspect an `.eml` before building a blueprint around it (§29.5).
 *
 * Reports what a DKIM verifier will see and flags the things that quietly
 * break ZK Email blueprints: bare-LF line endings, a body-length limit, a
 * relay signature sitting in front of the sender's, a claim field that is not
 * actually covered by the signature.
 *
 * The body is never printed. Header *values* are redacted unless --unsafe-show
 * is passed, because this output tends to end up pasted into issues and chats.
 *
 *   npx tsx scripts/inspect-eml.ts <file.eml> [--expect-domain d] [--unsafe-show]
 */
import { readFileSync } from 'node:fs';

import {
  dkimDnsRecordName,
  getHeader,
  getHeaders,
  parseDkimSignatures,
  parseEml,
  selectSignatureForDomain,
  type ParsedEml,
} from '../packages/shared/eml';

interface Options {
  file: string;
  expectDomain: string | undefined;
  showValues: boolean;
}

function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error(
      'Usage: npx tsx scripts/inspect-eml.ts <file.eml> [--expect-domain <d>] [--unsafe-show]',
    );
    process.exit(1);
  }
  const domainIndex = args.indexOf('--expect-domain');
  return {
    file,
    expectDomain: domainIndex === -1 ? undefined : args[domainIndex + 1],
    showValues: args.includes('--unsafe-show'),
  };
}

/** Keep the shape of a value visible without publishing its content. */
function redact(value: string, show: boolean): string {
  if (show) return value;
  if (value.length <= 8) return `<${value.length} chars>`;
  return `${value.slice(0, 4)}…${value.slice(-2)}  <${value.length} chars>`;
}

const notes: string[] = [];
const warnings: string[] = [];

function reportStructure(eml: ParsedEml): void {
  console.log('── Structure ─────────────────────────────────────────────────');
  console.log(`  Line endings:  ${eml.lineEnding}`);
  console.log(`  Header block:  ${eml.headerBlockBytes} bytes, ${eml.headers.length} fields`);
  console.log(`  Body:          ${eml.bodyBytes} bytes`);

  if (eml.lineEnding !== 'CRLF') {
    warnings.push(
      `Line endings are ${eml.lineEnding}, not CRLF. Something rewrote this file; ` +
        'the body hash will almost certainly fail. Re-download it and do not open it in an editor.',
    );
  }
}

function reportHeaders(eml: ParsedEml, show: boolean): void {
  console.log('\n── Headers of interest ───────────────────────────────────────');
  for (const name of ['from', 'to', 'subject', 'date', 'message-id', 'content-type', 'content-transfer-encoding']) {
    const found = getHeaders(eml, name);
    if (found.length === 0) {
      console.log(`  ${name.padEnd(26)} (absent)`);
      continue;
    }
    for (const header of found) {
      console.log(`  ${header.rawName.padEnd(26)} ${redact(header.value, show)}`);
    }
    if (found.length > 1) {
      warnings.push(
        `${name} appears ${found.length} times. Duplicated headers are a known ` +
          'DKIM ambiguity — confirm which instance the signature covers.',
      );
    }
  }

  if (!getHeader(eml, 'message-id')) {
    notes.push('No Message-ID. If you were counting on it for uniqueness, pick another field.');
  }
}

function reportSignatures(eml: ParsedEml, expectDomain: string | undefined): void {
  const signatures = parseDkimSignatures(eml);

  console.log('\n── DKIM signatures ───────────────────────────────────────────');
  if (signatures.length === 0) {
    console.log('  none');
    warnings.push('No DKIM-Signature header. This message cannot back a proof.');
    return;
  }

  signatures.forEach((sig, i) => {
    console.log(`  [${i}] d=${sig.domain ?? '?'}  s=${sig.selector ?? '?'}  a=${sig.algorithm ?? '?'}`);
    console.log(`      c=${sig.canonicalization}`);
    console.log(`      DNS record:     ${dkimDnsRecordName(sig) ?? '(incomplete)'}`);
    console.log(`      signed headers: ${sig.signedHeaders.join(', ') || '(none)'}`);
    if (sig.bodyLength !== undefined) {
      console.log(`      l=${sig.bodyLength}  ← body-length limit`);
      warnings.push(
        `Signature [${i}] sets l=${sig.bodyLength}: anything past that byte is unsigned ` +
          'and can be appended by anyone. Make sure the claim text sits before the limit.',
      );
    }
    if (sig.timestamp) console.log(`      t=${sig.timestamp} (${new Date(sig.timestamp * 1000).toISOString()})`);
    if (sig.expiry) {
      console.log(`      x=${sig.expiry} (${new Date(sig.expiry * 1000).toISOString()})`);
      if (sig.expiry * 1000 < Date.now()) {
        warnings.push(`Signature [${i}] expired at ${new Date(sig.expiry * 1000).toISOString()}.`);
      }
    }
  });

  if (signatures.length > 1) {
    notes.push(
      `${signatures.length} signatures present. Pin the blueprint to a specific d= — ` +
        'taking the first one can authenticate a forwarder instead of the sender (§20.8).',
    );
  }

  const fromHeader = getHeader(eml, 'from');
  const fromDomain = fromHeader?.value.match(/@([^\s>]+)/)?.[1]?.toLowerCase();
  const signingDomains = signatures.map((s) => s.domain?.toLowerCase()).filter(Boolean);
  if (fromDomain && !signingDomains.includes(fromDomain)) {
    notes.push(
      `From is @${fromDomain} but no signature has d=${fromDomain}. That is legitimate for ` +
        'many senders — just make sure the blueprint pins the d= you actually mean, not the From.',
    );
  }

  if (expectDomain) {
    console.log('\n── Expected issuer ───────────────────────────────────────────');
    const chosen = selectSignatureForDomain(signatures, expectDomain);
    if (chosen) {
      console.log(`  ✓ d=${expectDomain} signed this message (selector ${chosen.selector})`);
      const covered = new Set(chosen.signedHeaders);
      const wanted = ['from', 'subject', 'date'].filter((h) => !covered.has(h));
      if (wanted.length > 0) {
        warnings.push(
          `d=${expectDomain} does not sign: ${wanted.join(', ')}. ` +
            'Any field it does not sign is attacker-controlled — do not build a claim on it.',
        );
      }
    } else {
      console.log(`  ✗ no signature with d=${expectDomain}`);
      warnings.push(`Expected issuer ${expectDomain} did not sign this message.`);
    }
  }
}

function reportOutcome(): void {
  if (notes.length > 0) {
    console.log('\n── Notes ─────────────────────────────────────────────────────');
    for (const note of notes) console.log(`  • ${note}`);
  }
  if (warnings.length > 0) {
    console.log('\n── Warnings ──────────────────────────────────────────────────');
    for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  }
  console.log(
    '\nThis reports structure only — it does not verify the signature. ' +
      'ZK Email does that in-circuit.\n',
  );
}

function main(): void {
  const options = parseArgs(process.argv);
  const raw = readFileSync(options.file, 'utf8');
  const eml = parseEml(raw);

  console.log(`\nInspecting ${options.file}`);
  if (!options.showValues) {
    console.log('Header values are redacted. Pass --unsafe-show to print them.\n');
  } else {
    console.log('⚠ --unsafe-show: header values are printed in full.\n');
  }

  reportStructure(eml);
  reportHeaders(eml, options.showValues);
  reportSignatures(eml, options.expectDomain);
  reportOutcome();

  process.exit(warnings.length > 0 ? 1 : 0);
}

main();
