#!/usr/bin/env node
// make-code-snapshot — pack the DD Mau source into single-file
// dumps for AI review (ChatGPT, Claude, Gemini, Cursor, etc.).
//
// Why this exists: pasting a private repo into ChatGPT one file at
// a time is painful, and these AI tools each have different context
// limits. The script bundles every source file we want reviewed
// into a couple of markdown documents that the reviewer can drag
// straight into the chat.
//
// Outputs (all in dist-snapshot/, which is gitignored):
//   app-snapshot.md          — every source file + CLAUDE.md + git
//                              log + recent commits. For Claude /
//                              Gemini (1M+ token context window).
//   app-snapshot-curated.md  — only the architecturally important
//                              files. Fits in ChatGPT-4o's 128K
//                              context. Skim-friendly.
//   app-snapshot-toc.md      — table of contents only (file list
//                              + sizes + line counts). Useful for
//                              asking the AI which files to review.
//
// Run:  npm run snapshot
//
// What we deliberately skip:
//   • node_modules, dist, .git, backups, .firebase
//   • lock files (too noisy, never useful for review)
//   • binary assets (images, fonts, PDFs, video)
//   • firebase-service-account.json + anything env-shaped
//   • generated *.timestamp-*.mjs files Vite leaves behind
//
// PII posture: the script reads SOURCE CODE only, never Firestore.
// Real staff names, customer data, prices, etc. live in Firestore
// and never enter the snapshot. The only PII-shaped values that
// might leak through are hardcoded defaults in src/data/staff.js
// (DEFAULT_STAFF) — Andrew has already neutralized that file for
// public distribution.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const OUT_DIR   = path.join(ROOT, 'dist-snapshot');

// ─── Walk filters ──────────────────────────────────────────────
const SKIP_DIRS = new Set([
    'node_modules', 'dist', 'dist-snapshot', '.git', '.github',
    'backups', '.next', '.vercel', '.firebase', '.husky', '.vscode',
    '.idea', 'storybook-static', 'coverage',
]);
const SKIP_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
    'firebase-service-account.json',
    '.DS_Store',
    '.env', '.env.local', '.env.production',
]);
const SKIP_EXT = new Set([
    // Images / video / audio
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif',
    '.mp4', '.mov', '.avi', '.webm', '.mp3', '.wav', '.ogg', '.flac',
    // Fonts
    '.otf', '.ttf', '.woff', '.woff2', '.eot',
    // Binary / archive
    '.pdf', '.xlsx', '.xls', '.zip', '.tar', '.gz', '.7z', '.rar',
    // Backups / temp
    '.bak', '.tmp', '.swp',
]);

// ─── Curated set ──────────────────────────────────────────────
// Files that explain the architecture without including the
// 7000-line giants. Tuned for "ChatGPT can ingest this" use case.
// Intentionally leaves out Operations / Schedule / ChatThread —
// they're each huge and not the best starting point for a review.
const CURATED = new Set([
    // Top-level docs + config
    'CLAUDE.md',
    'README.md',
    'package.json',
    'vite.config.js',
    'tailwind.config.js',
    'firestore.rules',
    'index.html',

    // App skeleton
    'src/App.jsx',
    'src/main.jsx',
    'src/firebase.js',
    'src/messaging.js',
    'src/pwa.js',

    // v2 shell
    'src/v2/AppShellV2.jsx',
    'src/v2/Sidebar.jsx',
    'src/v2/MobileHome.jsx',
    'src/v2/Header.jsx',
    'src/v2/MobileBottomNav.jsx',

    // Data layer — the most important architecture
    'src/data/staff.js',
    'src/data/tvConfigs.js',
    'src/data/chat.js',
    'src/data/chatPermissions.js',
    'src/data/audit.js',
    'src/data/notify.js',

    // Representative component samples (not the giants)
    'src/components/MenuScreensPage.jsx',
    'src/components/MenuDisplay.jsx',
    'src/components/ChatShared.jsx',
    'src/components/ChatCenter.jsx',
    'src/components/HomePage.jsx',

    // Cloud Functions (single file architecture)
    'functions/index.js',
    'functions/package.json',
]);

// ─── Helpers ──────────────────────────────────────────────────
async function walk(dir, base = ROOT) {
    const out = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
        if (SKIP_DIRS.has(ent.name)) continue;
        if (SKIP_FILES.has(ent.name)) continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            out.push(...(await walk(full, base)));
            continue;
        }
        const ext = path.extname(ent.name).toLowerCase();
        if (SKIP_EXT.has(ext)) continue;
        // Vite leaves *.timestamp-12345.mjs files for HMR; skip.
        if (/\.timestamp-\d+/.test(ent.name)) continue;
        // functions/ has its own node_modules — covered above by
        // SKIP_DIRS, but defense in depth.
        if (full.includes('/functions/node_modules/')) continue;

        const stat = await fs.stat(full);
        const rel  = path.relative(base, full);
        out.push({ rel, full, size: stat.size });
    }
    return out;
}

function langFromExt(ext) {
    switch (ext) {
        case '.js': case '.mjs': case '.cjs':  return 'js';
        case '.jsx':                           return 'jsx';
        case '.ts':                            return 'ts';
        case '.tsx':                           return 'tsx';
        case '.json':                          return 'json';
        case '.css':                           return 'css';
        case '.html':                          return 'html';
        case '.md':                            return 'markdown';
        case '.sh':                            return 'bash';
        case '.py':                            return 'python';
        case '.yml': case '.yaml':             return 'yaml';
        case '.rules':                         return 'js';
        default:                               return '';
    }
}

// Rough token estimate — 1 token ≈ 4 chars for English code. Good
// enough to tell the user "this will fit in ChatGPT" vs "you need
// Claude / Gemini". Not used for any logic, just printed.
function approxTokens(bytes) { return Math.round(bytes / 4); }

function fmtSize(bytes) {
    if (bytes < 1024)            return `${bytes} B`;
    if (bytes < 1024 * 1024)     return `${(bytes / 1024).toFixed(1)} KB`;
    return                              `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function countLines(s) { return s ? s.split('\n').length : 0; }

function safeExec(cmd) {
    try {
        return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return ''; }
}

const REVIEW_PROMPT = `You're reviewing the source code of a production restaurant app called **DD Mau**. It runs at app.ddmaustl.com and is in active use at two physical restaurant locations.

**Stack:** React 18 + Vite 6 + Firebase Firestore + GitHub Pages + Cloud Functions.
**Auth model (important quirk):** anonymous Firestore access, no Firebase Auth — security enforced via client-side gates, narrow Firestore rules, audit logs, and a PIN-gated lock screen. There's a documented Phase 2 plan to wire Firebase Auth + custom claims + App Check.

**What I want from the review (in priority order):**
1. **Security risks** — any path where the anonymous-Firestore-access model leaks PII or allows tampering that the rules don't already block.
2. **Real bugs** — races, stale closures, missing error handling, off-by-one, TZ bugs.
3. **Performance** — re-render storms, unbounded queries, N+1 patterns, blocking work on main thread.
4. **Architecture concerns** — circular imports, lazy-loading pitfalls, TDZ traps, sloppy chunk boundaries.
5. **UX gaps** — missing empty states, error states, loading states, offline behavior.

**What I DON'T need:**
- Generic React advice ("you should use TypeScript", "consider Redux", etc.).
- Restyling the whole codebase to your preferred patterns.
- Nitpicks on naming or formatting unless they signal a real bug.

**Heads up on the codebase style:** there are VERY heavy comment blocks at the top of functions/sections explaining WHY decisions were made (outage history, edge cases, prior bugs). They're load-bearing context, not noise. Read them.

Start with the architecture in \`CLAUDE.md\`, then \`src/App.jsx\`, then look at whatever surface area you find most interesting.`;

// ─── Main ─────────────────────────────────────────────────────
async function main() {
    console.log('Scanning…');
    // Wipe + recreate the output dir so a previous run's files
    // don't shadow a new chunking pass (e.g. an old `app-snapshot.md`
    // sitting next to a new `app-snapshot-01-of-03.md` set).
    try { await fs.rm(OUT_DIR, { recursive: true, force: true }); } catch {}
    await fs.mkdir(OUT_DIR, { recursive: true });

    const files = await walk(ROOT);
    files.sort((a, b) => a.rel.localeCompare(b.rel));

    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    console.log(`  ${files.length} files, ${fmtSize(totalBytes)} total`);

    // Read everything once so we can count lines + reuse content
    // for multiple outputs.
    const contents = new Map();
    let totalLines = 0;
    for (const f of files) {
        let txt = '';
        try { txt = await fs.readFile(f.full, 'utf8'); } catch {}
        contents.set(f.rel, txt);
        f.lines = countLines(txt);
        totalLines += f.lines;
    }

    const gitBranch = safeExec('git rev-parse --abbrev-ref HEAD');
    const gitHash   = safeExec('git rev-parse --short HEAD');
    const gitLog    = safeExec('git log -n 20 --pretty=format:"%h  %ad  %s" --date=short');
    const stamp     = new Date().toISOString();

    const header = (title) => [
        `# ${title}`,
        '',
        `**Generated:** ${stamp}`,
        `**Git:** ${gitBranch || '?'} @ ${gitHash || '?'}`,
        `**Source files:** ${files.length} · **Total lines:** ${totalLines.toLocaleString()} · **Total size:** ${fmtSize(totalBytes)} · **~Tokens:** ${approxTokens(totalBytes).toLocaleString()}`,
        '',
        '## How to use this file',
        '',
        REVIEW_PROMPT,
        '',
        '## Recent commits',
        '',
        '```',
        gitLog || '(git log unavailable)',
        '```',
        '',
    ];

    const tocLines = files.map(f =>
        `- \`${f.rel}\` — ${f.lines.toLocaleString()} lines, ${fmtSize(f.size)}`
    );

    // ── FULL snapshot, auto-chunked ───────────────────────────
    // Cap each chunk at ~2.5 MB so each file fits comfortably in
    // a 700K-token-ish window (Claude 200K, Gemini 1.5 Pro 1M,
    // GPT-4 turbo 128K all work at this size). The TOC is in
    // chunk #1 so a reviewer can decide which chunks to load.
    const CHUNK_MAX_BYTES = 2.5 * 1024 * 1024;
    const fullChunks = [];
    let chunkParts = [];
    let chunkBytes = 0;
    let chunkIdx = 1;
    const flushChunk = () => {
        if (chunkParts.length === 0) return;
        fullChunks.push({ idx: chunkIdx, body: chunkParts.join('\n') });
        chunkIdx++;
        chunkParts = [];
        chunkBytes = 0;
    };
    const pushBlock = (block) => {
        const blockBytes = Buffer.byteLength(block, 'utf8');
        if (chunkBytes + blockBytes > CHUNK_MAX_BYTES && chunkParts.length > 0) {
            flushChunk();
        }
        chunkParts.push(block);
        chunkBytes += blockBytes;
    };

    // Chunk #1 starts with the global header + the table of contents.
    pushBlock([
        ...header('DD Mau App — Full Code Snapshot (chunk 1)'),
        '## Table of contents (all chunks)',
        '',
        ...tocLines,
        '',
        '---',
        '',
    ].join('\n'));

    for (const f of files) {
        const ext  = path.extname(f.full).toLowerCase();
        const lang = langFromExt(ext);
        const block = [
            `## \`${f.rel}\``,
            '',
            `_${f.lines.toLocaleString()} lines · ${fmtSize(f.size)}_`,
            '',
            `\`\`\`${lang}`,
            contents.get(f.rel) || '',
            '```',
            '',
        ].join('\n');
        pushBlock(block);
    }
    flushChunk();

    // Write each chunk; rewrite the title of chunks 2..N to reflect
    // their index. Returns total bytes for the summary printout.
    let fullSize = 0;
    for (const chunk of fullChunks) {
        const filename = fullChunks.length === 1
            ? 'app-snapshot.md'
            : `app-snapshot-${String(chunk.idx).padStart(2, '0')}-of-${String(fullChunks.length).padStart(2, '0')}.md`;
        let body = chunk.body;
        if (chunk.idx > 1) {
            // Replace the chunk-1 title baked into the first block
            // with a per-chunk title so reviewers know where they
            // are if they open chunks out of order.
            body = body.replace(
                '# DD Mau App — Full Code Snapshot (chunk 1)',
                `# DD Mau App — Full Code Snapshot (chunk ${chunk.idx} of ${fullChunks.length})`,
            );
        }
        const p = path.join(OUT_DIR, filename);
        await fs.writeFile(p, body);
        fullSize += (await fs.stat(p)).size;
    }
    const fullPath = path.join(OUT_DIR, fullChunks.length === 1
        ? 'app-snapshot.md'
        : `app-snapshot-01-of-${String(fullChunks.length).padStart(2, '0')}.md`);

    // ── CURATED snapshot ──────────────────────────────────────
    const curatedFiles = files.filter(f => CURATED.has(f.rel));
    const missingCurated = [...CURATED].filter(p => !files.some(f => f.rel === p));
    if (missingCurated.length) {
        console.warn('  Curated list refers to missing files:', missingCurated.join(', '));
    }
    const curatedBytes = curatedFiles.reduce((s, f) => s + f.size, 0);
    const curatedLines = curatedFiles.reduce((s, f) => s + f.lines, 0);

    const curatedParts = [];
    curatedParts.push(...header('DD Mau App — Curated Code Snapshot'));
    curatedParts.push(`> **Curated:** ${curatedFiles.length} files, ${curatedLines.toLocaleString()} lines, ${fmtSize(curatedBytes)}, ~${approxTokens(curatedBytes).toLocaleString()} tokens. Fits in ChatGPT-4o's 128K context. For the full codebase (including the 7k-line components), use \`app-snapshot.md\`.`);
    curatedParts.push('');
    curatedParts.push('## Files included');
    curatedParts.push('');
    curatedParts.push(...curatedFiles.map(f =>
        `- \`${f.rel}\` — ${f.lines.toLocaleString()} lines, ${fmtSize(f.size)}`));
    curatedParts.push('');
    curatedParts.push('---');
    curatedParts.push('');

    for (const f of curatedFiles) {
        const ext  = path.extname(f.full).toLowerCase();
        const lang = langFromExt(ext);
        curatedParts.push(`## \`${f.rel}\``);
        curatedParts.push('');
        curatedParts.push(`_${f.lines.toLocaleString()} lines · ${fmtSize(f.size)}_`);
        curatedParts.push('');
        curatedParts.push(`\`\`\`${lang}`);
        curatedParts.push(contents.get(f.rel) || '');
        curatedParts.push('```');
        curatedParts.push('');
    }

    const curatedPath = path.join(OUT_DIR, 'app-snapshot-curated.md');
    await fs.writeFile(curatedPath, curatedParts.join('\n'));
    const curatedSize = (await fs.stat(curatedPath)).size;

    // ── TOC only ──────────────────────────────────────────────
    const tocParts = [];
    tocParts.push(...header('DD Mau App — File Tree'));
    tocParts.push('## All source files');
    tocParts.push('');
    tocParts.push(...tocLines);
    const tocPath = path.join(OUT_DIR, 'app-snapshot-toc.md');
    await fs.writeFile(tocPath, tocParts.join('\n'));
    const tocSize = (await fs.stat(tocPath)).size;

    // ── Report ────────────────────────────────────────────────
    console.log('');
    console.log('Wrote:');
    console.log(`  dist-snapshot/app-snapshot-toc.md      ${fmtSize(tocSize).padStart(9)}   file tree only`);
    console.log(`  dist-snapshot/app-snapshot-curated.md  ${fmtSize(curatedSize).padStart(9)}   ~${approxTokens(curatedSize).toLocaleString()} tokens  (ChatGPT / Claude)`);
    if (fullChunks.length === 1) {
        console.log(`  dist-snapshot/app-snapshot.md          ${fmtSize(fullSize).padStart(9)}   ~${approxTokens(fullSize).toLocaleString()} tokens  (full)`);
    } else {
        console.log(`  ${fullChunks.length} chunks of the full snapshot:`);
        for (const chunk of fullChunks) {
            const filename = `app-snapshot-${String(chunk.idx).padStart(2, '0')}-of-${String(fullChunks.length).padStart(2, '0')}.md`;
            const bytes = Buffer.byteLength(chunk.body, 'utf8');
            console.log(`    dist-snapshot/${filename}  ${fmtSize(bytes).padStart(9)}   ~${approxTokens(bytes).toLocaleString()} tokens`);
        }
    }
    console.log('');
    console.log('Drag a .md file into the AI of your choice. The review prompt + commit log');
    console.log('are at the top of each file so the AI knows what to look at first.');
    console.log('');
    console.log('Rule of thumb:');
    console.log('  • ChatGPT-4o (128K) → app-snapshot-curated.md');
    console.log('  • Claude / Sonnet  (200K) → app-snapshot-curated.md, then chunks one at a time');
    console.log('  • Gemini 1.5 Pro / GPT-4 (1M) → all chunks in one go');
}

main().catch(err => { console.error(err); process.exit(1); });
