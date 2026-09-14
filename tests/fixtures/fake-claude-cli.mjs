#!/usr/bin/env node
/**
 * Stand-in for the `claude` binary in tests.
 *
 * Parses the flags `CLI_RUNTIMES["claude-code"].argv()` actually emits and
 * answers in Claude Code's `--output-format json` envelope, so the real argv
 * and permission translation are what gets exercised — no network, no key.
 *
 * The brief arrives on stdin (`-p` is boolean --print). A positional after
 * `-p` is still accepted so older argv shapes keep working.
 */

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const seen = { prompt: null, outputFormat: null, model: null, permissionMode: null, disallowedTools: [] };

for (let i = 0; i < argv.length; i += 1) {
  switch (argv[i]) {
    // `-p` is --print. Consume a following positional only if it is not a flag.
    case "-p":
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) seen.prompt = argv[++i];
      break;
    case "--output-format": seen.outputFormat = argv[++i]; break;
    case "--model": seen.model = argv[++i]; break;
    case "--permission-mode": seen.permissionMode = argv[++i]; break;
    // Variadic: consume every value up to the next flag, like commander does.
    case "--disallowedTools":
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) seen.disallowedTools.push(argv[++i]);
      break;
    default: break;
  }
}

if (seen.prompt === null) {
  try {
    const stdin = readFileSync(0, "utf8");
    if (stdin.trim()) seen.prompt = stdin;
  } catch {
    // no stdin
  }
}

if (seen.prompt === null) {
  process.stderr.write("fake-claude: missing prompt (-p <text> or stdin)\n");
  process.exit(2);
}

if (process.env.FAKE_CLAUDE_FAIL === "1") {
  process.stderr.write("fake-claude: simulated failure\n");
  process.exit(1);
}

// Claude Code can report failure in the payload while still exiting 0.
if (process.env.FAKE_CLAUDE_IS_ERROR === "1") {
  process.stdout.write(
    JSON.stringify({ type: "result", is_error: true, result: "rate limit exceeded" }) + "\n",
  );
  process.exit(0);
}

// Echo what we received so the test can assert on the real argv + cwd + stdin.
process.stdout.write(
  JSON.stringify({
    type: "result",
    is_error: false,
    result: JSON.stringify({ received: seen, cwd: process.cwd(), argv }),
  }) + "\n",
);
