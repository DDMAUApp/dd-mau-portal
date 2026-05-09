#!/usr/bin/env node
// backup-all.mjs
// One-command refresh + backup. Run this whenever you want to:
//   1. Pull the latest code from GitHub (so your local copy matches the
//      live site).
//   2. Dump a fresh Firestore snapshot to /backups.
//
// Usage from the repo root:
//   npm run backup-all
//
// Both steps run in sequence and the script bails out early if either
// fails — so you'll see a clear error instead of silently moving on.

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const repoRoot   = path.resolve(__dirname, '..');

function run(label, cmd) {
    console.log('');
    console.log('━'.repeat(60));
    console.log(`▶ ${label}`);
    console.log('━'.repeat(60));
    try {
        execSync(cmd, { cwd: repoRoot, stdio: 'inherit' });
    } catch (e) {
        console.error('');
        console.error(`✗ ${label} failed.`);
        console.error('Aborting backup-all.');
        process.exit(1);
    }
}

run('Step 1/2: Pull latest code from GitHub', 'git pull --ff-only');
run('Step 2/2: Export Firestore data',         'node scripts/backup-firestore.mjs');

console.log('');
console.log('✓ All done. Code + data are current and backed up locally.');
