#!/usr/bin/env node
/**
 * Stand-in for `claude -p`, `codex exec`, and `copilot -p`.
 *
 * Reads the brief's intended actions and applies each one in cwd:
 * `argv` runs a command, `path` + `content` writes a file. Any other action
 * is left for a real agent. Speaks each CLI's output shape.
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

const actions = prompt.split("## Intended actions\n")[1]?.split("\n## ")[0] ?? "";
const calls = [];
for (const line of actions.split("\n")) {
  const match = line.match(/^- [A-Za-z0-9_-]+\((.*)\)\s*$/);
  if (!match) continue;
  calls.push(JSON.parse(match[1]));
}
if (!calls.length) {
  process.stderr.write("fake-harness-cli: brief has no intended actions\n");
  process.exit(1);
}

for (const input of calls) {
  if (Array.isArray(input.argv) && input.argv.length && input.argv.every((part) => typeof part === "string")) {
    const [bin, ...args] = input.argv;
    execFileSync(bin, args, {
      cwd: process.cwd(),
      env: process.env,
    });
    continue;
  }
  if (typeof input.path === "string" && typeof input.content === "string") {
    if (input.path.startsWith("/") || input.path.split(/[\\/]/).includes("..")) {
      process.stderr.write(`fake-harness-cli: refusing path ${input.path}\n`);
      process.exit(1);
    }
    mkdirSync(dirname(input.path), { recursive: true });
    writeFileSync(input.path, input.content);
  }
}

const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }).trim();
const summary = `committed ${sha}`;

if (argv.includes("--output-format")) {
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: summary }) + "\n");
} else if (argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ message: summary }) + "\n");
} else {
  process.stdout.write(summary + "\n");
}
