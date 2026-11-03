#!/usr/bin/env node
// Turns the debug agent's QUEUED fixes into pull requests. Runs in its own CI
// job, AFTER the agent, with no AI involved (see .github/workflows/debug-agent.yml).
//
// The agent reads the 🐛 Debug Agent chat, which anyone can write to under any
// name, so it runs with a READ-ONLY GitHub token and can't push anything. It
// leaves a patch + title + description in agent-out/<slug>/ (scripts/qa/queue-pr.mjs),
// uploaded as a run artifact. This script holds the write token and treats that
// artifact as hostile: a compromised agent can upload ANY zip. So it never uses an
// extractor that writes files by the names inside the zip (a "../" entry could
// overwrite the code this job runs next). It reads the entries into memory, keeps
// only the expected names, applies the patch in a throwaway worktree, never runs
// anything from it, and only ever creates a NEW autofix/* branch + a PR. Nothing
// here can merge or deploy. Only Andrew's merge in GitHub does that.

import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

export const MAX_PRS = 3;
const ARTIFACT_NAME = "agent-prs";
const MAX_ZIP_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 20000;
const BRANCH_RE = /^autofix\/[a-z0-9][a-z0-9-]{0,60}$/;
const ENTRY_RE = /^([a-z0-9][a-z0-9-]{0,60})\/(meta\.json|change\.patch)$/;

// A fix never needs these. .github/ is what would turn a PR into new CI powers.
const FORBIDDEN_PATH_RE = /^(\.github\/|\.claude\/|node_modules\/|firebase-service-account\.json$)|(^|\/)(\.git(modules|attributes|ignore)|\.npmrc|\.lfsconfig|\.env[^/]*)$/;
// A backtick, newline or "<" in a file name could hide the file list on the PR.
const UNSAFE_NAME_RE = /[\u0000-\u001f\u007f`<>]/;
// Allowed, but called out on the PR + in the chat ping so they get a real look.
const SENSITIVE_PATH_RE = /^(firestore\.rules|storage\.rules|firebase\.json|functions(-media)?\/|scripts\/|package(-lock)?\.json|vite\.config|vitest\.config|postcss\.config|tailwind\.config|Dockerfile|capacitor|android\/|ios\/|src\/firebase\.js|src\/data\/staff\.js|src\/data\/testMode|src\/testmode\/)|payroll/i;

export function validateMeta(meta) {
    const branch = String(meta?.branch ?? "");
    if (!BRANCH_RE.test(branch)) throw new Error(`bad branch name "${branch.slice(0, 80)}"`);
    const title = String(meta?.title ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120);
    if (!title) throw new Error("missing title");
    return { branch, title, body: String(meta?.body ?? "").slice(0, MAX_BODY_CHARS), draft: meta?.draft === true };
}

export function forbiddenPaths(paths) {
    return paths.filter((p) => FORBIDDEN_PATH_RE.test(p));
}

export function hasUnsafeName(paths) {
    return paths.some((p) => UNSAFE_NAME_RE.test(p));
}

export function sensitivePaths(paths) {
    return paths.filter((p) => SENSITIVE_PATH_RE.test(p));
}

// The first part is built from the diff itself, so whatever the agent wrote
// below it can't hide what the PR really touches.
export function buildPrBody({ body, files, sensitive }) {
    const shown = files.slice(0, 40).map((f) => `- \`${f}\``).join("\n");
    const more = files.length > 40 ? `\n- …and ${files.length - 40} more` : "";
    return [
        "> **Merging this PR makes it live on web + phones.** Approval happens here, never in the chat.",
        "> The agent acts on chat messages, and names in that chat aren't verified, so check what this changes.",
        "> Any \"tests passed\" below is the agent's own claim. The independent run is under Checks.",
        "",
        "**Files changed (read from the diff, not written by the agent):**",
        shown + more,
        ...(sensitive.length ? ["", `⚠️ **Sensitive:** ${sensitive.map((f) => `\`${f}\``).join(", ")}`] : []),
        "",
        "---",
        "",
        body,
    ].join("\n");
}

function runner(cwd) {
    return (cmd, args) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// The chat is world-readable, and this goes there.
function shortError(e) {
    return String(e?.stderr || e?.message || e).trim().split("\n").slice(0, 3).join(" ")
        .replace(/\b(gh[a-z]_|github_pat_)[A-Za-z0-9_]+/g, "***").slice(0, 300);
}

// Reads every entry into memory and prints it as JSON, so nothing is ever written
// under a name from the zip. zipfile stops at each entry's declared size and
// checks its CRC, so capping the declared sizes also caps a zip bomb.
const READ_ZIP_PY = `
import base64, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    infos = [i for i in z.infolist() if not i.is_dir()]
    if len(infos) > 40 or sum(i.file_size for i in infos) > ${MAX_ZIP_BYTES / 2}:
        raise SystemExit("artifact is too large")
    print(json.dumps({i.filename: base64.b64encode(z.read(i)).decode() for i in infos}))
`;

export function readQueueZip(zipPath) {
    const files = JSON.parse(execFileSync("python3", ["-I", "-c", READ_ZIP_PY, zipPath], {
        encoding: "utf8", maxBuffer: MAX_ZIP_BYTES * 2, stdio: ["ignore", "pipe", "pipe"],
    }));
    const bySlug = new Map();
    const ignored = [];
    for (const [name, b64] of Object.entries(files)) {
        const m = ENTRY_RE.exec(name);
        if (!m) { ignored.push(name); continue; }
        const entry = bySlug.get(m[1]) || { name: m[1] };
        if (m[2] === "meta.json") entry.meta = Buffer.from(b64, "base64").toString("utf8");
        else entry.patch = Buffer.from(b64, "base64");
        bySlug.set(m[1], entry);
    }
    const entries = [...bySlug.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    return { entries, ignored };
}

// Downloads this run's queue through the REST API. Returns null if nothing was queued.
export function fetchQueuedZip({ repoSlug, runId, ghCmd = "gh", destDir }) {
    const list = JSON.parse(execFileSync(ghCmd, ["api", `repos/${repoSlug}/actions/runs/${runId}/artifacts`], {
        encoding: "utf8", maxBuffer: MAX_ZIP_BYTES, stdio: ["ignore", "pipe", "pipe"],
    }));
    const artifact = (list.artifacts || []).find((a) => a.name === ARTIFACT_NAME && !a.expired);
    if (!artifact) return null;
    if (artifact.size_in_bytes > MAX_ZIP_BYTES) throw new Error("artifact is too large");
    const bytes = execFileSync(ghCmd, ["api", `repos/${repoSlug}/actions/artifacts/${Number(artifact.id)}/zip`], {
        maxBuffer: MAX_ZIP_BYTES, stdio: ["ignore", "pipe", "pipe"],
    });
    const zipPath = join(destDir, "queue.zip");
    writeFileSync(zipPath, bytes);
    return zipPath;
}

// NUL-separated so odd file names can't come back quoted and dodge the checks.
export function parseRawDiff(raw) {
    const parts = raw.split("\0").filter(Boolean);
    const changes = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        const [, newMode] = parts[i].split(" ");
        changes.push({ path: parts[i + 1], newMode });
    }
    return changes;
}

function publishOne(entry, { repoDir, baseRef, ghCmd, repoSlug }) {
    if (typeof entry.meta !== "string" || !entry.patch) throw new Error("queued fix is incomplete");
    const meta = validateMeta(JSON.parse(entry.meta));
    if (entry.patch.length > MAX_PATCH_BYTES) throw new Error("patch is too large");

    const repo = runner(repoDir);
    const scratch = mkdtempSync(join(tmpdir(), "agent-pr-"));
    const worktree = join(scratch, "worktree");
    const patchPath = join(scratch, "change.patch");
    const bodyFile = join(scratch, "pr-body.md");
    writeFileSync(patchPath, entry.patch);
    repo("git", ["worktree", "add", "--detach", "--quiet", worktree, baseRef]);
    try {
        const wt = runner(worktree);
        // --cached: index only. Writing files would load any .gitattributes in the
        // patch, and with it filters like git-lfs, before the checks below refuse it.
        wt("git", ["apply", "--cached", "--whitespace=nowarn", patchPath]);
        const changes = parseRawDiff(wt("git", ["diff", "--cached", "--no-renames", "--raw", "-z"]));
        const files = changes.map((c) => c.path);
        if (!files.length) throw new Error("patch changes nothing");
        if (hasUnsafeName(files)) throw new Error("patch has a file name with unsafe characters");
        const blocked = forbiddenPaths(files);
        if (blocked.length) throw new Error(`patch touches files a fix may not touch: ${blocked.join(", ")}`);
        // 120000 = symlink, 160000 = submodule.
        if (changes.some((c) => c.newMode === "120000" || c.newMode === "160000")) {
            throw new Error("patch adds a symlink or submodule");
        }
        wt("git", ["-c", "user.name=DD Mau Debug Agent", "-c", "user.email=noreply@ddmaustl.com",
            "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-verify", "-m", meta.title]);
        // Not forced: a branch that already exists stays as it is and this fails.
        wt("git", ["push", "--quiet", "origin", `HEAD:refs/heads/${meta.branch}`]);

        const sensitive = sensitivePaths(files);
        writeFileSync(bodyFile, buildPrBody({ body: meta.body, files, sensitive }));
        let url;
        try {
            url = repo(ghCmd, ["pr", "create", "--base", "main", "--head", meta.branch,
                "--title", meta.title, "--body-file", bodyFile, ...(meta.draft ? ["--draft"] : [])]).split("\n").pop();
        } catch (e) {
            // The branch is up, so the fix isn't lost. Usually this is the repo
            // setting that lets Actions create PRs being off.
            return { ...meta, sensitive, prFailed: shortError(e), url: `https://github.com/${repoSlug}/compare/main...${meta.branch}?expand=1` };
        }
        // A PR opened with this token doesn't start test.yml by itself, so ask for
        // it. Best-effort: the fix is still reviewable if this fails.
        let testsStarted = true;
        try { repo(ghCmd, ["workflow", "run", "test.yml", "--ref", meta.branch]); } catch { testsStarted = false; }
        return { ...meta, url, sensitive, testsStarted };
    } finally {
        try { repo("git", ["worktree", "remove", "--force", worktree]); } catch { /* the scratch dir goes below */ }
        rmSync(scratch, { recursive: true, force: true });
    }
}

export function formatPing({ title, url, draft, sensitive, prFailed, testsStarted }) {
    if (prFailed) {
        return [`⚠️ Fix is on a branch, but GitHub wouldn't let me open the PR: ${title}`,
            `Open it yourself: ${url}`,
            `Probably the setting under Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests". Error: ${prFailed}`].join("\n");
    }
    if (draft) return `📝 Diagnosis written up, nothing to approve yet: ${title}\n${url}`;
    const lines = [`✅ Ready for your OK: ${title}`, url, "To make it live, open it in the GitHub app, check the changes and tap Merge. Replying in chat won't ship it."];
    if (testsStarted === false) lines.push("⚠️ The automatic test run didn't start, so nothing has checked this independently.");
    if (sensitive.length) lines.push(`⚠️ Touches sensitive files: ${sensitive.slice(0, 5).join(", ")}${sensitive.length > 5 ? "…" : ""}`);
    return lines.join("\n");
}

export function publishAll(entries, { repoDir, baseRef = "HEAD", ghCmd = "gh", repoSlug = "", post }) {
    const results = [];
    for (const [i, entry] of entries.entries()) {
        const { name } = entry;
        if (i >= MAX_PRS) {
            post(`⚠️ Skipped a queued fix (limit is ${MAX_PRS} per run): ${name}`);
            results.push({ name, ok: false, error: "over the per-run limit" });
            continue;
        }
        try {
            const pr = publishOne(entry, { repoDir, baseRef, ghCmd, repoSlug });
            post(formatPing(pr));
            results.push({ name, ok: !pr.prFailed, ...pr });
        } catch (e) {
            const error = shortError(e);
            post(`❌ Couldn't open the PR for a queued fix (${name}): ${error}`);
            results.push({ name, ok: false, error });
        }
    }
    return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const repoDir = process.cwd();
    const repoSlug = process.env.GITHUB_REPOSITORY;
    const post = (text) => {
        console.log(text);
        try {
            execFileSync(process.execPath, ["scripts/qa/agent-comms.mjs", "post", text], { cwd: repoDir, stdio: "inherit" });
        } catch (e) { console.error("chat post failed:", shortError(e)); }
    };
    const scratch = mkdtempSync(join(tmpdir(), "agent-queue-"));
    let queue;
    try {
        const zipPath = fetchQueuedZip({ repoSlug, runId: process.env.GITHUB_RUN_ID, destDir: scratch });
        if (!zipPath) { console.log("nothing queued"); process.exit(0); }
        queue = readQueueZip(zipPath);
    } catch (e) {
        post(`❌ Couldn't read the fixes the agent queued: ${shortError(e)}`);
        process.exit(1);
    }
    if (queue.ignored.length) console.log(`ignored ${queue.ignored.length} unexpected file(s) in the artifact`);
    const results = publishAll(queue.entries, { repoDir, repoSlug, post });
    process.exit(results.some((r) => !r.ok) ? 1 : 0);
}
