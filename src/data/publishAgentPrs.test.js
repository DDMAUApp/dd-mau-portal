// @vitest-environment node
// The job that opens the debug agent's PRs holds a write token and treats what
// the agent queued as untrusted, so these run it end to end against real git.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    validateMeta, buildPrBody, forbiddenPaths, hasUnsafeName, sensitivePaths, formatPing, publishAll, readQueueZip, fetchQueuedZip, parseRawDiff, MAX_PRS,
} from '../../scripts/qa/publish-agent-prs.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const IDENT = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

describe('validateMeta', () => {
    it('accepts a normal autofix branch', () => {
        expect(validateMeta({ branch: 'autofix/chat-crash', title: 'autofix: x' }).branch).toBe('autofix/chat-crash');
    });
    it.each(['main', 'refs/heads/main', 'autofix/../main', 'autofix/a b', 'autofix/x;rm', 'autofix/', '--force', 'autofix/A'])('refuses branch %s', (branch) => {
        expect(() => validateMeta({ branch, title: 't' })).toThrow(/bad branch/);
    });
    it('needs a title and strips control characters', () => {
        expect(() => validateMeta({ branch: 'autofix/a', title: ' \n ' })).toThrow(/title/);
        expect(validateMeta({ branch: 'autofix/a', title: 'a\nb' }).title).toBe('a b');
    });
});

describe('path checks', () => {
    it('blocks CI, credentials and dependencies', () => {
        expect(forbiddenPaths(['.github/workflows/x.yml', 'src/a.js', 'firebase-service-account.json', '.gitattributes', 'src/.gitattributes', 'node_modules/a/b.js']))
            .toEqual(['.github/workflows/x.yml', 'firebase-service-account.json', '.gitattributes', 'src/.gitattributes', 'node_modules/a/b.js']);
    });
    it.each(['.gitignore', 'src/.gitignore', '.npmrc', 'functions/.npmrc', '.env', '.env.local', '.lfsconfig', '.claude/settings.json'])('blocks %s', (p) => {
        expect(forbiddenPaths([p])).toEqual([p]);
    });
    it('does not block ordinary source files', () => {
        expect(forbiddenPaths(['src/env.js', 'src/environment/a.js', 'src/gitignore.js', 'functions/index.js'])).toEqual([]);
    });
    it('catches file names that could rewrite the PR description', () => {
        expect(hasUnsafeName(['src/a`b.js'])).toBe(true);
        expect(hasUnsafeName(['src/a\nb.js'])).toBe(true);
        expect(hasUnsafeName(['src/<!--.js'])).toBe(true);
        expect(hasUnsafeName(['src/normal file (1).js'])).toBe(false);
    });
    it('flags sensitive files', () => {
        expect(sensitivePaths(['firestore.rules', 'functions/index.js', 'src/components/Payroll.jsx', 'src/components/Chat.jsx', 'scripts/deploy.sh']))
            .toEqual(['firestore.rules', 'functions/index.js', 'src/components/Payroll.jsx', 'scripts/deploy.sh']);
        expect(sensitivePaths(['functions-media/index.js', 'Dockerfile', 'vitest.config.js'])).toHaveLength(3);
    });
});

describe('parseRawDiff', () => {
    it('reads paths and new modes without git quoting', () => {
        expect(parseRawDiff(':100644 120000 abc def T\0.github/workflows/é.yml\0:000000 100644 000 fff A\0src/a.js\0'))
            .toEqual([{ path: '.github/workflows/é.yml', newMode: '120000' }, { path: 'src/a.js', newMode: '100644' }]);
    });
});

describe('messages', () => {
    it('puts the real file list ahead of anything the agent wrote', () => {
        const body = buildPrBody({ body: 'Files changed: only a typo', files: ['firestore.rules'], sensitive: ['firestore.rules'] });
        expect(body.indexOf('`firestore.rules`')).toBeLessThan(body.indexOf('only a typo'));
        expect(body).toContain('⚠️ **Sensitive:**');
    });
    it('tells Andrew that shipping happens in GitHub', () => {
        const ping = formatPing({ title: 't', url: 'u', draft: false, sensitive: [] });
        expect(ping).toContain('tap Merge');
        expect(ping).toContain("won't ship");
    });
    it('gives Andrew a way forward when GitHub refuses the PR', () => {
        const ping = formatPing({ title: 't', url: 'https://x/compare', prFailed: 'not permitted', sensitive: [] });
        expect(ping).toContain('https://x/compare');
        expect(ping).toContain('Allow GitHub Actions');
    });
});

describe('readQueueZip', () => {
    let root;
    const makeZip = (files) => {
        const zip = join(root, 'q.zip');
        const code = 'import json,sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED)\nfor k,v in json.loads(sys.argv[2]).items(): z.writestr(k,"x"*v if isinstance(v,int) else v)\nz.close()';
        execFileSync('python3', ['-I', '-c', code, zip, JSON.stringify(files)]);
        return zip;
    };
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'zip-test-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('returns the expected files', () => {
        const { entries, ignored } = readQueueZip(makeZip({ 'one/meta.json': '{"a":1}', 'one/change.patch': 'diff' }));
        expect(ignored).toEqual([]);
        expect(entries).toHaveLength(1);
        expect(entries[0].name).toBe('one');
        expect(entries[0].meta).toBe('{"a":1}');
        expect(entries[0].patch.toString()).toBe('diff');
    });

    it('never writes zip entries to disk, and drops path traversal names', () => {
        const zip = makeZip({
            '../../evil.mjs': 'owned',
            'a/../../../scripts/qa/publish-agent-prs.mjs': 'owned',
            '/tmp/absolute-evil': 'owned',
            '.hidden/meta.json': 'owned',
            'UPPER/meta.json': 'owned',
            'one/other.txt': 'owned',
            'one/../two/meta.json': 'owned',
            'one/meta.json': '{}',
        });
        const before = readdirSync(root);
        const { entries, ignored } = readQueueZip(zip);
        expect(entries.map((e) => e.name)).toEqual(['one']);
        expect(entries[0].meta).toBe('{}');
        expect(ignored).toHaveLength(7);
        expect(readdirSync(root)).toEqual(before);
        expect(existsSync('/tmp/absolute-evil')).toBe(false);
    });

    it('refuses an oversized artifact', () => {
        expect(() => readQueueZip(makeZip({ 'one/change.patch': 9 * 1024 * 1024 }))).toThrow();
    });
});

describe('fetchQueuedZip', () => {
    let root;
    const fakeGh = (artifactsJson) => {
        const gh = join(root, 'gh');
        writeFileSync(join(root, 'artifacts.json'), artifactsJson);
        writeFileSync(join(root, 'bytes.zip'), 'zipbytes');
        writeFileSync(gh, `#!/bin/sh\ncase "$2" in\n  */artifacts) cat "${root}/artifacts.json" ;;\n  */zip) printf '%s' "$2" > "${root}/asked"; cat "${root}/bytes.zip" ;;\nesac\n`);
        chmodSync(gh, 0o755);
        return gh;
    };
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fetch-test-')); });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('downloads this run\'s artifact to a fixed path', () => {
        const ghCmd = fakeGh(JSON.stringify({ artifacts: [{ id: 7, name: 'other', size_in_bytes: 1 }, { id: 9, name: 'agent-prs', size_in_bytes: 8 }] }));
        const zip = fetchQueuedZip({ repoSlug: 'o/r', runId: '1', ghCmd, destDir: root });
        expect(zip).toBe(join(root, 'queue.zip'));
        expect(readFileSync(zip, 'utf8')).toBe('zipbytes');
        expect(readFileSync(join(root, 'asked'), 'utf8')).toBe('repos/o/r/actions/artifacts/9/zip');
    });
    it('returns null when nothing was queued', () => {
        const ghCmd = fakeGh(JSON.stringify({ artifacts: [] }));
        expect(fetchQueuedZip({ repoSlug: 'o/r', runId: '1', ghCmd, destDir: root })).toBeNull();
    });
    it('refuses an oversized artifact before downloading it', () => {
        const ghCmd = fakeGh(JSON.stringify({ artifacts: [{ id: 9, name: 'agent-prs', size_in_bytes: 999999999 }] }));
        expect(() => fetchQueuedZip({ repoSlug: 'o/r', runId: '1', ghCmd, destDir: root })).toThrow(/too large/);
    });
});

// These are what keep a compromised agent away from anything that can ship.
describe('workflow invariants', () => {
    const wf = (name) => readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8');
    const code = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#')).map((l) => l.replace(/\s#.*$/, '')).join('\n');
    const agentJob = () => { const s = code(wf('debug-agent.yml')); return s.slice(s.indexOf('\n  agent:'), s.indexOf('\n  publish-prs:')); };

    it.each(['debug-agent.yml', 'ship-live.yml', 'deploy.yml', 'test.yml'])('%s restores no npm cache', (name) => {
        expect(code(wf(name))).not.toMatch(/^\s*cache:/m);
    });
    it('the agent job has no write access and only its API key', () => {
        const job = agentJob();
        expect(job).not.toMatch(/:\s*write\b/);
        expect(job).not.toContain('id-token');
        expect(job.match(/secrets\.[A-Z_]+/g)).toEqual(['secrets.ANTHROPIC_API_KEY']);
        expect(job).toContain('github_token: ${{ github.token }}');
        expect(job).toContain('persist-credentials: false');
    });
    it('the workflow-level token is read-only', () => {
        expect(code(wf('debug-agent.yml'))).toMatch(/^permissions:\n {2}contents: read\n\n/m);
    });
    it('the PR job extracts nothing with a third-party action', () => {
        expect(code(wf('debug-agent.yml'))).not.toContain('download-artifact');
    });
    it('no chat-reachable trigger can start a deploy', () => {
        const ship = code(wf('ship-live.yml'));
        expect(ship).not.toContain('repository_dispatch');
        expect(ship).not.toContain('client_payload');
        expect(code(wf('debug-agent.yml'))).not.toContain('SHIP_PAT');
    });
    it('a web deploy can\'t cancel a ship, and waiting runs queue instead of replacing each other', () => {
        expect(code(wf('deploy.yml'))).toMatch(/cancel-in-progress: false\n\s+queue: max/);
        expect(code(wf('ship-live.yml'))).toMatch(/cancel-in-progress: false\n\s+queue: max/);
    });
    it('the agent step does not set the scrub variable, which stops the CLI starting', () => {
        expect(code(wf('debug-agent.yml'))).not.toContain('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB');
    });
    it('Firebase never deploys every codebase from a merged PR, and each installs without the token', () => {
        const ship = code(wf('ship-live.yml'));
        expect(ship).toContain('--only "$TARGET"');
        expect(ship).toContain('functions:default');
        expect(ship).toContain('functions:media');
        const install = ship.slice(ship.indexOf('Install Cloud Functions deps'), ship.indexOf('Deploy Cloud Functions (optional)'));
        expect(install).not.toContain('FIREBASE_TOKEN');
    });
    it('a server deploy that fails tells the chat', () => {
        expect(code(wf('ship-live.yml'))).toContain("steps.functions.outcome == 'failure'");
    });
    it('test.yml stays read-only', () => {
        expect(code(wf('test.yml'))).toMatch(/^permissions:\n {2}contents: read/m);
        expect(code(wf('test.yml'))).toMatch(/timeout-minutes: \d+/);
        expect(code(wf('test.yml'))).not.toContain('secrets.');
    });
});

describe('publishAll', () => {
    let root, repo, origin, queue, ghCmd, ghLog, posts;
    const post = (t) => posts.push(t);
    const opts = () => ({ repoDir: repo, ghCmd, post, repoSlug: 'o/r' });
    const queueFix = (slug, { path = 'src/a.js', content = 'fixed\n', branch = `autofix/${slug}`, title = `fix ${slug}`, setup } = {}) => {
        const b = `work-${slug}`;
        git(repo, 'checkout', '-q', '-b', b);
        if (setup) setup(); else { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), content); }
        git(repo, 'add', '-A');
        git(repo, ...IDENT, 'commit', '-qm', 'x');
        const patch = execFileSync('git', ['diff', '--binary', '--no-renames', 'main', 'HEAD'], { cwd: repo });
        git(repo, 'checkout', '-q', 'main');
        git(repo, 'branch', '-qD', b);
        queue.push({ name: slug, patch, meta: JSON.stringify({ branch, title, body: 'notes' }) });
    };
    const remoteBranches = () => git(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
    const setFakeGh = (script) => { writeFileSync(ghCmd, script); chmodSync(ghCmd, 0o755); };
    const logAndUrl = () => `printf '%s\\n' "$*" >> "${ghLog}"\necho https://github.test/pr/1\n`;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'publish-test-'));
        origin = join(root, 'origin.git');
        repo = join(root, 'repo');
        queue = [];
        git(root, 'init', '-q', '--bare', '-b', 'main', origin);
        git(root, 'clone', '-q', origin, repo);
        git(repo, 'checkout', '-q', '-B', 'main');
        mkdirSync(join(repo, 'src'));
        writeFileSync(join(repo, 'src/a.js'), 'broken\n');
        git(repo, 'add', '-A');
        git(repo, ...IDENT, 'commit', '-qm', 'init');
        git(repo, 'push', '-q', 'origin', 'main');
        ghLog = join(root, 'gh.log');
        ghCmd = join(root, 'fake-gh');
        setFakeGh(`#!/bin/sh\n${logAndUrl()}`);
        posts = [];
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('pushes a new branch, opens a PR, starts the tests, pings the chat, and leaves main alone', () => {
        const before = git(origin, 'rev-parse', 'main');
        queueFix('one');
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(true);
        expect(git(origin, 'show', 'autofix/one:src/a.js')).toBe('fixed');
        expect(git(origin, 'rev-parse', 'main')).toBe(before);
        const log = readFileSync(ghLog, 'utf8');
        expect(log).toContain('pr create --base main --head autofix/one');
        expect(log).toContain('workflow run test.yml --ref autofix/one');
        expect(posts[0]).toContain('https://github.test/pr/1');
        expect(readFileSync(join(repo, 'src/a.js'), 'utf8')).toBe('broken\n');
    });

    it('still reports the PR when the test run can\'t start', () => {
        setFakeGh(`#!/bin/sh\n[ "$1" = "workflow" ] && exit 1\n${logAndUrl()}`);
        queueFix('one');
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(true);
        expect(posts[0]).toContain("didn't start");
    });

    it('keeps the branch and links it when GitHub refuses the PR', () => {
        setFakeGh('#!/bin/sh\necho "GitHub Actions is not permitted to create or approve pull requests" >&2\nexit 1\n');
        queueFix('one');
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(false);
        expect(remoteBranches()).toContain('autofix/one');
        expect(posts[0]).toContain('https://github.com/o/r/compare/main...autofix/one');
        expect(posts[0]).toContain('not permitted');
    });

    it('refuses a patch that touches CI, and pushes nothing', () => {
        queueFix('ci', { path: '.github/workflows/evil.yml', content: 'on: push\n' });
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/\.github/);
        expect(remoteBranches()).toEqual(['main']);
        expect(existsSync(ghLog)).toBe(false);
        expect(posts[0]).toMatch(/^❌/);
    });

    it('refuses CI files with non-ASCII names, which git would print quoted', () => {
        queueFix('uni', { path: '.github/workflows/é.yml', content: 'on: push\n' });
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(false);
        expect(remoteBranches()).toEqual(['main']);
    });

    it('refuses a nested .gitattributes', () => {
        queueFix('attrs', { path: 'src/.gitattributes', content: '*.js -diff\n' });
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(false);
        expect(remoteBranches()).toEqual(['main']);
    });

    it('refuses .gitignore and .npmrc changes', () => {
        queueFix('ignore', { path: '.gitignore', content: '!firebase-service-account.json\n' });
        queueFix('npmrc', { path: '.npmrc', content: 'script-shell=./evil.sh\n' });
        const results = publishAll(queue, opts());
        expect(results.map((r) => r.ok)).toEqual([false, false]);
        expect(remoteBranches()).toEqual(['main']);
    });

    it('refuses a file name that could hide the file list', () => {
        queueFix('tick', { path: 'src/a`b.js' });
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/unsafe/);
        expect(remoteBranches()).toEqual(['main']);
    });

    it('never runs a filter from a refused patch', () => {
        const marker = join(root, 'filter-ran');
        git(repo, 'config', 'filter.evil.smudge', `touch ${marker}; cat`);
        git(repo, 'config', 'filter.evil.clean', `touch ${marker}; cat`);
        queueFix('filter', { setup: () => {
            mkdirSync(join(repo, 'src/z'));
            writeFileSync(join(repo, 'src/z/.gitattributes'), '* filter=evil\n');
            writeFileSync(join(repo, 'src/z/f.js'), 'x\n');
            git(repo, '-c', 'filter.evil.clean=cat', '-c', 'filter.evil.smudge=cat', 'add', '-A');
        } });
        rmSync(marker, { force: true });
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(false);
        expect(existsSync(marker)).toBe(false);
        expect(remoteBranches()).toEqual(['main']);
    });

    it('queue-pr writes to the repo root from any folder', () => {
        git(repo, 'checkout', '-q', '-b', 'autofix/from-sub');
        writeFileSync(join(repo, 'src/a.js'), 'fixed\n');
        git(repo, 'add', '-A');
        git(repo, ...IDENT, 'commit', '-qm', 'x');
        execFileSync(process.execPath, [join(process.cwd(), 'scripts/qa/queue-pr.mjs'), '--title', 'a fix'], { cwd: join(repo, 'src'), stdio: 'ignore' });
        expect(existsSync(join(repo, 'agent-out/from-sub/change.patch'))).toBe(true);
        expect(existsSync(join(repo, 'src/agent-out'))).toBe(false);
    });

    it('refuses a new symlink', () => {
        queueFix('link', { setup: () => execFileSync('ln', ['-s', '/etc/passwd', join(repo, 'src/link')]) });
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/symlink/);
        expect(remoteBranches()).toEqual(['main']);
    });

    it('refuses turning an existing file into a symlink', () => {
        queueFix('swap', { setup: () => { rmSync(join(repo, 'src/a.js')); execFileSync('ln', ['-s', '/etc/passwd', join(repo, 'src/a.js')]); } });
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/symlink/);
        expect(remoteBranches()).toEqual(['main']);
    });

    it('refuses a branch name aimed at main', () => {
        queueFix('target', { branch: 'main' });
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(false);
        expect(remoteBranches()).toEqual(['main']);
    });

    it('refuses an incomplete entry', () => {
        const [r] = publishAll([{ name: 'x', meta: '{}' }], opts());
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/incomplete/);
    });

    it('never overwrites an existing branch', () => {
        queueFix('dupe', { content: 'first\n' });
        publishAll(queue, opts());
        const sha = git(origin, 'rev-parse', 'autofix/dupe');
        queue = [];
        queueFix('dupe', { content: 'second\n' });
        const [r] = publishAll(queue, opts());
        expect(r.ok).toBe(false);
        expect(git(origin, 'rev-parse', 'autofix/dupe')).toBe(sha);
    });

    it(`stops at ${MAX_PRS} PRs and leaves no worktrees behind`, () => {
        ['a', 'b', 'c', 'd'].forEach((s) => queueFix(s, { path: `src/${s}.js` }));
        const results = publishAll(queue, opts());
        expect(results.filter((r) => r.ok)).toHaveLength(MAX_PRS);
        expect(remoteBranches()).not.toContain('autofix/d');
        expect(git(repo, 'worktree', 'list').split('\n')).toHaveLength(1);
    });
});
