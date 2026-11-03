#!/usr/bin/env node
// How the debug agent hands over a finished fix. The agent can't push (its
// GitHub token is read-only), so from its autofix/<slug> branch it runs:
//
//   node scripts/qa/queue-pr.mjs --title "..." --body-file notes.md [--draft]
//
// This saves the branch's commits as a patch in agent-out/<slug>/. After the
// agent finishes, scripts/qa/publish-agent-prs.mjs opens the actual PR.

import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { validateMeta } from "./publish-agent-prs.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const bodyFile = flag("--body-file");

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const meta = validateMeta({
    branch,
    title: flag("--title"),
    body: bodyFile ? readFileSync(bodyFile, "utf8") : "",
    draft: args.includes("--draft"),
});
const base = git("merge-base", "origin/main", "HEAD");
const patch = execFileSync("git", ["diff", "--binary", "--no-renames", base, "HEAD"], { maxBuffer: 64 * 1024 * 1024 });
if (!patch.length) { console.error("queue-pr: no committed changes on this branch"); process.exit(1); }

const dir = join(git("rev-parse", "--show-toplevel"), "agent-out", branch.slice("autofix/".length));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "change.patch"), patch);
writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
console.log(`queued ${branch}. The PR opens right after this run ends, and its link goes to the chat automatically.`);
