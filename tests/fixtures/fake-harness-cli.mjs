#!/usr/bin/env node
/**
 * Stand-in for `claude -p`, `codex exec`, and `copilot -p`.
 *
 * Reads the composed brief, applies the ## Workspace files, and git-commits
 * them in the process cwd — the same job the real CLI does as the harness.
 * Speaks each CLI's output shape so the real argv() and parse() are what run.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);

function promptFromArgv() {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "-p" && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
      return argv[i + 1];
    }
  }
  return null;
}

let prompt = promptFromArgv();
if (prompt === null) {
  try {
    const stdin = readFileSync(0, "utf8");
    if (stdin.trim()) prompt = stdin;
  } catch {
    // no stdin
  }
}
if (prompt === null) {
  process.stderr.write("fake-harness-cli: missing brief\n");
  process.exit(2);
}

const block = prompt.match(/## Workspace\n[\s\S]*?```json\n([\s\S]*?)\n```/);
if (!block) {
  process.stderr.write("fake-harness-cli: brief has no ## Workspace edits\n");
  process.exit(1);
}
const edits = JSON.parse(block[1]);
const files = Array.isArray(edits.files) ? edits.files : [];
for (const file of files) {
  if (!file.path || file.path.startsWith("/") || file.path.split(/[\\/]/).includes("..")) {
    process.stderr.write(`fake-harness-cli: refusing path ${file.path}\n`);
    process.exit(1);
  }
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, String(file.content ?? ""));
}

const message = String(edits.message ?? "").trim() || "task";
execFileSync(
  "git",
  ["add", "-A", "--", ".", ":(exclude).ropex-worker.json", ":(exclude)README.ropex"],
  { cwd: process.cwd() },
);
execFileSync(
  "git",
  [
    "-c",
    "user.name=Ropex",
    "-c",
    "user.email=ropex@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    message,
  ],
  { cwd: process.cwd() },
);
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
const summary = `committed ${sha}`;

if (argv.includes("--output-format")) {
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: summary }) + "\n");
} else if (argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ message: summary }) + "\n");
} else {
  process.stdout.write(summary + "\n");
}
