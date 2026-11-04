#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  CertificationRegistry,
  runCertifications,
  type CertificationEntry,
} from './index.js';

type CertificationModule = {
  default?: (registry: CertificationRegistry) => void | Promise<void>;
  certifications?: readonly CertificationEntry[];
};

const modules = process.argv.slice(2);
async function main(): Promise<void> {
  if (modules.length === 0) {
    console.error('Usage: voicekit-certify <fixture-module> [...]');
    process.exitCode = 2;
    return;
  }

  const registry = new CertificationRegistry();
  for (const modulePath of modules) {
    const loaded = await import(pathToFileURL(modulePath).href) as CertificationModule;
    await loaded.default?.(registry);
    for (const entry of loaded.certifications ?? []) registry.register(entry);
  }

  const results = await runCertifications(registry, { secrets: process.env });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
