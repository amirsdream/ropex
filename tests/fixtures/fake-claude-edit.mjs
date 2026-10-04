#!/usr/bin/env node
/**
 * Stand-in for `claude` that edits the workspace, then answers in Claude
 * Code's `--output-format json` envelope. Used to prove a sandbox task can
 * change repo files and have Ropex commit them — no network, no model.
 *
 * FAKE_CLAUDE_FAIL=1  exit 1
 * FAKE_CLAUDE_NOOP=1  succeed without writing
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
let prompt = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "-p" && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
    prompt = argv[++i];
  }
}
if (prompt === null) {
  try {
    const stdin = readFileSync(0, "utf8");
    if (stdin.trim()) prompt = stdin;
  } catch {
    // no stdin
  }
}
if (prompt === null) {
  process.stderr.write("fake-claude-edit: missing prompt\n");
  process.exit(2);
}
if (process.env.FAKE_CLAUDE_FAIL === "1") {
  process.stderr.write("fake-claude-edit: simulated failure\n");
  process.exit(1);
}

const wrote = [];
if (process.env.FAKE_CLAUDE_NOOP !== "1") {
  const files = {
    "src/hello.ts":
      "export function hello(name: string): string {\n" +
      "  return `hello, ${name}`;\n" +
      "}\n",
    "src/hello.test.ts":
      'import { hello } from "./hello.js";\n' +
      "\n" +
      'if (hello("world") !== "hello, world") {\n' +
      '  throw new Error("hello() mismatch");\n' +
      "}\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(rel), { recursive: true });
    writeFileSync(rel, body);
    wrote.push(rel);
  }
}

process.stdout.write(
  JSON.stringify({
    type: "result",
    is_error: false,
    result: `edited ${wrote.join(", ") || "nothing"}`,
  }) + "\n",
);
