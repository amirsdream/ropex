# More manual tasks — Cursor and Codex

Extra tasks for a real `codex` or `agent` binary. The setup, the fleets, and the greeting check live in [manual-runtime-checks.md](./manual-runtime-checks.md). This page only adds prompts.

You run every step. Each one spends Codex or Cursor usage. `drain` can sit for several minutes. A failed run is retried up to three times.

Two kinds of task:

| Kind | Prompt | Who writes the files |
| --- | --- | --- |
| Less realistic | A fenced path block, as in the greeting check | The plan. The runtime is told to write those bytes and commit. |
| More realistic | Prose. No fences. | The runtime. It has to read the worktree and make the edit. |

A prompt that contains `test`, `fix`, or `implement` makes the embedded plan ask for a GitHub pull request. This fixture has no remote, so these prompts leave those words out.

## 0. Start from the other guide

Finish sections 0 and 1 there, including `ROPEX`, `WORK`, `ropex`, and `reset`. `cursor` and `codex` must show `status: ready` in `ropex runtimes`. If a block says `more than one auth method`, uncomment one `auth:` line in the matching fleet, as sections 7 and 8 describe.

```bash
export ROPEX="${ROPEX:-$HOME/ropex-src}"
export WORK="${WORK:-$HOME/ropex-manual}"
cd "$WORK"
export BASE="$(git rev-parse main)"
```

Helpers for this page:

```bash
show_tip() {
  local wt="$1"
  echo "---- $wt ----"
  git -C "$wt" log -1 --format='%s%n%an <%ae>%n%cn <%ce>'
  echo "---- files ----"
  git -C "$wt" show --stat --format='' HEAD
  echo "---- main ----"
  git -C "$WORK" rev-parse main
}

run_task() {
  local kind="$1" prompt="$2"
  reset
  ropex apply "$ROPEX/fleets/examples/manual/${kind}-host.yaml"
  ropex tasks submit --agent "${kind}-host" "$(cat "$ROPEX/fleets/examples/manual/prompts/${prompt}.txt")"
  ropex drain --limit 1
  ropex queue
  show_tip "$WORK/sandbox/worktrees/${kind}-host_0"
  ropex trajectories --jsonl
}
```

`kind` is `codex` or `cursor`. Run a task on one, then the other, when you want both. `main` must stay `$BASE` after every task. The new commit is only on the detached worktree.

## 1. Less realistic — record a version

The prompt already contains `src/version.ts`. The plan writes that file and commits. Subject is the first line, `record the build version`.

```bash
run_task codex version-stamp
# or: run_task cursor version-stamp
```

Pass when `queue` shows the agent `[done]` with no `err=`, and:

| Check | Expected |
| --- | --- |
| Subject | `record the build version` |
| Author and committer | `Ropex <ropex@localhost>` |
| `src/version.ts` | contains `export const version = "0.1.0"` |
| `main` | still `$BASE` |
| Trajectory plugin | `runtime:codex` or `runtime:cursor` |

```bash
git -C "$WORK/sandbox/worktrees/codex-host_0" show HEAD:src/version.ts
```

Use `cursor-host_0` when that was the kind you ran.

## 2. Less realistic — leave a note

Same shape, a toy file. Subject `leave a note`. Body is three lines in `docs/note.txt`.

```bash
run_task cursor haiku
```

Pass when the tip subject is `leave a note`, the author is `Ropex <ropex@localhost>`, `docs/note.txt` contains `a frog jumps in`, and `main` is still `$BASE`.

## 3. More realistic — correct `add`

This one is a small bug. The prompt does not include the new file body. Codex or Cursor has to change the worktree.

Commit the bug on `main` first, so the worktree is created from it. Then point `BASE` at that commit.

```bash
cd "$WORK"
mkdir -p src
cat > src/sum.ts << 'EOF'
export function add(a: number, b: number): number {
  return a - b;
}
EOF
git add src/sum.ts
git commit -m "seed a wrong add"
export BASE="$(git rev-parse HEAD)"
echo "base $BASE"
```

```bash
run_task codex sum-correction
```

Pass when the agent is `[done]` with no `err=`, and the worktree tip has all of these:

| Check | Expected |
| --- | --- |
| Author and committer | `Ropex <ropex@localhost>` |
| Subject | `correct add` |
| `src/sum.ts` | returns `a + b` |
| `src/sum.check.ts` | throws unless `add(2, 3)` is `5` |
| `main` | still `$BASE` |

The subject is what the prompt asks the runtime to use. If the code is right and the subject differs, the run still edited the repo. Look at the tip before rerunning.

`main` on `$WORK` does not contain the correction. The seed commit is still the bug.

## 4. More realistic — add `clamp`

A small feature on the same repo. No new seed. **reset** is inside `run_task`, so this starts again from `main` (the bug seed is still there, and that is fine).

```bash
run_task cursor clamp
```

Pass when:

| Check | Expected |
| --- | --- |
| Author and committer | `Ropex <ropex@localhost>` |
| Subject | `add clamp` |
| `src/clamp.ts` | exports `clamp` and limits `n` to `lo..hi` |
| `src/clamp.check.ts` | requires `clamp(5, 0, 3)` to be `3` |
| `main` | still `$BASE` |

## 5. More realistic — a notes module

A slightly larger ticket: one module, blank input ignored, order kept. Same fleets.

```bash
run_task codex notes
```

Pass when the tip is by `Ropex <ropex@localhost>`, the subject is `add a notes module`, `src/notes.ts` exports `createNotes`, `src/notes.check.ts` covers `"a"` then a blank then `"b"`, and `main` is still `$BASE`.

## What you are comparing

Sections 1 and 2 tell you the runtime applied a plan. The file bytes are in the prompt, so a success there does not show that the model can edit.

Sections 3–5 are closer to a real ticket. The pass bar is the diff, not a byte-for-byte plan. The model can still miss the subject, skip the check file, or stop without a commit. Read `err=` on the queue line, then run that one task again. Three failures on the same prompt means stop.
