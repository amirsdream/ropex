# Manual checks — harness commits and CLI runtimes

Repeatable checks for the execute-stage changes: the harness commits inside the task, auth is a named strategy, and Cursor is a runtime. You run every step yourself. Nothing here calls a model unless you choose the optional Codex section.

Run this in **bash** on Linux, macOS, or [WSL](./wsl.md). The control plane’s root is the current directory, so the fixture repo and the Ropex source stay separate.

Automated coverage of the same behavior is `npm test`. This page is the manual path.

## 0. Clean Ropex setup

Do this once per machine, and again whenever you want a known source tree.

```bash
git clone https://github.com/amirsdream/ropex.git "$HOME/ropex-src"
cd "$HOME/ropex-src"
git fetch origin cursor/sandbox-task-commit-75e8
git checkout cursor/sandbox-task-commit-75e8
node -v    # 20 or newer. 22 matches the sandbox image.
npm install
```

Leave this checkout as the source. Do not enqueue tasks while your shell is inside it. A local run creates a git worktree of whatever repo is current, and a commit there would be a commit on the Ropex history.

```bash
export ROPEX="$HOME/ropex-src"
```

`npm install` does not install Claude, Codex, Copilot, or Cursor. Parts 1–4 need only Node and git.

## 1. Fresh fixture repo

Re-run this whole section before a new pass. It deletes the previous fixture.

```bash
export WORK="$HOME/ropex-manual"
rm -rf "$WORK"
mkdir -p "$WORK/src"
cd "$WORK"
git init -b main
git config user.email dev@example.com
git config user.name Dev
git config commit.gpgsign false
printf '%s\n' 'export function hello(): string {' '  return "hi";' '}' > src/hello.ts
git add src/hello.ts
git commit -m "init hello"
export BASE="$(git rev-parse HEAD)"
echo "base $BASE"
```

Helper used by every later step. It always runs Ropex with the fixture as the current directory:

```bash
ropex() { (cd "$WORK" && "$ROPEX/node_modules/.bin/tsx" "$ROPEX/src/cli.ts" "$@"); }
```

Reset between checks when a step says **reset**. This drops cluster state and worktrees. It does not move `main`.

```bash
reset() {
  cd "$WORK"
  rm -rf .ropex sandbox
  git worktree prune
  git rev-parse main
}
```

`git rev-parse main` must print the same hash as `BASE` after every check.

## 2. Embedded harness commits a fenced prompt

**reset**, then:

```bash
reset
ropex apply "$ROPEX/fleets/examples/manual/embedded.yaml"
ropex tasks submit --agent writer "$(cat "$ROPEX/fleets/examples/manual/prompts/greeting.txt")"
ropex drain --limit 1
```

Pass when all of these are true:

```bash
# drain printed: drained 1
ropex queue
# the writer line is [done], and err= is absent

WT="$WORK/sandbox/worktrees/writer_0"
git -C "$WT" log -1 --format='%s%n%an <%ae>%n%cn <%ce>'
git -C "$WT" show HEAD:src/hello.ts
git -C "$WT" show HEAD:src/hello.test.ts
git -C "$WORK" rev-parse main
```

| Check | Expected |
| --- | --- |
| Subject | `add a greeting argument` |
| Author and committer | `Ropex <ropex@localhost>` |
| `src/hello.ts` | contains `hello, ${name}` |
| `src/hello.test.ts` | contains `hello, world` |
| `main` in `$WORK` | still `$BASE` |

The standing worker is `writer:0`, so the worktree directory is `writer_0`. The commit is on that detached worktree. `main` stays on the init commit.

`ropex trajectories` shows one writer trajectory whose step plugin is `runtime:dsh`.

## 3. A prompt without file fences does not commit

Stay on the same applied fleet. Record the worktree tip, submit the plain prompt, drain again.

```bash
WT="$WORK/sandbox/worktrees/writer_0"
BEFORE="$(git -C "$WT" rev-parse HEAD)"
ropex tasks submit --agent writer "$(cat "$ROPEX/fleets/examples/manual/prompts/no-fence.txt")"
ropex drain --limit 1
AFTER="$(git -C "$WT" rev-parse HEAD)"
test "$BEFORE" = "$AFTER" && echo "tip unchanged"
git -C "$WORK" rev-parse main
```

Pass when:

- drain printed `drained 1` and `ropex queue` shows the new item `[done]`
- `tip unchanged` is printed
- `main` is still `$BASE`
- `git -C "$WT" status --short` does not show `src/hello.ts` or `src/hello.test.ts` as modified beyond the commit from section 2

That prompt asks for an implementation and a commit. The embedded planner does not invent file bodies for it, so the workspace is left as it was.

## 4. Cursor is a runtime, and `oauth` is rejected

```bash
reset
ropex runtimes
```

The list includes `dsh`, `claude-code`, `codex`, `copilot`, and `cursor`. `cursor` is not ready until `agent` is on `PATH` and one auth strategy has credentials. The hint names `agent` or `ROPEX_RUNTIME_BIN_CURSOR`.

```bash
ropex apply "$ROPEX/fleets/examples/manual/cursor-rejected.yaml"
echo "apply exit $?"
```

Pass when apply exits non-zero and the message contains `not supported by cursor` and `api-key | oauth-file`. No container is started. `main` is still `$BASE`.

## 5. Two credentials fail until `auth` is set

This uses `node` as a stand-in binary so you do not install Claude. The task is supposed to fail at boot. Unset any real keys first so the shell values are the only ones.

```bash
reset
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN OPENAI_API_KEY CODEX_API_KEY CURSOR_API_KEY
ropex apply "$ROPEX/fleets/examples/manual/auth-ambiguous.yaml"
```

### 5a. No credentials

```bash
ropex tasks submit --agent writer "say hi"
ropex drain --limit 1
ropex queue
```

Pass when the queue error contains `Claude Code CLI requires one of` and both `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`. The task may be retried and then become `dead`. That is the expected boot failure. `main` is still `$BASE`.

### 5b. Both strategies at once

**reset**, apply the same fleet again, then:

```bash
reset
ropex apply "$ROPEX/fleets/examples/manual/auth-ambiguous.yaml"
export ANTHROPIC_API_KEY=sk-manual-test
export CLAUDE_CODE_OAUTH_TOKEN=oauth-manual-test
ropex tasks submit --agent writer "say hi"
ropex drain --limit 1
ropex queue
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
```

Pass when the error contains `more than one auth method` and `Set spec.runtime.auth`. The values above are placeholders. They are not sent anywhere, because boot stops before the process runs.

### 5c. One strategy is enough to boot

**reset**, apply again, export only the API key:

```bash
reset
ropex apply "$ROPEX/fleets/examples/manual/auth-ambiguous.yaml"
export ANTHROPIC_API_KEY=sk-manual-test
unset CLAUDE_CODE_OAUTH_TOKEN
ropex tasks submit --agent writer "say hi"
ropex drain --limit 1
ropex queue
unset ANTHROPIC_API_KEY
```

Pass when the error is `Claude Code CLI exited` (node rejects the Claude argv). It must not say `requires one of` and it must not say `Set spec.runtime.auth`.

## 6. Optional — Codex in Docker

Skip this section unless Docker is running and `OPENAI_API_KEY` is a real key in the environment. The fleet names the variable. It does not contain the value.

```bash
docker info >/dev/null
test -n "$OPENAI_API_KEY"
reset
ropex apply "$ROPEX/fleets/examples/manual/docker-codex.yaml"
ropex sandbox build codex-writer
ropex tasks submit --agent codex-writer "$(cat "$ROPEX/fleets/examples/manual/prompts/greeting.txt")"
ropex drain --limit 1
ropex queue
ropex sandboxes
```

The first build pulls `node:22-bookworm` and installs `@openai/codex`. Later resets of `$WORK` rebuild only when the image is gone. `ropex-env:*` images survive the reset.

Pass when:

- queue status for `codex-writer` is `[done]`
- `ropex sandboxes` lists a task snapshot
- the snapshot’s git tip is the greeting commit by `Ropex <ropex@localhost>`

```bash
IMG="$(docker images ropex-snap --format '{{.Repository}}:{{.Tag}}' | head -1)"
docker run --rm "$IMG" git -C /workspace log -1 --format='%s%n%an <%ae>'
docker run --rm "$IMG" cat /workspace/src/hello.ts
```

Subject `add a greeting argument`. Author `Ropex <ropex@localhost>`. File text contains `hello, ${name}`.

The container is removed when the task ends. The snapshot is what you inspect. `main` in `$WORK` is still `$BASE`, because the clone lives in the container.

If `~/.codex/auth.json` also exists, this fleet still uses the API key because it sets `auth: api-key`.

Codex `oauth-file`, Claude, Copilot, and Cursor have the same boot path and fixture tests. This Docker section is the one live run already exercised for Codex `api-key`. The other CLIs are not required for this pass.

## 7. Optional — a real Cursor binary

When `agent` is on `PATH` and `CURSOR_API_KEY` is set:

```bash
ropex runtimes
```

Pass when the `cursor` line says `ready` and the hint names `CURSOR_API_KEY`. This page does not start a Cursor edit. Section 4 already checked that `auth: oauth` is rejected.

## 8. Put the fixture away

```bash
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
reset
rm -rf "$WORK"
```

Leave `$ROPEX` in place if you will run the pass again. To drop sandbox images from section 6:

```bash
docker images ropex-snap ropex-env
# delete only the tags this pass created, for example:
# docker rmi ropex-snap:task-... ropex-env:...
```
